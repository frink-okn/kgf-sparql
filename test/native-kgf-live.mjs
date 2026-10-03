// Opt-in public-server smoke test. It reads a small, finite set of entities.
// KGF_ROOT=https://apps.okn.us/kgf/ npm run test:live
import assert from 'node:assert/strict';
import { ActionContext } from '@comunica/core';
import { AlgebraFactory } from '@comunica/utils-algebra';
import { BindingsFactory } from '@comunica/utils-bindings-factory';
import { MetadataValidationState } from '@comunica/utils-metadata';
import { ArrayIterator } from 'asynciterator';
import { DataFactory } from 'rdf-data-factory';
import { termToString } from 'rdf-string-ttl';
import { QueryEngine as StockQueryEngine } from '@comunica/query-sparql';
import { QueryEngine, KEY_KGF_PAGE_SIZE, KEY_KGF_VOID_STATISTICS } from '@frink-okn/kgf-sparql';
import { QuerySourceKgf } from '../packages/actor-query-source-identify-kgf/lib/QuerySourceKgf.js';
import { VOID_STATISTICS_PROVIDER } from '@frink-okn/actor-rdf-join-selectivity-void';

const root = new URL(process.env.KGF_ROOT ?? 'https://apps.okn.us/kgf/');
const fetchBounded = (url, init = {}) => fetch(url, {
  ...init, signal: AbortSignal.any([AbortSignal.timeout(30000), ...(init.signal ? [init.signal] : [])]),
});
const get = async url => {
  const response = await fetchBounded(url);
  assert.equal(response.status, 200);
  return response.json();
};
const index = await get(root);
const dataset = index.datasets.find(entry => entry.id === (process.env.KGF_DATASET ?? 'biobricks-tox21'));
assert.ok(dataset, 'test dataset must exist');
const endpoint = new URL(dataset.links.fragment, root).href;
const brtpfEndpoint = new URL(dataset.links.tpf, root).href;
const label = 'http://www.w3.org/2000/01/rdf-schema#label';
const seedUrl = new URL(endpoint);
seedUrl.searchParams.set('p', `<${label}>`);
seedUrl.searchParams.set('limit', '4');
const seeds = [...new Set((await get(seedUrl)).rows.map(row => row.s.value))].slice(0, 2);
assert.equal(seeds.length, 2);
const query = `SELECT ?s ?label ?type WHERE {
  VALUES ?s { ${[...seeds, seeds[0]].map(iri => `<${iri}>`).join(' ')} }
  ?s <${label}> ?label ; a ?type .
}`;
const bag = rows => rows.map(row => JSON.stringify([...row].map(([k, v]) => [k.value, termToString(v)]).sort())).sort();
const expected = await (await new StockQueryEngine().queryBindings(query, {
  sources: [{ type: 'brtpf', value: brtpfEndpoint }], fetch: fetchBounded,
})).toArray();
const summaries = [];
for (const automaticStats of [false, true]) {
  const requests = [];
  const traced = async(url, init = {}) => {
    const response = await fetchBounded(url, init);
    requests.push({ url: String(url), method: init.method ?? 'GET', status: response.status });
    return response;
  };
  const actual = await (await new QueryEngine().queryBindings(query, {
    sources: [{ type: 'kgf', value: endpoint }], fetch: traced,
    [KEY_KGF_PAGE_SIZE.name]: 1000, [KEY_KGF_VOID_STATISTICS.name]: automaticStats,
  })).toArray();
  assert.deepEqual(bag(actual), bag(expected));
  assert.ok(requests.some(request => new URL(request.url).pathname.endsWith('/count')));
  assert.ok(requests.every(request => !new URL(request.url).pathname.endsWith('/void')));
  if (!automaticStats) assert.ok(requests.every(request => !new URL(request.url).pathname.endsWith('/schema')));
  summaries.push({ automaticStats, rows: actual.length, requests });
}

// Exercise filterBindings directly as well, independently of the optimizer's choice of join.
const df = new DataFactory();
const bf = new BindingsFactory(df);
const requests = [];
const source = new QuerySourceKgf(endpoint, { mediate: async({ input, init }) => {
  requests.push({ url: input, method: init.method, body: init.body && JSON.parse(init.body) });
  return fetchBounded(input, init);
} }, df, bf);
const operation = new AlgebraFactory(df).createPattern(df.variable('s'), df.namedNode(label), df.variable('label'));
const path = request => new URL(request.url).pathname;

// A pattern is counted before any page is read, and its metadata carries the lazy VoID provider.
const scan = source.queryBindings(operation, new ActionContext({ [KEY_KGF_PAGE_SIZE.name]: 1 }));
const scanned = await new Promise(resolve => scan.getProperty('metadata', resolve));
scan.destroy();
assert.ok(requests.some(request => path(request).endsWith('/count')));
assert.ok(requests.every(request => !path(request).endsWith('/fragment')));
const statistics = await scanned[VOID_STATISTICS_PROVIDER]();
assert.ok(statistics?.propertyPartitions?.[label]?.distinctSubjects > 0);
assert.ok(requests.filter(request => path(request).endsWith('/schema'))
  .every(request => new URL(request.url).searchParams.get('view') === 'queryable' && !new URL(request.url).searchParams.has('children')));

// A call with bindings is a bind join's probe: it is not counted, reports an unknown
// cardinality, and reads its pages over QUERY, following the cursor.
requests.length = 0;
const rows = source.queryBindings(operation, new ActionContext({ [KEY_KGF_PAGE_SIZE.name]: 1 }), {
  filterBindings: {
    bindings: new ArrayIterator([...seeds, seeds[0]].map(iri => bf.bindings([[df.variable('s'), df.namedNode(iri)]]))),
    metadata: {
      cardinality: { type: 'exact', value: 3 }, state: new MetadataValidationState(),
      variables: [{ variable: df.variable('s'), canBeUndef: false }],
    },
  },
});
const metadata = await new Promise(resolve => rows.getProperty('metadata', resolve));
assert.equal(metadata.cardinality.value, Number.POSITIVE_INFINITY);
assert.ok(requests.every(request => !path(request).endsWith('/fragment')));
const bound = await rows.toArray();
assert.ok(bound.length >= 2);
assert.equal(new Set(bag(bound)).size, bound.length);
assert.ok(requests.every(request => !path(request).endsWith('/count')), 'a probe is not counted');
assert.ok(requests.some(request => request.method === 'QUERY' && path(request).endsWith('/fragment')));
assert.ok(requests.some(request => request.method === 'QUERY' && request.body?.cursor));
const expectedLabels = await (await new StockQueryEngine().queryBindings(
  `SELECT ?s ?label WHERE { VALUES ?s { ${seeds.map(iri => `<${iri}>`).join(' ')} } ?s <${label}> ?label }`,
  { sources: [{ type: 'brtpf', value: brtpfEndpoint }], fetch: fetchBounded },
)).toArray();
assert.deepEqual(bag(bound), bag(expectedLabels));
console.log(JSON.stringify({ endpoint, comparison: summaries, statistics, bindings: { rows: bound.length, requests } }, null, 2));
