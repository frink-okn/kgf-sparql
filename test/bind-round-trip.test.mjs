import assert from 'node:assert/strict';
import test from 'node:test';
import { ActorRdfJoinMultiBind } from '@comunica/actor-rdf-join-inner-multi-bind';
import { ActionContext, Bus } from '@comunica/core';
import { AlgebraFactory } from '@comunica/utils-algebra';
import { MetadataValidationState } from '@comunica/utils-metadata';
import { ArrayIterator } from 'asynciterator';
import { DataFactory } from 'rdf-data-factory';
import { ActorRdfJoinOptionalBind } from '@comunica/actor-rdf-join-optional-bind';
import { ActorRdfJoinMultiBindRoundTrip, ActorRdfJoinOptionalBindRoundTrip } from '@kgf/actor-rdf-join-inner-multi-bind-round-trip';

const df = new DataFactory();
const af = new AlgebraFactory(df);
const variable = name => ({ variable: df.variable(name), canBeUndef: false });
// Comunica supplies these defaults from its component config, not from the constructor.
const defaults = { bindOrder: 'depth-first', selectivityModifier: 0.0001, minMaxCardinalityRatio: 60 };
const mediators = {
  ...defaults,
  mediatorJoinSelectivity: { mediate: async() => ({ selectivity: 1 }) },
  mediatorJoinEntriesSort: { mediate: async({ entries }) => ({ entries }) },
  mediatorQueryOperation: { mediate: async() => { throw new Error('not run'); } },
  mediatorMergeBindingsContext: { mediate: async() => ({ mergeHandlers: {} }) },
};
const actors = () => ({
  stock: new ActorRdfJoinMultiBind({ name: 'stock', bus: new Bus({ name: 'stock' }), ...mediators }),
  roundTrip: new ActorRdfJoinMultiBindRoundTrip({ name: 'round-trip', bus: new Bus({ name: 'round-trip' }), ...mediators }),
});
// Entries as the planner sees them: the smallest is bound into the rest; each carries its source's request metadata.
function entry(predicate, cardinality, transport) {
  const metadata = {
    state: new MetadataValidationState(), cardinality: { type: 'exact', value: cardinality },
    variables: [ variable('s'), variable(predicate) ], ...transport,
  };
  return {
    operation: af.createPattern(df.variable('s'), df.namedNode(`urn:${predicate}`), df.variable(predicate)),
    output: { type: 'bindings', bindingsStream: new ArrayIterator([]), metadata: async() => metadata },
  };
}
async function coefficients(actor, entries) {
  const metadatas = await Promise.all(entries.map(e => e.output.metadata()));
  const result = await actor.getJoinCoefficients({ type: 'inner', entries, context: new ActionContext() }, { metadatas });
  assert.ok(result.isPassed(), result.isFailed() ? result.getFailMessage() : '');
  return result.get();
}

test('a bound probe against a paged source is charged one request; nothing else changes', async() => {
  const { stock, roundTrip } = actors();
  const entries = [
    entry('name', 296, { pageSize: 10_000, requestTime: 60 }),
    entry('type', 434_501, { pageSize: 10_000, requestTime: 60 }),
    entry('comid', 507_486, { pageSize: 10_000, requestTime: 60 }),
  ];
  const before = await coefficients(stock, entries);
  const after = await coefficients(roundTrip, entries);
  assert.equal(after.iterations, before.iterations);
  assert.equal(after.persistedItems, before.persistedItems);
  assert.equal(after.blockingItems, before.blockingItems);
  assert.ok(before.requestTime < 10 * 60, `the stock formula prices 592 probes at ${before.requestTime} ms, under ten requests' worth`);
  assert.equal(after.requestTime, before.requestTime + 296 * (60 + 60), 'one request per probe per remaining paged entry');
});

test('a non-paged source is not charged twice, and an unpriced source not at all', async() => {
  const { stock, roundTrip } = actors();
  const endpoint = [ entry('a', 10, { requestTime: 40 }), entry('b', 1_000, { requestTime: 200 }) ];
  assert.deepEqual(await coefficients(roundTrip, endpoint), await coefficients(stock, endpoint));
  const silent = [ entry('a', 10, { pageSize: 100 }), entry('b', 1_000, { pageSize: 100 }) ];
  assert.deepEqual(await coefficients(roundTrip, silent), await coefficients(stock, silent));
});

test('the stock refusals still apply', async() => {
  const { roundTrip } = actors();
  const entries = [ entry('a', 1_000, { pageSize: 100, requestTime: 10 }), entry('b', 1_200, { pageSize: 100, requestTime: 10 }) ];
  const metadatas = await Promise.all(entries.map(e => e.output.metadata()));
  const result = await roundTrip.getJoinCoefficients({ type: 'inner', entries, context: new ActionContext() }, { metadatas });
  assert.ok(result.isFailed());
  assert.match(result.getFailMessage(), /smallest stream is much smaller/u);
});

test('an OPTIONAL probe against a paged source is charged one request too', async() => {
  const optionalDefaults = { bindOrder: 'depth-first', selectivityModifier: 0.000001 };
  const stock = new ActorRdfJoinOptionalBind({ name: 'stock', bus: new Bus({ name: 'stock' }), ...mediators, ...optionalDefaults });
  const roundTrip = new ActorRdfJoinOptionalBindRoundTrip({ name: 'round-trip', bus: new Bus({ name: 'round-trip' }), ...mediators, ...optionalDefaults });
  const entries = [ entry('provider', 7_053, { pageSize: 10_000, requestTime: 60 }), entry('telephone', 9_000, { pageSize: 10_000, requestTime: 60 }) ];
  const metadatas = await Promise.all(entries.map(e => e.output.metadata()));
  const run = async actor => (await actor.getJoinCoefficients({ type: 'optional', entries, context: new ActionContext() }, { metadatas })).get();
  const before = await run(stock);
  const after = await run(roundTrip);
  assert.equal(after.iterations, before.iterations);
  assert.ok(before.requestTime < 10 * 60, `the stock formula prices 7,053 probes at ${before.requestTime} ms`);
  assert.equal(after.requestTime, before.requestTime + 7_053 * 60);
  const endpoint = [ entry('a', 10, { requestTime: 40 }), entry('b', 1_000, { requestTime: 200 }) ];
  const endpointMetadatas = await Promise.all(endpoint.map(e => e.output.metadata()));
  const runEndpoint = async actor => (await actor.getJoinCoefficients({ type: 'optional', entries: endpoint, context: new ActionContext() }, { metadatas: endpointMetadatas })).get();
  assert.deepEqual(await runEndpoint(roundTrip), await runEndpoint(stock));
});
