import assert from 'node:assert/strict';
import test from 'node:test';
import { ActionContext, Bus, failTest, passTest } from '@comunica/core';
import { AlgebraFactory } from '@comunica/utils-algebra';
import { assignOperationSource } from '@comunica/utils-query-operation';
import { DataFactory } from 'rdf-data-factory';
import { ActorRdfJoinSelectivityBound, KEY_SELECTIVITY_BOUND_DELEGATING } from '@frink-okn/actor-rdf-join-selectivity-bound';

const df = new DataFactory();
const af = new AlgebraFactory(df);
const v = name => df.variable(name);
const n = name => df.namedNode(`urn:${name}`);

// The delegate answers what the shape-only heuristic answered for the abdomen cells: 0.2785.
// `delegated` may instead be a function answering the TestResult the bus would.
function actor(delegated = 0.2785) {
  const asked = [];
  const mediatorJoinSelectivity = {
    mediateTestable: async action => {
      asked.push(action.context.get(KEY_SELECTIVITY_BOUND_DELEGATING));
      return typeof delegated === 'function' ? delegated() : passTest({ selectivity: delegated });
    },
  };
  return { asked, actor: new ActorRdfJoinSelectivityBound({ name: 'bound', bus: new Bus({ name: 'test' }), mediatorJoinSelectivity }) };
}
/** A join entry. A union's branches carry their own sources; any other operation is given one. */
function entry(operation, cardinality, names, undef = [], type = 'exact', { modified = false } = {}) {
  const metadata = {
    cardinality: { type, value: cardinality },
    variables: names.map(name => ({ variable: v(name), canBeUndef: undef.includes(name) })),
  };
  return {
    operation: operation.type === 'union' || operation.type === 'join' ? operation : sourced(operation),
    operationModified: modified,
    output: { metadata: async() => metadata },
  };
}
const SOURCE = { source: { toString: () => 'source' } };
const sourced = operation => assignOperationSource(operation, SOURCE);
const pattern = (s, p, o) => af.createPattern(s, p, o);

test('a pattern whose only variable is the join variable caps the join at the other side', async() => {
  const { actor: bound, asked } = actor();
  const entries = [
    entry(pattern(v('cell'), n('subClassOf'), n('cell')), 31_721, [ 'cell' ]),
    entry(pattern(v('cell'), n('part_of'), n('abdomen')), 838, [ 'cell' ]),
  ];
  const action = { entries, context: new ActionContext() };
  assert.ok((await bound.test(action)).isPassed());
  const { selectivity } = await bound.run(action);
  assert.equal(31_721 * 838 * selectivity, 838);
  assert.deepEqual(asked, [ true ], 'the estimate it bounds comes from the bus with this actor excluded');
});

test('a smaller delegated estimate stands', async() => {
  const { actor: bound } = actor(1e-9);
  const entries = [
    entry(pattern(v('cell'), n('subClassOf'), n('cell')), 31_721, [ 'cell' ]),
    entry(pattern(v('cell'), n('part_of'), n('abdomen')), 838, [ 'cell' ]),
  ];
  assert.equal((await bound.run({ entries, context: new ActionContext() })).selectivity, 1e-9);
});

test('entries that each bring a variable of their own are not bounded', async() => {
  const entries = [
    entry(pattern(v('a'), n('p'), v('b')), 1_000, [ 'a', 'b' ]),
    entry(pattern(v('b'), n('q'), v('c')), 2_000, [ 'b', 'c' ]),
  ];
  assert.equal(ActorRdfJoinSelectivityBound.upperBound(entries, await Promise.all(entries.map(e => e.output.metadata()))),
    Number.POSITIVE_INFINITY);
  const { actor: bound } = actor(0.25);
  assert.equal((await bound.run({ entries, context: new ActionContext() })).selectivity, 0.25);
});

test('a filter among several entries removes only itself, largest filter first', async() => {
  const entries = [
    entry(pattern(v('a'), n('p'), v('b')), 50, [ 'a', 'b' ]),
    entry(pattern(v('b'), n('q'), v('c')), 70, [ 'b', 'c' ]),
    entry(pattern(v('a'), n('type'), n('C')), 10_000, [ 'a' ]),
    entry(pattern(v('c'), n('type'), n('D')), 9_000, [ 'c' ]),
  ];
  const metadatas = await Promise.all(entries.map(e => e.output.metadata()));
  assert.equal(ActorRdfJoinSelectivityBound.upperBound(entries, metadatas), 50 * 70);
});

test('when two filters cover only each other, one of them stays', async() => {
  const entries = [
    entry(pattern(v('x'), n('p'), n('o')), 300, [ 'x' ]),
    entry(pattern(v('x'), n('q'), n('o')), 20, [ 'x' ]),
  ];
  const metadatas = await Promise.all(entries.map(e => e.output.metadata()));
  assert.equal(ActorRdfJoinSelectivityBound.upperBound(entries, metadatas), 20);
});

test('a union of two sources counts each solution up to twice; unknown operators never filter', async() => {
  const union = af.createUnion([ pattern(v('x'), n('label'), n('o')), pattern(v('x'), n('label'), n('o')) ].map(sourced));
  const entries = [ entry(union, 500, [ 'x' ]), entry(pattern(v('x'), n('p'), v('y')), 40, [ 'x', 'y' ]) ];
  const metadatas = await Promise.all(entries.map(e => e.output.metadata()));
  assert.equal(ActorRdfJoinSelectivityBound.upperBound(entries, metadatas), 80);

  const values = af.createValues([ v('x') ], [{ x: n('a') }, { x: n('a') }]);
  const opaque = [ entry(values, 500, [ 'x' ]), entry(pattern(v('x'), n('p'), v('y')), 40, [ 'x', 'y' ]) ];
  assert.equal(ActorRdfJoinSelectivityBound.upperBound(opaque, await Promise.all(opaque.map(e => e.output.metadata()))),
    Number.POSITIVE_INFINITY);
});

test('unknown sizes and optional variables leave the delegate alone', async() => {
  const { actor: bound } = actor(0.3);
  const infinite = [
    entry(pattern(v('cell'), n('label'), v('l')), Number.POSITIVE_INFINITY, [ 'cell', 'l' ]),
    entry(pattern(v('cell'), n('part_of'), n('abdomen')), 838, [ 'cell' ]),
  ];
  assert.equal((await bound.run({ entries: infinite, context: new ActionContext() })).selectivity, 0.3);
  const optional = [
    entry(pattern(v('cell'), n('subClassOf'), n('cell')), 31_721, [ 'cell' ]),
    entry(pattern(v('cell'), n('part_of'), n('abdomen')), 838, [ 'cell' ], [ 'cell' ]),
  ];
  assert.equal((await bound.run({ entries: optional, context: new ActionContext() })).selectivity, 0.3);
});

test('the actor steps aside while it is delegating, and with a single entry', async() => {
  const { actor: bound } = actor();
  const two = [ entry(pattern(v('x'), n('p'), n('o')), 3, [ 'x' ]), entry(pattern(v('x'), n('q'), n('o')), 4, [ 'x' ]) ];
  const delegating = new ActionContext({ [KEY_SELECTIVITY_BOUND_DELEGATING.name]: true });
  assert.ok((await bound.test({ entries: two, context: delegating })).isFailed());
  assert.ok((await bound.test({ entries: two.slice(0, 1), context: new ActionContext() })).isFailed());
});

test('a size that is only estimated never bounds the join, but such an entry can still be removed', async() => {
  // Two patterns on ?x whose COUNTs reached the cap at 1,000,001: the humans and their labels
  // join to tens of millions, and the capped label count is not an upper bound on that.
  const humans = entry(pattern(v('x'), n('P31'), n('Q5')), 1_000_001, [ 'x' ], [], 'estimate');
  const labels = entry(pattern(v('x'), n('label'), v('l')), 1_000_001, [ 'x', 'l' ], [], 'estimate');
  const capped = [ humans, labels ];
  assert.equal(ActorRdfJoinSelectivityBound.upperBound(capped, await Promise.all(capped.map(e => e.output.metadata()))),
    Number.POSITIVE_INFINITY);
  const { actor: bound } = actor(0.5);
  assert.equal((await bound.run({ entries: capped, context: new ActionContext() })).selectivity, 0.5);
  // Each covers the other: the estimated one is removed though it is the smaller, and the exact one bounds the join.
  const mixed = [
    entry(pattern(v('x'), n('P31'), n('Q5')), 300, [ 'x' ], [], 'estimate'),
    entry(pattern(v('x'), n('part_of'), n('abdomen')), 500, [ 'x' ]),
  ];
  assert.equal(ActorRdfJoinSelectivityBound.upperBound(mixed, await Promise.all(mixed.map(e => e.output.metadata()))), 500);
});

test('a size a join computed is an estimate, however its inputs were counted', async() => {
  // A join of two counted entries is labeled exact by Comunica, though its 50 rows are an
  // estimate (40,000 in truth): bounding by it would cap the join at 50.
  const join = af.createJoin([ pattern(v('x'), n('p'), v('z')), pattern(v('z'), n('q'), n('o')) ].map(sourced));
  const types = entry(pattern(v('x'), n('type'), n('Gene')), 2_000_000, [ 'x' ]);
  for (const computed of [
    entry(join, 50, [ 'x', 'z' ], [], 'exact', { modified: true }),
    entry(join, 50, [ 'x', 'z' ]),
  ]) {
    const entries = [ computed, types ];
    assert.equal(ActorRdfJoinSelectivityBound.upperBound(entries, await Promise.all(entries.map(e => e.output.metadata()))),
      Number.POSITIVE_INFINITY);
  }
  // The same join answered whole by one source was counted by it.
  const pushed = [ entry(join, 50, [ 'x', 'z' ]), types ];
  pushed[0].operation = sourced(join);
  assert.equal(ActorRdfJoinSelectivityBound.upperBound(pushed, await Promise.all(pushed.map(e => e.output.metadata()))), 50);
});

test('without another estimate the product stands, and a delegate that fails fails the estimate', async() => {
  const entries = [
    entry(pattern(v('cell'), n('subClassOf'), n('cell')), 31_721, [ 'cell' ]),
    entry(pattern(v('cell'), n('part_of'), n('abdomen')), 838, [ 'cell' ]),
  ];
  const { actor: alone } = actor(() => failTest('no actor answers'));
  assert.equal((await alone.run({ entries, context: new ActionContext() })).selectivity, 1 / 31_721);
  const { actor: failing } = actor(() => {
    throw new Error('malformed statistics');
  });
  await assert.rejects(failing.run({ entries, context: new ActionContext() }), /malformed statistics/u);
});
