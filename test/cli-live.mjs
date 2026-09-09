// Opt-in public-server run of the command line on a small graph (phaseskg, 2,750 triples).
// KGF_ROOT=https://apps.okn.us/kgf/ KGF_DATASET=phaseskg node test/cli-live.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BIN = new URL('../packages/kgf-sparql/bin/kgf-sparql.js', import.meta.url).pathname;
const root = (process.env.KGF_ROOT ?? 'https://apps.okn.us/kgf/').replace(/\/$/u, '');
const datasetId = process.env.KGF_DATASET ?? 'phaseskg';
const index = await (await fetch(`${root}/`, { signal: AbortSignal.timeout(30_000) })).json();
const dataset = index.datasets.find(entry => entry.id === datasetId);
assert.ok(dataset, `dataset ${datasetId} must exist at ${root}`);
const source = `kgf@${new URL(dataset.links.fragment, root).href}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgf-sparql-live-'));
const run = args => new Promise(resolve => {
  const child = spawn(process.execPath, [ BIN, ...args ], { stdio: [ 'ignore', 'inherit', 'pipe' ] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('close', code => resolve({ code, stderr }));
});
const query = 'SELECT ?s ?p ?o WHERE { ?s ?p ?o }';

const complete = await run([ '-q', query, '--source', source, '--out', path.join(dir, 'all.srj'), '--receipt', path.join(dir, 'all.json'),
  '--max-requests', '100', '--max-bytes', '64M', '--timeout', '120' ]);
assert.equal(complete.code, 0, complete.stderr);
const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'all.json'), 'utf8'));
assert.equal(receipt.outcome.contract, 'complete');
assert.equal(receipt.outcome.rows, dataset.triples);
assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'all.srj'), 'utf8')).results.bindings.length, dataset.triples);
assert.equal(receipt.sources[0].dataset, datasetId);
assert.equal(receipt.sources[0].version, dataset.current);
assert.match(receipt.sources[0].content_digest, /^sha256:[0-9a-f]{64}$/u);
assert.ok(receipt.requests.length >= 3);
assert.ok(receipt.requests.every(request => request.status === 200 && /^[0-9a-f]+-[0-9a-f]+$/u.test(request.request_id)), 'every request carries the server id');
assert.ok(receipt.requests.some(request => request.complete === false && request.truncation_reason === 'page_limit'));
assert.equal(receipt.statistics.schema_requests, 0, 'a single pattern needs no join statistics');
assert.equal(receipt.totals.bytes, receipt.requests.reduce((sum, request) => sum + request.bytes, 0));

const aborted = await run([ '-q', query, '--source', source, '--out', path.join(dir, 'few.srj'), '--receipt', path.join(dir, 'few.json'),
  '--max-requests', '2', '--timeout', '60' ]);
assert.equal(aborted.code, 3, aborted.stderr);
const few = JSON.parse(fs.readFileSync(path.join(dir, 'few.json'), 'utf8'));
assert.equal(few.outcome.contract, 'aborted');
assert.equal(few.outcome.budget, 'max_requests');
assert.equal(few.requests.length, 2);
assert.ok(fs.existsSync(path.join(dir, 'few.srj')), 'whatever was serialized before the abort is kept');

console.log(JSON.stringify({
  source, rows: receipt.outcome.rows, requests: receipt.totals.requests, bytes: receipt.totals.bytes,
  elapsed_ms: receipt.totals.elapsed_ms, engine: receipt.engine, aborted: few.outcome,
}, null, 2));
fs.rmSync(dir, { recursive: true, force: true });
