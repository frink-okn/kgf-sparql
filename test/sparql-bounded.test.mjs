import assert from 'node:assert/strict';
import test from 'node:test';
import { KEY_HTTP_HOST_LIMITS, KEY_SPARQL_COUNT_CAP_HOSTS, QueryEngine } from 'kgf-sparql';
import { EP, server } from './helpers/mock-kgf.mjs';

const ENDPOINT = 'https://sparql.test/sparql';
const QUERY = 'SELECT ?s ?o ?x WHERE { ?s <urn:p> ?o . ?o <urn:sameAs> ?x }';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * A SPARQL endpoint with two `urn:sameAs` statements and no `urn:p`, behind the mock KGF
 * graph's fetch. `countFor(query, n)` answers the n-th COUNT; it may wait first.
 */
function endpoint(countFor) {
  const kgf = server();
  const requests = [];
  let counts = 0;
  const sparql = (rows, vars) => new Response(JSON.stringify({ head: { vars }, results: { bindings: rows } }), {
    headers: { 'content-type': 'application/sparql-results+json' },
  });
  const fetch = async(input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.host !== 'sparql.test') {
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
      const count = request.values ? 2 : await countFor(request, counts++);
      return sparql([{ count: { type: 'literal', value: String(count), datatype: XSD_INTEGER } }], [ 'count' ]);
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

async function run(fake, settings = {}) {
  const engine = new QueryEngine();
  const bindings = await engine.queryBindings(QUERY, {
    sources: [{ type: 'kgf', value: EP }, { type: 'sparql', value: ENDPOINT }],
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
