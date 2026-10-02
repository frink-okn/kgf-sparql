import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Parser } from 'n3';
import { RunAccount, createPooledFetch, runCli } from 'kgf-sparql';
import { server, triples, EP } from './helpers/mock-kgf.mjs';

const BIN = new URL('../packages/kgf-sparql/bin/kgf-sparql.js', import.meta.url).pathname;
const SOURCE = `kgf@${EP}`;
const SCAN = 'SELECT ?s ?o WHERE { ?s <urn:p> ?o }';
const JOIN = 'SELECT ?s ?o ?label WHERE { ?s <urn:p> ?o . ?o <urn:label> ?label }';
const LABELS = 'SELECT ?s ?label WHERE { ?s <urn:label> ?label }';

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgf-sparql-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, out: path.join(dir, 'results'), receipt: path.join(dir, 'receipt.json') };
}
const readJson = file => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined);
const readText = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined);
const quadKey = quad => [ quad.subject.value, quad.predicate.value, quad.object.value, quad.object.language ?? '', quad.object.datatype?.value ?? '' ].join('|');

// A real HTTP server in front of the mock, for the executable and the transport; it records
// how many requests it was handling at once.
async function bridge(t, options = {}) {
  const state = { active: 0, peak: 0 };
  let mock;
  const httpServer = http.createServer(async(request, response) => {
    state.active++;
    state.peak = Math.max(state.peak, state.active);
    try {
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      const answer = await mock.fetch(new URL(request.url, `http://${request.headers.host}`).href, {
        method: request.method, headers: request.headers, body: body.length ? body.toString() : undefined,
      });
      response.writeHead(answer.status, Object.fromEntries(answer.headers));
      response.end(Buffer.from(await answer.arrayBuffer()));
    } finally {
      state.active--;
    }
  });
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  t.after(() => httpServer.close());
  const origin = `http://127.0.0.1:${httpServer.address().port}`;
  mock = server({ origin, ...options });
  return { origin, mock, state, source: `kgf@${origin}/mount/graph/v/1/fragment` };
}
const spawnCli = args => new Promise(resolve => {
  const child = spawn(process.execPath, [ BIN, ...args ], { stdio: [ 'ignore', 'pipe', 'pipe' ] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('close', code => resolve({ code, stderr }));
});

async function run(t, mock, args, extra = {}) {
  const ws = workspace(t);
  let stderr = '';
  const code = await runCli([ ...args, '--out', ws.out, '--receipt', ws.receipt ],
    { fetch: mock.fetch, stderr: text => { stderr += text; }, stdout: () => {}, ...extra });
  return { code, receipt: readJson(ws.receipt), output: readText(ws.out), stderr, ws };
}

test('a complete run writes SPARQL Results JSON and a receipt that accounts for every request', async t => {
  const mock = server();
  const { code, receipt, output, ws } = await run(t, mock, [ '-q', JOIN, '--source', SOURCE ]);
  assert.equal(code, 0);
  const results = JSON.parse(output);
  assert.deepEqual(results.head.vars, [ 's', 'o', 'label' ]);
  assert.equal(results.results.bindings.length, 5);
  assert.ok(results.results.bindings.every(row => row.s.type === 'uri' && row.label.type === 'literal'));
  assert.equal(receipt.schema, 'kgf-sparql.receipt/1');
  assert.equal(receipt.query, JOIN);
  assert.deepEqual(receipt.outcome, { contract: 'complete', rows: 5, result_type: 'bindings' });
  assert.deepEqual(receipt.output, { path: ws.out, format: 'application/sparql-results+json', variables: [ 's', 'o', 'label' ] });
  assert.deepEqual(receipt.sources, [{ kind: 'kgf', url: EP, dataset: 'graph', version: '1', content_digest: 'sha256:mock' }]);
  // The counting fetch saw exactly what the server saw, in order, starting with the dataset descriptor.
  assert.deepEqual(receipt.requests.map(request => request.url), mock.requests.map(call => call.url.href));
  assert.equal(receipt.requests[0].url, 'https://kgf.test/mount/graph');
  assert.ok(receipt.requests.every(request => request.status === 200 && /^mock-\d{7}$/u.test(request.request_id)));
  assert.ok(receipt.requests.every(request => request.bytes > 0 && request.bytes === request.bytes_wire && request.elapsed_ms >= 0));
  assert.deepEqual(receipt.requests.map(request => request.bindings), mock.requests.map(call => Boolean(call.body?.bindings)));
  assert.ok(receipt.requests.some(request => request.complete === false && request.truncation_reason === 'page_limit'));
  assert.ok(receipt.requests.some(request => request.complete === true && request.truncation_reason === null));
  assert.equal(receipt.totals.requests, mock.requests.length);
  assert.equal(receipt.totals.bindings_requests, receipt.requests.filter(request => request.bindings).length);
  assert.equal(receipt.totals.bytes, receipt.requests.reduce((sum, request) => sum + request.bytes, 0));
  assert.ok(receipt.totals.elapsed_ms >= 0);
  assert.equal(receipt.statistics.void, true);
  assert.equal(receipt.statistics.schema_requests, mock.requests.filter(call => call.url.pathname.endsWith('/schema')).length);
  assert.ok(receipt.statistics.schema_requests > 0, 'a two-pattern join consults the lazy VoID provider');
  assert.deepEqual(receipt.budget, { max_requests: null, max_bytes: null, max_rows: null, timeout_s: null, max_connections: 32,
    max_in_flight: 32, max_in_flight_hosts: {}, max_rate_hosts: {}, sparql_count_cap: null, sparql_count_cap_hosts: {} });
  assert.ok(receipt.engine.kgf_sparql && receipt.engine.comunica);
  assert.equal(receipt.engine.node, process.version);
  assert.ok(Date.parse(receipt.started) <= Date.parse(receipt.finished));
});

test('--max-requests aborts before the request past the budget, writes the receipt, and exits 3', async t => {
  const mock = server();
  const { code, receipt, output, stderr } = await run(t, mock, [ '-q', SCAN, '--source', SOURCE, '--max-requests', '3' ]);
  assert.equal(code, 3);
  assert.equal(mock.requests.length, 3, 'the fourth request never reached the server');
  assert.equal(receipt.requests.length, 3);
  assert.equal(receipt.totals.requests, 3);
  assert.deepEqual(receipt.outcome, { contract: 'aborted', rows: 0, budget: 'max_requests', result_type: 'bindings' });
  assert.equal(receipt.budget.max_requests, 3);
  assert.match(stderr, /max_requests/u);
  assert.equal(typeof output, 'string', 'whatever was serialized before the abort is kept');
});

test('--max-bytes stops a body while it streams and bounds what was received', async t => {
  const mock = server();
  const { code, receipt } = await run(t, mock, [ '-q', SCAN, '--source', SOURCE, '--max-bytes', '300' ]);
  assert.equal(code, 3);
  assert.equal(receipt.outcome.contract, 'aborted');
  assert.equal(receipt.outcome.budget, 'max_bytes');
  assert.equal(receipt.budget.max_bytes, 300);
  assert.ok(receipt.totals.bytes > 300, 'the abort fires on the chunk that crosses the budget');
  assert.ok(receipt.totals.bytes < 300 + 1024, 'and no later than that chunk');
  assert.equal(receipt.requests.length, mock.requests.length);
  const kilobytes = await run(t, server(), [ '-q', SCAN, '--source', SOURCE, '--max-bytes', '1k' ]);
  assert.equal(kilobytes.receipt.budget.max_bytes, 1024);
});

test('--max-rows writes exactly the budgeted rows as a well-formed document and aborts', async t => {
  const srj = await run(t, server(), [ '-q', SCAN, '--source', SOURCE, '--max-rows', '2' ]);
  assert.equal(srj.code, 3);
  assert.deepEqual(srj.receipt.outcome, { contract: 'aborted', rows: 2, budget: 'max_rows', result_type: 'bindings' });
  assert.equal(JSON.parse(srj.output).results.bindings.length, 2);
  const csv = await run(t, server(), [ '-q', SCAN, '--source', SOURCE, '--max-rows', '2', '--format', 'csv' ]);
  assert.equal(csv.code, 3);
  assert.deepEqual(csv.output.split('\r\n'), [ 's,o', 'urn:a,urn:b', 'urn:a,urn:c', '' ]);
  // A query with exactly as many rows as the budget is complete: the abort needs a row past it.
  const exact = await run(t, server(), [ '-q', SCAN, '--source', SOURCE, '--max-rows', '5' ]);
  assert.equal(exact.code, 0);
  assert.equal(exact.receipt.outcome.contract, 'complete');
});

test('--timeout aborts the in-flight request through its signal', async t => {
  const mock = server({ delayMs: 2_000 });
  const started = Date.now();
  const { code, receipt } = await run(t, mock, [ '-q', SCAN, '--source', SOURCE, '--timeout', '0.2' ]);
  assert.equal(code, 3);
  assert.ok(Date.now() - started < 1_500, 'the run did not wait for the slow response');
  assert.equal(receipt.outcome.contract, 'aborted');
  assert.equal(receipt.outcome.budget, 'timeout');
  assert.equal(receipt.budget.timeout_s, 0.2);
  assert.equal(receipt.requests.length, 1);
  assert.equal(receipt.requests[0].status, null);
  assert.match(receipt.requests[0].error, /timeout/u);
});

test('query, source, and output errors write an error receipt and exit 1', async t => {
  const malformed = await run(t, server(), [ '-q', 'SELECT ?s WHERE { ?s', '--source', SOURCE ]);
  assert.equal(malformed.code, 1);
  assert.equal(malformed.receipt.outcome.contract, 'error');
  assert.ok(malformed.receipt.outcome.error);
  assert.match(malformed.stderr, /Parse error|Expected|syntax/iu);
  const serverError = await run(t, server({ countFailure: true }), [ '-q', SCAN, '--source', SOURCE ]);
  assert.equal(serverError.code, 1);
  assert.match(serverError.receipt.outcome.error, /500/u);
  assert.ok(serverError.receipt.requests.some(request => request.status === 500));
  const missingRelease = await run(t, server(), [ '-q', SCAN, '--source', 'kgf@https://kgf.test/mount/graph/v/9/fragment' ]);
  assert.equal(missingRelease.code, 1);
  assert.match(missingRelease.receipt.outcome.error, /release '9'/u);
  assert.equal(missingRelease.receipt.requests.length, 1);
  const ws = workspace(t);
  const unwritable = await runCli([ '-q', SCAN, '--source', SOURCE, '--out', path.join(ws.dir, 'missing', 'results'), '--receipt', ws.receipt ],
    { fetch: server().fetch, stderr: () => {} });
  assert.equal(unwritable, 1);
  assert.match(readJson(ws.receipt).outcome.error, /ENOENT/u);
  assert.deepEqual(readJson(ws.receipt).requests, []);
});

test('usage errors exit 2 before any run; a format the result cannot take exits 2 with a receipt', async t => {
  for (const args of [
    [ '-q', SCAN, '--source', SOURCE ],
    [ '-q', SCAN, '--source', EP, '--out', 'x' ],
    [ '-q', SCAN, '-f', 'query.rq', '--source', SOURCE, '--out', 'x' ],
    [ '--source', SOURCE, '--out', 'x' ],
    [ '-q', SCAN, '--out', 'x' ],
    [ '-q', SCAN, '--source', SOURCE, '--out', 'x', '--max-requests', 'many' ],
    [ '-q', SCAN, '--source', SOURCE, '--out', 'x', '--max-bytes', '0' ],
    [ '-q', SCAN, '--source', SOURCE, '--out', 'x', '--timeout', '-1' ],
    [ '-q', SCAN, '--source', SOURCE, '--out', 'x', '--http-method', 'PATCH' ],
    [ '-q', SCAN, '--source', SOURCE, '--out', 'x', '--max-connections', '0' ],
    [ '-q', SCAN, '--source', SOURCE, '--out', 'x', '--bogus' ],
  ]) {
    const mock = server();
    let stderr = '';
    assert.equal(await runCli(args, { fetch: mock.fetch, stderr: text => { stderr += text; } }), 2, args.join(' '));
    assert.match(stderr, /Usage:/u);
    assert.equal(mock.requests.length, 0);
  }
  let stdout = '';
  assert.equal(await runCli([ '--help' ], { stdout: text => { stdout += text; } }), 0);
  assert.match(stdout, /--receipt/u);
  for (const format of [ 'nt', 'no/such-type' ]) {
    const mismatch = await run(t, server(), [ '-q', SCAN, '--source', SOURCE, '--format', format ]);
    assert.equal(mismatch.code, 2, format);
    assert.equal(mismatch.receipt.outcome.contract, 'error');
    assert.match(mismatch.receipt.outcome.error, /Cannot write a bindings result as/u);
    assert.ok(mismatch.receipt.requests.length > 0, 'the query was planned before the format was refused');
  }
});

test("CSV, TSV, ASK, CONSTRUCT, and a query file are written by the engine's serializers", async t => {
  const csv = await run(t, server(), [ '-q', LABELS, '--source', SOURCE, '--format', 'csv' ]);
  assert.equal(csv.code, 0);
  assert.equal(csv.receipt.output.format, 'text/csv');
  assert.deepEqual(csv.receipt.output.variables, [ 's', 'label' ]);
  assert.ok(csv.output.startsWith('s,label\r\n'));
  assert.ok(csv.output.includes('urn:a,"A\n""quoted"" \\ café"\r\n'));
  assert.ok(csv.output.includes('urn:b,2\r\n'));
  const tsv = await run(t, server(), [ '-q', LABELS, '--source', SOURCE, '--format', 'text/tab-separated-values' ]);
  assert.equal(tsv.code, 0);
  assert.ok(tsv.output.startsWith('?s\t?label\n'));
  assert.equal(tsv.output.trimEnd().split('\n').length, 4);
  const ask = await run(t, server(), [ '-q', 'ASK { <urn:a> <urn:p> <urn:b> }', '--source', SOURCE ]);
  assert.equal(ask.code, 0);
  assert.deepEqual(JSON.parse(ask.output), { head: {}, boolean: true });
  assert.deepEqual(ask.receipt.outcome, { contract: 'complete', rows: 1, result_type: 'boolean' });
  const ws = workspace(t);
  const file = path.join(ws.dir, 'query.rq');
  fs.writeFileSync(file, 'CONSTRUCT { ?s <urn:has> ?label } WHERE { ?s <urn:label> ?label }');
  const expected = triples.filter(quad => quad.predicate.value === 'urn:label')
    .map(quad => quadKey({ ...quad, predicate: { value: 'urn:has' } })).sort();
  const construct = await run(t, server(), [ '-f', file, '--source', SOURCE ]);
  assert.equal(construct.code, 0);
  assert.deepEqual(construct.receipt.output, { path: construct.ws.out, format: 'application/n-triples' });
  assert.deepEqual(construct.receipt.outcome, { contract: 'complete', rows: 3, result_type: 'quads' });
  assert.deepEqual(new Parser({ format: 'N-Triples' }).parse(construct.output).map(quadKey).sort(), expected);
  const turtle = await run(t, server(), [ '-f', file, '--source', SOURCE, '--format', 'ttl' ]);
  assert.equal(turtle.code, 0);
  assert.deepEqual(new Parser({ format: 'Turtle' }).parse(turtle.output).map(quadKey).sort(), expected);
});

test('transport settings reach the engine and are reflected in the receipt', async t => {
  const mock = server();
  const { code, receipt } = await run(t, mock, [ '-q', JOIN, '--source', SOURCE, '--no-void-statistics', '--http-method', 'POST', '--page-size', '1' ]);
  assert.equal(code, 0);
  assert.equal(receipt.outcome.rows, 5);
  assert.equal(receipt.statistics.void, false);
  assert.equal(receipt.statistics.schema_requests, 0);
  assert.ok(mock.requests.some(call => call.body?.bindings), 'the join pushed bindings');
  assert.ok(mock.requests.filter(call => call.body).every(call => call.method === 'POST'));
  assert.ok(mock.requests.filter(call => call.url.pathname.endsWith('/fragment') && !call.body)
    .every(call => call.url.searchParams.get('limit') === '1'));
});

test('a SPARQL endpoint named explicitly is queried through the same counting fetch and recorded by kind', async t => {
  const mock = server();
  const { code, receipt, output } = await run(t, mock, [ '-q', SCAN, '--source', 'sparql@https://kgf.test/sparql' ]);
  assert.equal(code, 0);
  assert.deepEqual(receipt.sources, [{ kind: 'sparql', url: 'https://kgf.test/sparql' }]);
  assert.ok(receipt.requests.length > 0);
  assert.ok(receipt.requests.every(request => request.url.startsWith('https://kgf.test/sparql')));
  assert.equal(receipt.requests.length, mock.requests.length);
  assert.equal(JSON.parse(output).results.bindings.length, 1);
  assert.equal(receipt.outcome.contract, 'complete');
});

test('the executable flushes results, writes the receipt, and reports the exit status', async t => {
  const { source } = await bridge(t);
  const ws = workspace(t);
  const aborted = await spawnCli([ '-q', SCAN, '--source', source, '--out', ws.out, '--receipt', ws.receipt, '--max-rows', '1' ]);
  assert.equal(aborted.code, 3, aborted.stderr);
  assert.equal(JSON.parse(readText(ws.out)).results.bindings.length, 1);
  assert.equal(readJson(ws.receipt).outcome.budget, 'max_rows');
  assert.ok(readJson(ws.receipt).requests.every(request => /^mock-/u.test(request.request_id)));
  const complete = await spawnCli([ '-q', SCAN, '--source', source, '--out', ws.out, '--receipt', ws.receipt ]);
  assert.equal(complete.code, 0, complete.stderr);
  assert.equal(JSON.parse(readText(ws.out)).results.bindings.length, 5);
  assert.equal(readJson(ws.receipt).outcome.contract, 'complete');
  const usage = await spawnCli([]);
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /Usage:/u);
});

test('a run the engine never ends still writes its receipt when the event loop drains', async t => {
  // A fetch that never settles, with no timer or socket behind it, is what a stalled engine looks like.
  const stalled = () => new Promise(() => {});
  for (const [ args, expected ] of [
    [[], { contract: 'error', code: 1 }],
    [[ '--timeout', '0.1' ], { contract: 'aborted', code: 3 }],
  ]) {
    const ws = workspace(t);
    let stderr = '';
    const pending = runCli([ '-q', SCAN, '--source', SOURCE, '--out', ws.out, '--receipt', ws.receipt, ...args ],
      { fetch: stalled, stderr: text => { stderr += text; } });
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(readJson(ws.receipt), undefined, 'nothing written while the run is open');
    process.emit('beforeExit', 0);
    const receipt = readJson(ws.receipt);
    assert.equal(receipt.outcome.contract, expected.contract);
    assert.match(receipt.outcome.error, /stopped without ending the run/u);
    assert.equal(process.exitCode, expected.code);
    assert.match(stderr, /stopped without ending/u);
    process.exitCode = 0;
    void pending;
  }
});

test("a brTPF request carrying bindings in its URL counts as a bindings request", async() => {
  const account = new RunAccount({}, async() => new Response('{}', { headers: { 'content-type': 'application/json' } }));
  await account.fetch('https://kgf.test/graph/tpf?s=%3Curn%3Aa%3E&values=%7B%7D');
  await account.fetch('https://kgf.test/graph/tpf?p=%3Curn%3Ap%3E');
  assert.deepEqual(account.requests.map(request => request.bindings), [ true, false ]);
});

test('the pooled fetch caps concurrent connections per origin and reuses them', async t => {
  const state = { active: 0, peak: 0, sockets: new Set() };
  const httpServer = http.createServer((request, response) => {
    state.active++;
    state.peak = Math.max(state.peak, state.active);
    state.sockets.add(request.socket);
    setTimeout(() => { state.active--; response.end('ok'); }, 150);
  });
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  t.after(() => httpServer.close());
  const url = `http://127.0.0.1:${httpServer.address().port}/`;
  for (const cap of [ 2, 6 ]) {
    Object.assign(state, { active: 0, peak: 0, sockets: new Set() });
    const pooled = createPooledFetch(cap);
    const bodies = await Promise.all(Array.from({ length: 6 }, () => pooled.fetch(url).then(response => response.text())));
    await pooled.close();
    assert.deepEqual(bodies, Array.from({ length: 6 }, () => 'ok'));
    assert.equal(state.peak, cap, `at most ${cap} requests in flight`);
    assert.equal(state.sockets.size, cap, 'the connections were reused, not reopened');
  }
});

test('--max-in-flight reaches the engine, which holds requests back however many connections there are', async t => {
  // HTTP/2 carries any number of requests on one connection, so the cap is the engine's.
  const { source, state } = await bridge(t, { delayMs: 20 });
  const ws = workspace(t);
  const run = await spawnCli([ '-q', JOIN, '--source', source, '--out', ws.out, '--receipt', ws.receipt,
    '--max-connections', '32', '--max-in-flight', '1' ]);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(readJson(ws.receipt).outcome.rows, 5);
  assert.equal(state.peak, 1, 'one request at a time');
});

test('a server that refuses with 429 is retried, paced, and the receipt shows the refusals', async t => {
  // QLever's way: 429 with no Retry-After. No --http-retries: the engine retries refusals anyway.
  const mock = server();
  let refusals = 0;
  const fetch = async(input, init) => {
    if (init?.body && refusals < 2) {
      refusals++;
      return new Response('slow down', { status: 429 });
    }
    return mock.fetch(input, init);
  };
  const { code, receipt } = await run(t, mock, [ '-q', JOIN, '--source', SOURCE ], { fetch });
  assert.equal(code, 0);
  assert.equal(receipt.outcome.rows, 5);
  assert.equal(receipt.requests.filter(request => request.status === 429).length, 2);
});

test('--http-retries bounds a refused request\'s attempts once, not once per retrying actor', async t => {
  // The engine's throttle wraps Comunica's retry actor and tells it to stand aside; were it the
  // other way round, each of Comunica's attempts would carry the throttle's own retries.
  const mock = server();
  const attempts = new Map();
  const fetch = async(input, init) => {
    if (init?.body) {
      const key = `${input} ${init.body}`;
      attempts.set(key, (attempts.get(key) ?? 0) + 1);
      return new Response('slow down', { status: 429 });
    }
    return mock.fetch(input, init);
  };
  const { code } = await run(t, mock, [ '-q', JOIN, '--source', SOURCE, '--http-retries', '2' ], { fetch });
  assert.equal(code, 1);
  assert.ok(attempts.size > 0);
  assert.equal(Math.max(...attempts.values()), 3, 'one attempt and two retries');
});

test('--max-in-flight, --max-rate and --count-cap set the limits, and the receipt records them', async t => {
  const { source } = await bridge(t, {});
  const ws = workspace(t);
  const run = await spawnCli([ '-q', JOIN, '--source', source, '--out', ws.out, '--receipt', ws.receipt,
    '--max-in-flight', '4', '--max-in-flight', 'qlever.dev=2', '--max-rate', 'qlever.dev=1', '--max-rate', 'example.org=0.5',
    '--count-cap', '100000', '--count-cap', 'query.wikidata.org=10000', '--count-cap', 'example.org=none' ]);
  assert.equal(run.code, 0, run.stderr);
  const { budget } = readJson(ws.receipt);
  assert.equal(budget.max_in_flight, 4);
  assert.deepEqual(budget.max_in_flight_hosts, { 'qlever.dev': 2 });
  assert.deepEqual(budget.max_rate_hosts, { 'qlever.dev': 1, 'example.org': 0.5 });
  assert.equal(budget.sparql_count_cap, 100000);
  assert.deepEqual(budget.sparql_count_cap_hosts, { 'query.wikidata.org': 10000, 'example.org': 'none' });
  for (const [ flag, value, message ] of [
    [ '--max-in-flight', '=2', /needs a host/u ],
    [ '--max-rate', '2', /takes host=n/u ],
    [ '--max-rate', 'qlever.dev=0', /positive number/u ],
    [ '--count-cap', '=5', /needs a host/u ],
    [ '--count-cap', 'example.org=all', /integer/u ],
  ]) {
    const usage = await spawnCli([ '-q', JOIN, '--source', source, '--out', ws.out, flag, value ]);
    assert.equal(usage.code, 2, `${flag} ${value}`);
    assert.match(usage.stderr, message);
  }
});

test('--max-connections reaches the transport and bounds what the server sees at once', async t => {
  const { source, state } = await bridge(t, { delayMs: 20 });
  const ws = workspace(t);
  const one = await spawnCli([ '-q', JOIN, '--source', source, '--out', ws.out, '--receipt', ws.receipt, '--max-connections', '1' ]);
  assert.equal(one.code, 0, one.stderr);
  assert.equal(readJson(ws.receipt).outcome.rows, 5);
  assert.equal(readJson(ws.receipt).budget.max_connections, 1);
  assert.equal(state.peak, 1, 'one connection means one request at a time');
});
