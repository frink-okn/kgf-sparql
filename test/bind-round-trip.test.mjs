import assert from 'node:assert/strict';
import test from 'node:test';
import { ActorRdfJoinMultiBind } from '@comunica/actor-rdf-join-inner-multi-bind';
import { ActionContext, Bus } from '@comunica/core';
import { AlgebraFactory } from '@comunica/utils-algebra';
import { MetadataValidationState } from '@comunica/utils-metadata';
import { ArrayIterator } from 'asynciterator';
import { DataFactory } from 'rdf-data-factory';
import { ActorRdfJoinOptionalBind } from '@comunica/actor-rdf-join-optional-bind';
import { ActorRdfJoinMultiBindRoundTrip, ActorRdfJoinOptionalBindRoundTrip } from '@frink-okn/actor-rdf-join-multi-bind-round-trip';
import { ActorRdfJoinMultiBindBlock, ActorRdfJoinOptionalBindBlock } from '@frink-okn/actor-rdf-join-multi-bind-block';

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
// An entry the engine computes, as a join's or an OPTIONAL's result: it reports no page size and
// no request time, and a probe into it re-runs every pattern of its operation.
function computed(operation, cardinality, names) {
  const metadata = {
    state: new MetadataValidationState(), cardinality: { type: 'estimate', value: cardinality }, variables: names.map(variable),
  };
  return { operation, output: { type: 'bindings', bindingsStream: new ArrayIterator([]), metadata: async() => metadata } };
}
const pattern = (subject, predicate) => af.createPattern(df.variable(subject), df.namedNode(`urn:${predicate}`), df.variable(predicate));
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

test('a probe into an entry the engine computes is charged a request per pattern, at the join\'s own time per pattern', async() => {
  const { stock, roundTrip } = actors();
  const group = af.createJoin([ pattern('s', 'x'), af.createLeftJoin(pattern('x', 'y'), pattern('y', 'z')) ]);
  const entries = [ entry('a', 10, { pageSize: 1_000, requestTime: 60 }), computed(group, 5_000, [ 's', 'x', 'y', 'z' ]) ];
  const before = await coefficients(stock, entries);
  const after = await coefficients(roundTrip, entries);
  assert.equal(after.iterations, before.iterations);
  assert.equal(after.requestTime, before.requestTime + 10 * 3 * 60, 'three patterns per probe, at the paged entry\'s 60 ms');
  // VALUES has no pattern to re-run.
  const values = computed(af.createValues([ df.variable('s') ], [ { s: df.namedNode('urn:v') } ]), 5_000, [ 's' ]);
  assert.deepEqual(await coefficients(roundTrip, [ entries[0], values ]), await coefficients(stock, [ entries[0], values ]));
});

test('an OPTIONAL probe into a computed group is charged its patterns, at the configured time when nothing is timed', async() => {
  // The shape that lost a query: a group of five patterns joined per row, both sides computed.
  const optionalDefaults = { bindOrder: 'depth-first', selectivityModifier: 0.000001 };
  const left = computed(af.createJoin([ pattern('study', 'title'), pattern('study', 'assay') ]), 105, [ 'study', 'title', 'assay' ]);
  let group = pattern('mission', 'study');
  for (const predicate of [ 'program', 'flight', 'start', 'end' ]) {
    group = af.createLeftJoin(group, pattern('mission', predicate));
  }
  const right = computed(group, 127, [ 'mission', 'study', 'program', 'flight', 'start', 'end' ]);
  const metadatas = await Promise.all([ left, right ].map(e => e.output.metadata()));
  const run = async actor => (await actor.getJoinCoefficients({ type: 'optional', entries: [ left, right ], context: new ActionContext() }, { metadatas })).get();
  const actor = args => new ActorRdfJoinOptionalBindRoundTrip({ name: 'round-trip', bus: new Bus({ name: 'round-trip' }), ...mediators, ...optionalDefaults, ...args });
  const stock = await run(new ActorRdfJoinOptionalBind({ name: 'stock', bus: new Bus({ name: 'stock' }), ...mediators, ...optionalDefaults }));
  assert.equal(stock.requestTime, 0, 'the stock formula prices 105 re-runs of five patterns at nothing');
  assert.equal((await run(actor({}))).requestTime, 105 * 5 * 100);
  assert.equal((await run(actor({ patternRequestTime: 40 }))).requestTime, 105 * 5 * 40);
});

test('a join the block join binds whole from the same entry is left to it', async() => {
  // The block join sends the same probes a block at a time; weighed by cost, the per-row join won
  // where Comunica 5.4 had lowered its estimate, and sent a COUNT and a SELECT per row.
  const bus = new Bus({ name: 'rdf-join' });
  const blockArgs = { bus, mediatorJoinSelectivity: mediators.mediatorJoinSelectivity,
    mediatorJoinEntriesSort: mediators.mediatorJoinEntriesSort, mediatorJoin: { mediate: async() => { throw new Error('not run'); } } };
  const block = new ActorRdfJoinMultiBindBlock({ name: 'urn:test:block', ...blockArgs });
  let from;
  block.bindsEveryEntryFrom = async() => from;
  const roundTrip = new ActorRdfJoinMultiBindRoundTrip({ name: 'round-trip', bus, ...mediators, blockJoin: 'urn:test:block' });
  const entries = [ entry('name', 296, { pageSize: 10_000, requestTime: 60 }), entry('type', 434_501, { pageSize: 10_000, requestTime: 60 }) ];
  const metadatas = await Promise.all(entries.map(e => e.output.metadata()));
  const tested = () => roundTrip.getJoinCoefficients({ type: 'inner', entries, context: new ActionContext() }, { metadatas });

  from = entries[0].operation;
  const refused = await tested();
  assert.ok(refused.isFailed());
  assert.match(refused.getFailMessage(), /leaves to urn:test:block/u);
  from = entries[1].operation;
  assert.ok((await tested()).isPassed(), 'bound from another entry, the block join sends other probes');
  from = undefined;
  assert.ok((await tested()).isPassed(), 'a join it cannot take, or binds only in part, is weighed as before');

  // The block join is found by name on this actor's own bus: another engine's is not this one's.
  from = entries[0].operation;
  const elsewhere = new ActorRdfJoinMultiBindRoundTrip({ name: 'round-trip', bus: new Bus({ name: 'other' }), ...mediators, blockJoin: 'urn:test:block' });
  assert.ok((await elsewhere.getJoinCoefficients({ type: 'inner', entries, context: new ActionContext() }, { metadatas })).isPassed());

  // An OPTIONAL is left to the OPTIONAL block join in the same way.
  const optionalDefaults = { bindOrder: 'depth-first', selectivityModifier: 0.000001 };
  const optionalBlock = new ActorRdfJoinOptionalBindBlock({ name: 'urn:test:optional-block', ...blockArgs });
  optionalBlock.bindsEveryEntryFrom = async() => from;
  const optional = new ActorRdfJoinOptionalBindRoundTrip({ name: 'optional-round-trip', bus, ...mediators, ...optionalDefaults, blockJoin: 'urn:test:optional-block' });
  const left = await optional.getJoinCoefficients({ type: 'optional', entries, context: new ActionContext() }, { metadatas });
  assert.match(left.isFailed() ? left.getFailMessage() : '', /leaves to urn:test:optional-block/u);
});
