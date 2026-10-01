import assert from 'node:assert/strict';
import test from 'node:test';
import { ActionContext } from '@comunica/core';
import { KeysInitQuery } from '@comunica/context-entries';
import { AlgebraFactory } from '@comunica/utils-algebra';
import { BindingsFactory } from '@comunica/utils-bindings-factory';
import { MetadataValidationState } from '@comunica/utils-metadata';
import { ArrayIterator } from 'asynciterator';
import { QueryEngine as StockQueryEngine } from '@comunica/query-sparql';
import { QueryEngine, QueryEngineFactory, KEY_KGF_PAGE_SIZE, KEY_KGF_BINDINGS_SIZE, KEY_KGF_HTTP_METHOD, KEY_KGF_VOID_STATISTICS,
  KEY_VOID_STATISTICS } from 'kgf-sparql';
import { QuerySourceKgf } from '../packages/actor-query-source-identify-kgf/lib/QuerySourceKgf.js';
import { ActorRdfJoinSelectivityVoid, VOID_STATISTICS_PROVIDER } from '@kgf/actor-rdf-join-selectivity-void';
import { Bus } from '@comunica/core';
import { assignOperationSource } from '@comunica/utils-query-operation';
import { df, iri, triples, wire, server, EP, ROOT } from './helpers/mock-kgf.mjs';

const af = new AlgebraFactory(df);
const bf = new BindingsFactory(df);
const variable = value => df.variable(value);
function source(mock, settings = {}) {
  const context = new ActionContext({ [KeysInitQuery.queryTimestamp.name]: new Date(), ...settings });
  return { source: new QuerySourceKgf(EP, mock.http, df, bf), context };
}
const pattern = () => af.createPattern(variable('s'), iri('p'), variable('o'));
const metadata = stream => new Promise(resolve => stream.getProperty('metadata', resolve));
function filter(rows, names = ['s', 'o']) {
  return { filterBindings: {
    bindings: new ArrayIterator(rows.map(row => bf.bindings(Object.entries(row).map(([name, term]) => [variable(name), term])))),
    metadata: { state: new MetadataValidationState(), cardinality: { type: 'exact', value: rows.length },
      variables: names.map(name => ({ variable: variable(name), canBeUndef: true })) },
  } };
}
const bag = bindings => bindings.map(binding => JSON.stringify([...binding].map(([key, value]) => [key.value, wire(value)]).sort())).sort();
const calls = (mock, endpoint) => mock.requests.filter(call => call.url.pathname.endsWith(`/${endpoint}`));

test('planning uses /count without opening fragment pages or VoID; pages respect caps and cursors', async() => {
  const mock = server();
  const { source: kgf, context } = source(mock, { [KEY_KGF_PAGE_SIZE.name]: 10000 });
  const result = kgf.queryBindings(pattern(), context);
  const meta = await metadata(result);
  assert.deepEqual(meta.cardinality, { type: 'exact', value: 5 });
  assert.equal(meta.pageSize, 2);
  assert.deepEqual(mock.requests.map(call => call.url.pathname.split('/').at(-1)), ['', 'count']);
  assert.equal((await result.toArray()).length, 5);
  assert.equal(calls(mock, 'fragment').length, 3);
  assert.equal(calls(mock, 'schema').length, 0);
});

test('empty matches, empty bindings, and named graphs never request result pages', async() => {
  const mock = server();
  const { source: kgf, context } = source(mock);
  assert.equal((await kgf.queryBindings(af.createPattern(variable('s'), iri('missing'), variable('o')), context).toArray()).length, 0);
  assert.equal((await kgf.queryBindings(pattern(), context, filter([])).toArray()).length, 0);
  assert.equal((await kgf.queryBindings(af.createPattern(variable('s'), iri('p'), variable('o'), iri('g')), context).toArray()).length, 0);
  assert.equal(calls(mock, 'fragment').length, 0);
  assert.equal(calls(mock, 'count').length, 1);
});

test('QUERY pushes bindings and counts first; overlap and duplicates are removed across batches and pages', async() => {
  const mock = server({ caps: { max_bindings: 1 } });
  const { source: kgf, context } = source(mock);
  const result = kgf.queryBindings(pattern(), context, filter([{ s: iri('a') }, { o: iri('b') }, { s: iri('a') }]));
  const meta = await metadata(result);
  assert.equal(meta.cardinality.type, 'estimate');
  assert.equal(calls(mock, 'fragment').length, 0);
  const rows = await result.toArray();
  assert.equal(rows.length, 4);
  assert.equal(new Set(bag(rows)).size, 4);
  assert.equal(calls(mock, 'count').length, 2);
  assert.ok(calls(mock, 'count').every(call => call.method === 'QUERY'));
  assert.ok(calls(mock, 'fragment').every(call => call.method === 'QUERY'));
  assert.ok(calls(mock, 'fragment').some(call => call.body.cursor));
  const lastCount = mock.requests.findLastIndex(call => call.url.pathname.endsWith('/count'));
  const firstPage = mock.requests.findIndex(call => call.url.pathname.endsWith('/fragment'));
  assert.ok(lastCount < firstPage);
});

test('an unbound filter row matches all triples without multiplying results', async() => {
  const mock = server({ caps: { max_bindings: 1 } });
  const { source: kgf, context } = source(mock);
  assert.equal((await kgf.queryBindings(pattern(), context, filter([{ s: iri('a') }, {}])).toArray()).length, 5);
});

test('binding requests use the advertised limit unless a smaller override is set', async() => {
  const bindings = Array.from({ length: 205 }, (_, i) => ({ s: iri(`absent-${i}`) }));
  for (const { limit, override, expected } of [
    { limit: 1000, expected: [205] },
    { limit: 1000, override: 100, expected: [100, 100, 5] },
    { limit: 123, override: 1000, expected: [123, 82] },
  ]) {
    const mock = server({ caps: { max_bindings: limit } });
    const { source: kgf, context } = source(mock, override === undefined ? {} : { [KEY_KGF_BINDINGS_SIZE.name]: override });
    assert.equal((await kgf.queryBindings(pattern(), context, filter(bindings)).toArray()).length, 0);
    assert.deepEqual(calls(mock, 'count').map(call => call.body.bindings.rows.length), expected);
  }
});

test('QUERY falls back only for unsupported methods and POST can be forced', async() => {
  for (const forced of [false, true]) {
    const mock = server({ queryUnsupported: true });
    const { source: kgf, context } = source(mock, forced ? { [KEY_KGF_HTTP_METHOD.name]: 'POST' } : {});
    assert.equal((await kgf.queryBindings(pattern(), context, filter([{ s: iri('a') }])).toArray()).length, 2);
    assert.equal(mock.requests.filter(call => call.method === 'QUERY').length, forced ? 0 : 1);
    assert.ok(calls(mock, 'fragment').every(call => call.method === 'POST'));
  }
  const mock = server({ queryFailure: true });
  const { source: kgf, context } = source(mock);
  await assert.rejects(kgf.queryBindings(pattern(), context, filter([{ s: iri('a') }])).toArray(), /400/);
  assert.equal(mock.requests.filter(call => call.method === 'POST').length, 0);
});

test('concurrent QUERY requests both retry when the server only supports POST', async() => {
  const mock = server({ queryUnsupported: true });
  const { source: kgf, context } = source(mock);
  const results = await Promise.all(['a', 'b'].map(s => kgf.queryBindings(pattern(), context, filter([{ s: iri(s) }])).toArray()));
  assert.deepEqual(results.map(rows => rows.length), [2, 2]);
  assert.ok(calls(mock, 'fragment').every(call => call.method === 'POST'));
});

test('byte limits split binding requests independently of the row cap', async() => {
  const mock = server({ maxRequestBytes: 900, caps: { max_bindings: 200 } });
  const { source: kgf, context } = source(mock);
  const rows = Array.from({ length: 9 }, (_, i) => ({ s: iri(`absent-${i}-${'ü'.repeat(50)}`) }));
  assert.equal((await kgf.queryBindings(pattern(), context, filter(rows)).toArray()).length, 0);
  const batches = calls(mock, 'count').map(call => call.body);
  assert.ok(batches.length > 1);
  // Every batch is as full as the budget allows: each fits, and the next batch's first row
  // would not have. The sizes are counted as the body grows, so they must match it exactly.
  const budget = 900 - 512;
  const size = body => Buffer.byteLength(JSON.stringify({ ...body, limit: 2 }));
  for (const [ i, body ] of batches.entries()) {
    assert.ok(size(body) <= budget, `batch ${i} fits`);
    if (i + 1 < batches.length) {
      const grown = { ...body, bindings: { ...body.bindings, rows: [ ...body.bindings.rows, batches[i + 1].bindings.rows[0] ] }};
      assert.ok(size(grown) > budget, `batch ${i} could not take another row`);
    }
  }
  const bad = kgf.queryBindings(pattern(), context, filter([{ s: iri('ü'.repeat(1000)) }]));
  await assert.rejects(bad.toArray(), /max_request_bytes/);
});

test('repeated variables are filtered locally and RDF literals round-trip through GET and QUERY', async() => {
  const mock = server();
  const { source: kgf, context } = source(mock);
  const self = await kgf.queryBindings(af.createPattern(variable('x'), iri('p'), variable('x')), context).toArray();
  assert.deepEqual(self.map(binding => binding.get('x').value), ['urn:b']);
  for (const quad of triples.filter(quad => quad.predicate.equals(iri('label')))) {
    const op = af.createPattern(variable('s'), iri('label'), quad.object);
    const direct = await kgf.queryBindings(op, context).toArray();
    const restricted = await kgf.queryBindings(op, context, filter([{ s: quad.subject }])).toArray();
    assert.deepEqual(bag(direct), bag(restricted));
    assert.equal(direct.length, 1);
  }
});

test('incomplete cursor responses and count errors fail rather than returning partial answers', async() => {
  for (const options of [{ badCursor: 'missing' }, { badCursor: 'repeat' }, { countFailure: true }]) {
    const mock = server(options);
    const { source: kgf, context } = source(mock);
    await assert.rejects(kgf.queryBindings(pattern(), context).toArray(), /cursor|500/);
  }
  const mock = server({ countEstimateZero: true });
  const { source: kgf, context } = source(mock);
  const stream = kgf.queryBindings(pattern(), context);
  assert.deepEqual((await metadata(stream)).cardinality, { type: 'estimate', value: 1 });
  assert.equal((await stream.toArray()).length, 5);
});

test('destroying a planned or partially consumed stream stops page requests', async() => {
  const mock = server();
  const { source: kgf, context } = source(mock);
  const planned = kgf.queryBindings(pattern(), context);
  await metadata(planned);
  planned.destroy();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls(mock, 'fragment').length, 0);
  const running = kgf.queryBindings(pattern(), context);
  await new Promise((resolve, reject) => running.once('data', () => { running.destroy(); resolve(); }).on('error', reject));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls(mock, 'fragment').length, 1);
});

test('VoID is lazy, predicate-scoped, memoized, queryable, and optional', async() => {
  for (const options of [{}, { datasetStatsOnly: true }, { schemaFailure: true }]) {
    const mock = server(options);
    const { source: kgf, context } = source(mock);
    const stream = kgf.queryBindings(pattern(), context);
    const meta = await metadata(stream);
    assert.equal(calls(mock, 'schema').length, 0);
    const [a, b] = await Promise.all([meta[VOID_STATISTICS_PROVIDER](), meta[VOID_STATISTICS_PROVIDER]()]);
    assert.deepEqual(a, b);
    assert.equal(calls(mock, 'schema').length, options.datasetStatsOnly || options.schemaFailure ? 2 : 1);
    if (!options.schemaFailure) assert.equal(a.propertyPartitions['urn:p'].triples, 5);
    else assert.equal(a, undefined);
    stream.destroy();
  }
  const mock = server();
  const { source: kgf, context } = source(mock, { [KEY_KGF_VOID_STATISTICS.name]: false });
  const stream = kgf.queryBindings(pattern(), context);
  assert.equal((await metadata(stream))[VOID_STATISTICS_PROVIDER], undefined);
  stream.destroy();
});

test('query-specific transport preferences survive reuse of a source', async() => {
  const mock = server();
  const { source: kgf, context } = source(mock);
  await kgf.queryBindings(pattern(), context, filter([{ s: iri('a') }])).toArray();
  const nextContext = new ActionContext({ [KeysInitQuery.queryTimestamp.name]: new Date(), [KEY_KGF_HTTP_METHOD.name]: 'POST' });
  await kgf.queryBindings(pattern(), nextContext, filter([{ s: iri('a') }])).toArray();
  assert.deepEqual(calls(mock, 'fragment').map(call => call.method), ['QUERY', 'POST']);
});

test('the compiled engine identifies kgf sources and agrees with stock Comunica on SPARQL bags', async() => {
  const queries = [
    'SELECT * WHERE { ?s <urn:p> ?o }',
    'SELECT * WHERE { ?s <urn:p> ?o . ?o <urn:label> ?label }',
    'SELECT * WHERE { VALUES ?s { <urn:a> <urn:a> <urn:b> } ?s <urn:p> ?o }',
    'SELECT * WHERE { VALUES (?s ?o) { (<urn:a> UNDEF) (UNDEF <urn:b>) } ?s <urn:p> ?o }',
    'SELECT * WHERE { ?s <urn:p> ?o OPTIONAL { ?o <urn:label> ?label } }',
    'SELECT * WHERE { ?x <urn:p> ?x }',
    'SELECT (COUNT(*) AS ?count) WHERE { ?s <urn:p> ?o }',
    'SELECT * WHERE { GRAPH ?g { ?s <urn:p> ?o } }',
    'SELECT * WHERE { { ?s <urn:q> ?o } UNION { ?s <urn:p> ?o } }',
  ];
  const rdfjs = { match: (s, p, o, g) => new ArrayIterator(triples.filter(quad =>
    (!s || s.equals(quad.subject)) && (!p || p.equals(quad.predicate)) && (!o || o.equals(quad.object)) && (!g || g.equals(quad.graph)))) };
  for (const query of queries) {
    const mock = server();
    const actual = await (await new QueryEngine().queryBindings(query, { sources: [{ type: 'kgf', value: EP }], fetch: mock.fetch })).toArray();
    const expected = await (await new StockQueryEngine().queryBindings(query, { sources: [rdfjs] })).toArray();
    assert.deepEqual(bag(actual), bag(expected), query);
    assert.ok(mock.requests.every(call => !call.url.pathname.endsWith('/void')));
  }
});

test('dataset URLs pin the current version and engine context can disable automatic VoID', async() => {
  const mock = server();
  const result = await new QueryEngine().queryBindings('SELECT * WHERE { ?s <urn:p> ?o . ?o <urn:label> ?label }', {
    sources: [{ type: 'kgf', value: 'https://kgf.test/mount/graph' }], fetch: mock.fetch, [KEY_KGF_VOID_STATISTICS.name]: false,
  });
  assert.equal((await result.toArray()).length, 5);
  assert.equal(calls(mock, 'schema').length, 0);
  assert.ok(calls(mock, 'fragment').every(call => call.url.href.startsWith(EP)));
});

test('latest fragment aliases resolve through the dataset descriptor before counts or pages', async() => {
  for (const suffix of ['/latest/fragment', '/latest/fragment/']) {
    const mock = server();
    const result = await new QueryEngine().queryBindings('SELECT * WHERE { ?s <urn:p> ?o }', {
      sources: [{ type: 'kgf', value: `https://kgf.test/mount/graph${suffix}` }], fetch: mock.fetch,
    });
    assert.equal((await result.toArray()).length, 5);
    assert.equal(mock.requests[0].url.href, 'https://kgf.test/mount/graph');
    assert.equal(mock.requests[1].url.href, ROOT);
    assert.equal(mock.requests[2].url.pathname, '/mount/graph/v/1/count');
    assert.ok(calls(mock, 'fragment').every(call => call.url.href.startsWith(EP)));
    assert.ok(mock.requests.every(call => !call.url.pathname.includes('/latest/')));
  }
});

test('a reused engine respects each query fetch and settings', async() => {
  const engine = new QueryEngine();
  const query = 'SELECT * WHERE { ?s <urn:p> ?o . ?o <urn:label> ?label }';
  for (const enabled of [true, false]) {
    const mock = server();
    const result = await engine.queryBindings(query, {
      sources: [{ type: 'kgf', value: EP }], fetch: mock.fetch, [KEY_KGF_VOID_STATISTICS.name]: enabled,
    });
    assert.equal((await result.toArray()).length, 5);
    assert.ok(calls(mock, 'count').length > 0, 'the current query fetch must be used');
    if (!enabled) assert.equal(calls(mock, 'schema').length, 0);
    else assert.ok(calls(mock, 'schema').length > 0, 'the compiled engine must invoke the lazy VoID provider');
  }
});

test('runtime factory configuration, source-local settings, ASK, and CONSTRUCT work', async() => {
  const mock = server();
  const engine = await new QueryEngineFactory().create();
  const context = { sources: [{ type: 'kgf', value: EP, context: { [KEY_KGF_PAGE_SIZE.name]: 1,
    [KEY_KGF_BINDINGS_SIZE.name]: 1, [KEY_KGF_VOID_STATISTICS.name]: false } }], fetch: mock.fetch };
  assert.equal(await engine.queryBoolean('ASK { <urn:a> <urn:p> <urn:b> }', context), true);
  assert.equal(await engine.queryBoolean('ASK { <urn:a> <urn:p> <urn:missing> }', context), false);
  const output = await (await engine.queryQuads('CONSTRUCT { ?s <urn:q> ?o } WHERE { ?s <urn:p> ?o }', context)).toArray();
  assert.equal(output.length, 5);
  assert.ok(calls(mock, 'fragment').every(call => Number(call.url.searchParams.get('limit')) === 1));
});

test('the selectivity actor uses lazy statistics and explicit registries take precedence', async() => {
  const actor = new ActorRdfJoinSelectivityVoid({ name: 'void', bus: new Bus({ name: 'test' }) });
  let fetched = 0;
  const entries = [iri('p'), iri('q')].map(predicate => {
    const operation = assignOperationSource(af.createPattern(variable('s'), predicate, variable(predicate.value)), { source: { referenceValue: EP } });
    return { operation, output: { metadata: async() => ({ cardinality: { type: 'exact', value: 10 },
      [VOID_STATISTICS_PROVIDER]: async() => { fetched++; return { distinctSubjects: 5 }; } }) } };
  });
  const supplied = { entries, context: new ActionContext({ [KEY_VOID_STATISTICS.name]: { [EP]: { distinctSubjects: 10 } } }) };
  assert.ok((await actor.test(supplied)).isPassed());
  assert.equal((await actor.run(supplied)).selectivity, 0.1);
  assert.equal(fetched, 0);
  const lazy = { entries, context: new ActionContext() };
  assert.ok((await actor.test(lazy)).isPassed());
  assert.equal((await actor.run(lazy)).selectivity, 0.2);
  assert.ok(fetched > 0);
});
