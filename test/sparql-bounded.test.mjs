import assert from 'node:assert/strict';
import test from 'node:test';
import { ActorQuerySerializeSparql } from '@comunica/actor-query-serialize-sparql';
import { KeysQueryOperation } from '@comunica/context-entries';
import { ActionContext, Bus } from '@comunica/core';
import { AlgebraFactory } from '@comunica/utils-algebra';
import { BindingsFactory } from '@comunica/utils-bindings-factory';
import {
  QuerySourceSparqlBounded,
} from '@frink-okn/actor-query-source-identify-hypermedia-sparql-bounded/lib/QuerySourceSparqlBounded.js';
import {
  ActorOptimizeQueryOperationPruneEmptySourceOperationsBounded,
} from '@frink-okn/actor-query-source-identify-hypermedia-sparql-bounded';
import { ArrayIterator, BufferedIterator } from 'asynciterator';
import { ActorHttpThrottle } from '@frink-okn/actor-http-throttle';
import { KEY_HTTP_HOST_LIMITS, KEY_SPARQL_COUNT_CAP_HOSTS, QueryEngine } from '@frink-okn/kgf-sparql';
import { DataFactory } from 'rdf-data-factory';
import { EP, server } from './helpers/mock-kgf.mjs';

const ENDPOINT = 'https://sparql.test/sparql';
const QUERY = 'SELECT ?s ?o ?x WHERE { ?s <urn:p> ?o . ?o <urn:sameAs> ?x }';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * A SPARQL endpoint with two `urn:sameAs` statements and no `urn:p`, behind the mock KGF
 * graph's fetch. `countFor(query, n)` answers the n-th COUNT; it may wait first, or answer
 * `{ value, bodyDelayMs }` to send the headers at once and the count that much later.
 */
function endpoint(countFor, host = 'sparql.test') {
  const kgf = server();
  const requests = [];
  let counts = 0;
  const sparql = (rows, vars) => new Response(JSON.stringify({ head: { vars }, results: { bindings: rows } }), {
    headers: { 'content-type': 'application/sparql-results+json' },
  });
  const fetch = async(input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.host !== host) {
      return kgf.fetch(input, init);
    }
    const body = typeof init.body === 'string' ? init.body : init.body?.toString();
    const query = url.searchParams.get('query') ?? (body ? new URLSearchParams(body).get('query') : null);
    if (!query) {
      return new Response('', { status: 404 });
    }
    const pattern = query.includes('urn:sameAs') ? 'sameAs' : 'p';
    if (/COUNT/u.test(query)) {
      const request = { kind: 'count', pattern, query, values: /VALUES/u.test(query) };
      requests.push(request);
      const answer = request.values ? 2 : await countFor(request, counts++);
      const { value: count, bodyDelayMs = 0 } = typeof answer === 'object' ? answer : { value: answer };
      const response = sparql([{ count: { type: 'literal', value: String(count), datatype: XSD_INTEGER } }], [ 'count' ]);
      if (bodyDelayMs === 0) {
        return response;
      }
      const body = await response.arrayBuffer();
      return new Response(new ReadableStream({ async start(controller) {
        await sleep(bodyDelayMs);
        controller.enqueue(new Uint8Array(body));
        controller.close();
      } }), { headers: response.headers });
    }
    if (/^\s*ASK/iu.test(query.replace(/^(PREFIX[^\n]*\n)*/u, ''))) {
      requests.push({ kind: 'ask', pattern, query });
      return new Response(JSON.stringify({ head: {}, boolean: pattern === 'sameAs' }), {
        headers: { 'content-type': 'application/sparql-results+json' },
      });
    }
    requests.push({ kind: 'select', pattern, query });
    if (pattern === 'p') {
      return sparql([], [ 's', 'o' ]);
    }
    const iri = value => ({ type: 'uri', value });
    const sameAs = [[ 'urn:b', 'urn:B' ], [ 'urn:c', 'urn:C' ]];
    // Bindings sent as VALUES are joined here, as an endpoint joins them.
    const values = query.match(/VALUES\s*\(([^)]*)\)\s*\{(.*?)\}/su);
    if (!values) {
      return sparql(sameAs.map(([ o, x ]) => ({ o: iri(o), x: iri(x) })), [ 'o', 'x' ]);
    }
    const names = values[1].trim().split(/\s+/u).map(name => name.slice(1));
    const tuples = [ ...values[2].matchAll(/\(([^)]*)\)/gu) ]
      .map(([ , tuple ]) => [ ...tuple.matchAll(/<([^>]*)>/gu) ].map(([ , value ]) => value));
    const rows = tuples.flatMap(tuple => {
      const row = Object.fromEntries(names.map((name, i) => [ name, iri(tuple[i]) ]));
      return sameAs.filter(([ o ]) => row.o?.value === o).map(([ , x ]) => ({ ...row, x: iri(x) }));
    });
    return sparql(rows, [ ...names, 'x' ]);
  };
  return { fetch, requests };
}

async function run(fake, settings = {}, endpointUrl = ENDPOINT) {
  const engine = new QueryEngine();
  const bindings = await engine.queryBindings(QUERY, {
    sources: [{ type: 'kgf', value: EP }, { type: 'sparql', value: endpointUrl }],
    '@comunica/bus-http:fetch': fake.fetch,
    ...settings,
  });
  return (await bindings.toArray()).map(row => [ 's', 'o', 'x' ].map(name => row.get(name)?.value).join(' ')).sort();
}

const EXPECTED = [
  'urn:a urn:b urn:B', 'urn:a urn:c urn:C', 'urn:b urn:b urn:B', 'urn:b urn:c urn:C', 'urn:d urn:b urn:B',
];

test('COUNT queries to a SPARQL endpoint stop at the cap, and an exact count under it is used as is', async() => {
  const fake = endpoint(request => request.pattern === 'sameAs' ? 2 : 0);
  assert.deepEqual(await run(fake), EXPECTED);
  const planning = fake.requests.filter(request => request.kind === 'count' && !request.values);
  assert.ok(planning.length >= 2, 'a COUNT for each pattern');
  assert.ok(planning.every(request => /LIMIT\s+1000001\b/u.test(request.query)), planning.map(request => request.query).join('\n'));
  assert.deepEqual(fake.requests.filter(request => request.kind === 'ask'), [], 'exact counts need no ASK');
});

test('a count that reaches the cap is a lower bound, which source selection accepts without an ASK', async() => {
  // QLever's Wikidata endpoint counts a million labels in tens of milliseconds, and all of
  // them in seconds, past Comunica's three; a count at the cap says there are at least that many.
  const fake = endpoint(request => request.pattern === 'sameAs' ? 11 : 0);
  assert.deepEqual(await run(fake, { [KEY_SPARQL_COUNT_CAP_HOSTS.name]: { 'sparql.test': 10 } }), EXPECTED);
  const planning = fake.requests.filter(request => request.kind === 'count' && !request.values);
  assert.ok(planning.every(request => /LIMIT\s+11\b/u.test(request.query)), 'the cap is the host\'s own');
  assert.deepEqual(fake.requests.filter(request => request.kind === 'ask'), [],
    'Comunica confirms an estimate with an ASK; a count at the cap needs none');
});

test('a COUNT is timed while the server has it, not while it waits its turn', async() => {
  // One request at a time to the endpoint, and the server takes 3.5 s over the first COUNT:
  // that one times out after 3 s and is confirmed with an ASK, as in Comunica. The next waits
  // its turn for 3.5 s and is answered at once; timed from when it was asked, it timed out too.
  const fake = endpoint(async(request, n) => {
    if (n === 0) {
      await sleep(3_500);
    }
    return request.pattern === 'sameAs' ? 2 : 0;
  });
  assert.deepEqual(await run(fake, { [KEY_HTTP_HOST_LIMITS.name]: { 'sparql.test': { inFlight: 1 }}}), EXPECTED);
  const counts = fake.requests.filter(request => request.kind === 'count' && !request.values);
  const asks = fake.requests.filter(request => request.kind === 'ask');
  assert.equal(asks.length, 1, asks.map(request => request.pattern).join(', '));
  assert.equal(asks[0].pattern, counts[0].pattern, 'only the slow COUNT is confirmed with an ASK');
});

test('a COUNT whose server sends the headers before it has counted is still timed out', async() => {
  // The timer used to stop when the headers arrived, so such a COUNT had the whole 30 s
  // deadline: here it would have been answered after 3.5 s, exact, and planning waited for it.
  const fake = endpoint((request, n) => ({ value: request.pattern === 'sameAs' ? 2 : 0, bodyDelayMs: n === 0 ? 3_500 : 0 }));
  assert.deepEqual(await run(fake), EXPECTED);
  const counts = fake.requests.filter(request => request.kind === 'count' && !request.values);
  const asks = fake.requests.filter(request => request.kind === 'ask');
  assert.equal(asks.length, 1, 'the slow COUNT is reported unknown after 3 s, and confirmed with an ASK');
  assert.equal(asks[0].pattern, counts[0].pattern);
});

test('bindings that cannot be read still leave the probe a metadata', async() => {
  // Comunica writes an unknown cardinality whatever happens; the bound path used to write
  // nothing when its operation could not be built, and a wait on the metadata never ended.
  const df = new DataFactory();
  const af = new AlgebraFactory(df);
  const unused = { mediate: async() => {
    throw new Error('not sent');
  } };
  const source = new QuerySourceSparqlBounded(() => 1_000, 3_000, ENDPOINT, ENDPOINT, new ActionContext(), unused, unused,
    'values', df, af, new BindingsFactory(df), false, 0, 30_000, true, false, 600, false, {});
  const bindings = new BufferedIterator({ autoStart: false });
  bindings._read = () => bindings.destroy(new Error('no bindings'));
  const pattern = af.createPattern(df.variable('o'), df.namedNode('urn:sameAs'), df.variable('x'));
  const stream = source.queryBindings(pattern, new ActionContext(), {
    joinBindings: { bindings, metadata: { variables: [{ variable: df.variable('o'), canBeUndef: false }] }},
  });
  const metadata = await Promise.race([
    new Promise(resolve => stream.getProperty('metadata', resolve)),
    sleep(1_000).then(() => undefined),
  ]);
  assert.ok(metadata, 'the metadata is written');
  assert.equal(metadata.cardinality.value, Number.POSITIVE_INFINITY);
});

test('bindings sent as VALUES are selected, not counted', async() => {
  // Comunica counted each block of bindings before selecting it, two requests a block, and
  // no join read the count. KGF's five rows are bound here: the endpoint has more, and takes
  // long enough over each request that one per row costs more than one per block.
  const fake = endpoint(async request => {
    await sleep(50);
    return request.pattern === 'sameAs' ? 1_000 : 0;
  });
  assert.deepEqual(await run(fake), EXPECTED);
  assert.ok(fake.requests.some(request => request.kind === 'select' && /VALUES/u.test(request.query)),
    'the join sends its bindings to the endpoint');
  assert.deepEqual(fake.requests.filter(request => request.kind === 'count' && request.values), []);
});

test('Wikidata\'s query services are counted in full, unless the context caps them', async() => {
  // Blazegraph counts a pattern from its indexes, and reads every row of a capped subquery:
  // 0.12 s for every wdt:P921 statement against 10 s to count to a million.
  const wdqs = 'https://query-scholarly.wikidata.org/sparql';
  const full = endpoint(request => request.pattern === 'sameAs' ? 2 : 0, 'query-scholarly.wikidata.org');
  assert.deepEqual(await run(full, {}, wdqs), EXPECTED);
  const counts = full.requests.filter(request => request.kind === 'count' && !request.values);
  assert.ok(counts.length >= 2);
  assert.ok(counts.every(request => !/LIMIT/u.test(request.query)), counts.map(request => request.query).join('\n'));
  const capped = endpoint(request => request.pattern === 'sameAs' ? 2 : 0, 'query-scholarly.wikidata.org');
  assert.deepEqual(await run(capped, { [KEY_SPARQL_COUNT_CAP_HOSTS.name]: { 'query-scholarly.wikidata.org': 10 } }, wdqs), EXPECTED);
  assert.ok(capped.requests.filter(request => request.kind === 'count' && !request.values)
    .every(request => /LIMIT\s+11\b/u.test(request.query)), 'the host\'s own cap comes before the group\'s default');
});

test('a cap keyed *.domain applies to the hosts in it, and null counts in full', async() => {
  const grouped = endpoint(request => request.pattern === 'sameAs' ? 2 : 0, 'sparql.kgf.test');
  assert.deepEqual(await run(grouped, { [KEY_SPARQL_COUNT_CAP_HOSTS.name]: { '*.kgf.test': 10 } },
    'https://sparql.kgf.test/sparql'), EXPECTED);
  assert.ok(grouped.requests.filter(request => request.kind === 'count' && !request.values)
    .every(request => /LIMIT\s+11\b/u.test(request.query)));
  const uncapped = endpoint(request => request.pattern === 'sameAs' ? 2 : 0);
  assert.deepEqual(await run(uncapped, { [KEY_SPARQL_COUNT_CAP_HOSTS.name]: { 'sparql.test': null } }), EXPECTED);
  assert.ok(uncapped.requests.filter(request => request.kind === 'count' && !request.values)
    .every(request => !/LIMIT/u.test(request.query)));
});

test('each query\'s cap holds for its COUNTs, though the engine keeps the source it identified', async() => {
  // Comunica keeps an identified source for the engine's later queries, and the cap used to be
  // fixed when it was identified: a second query's own cap was ignored.
  const fake = endpoint(request => request.pattern === 'sameAs' ? 2 : 0);
  const engine = new QueryEngine();
  const query = async settings => (await engine.queryBindings(QUERY, {
    sources: [{ type: 'kgf', value: EP }, { type: 'sparql', value: ENDPOINT }],
    '@comunica/bus-http:fetch': fake.fetch,
    ...settings,
  })).toArray();
  const planning = () => fake.requests.filter(request => request.kind === 'count' && !request.values);
  await query({});
  assert.ok(planning().every(request => /LIMIT\s+1000001\b/u.test(request.query)));
  fake.requests.length = 0;
  await query({ [KEY_SPARQL_COUNT_CAP_HOSTS.name]: { 'sparql.test': 10 } });
  const capped = planning();
  assert.ok(capped.length >= 1, 'the second query counts with its own cap');
  assert.ok(capped.every(request => /LIMIT\s+11\b/u.test(request.query)), capped.map(request => request.query).join('\n'));
  fake.requests.length = 0;
  await query({ [KEY_SPARQL_COUNT_CAP_HOSTS.name]: { 'sparql.test': null } });
  assert.ok(planning().every(request => !/LIMIT/u.test(request.query)), 'and a third counts in full');
});

/**
 * A bounded source of its own over `fetch`, its requests paced by the throttle (whose attempt
 * listener times the COUNTs), with an LRU of counts and `attemptTimeout` ms per COUNT attempt.
 */
function boundedSource(fetch, attemptTimeout = 3_000) {
  const df = new DataFactory();
  const af = new AlgebraFactory(df);
  const serializer = new ActorQuerySerializeSparql({ name: 'serialize', bus: new Bus({ name: 'serialize' }) });
  const mediatorQuerySerialize = { mediate: async action => serializer.run(action) };
  const transport = { mediate: async action => fetch(action.input, action.init) };
  const throttle = new ActorHttpThrottle({ name: 'throttle', bus: new Bus({ name: 'http' }), mediatorHttp: transport });
  const mediatorHttp = { mediate: async action => throttle.run(action) };
  const source = new QuerySourceSparqlBounded(() => 1_000, attemptTimeout, ENDPOINT, ENDPOINT, new ActionContext(), mediatorHttp,
    mediatorQuerySerialize, 'values', df, af, new BindingsFactory(df), false, 16, 30_000, true, false, 600, false, {});
  const metadata = async operation => await new Promise(resolve =>
    source.queryBindings(operation, new ActionContext()).getProperty('metadata', resolve));
  return { df, af, source, metadata };
}

test('a repeated variable stays repeated in the COUNT, and its count is its own', async() => {
  // Each position was renamed apart: `?x <urn:p> ?x` was counted as every <urn:p> statement,
  // and that count reported as the pattern's exact size.
  const { df, af, source } = boundedSource(async() => new Response('', { status: 500 }));
  const x = df.variable('x');
  const count = async pattern => (await source.operationToNormalizedCountQuery(pattern)).replace(/\s+/gu, ' ');
  assert.match(await count(af.createPattern(x, df.namedNode('urn:p'), x)), /\?s <urn:p> \?s/u);
  assert.match(await count(af.createPattern(df.variable('a'), df.namedNode('urn:p'), df.variable('b'))), /\?s <urn:p> \?o/u);
  assert.match(await count(af.createPattern(x, df.variable('p'), df.variable('o'), x)), /GRAPH \?s \{ \?s \?p \?o/u);
});

test('a COUNT that timed out does not stand for the time of the endpoint\'s requests', async() => {
  // A COUNT timed out after its attempt's 200 ms used to become the source's request time, and
  // every count already known, and every probe, then reported it: here, a request of 30 ms.
  const sparqlCount = value => new Response(JSON.stringify({ head: { vars: [ 'count' ] },
    results: { bindings: [{ count: { type: 'literal', value: String(value), datatype: XSD_INTEGER }}] }}), {
    headers: { 'content-type': 'application/sparql-results+json' },
  });
  const { df, af, metadata } = boundedSource(async(input, init) => {
    const slow = decodeURIComponent(`${input} ${init?.body ?? ''}`).includes('urn:slow');
    await sleep(slow ? 600 : 30);
    return sparqlCount(5);
  }, 200);
  const fast = af.createPattern(df.variable('a'), df.namedNode('urn:fast'), df.variable('b'));
  const slow = af.createPattern(df.variable('a'), df.namedNode('urn:slow'), df.variable('b'));
  const answered = await metadata(fast);
  assert.equal(answered.cardinality.value, 5);
  assert.ok(answered.requestTime >= 25 && answered.requestTime < 150, `${answered.requestTime} ms`);
  const timedOut = await metadata(slow);
  assert.equal(timedOut.cardinality.value, Number.POSITIVE_INFINITY);
  assert.equal(timedOut.requestTime, answered.requestTime, 'the last answered COUNT\'s time stands for it');
  const known = await metadata(fast);
  assert.equal(known.cardinality.value, 5);
  assert.equal(known.requestTime, answered.requestTime);
  // Let the slow COUNT, which carries on, finish.
  await sleep(450);
});

test('source selection keeps the target of a SERVICE SILENT clause without asking it', async() => {
  const df = new DataFactory();
  const af = new AlgebraFactory(df);
  const prune = new ActorOptimizeQueryOperationPruneEmptySourceOperationsBounded({
    name: 'prune', bus: new Bus({ name: 'test' }), useAskIfSupported: false,
  });
  const asked = [];
  const empty = () => {
    asked.push('bindings');
    const bindings = new ArrayIterator([], { autoStart: false });
    bindings.setProperty('metadata', { cardinality: { type: 'exact', value: 0 }});
    return bindings;
  };
  const wrapper = context => ({ source: { queryBindings: empty }, context });
  const pattern = af.createPattern(df.variable('s'), df.namedNode('urn:p'), df.variable('o'));
  assert.equal(await prune.hasSourceResults(af, wrapper(new ActionContext()), pattern, new ActionContext()), false,
    'an empty source is dropped');
  asked.length = 0;
  const silent = new ActionContext({ [KeysQueryOperation.silent.name]: true });
  assert.equal(await prune.hasSourceResults(af, wrapper(silent), pattern, new ActionContext()), true);
  assert.deepEqual(asked, [], 'a SERVICE SILENT target that fails must still give its one empty solution');
});
