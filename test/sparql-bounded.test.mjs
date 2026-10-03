import assert from 'node:assert/strict';
import test from 'node:test';
import { ActionContext } from '@comunica/core';
import { AlgebraFactory } from '@comunica/utils-algebra';
import { BindingsFactory } from '@comunica/utils-bindings-factory';
import {
  QuerySourceSparqlBounded,
} from '@kgf/actor-query-source-identify-hypermedia-sparql-bounded/lib/QuerySourceSparqlBounded.js';
import { BufferedIterator } from 'asynciterator';
import { KEY_HTTP_HOST_LIMITS, KEY_SPARQL_COUNT_CAP_HOSTS, QueryEngine } from 'kgf-sparql';
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
  const source = new QuerySourceSparqlBounded(1_000, 3_000, ENDPOINT, ENDPOINT, new ActionContext(), unused, unused,
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
