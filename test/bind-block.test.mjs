import assert from 'node:assert/strict';
import test from 'node:test';
import { ActionContext, Bus } from '@comunica/core';
import { KeysInitQuery, KeysRdfJoin } from '@comunica/context-entries';
import { AlgebraFactory } from '@comunica/utils-algebra';
import { BindingsFactory } from '@comunica/utils-bindings-factory';
import { MetadataValidationState } from '@comunica/utils-metadata';
import { assignOperationSource } from '@comunica/utils-query-operation';
import { ArrayIterator, BufferedIterator, wrap } from 'asynciterator';
import { DataFactory } from 'rdf-data-factory';
import { ActorRdfJoinMultiBindBlock } from '@kgf/actor-rdf-join-inner-multi-bind-block';

const df = new DataFactory();
const af = new AlgebraFactory(df);
const bf = new BindingsFactory(df);
const v = name => df.variable(name);
const n = name => df.namedNode(`urn:${name}`);
const context = () => new ActionContext({ [KeysInitQuery.dataFactory.name]: df });

/**
 * An in-memory source that answers triple patterns, and either kind of bound request:
 * `joinBindings` (as a SPARQL endpoint does with VALUES) or `filterBindings` (as KGF does).
 */
function source(name, triples, mode) {
  const calls = [];
  const shape = mode === 'joinBindings' ?
      { type: 'operation', operation: { operationType: 'wildcard' }, joinBindings: true } :
      { type: 'operation', operation: { operationType: 'pattern', pattern: af.createPattern(v('s'), v('p'), v('o')) },
        variablesOptional: [ v('s'), v('p'), v('o') ], filterBindings: true };
  const match = pattern => triples.flatMap(([ s, p, o ]) => {
    const entries = [];
    for (const [ term, value ] of [[ pattern.subject, s ], [ pattern.predicate, p ], [ pattern.object, o ]]) {
      if (term.termType === 'Variable') {
        entries.push([ term, value ]);
      } else if (!term.equals(value)) {
        return [];
      }
    }
    return [ bf.bindings(entries) ];
  });
  return {
    calls,
    wrapper: { source: {
      referenceValue: `urn:source:${name}`,
      getSelectorShape: async() => shape,
      queryBindings(operation, _context, options) {
        return wrap((async() => {
          const rows = match(operation);
          const bound = options?.[mode];
          // Lazy, as real sources are: an eager empty iterator ends before wrap() listens.
          const lazy = items => new ArrayIterator(items, { autoStart: false });
          if (!bound) {
            return lazy(rows);
          }
          const bindings = await bound.bindings.toArray();
          calls.push({ bindings, variables: bound.metadata.variables.map(variable => variable.variable.value) });
          if (mode === 'joinBindings') {
            return lazy(bindings.flatMap(binding => rows.map(row => row.merge(binding)).filter(Boolean)));
          }
          return lazy(rows.filter(row => bindings.some(binding => row.merge(binding))));
        })());
      },
      toString: () => name,
    } },
  };
}
function on(src, s, p, o) {
  return assignOperationSource(af.createPattern(s, p, o), src.wrapper);
}
function entry(operation, cardinality, names, extra = {}, rows = []) {
  const metadata = {
    state: new MetadataValidationState(),
    cardinality: { type: 'exact', value: cardinality },
    variables: names.map(name => ({ variable: v(name), canBeUndef: false })),
    ...extra,
  };
  return {
    operation,
    output: { type: 'bindings', bindingsStream: new ArrayIterator(rows, { autoStart: false }), metadata: async() => metadata },
  };
}
function actor(blockSize = 2, mediatorJoin = { mediate: async() => { throw new Error('nothing remains to join'); } }, options = {}) {
  return new ActorRdfJoinMultiBindBlock({
    name: 'bind-block',
    bus: new Bus({ name: 'test' }),
    blockSize,
    ...options,
    selectivityModifier: 0.0001,
    mediatorJoinSelectivity: { mediate: async() => ({ selectivity: 0.001 }) },
    mediatorJoinEntriesSort: { mediate: async({ entries }) => ({
      entries: [ ...entries ].sort((left, right) => left.metadata.cardinality.value - right.metadata.cardinality.value),
    }) },
    mediatorJoin,
  });
}
async function run(joinActor, entries, ctx = context()) {
  const action = { type: 'inner', entries, context: ctx };
  const tested = await joinActor.test(action);
  assert.ok(tested.isPassed(), tested.isFailed() ? tested.getFailMessage() : '');
  const output = await joinActor.run(action, tested.getSideData());
  return { coefficients: tested.get(), rows: await output.bindingsStream.toArray() };
}
const row = (...pairs) => bf.bindings(pairs.map(([ name, value ]) => [ v(name), n(value) ]));
const key = binding => JSON.stringify([ ...binding ].map(([ variable, term ]) => [ variable.value, term.value ]).sort());
const sorted = rows => rows.map(key).sort();

test('the smallest entry is sent to a VALUES endpoint in blocks, projected onto the shared variable', async() => {
  const ubergraph = source('ubergraph', [], 'filterBindings');
  const wikidata = source('wikidata', [
    [ n('w1'), n('P7963'), n('c1') ], [ n('w2'), n('P7963'), n('c2') ], [ n('w9'), n('P7963'), n('c9') ],
  ], 'joinBindings');
  const cells = [ row([ 'cell', 'c1' ]), row([ 'cell', 'c2' ]), row([ 'cell', 'c3' ]) ];
  const { rows } = await run(actor(2), [
    entry(on(ubergraph, v('cell'), n('part_of'), n('abdomen')), 3, [ 'cell' ], {}, cells),
    entry(on(wikidata, v('w'), n('P7963'), v('cell')), 300_000, [ 'w', 'cell' ]),
  ]);
  assert.deepEqual(sorted(rows), sorted([ row([ 'cell', 'c1' ], [ 'w', 'w1' ]), row([ 'cell', 'c2' ], [ 'w', 'w2' ]) ]));
  assert.equal(wikidata.calls.length, 2, 'three rows in blocks of two');
  assert.deepEqual(wikidata.calls.map(call => call.variables), [[ 'cell' ], [ 'cell' ]]);
  assert.deepEqual(wikidata.calls.map(call => call.bindings.length), [ 2, 1 ]);
});

test('a union across sources gets every block in each branch, and keeps the duplicates a union makes', async() => {
  const ubergraph = source('ubergraph', [[ n('c1'), n('label'), n('neuron') ], [ n('c2'), n('label'), n('glia') ]], 'filterBindings');
  const wikidata = source('wikidata', [[ n('c1'), n('label'), n('neuron') ], [ n('a1'), n('label'), n('title') ]], 'joinBindings');
  const union = af.createUnion([ on(ubergraph, v('cell'), n('label'), v('l')), on(wikidata, v('cell'), n('label'), v('l')) ]);
  const cells = [ row([ 'cell', 'c1' ]), row([ 'cell', 'c2' ]) ];
  const { rows } = await run(actor(256), [
    entry(on(ubergraph, v('cell'), n('part_of'), n('abdomen')), 2, [ 'cell' ], {}, cells),
    entry(union, Number.POSITIVE_INFINITY, [ 'cell', 'l' ]),
  ]);
  assert.deepEqual(sorted(rows), sorted([
    row([ 'cell', 'c1' ], [ 'l', 'neuron' ]), row([ 'cell', 'c1' ], [ 'l', 'neuron' ]), row([ 'cell', 'c2' ], [ 'l', 'glia' ]),
  ]));
  assert.equal(ubergraph.calls.length, 1);
  assert.equal(wikidata.calls.length, 1);
});

test('a join no source took is probed input by input and joined to the block, never input to input', async() => {
  const ubergraph = source('ubergraph', [[ n('c1'), n('label'), n('neuron') ], [ n('c2'), n('label'), n('glia') ]], 'filterBindings');
  const wikidata = source('wikidata', [[ n('a1'), n('label'), n('t1') ], [ n('a2'), n('label'), n('t2') ], [ n('a3'), n('label'), n('t3') ]],
    'joinBindings');
  const titles = af.createUnion([ on(ubergraph, v('article'), n('label'), v('title')), on(wikidata, v('article'), n('label'), v('title')) ]);
  const labels = af.createUnion([ on(ubergraph, v('cell'), n('label'), v('l')), on(wikidata, v('cell'), n('label'), v('l')) ]);
  const pairs = [ row([ 'cell', 'c1' ], [ 'article', 'a1' ]), row([ 'cell', 'c2' ], [ 'article', 'a2' ]) ];
  const { rows } = await run(actor(256), [
    entry(af.createJoin([ on(wikidata, v('w'), n('P921'), v('article')) ]), 2, [ 'cell', 'article' ], {}, pairs),
    entry(af.createJoin([ titles, labels ]), Number.POSITIVE_INFINITY, [ 'article', 'title', 'cell', 'l' ]),
  ]);
  assert.deepEqual(sorted(rows), sorted([
    row([ 'cell', 'c1' ], [ 'article', 'a1' ], [ 'title', 't1' ], [ 'l', 'neuron' ]),
    row([ 'cell', 'c2' ], [ 'article', 'a2' ], [ 'title', 't2' ], [ 'l', 'glia' ]),
  ]));
  const sent = [ ...ubergraph.calls, ...wikidata.calls ].map(call => call.variables.join());
  assert.deepEqual(sent.sort(), [ 'article', 'article', 'cell', 'cell' ], 'each input carries only its own shared variable');
});

test('a join no source took is probed in an order where each input shares a variable with those before it', async() => {
  // Titles share ?article only with P921, which binds it from the block's ?wikicell: checked
  // against the block's variables alone, the join could not be probed, and the per-row bind
  // join that took it sent a COUNT per row to every source of every pattern.
  const ubergraph = source('ubergraph', [[ n('c1'), n('label'), n('neuron') ], [ n('c2'), n('label'), n('glia') ]], 'filterBindings');
  const wikidata = source('wikidata', [
    [ n('a1'), n('P921'), n('w1') ], [ n('a2'), n('P921'), n('w2') ], [ n('a9'), n('P921'), n('w9') ],
    [ n('a1'), n('label'), n('t1') ], [ n('a2'), n('label'), n('t2') ], [ n('a9'), n('label'), n('t9') ],
  ], 'joinBindings');
  const titles = af.createUnion([ on(ubergraph, v('article'), n('label'), v('title')), on(wikidata, v('article'), n('label'), v('title')) ]);
  const subjects = af.createUnion([ on(wikidata, v('article'), n('P921'), v('wikicell')) ]);
  const labels = af.createUnion([ on(ubergraph, v('cell'), n('label'), v('l')), on(wikidata, v('cell'), n('label'), v('l')) ]);
  const cells = [ row([ 'cell', 'c1' ], [ 'wikicell', 'w1' ]), row([ 'cell', 'c2' ], [ 'wikicell', 'w2' ]) ];
  const { rows } = await run(actor(256), [
    entry(on(wikidata, v('wikicell'), n('P7963'), v('cell')), 2, [ 'cell', 'wikicell' ], {}, cells),
    entry(af.createJoin([ titles, subjects, labels ]), Number.POSITIVE_INFINITY, [ 'article', 'title', 'wikicell', 'cell', 'l' ]),
  ]);
  assert.deepEqual(sorted(rows), sorted([
    row([ 'cell', 'c1' ], [ 'wikicell', 'w1' ], [ 'article', 'a1' ], [ 'title', 't1' ], [ 'l', 'neuron' ]),
    row([ 'cell', 'c2' ], [ 'wikicell', 'w2' ], [ 'article', 'a2' ], [ 'title', 't2' ], [ 'l', 'glia' ]),
  ]));
  const sent = [ ...ubergraph.calls, ...wikidata.calls ].map(call => call.variables.join());
  assert.deepEqual(sent.sort(), [ 'article', 'article', 'cell', 'cell', 'wikicell' ]);
});

test('a block join that is never read reads nothing, however readable its entry says it is', async() => {
  // A lazy iterator says it is readable as soon as it exists. A join built inside an entry that
  // another join only probes is never read, and reading its first entry anyway sent a scan of
  // every wdt:P921 statement to two of Wikidata's query services.
  let reads = 0;
  const first = new BufferedIterator({ autoStart: false });
  first._read = (count, done) => {
    reads++;
    first.close();
    done();
  };
  const wikidata = source('wikidata', [], 'joinBindings');
  const bound = entry(on(wikidata, v('cell'), n('part_of'), n('abdomen')), 3, [ 'cell' ]);
  bound.output.bindingsStream = first;
  const action = { type: 'inner', entries: [ bound, entry(on(wikidata, v('w'), n('P7963'), v('cell')), 300, [ 'w', 'cell' ]) ], context: context() };
  const tested = await actor(2).test(action);
  const output = await actor(2).run(action, tested.getSideData());
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(reads, 0, 'nothing read before the join is');
  assert.deepEqual(await output.bindingsStream.toArray(), []);
  assert.equal(reads, 1);
});

test('entries that are not bound go back to the join mediator with the bound result', async() => {
  const ubergraph = source('ubergraph', [], 'filterBindings');
  const wikidata = source('wikidata', [[ n('w1'), n('P7963'), n('c1') ]], 'joinBindings');
  let handed;
  const mediatorJoin = { mediate: async action => {
    handed = action.entries;
    return action.entries[0].output;
  } };
  const tpf = { source: { referenceValue: 'urn:source:tpf', getSelectorShape: async() => ({
    type: 'operation', operation: { operationType: 'pattern', pattern: af.createPattern(v('s'), v('p'), v('o')) },
  }), queryBindings: () => new ArrayIterator([]) } };
  const other = entry(assignOperationSource(af.createPattern(v('cell'), n('label'), v('l')), tpf), 5_000, [ 'cell', 'l' ]);
  const { rows } = await run(actor(2, mediatorJoin), [
    entry(on(ubergraph, v('cell'), n('part_of'), n('abdomen')), 1, [ 'cell' ], {}, [ row([ 'cell', 'c1' ]) ]),
    entry(on(wikidata, v('w'), n('P7963'), v('cell')), 300_000, [ 'w', 'cell' ]),
    other,
  ]);
  assert.equal(handed.length, 2);
  assert.ok(handed[0].operationModified);
  assert.equal(handed[1].operation, other.operation);
  assert.deepEqual(sorted(rows), sorted([ row([ 'cell', 'c1' ], [ 'w', 'w1' ]) ]));
});

test('an entry of unknown size does not stop the join binding from one of known size', async() => {
  // A COUNT that failed or timed out leaves an entry of unknown size, and one computed
  // locally sorts first; the join used to refuse, and a per-row bind join took over.
  const ubergraph = source('ubergraph', [], 'filterBindings');
  const wikidata = source('wikidata', [[ n('w1'), n('P7963'), n('c1') ]], 'joinBindings');
  let handed;
  const mediatorJoin = { mediate: async action => {
    handed = action.entries;
    return action.entries[0].output;
  } };
  const unknown = { ...entry(af.createJoin([]), Number.POSITIVE_INFINITY, [ 'cell', 'x' ]), operationModified: true };
  const { rows } = await run(actor(2, mediatorJoin), [
    unknown,
    entry(on(ubergraph, v('cell'), n('part_of'), n('abdomen')), 1, [ 'cell' ], {}, [ row([ 'cell', 'c1' ]) ]),
    entry(on(wikidata, v('w'), n('P7963'), v('cell')), 300_000, [ 'w', 'cell' ]),
  ]);
  assert.equal(handed.length, 2, 'the bound result, and the entry of unknown size to join it with');
  assert.ok(handed.some(handedEntry => handedEntry.operation === unknown.operation));
  assert.deepEqual(sorted(rows), sorted([ row([ 'cell', 'c1' ], [ 'w', 'w1' ]) ]));
});

test('the cost is the stock bind join\'s, with requests charged per block instead of per row', async() => {
  const ubergraph = source('ubergraph', [], 'filterBindings');
  const wikidata = source('wikidata', [], 'joinBindings');
  const entries = [
    entry(on(ubergraph, v('cell'), n('part_of'), n('abdomen')), 600, [ 'cell' ], { requestTime: 10, pageSize: 1_000 }),
    entry(on(wikidata, v('w'), n('P7963'), v('cell')), 300_000, [ 'w', 'cell' ], { requestTime: 400 }),
  ];
  const tested = await actor(256).test({ type: 'inner', entries, context: context() });
  assert.ok(tested.isPassed(), tested.isFailed() ? tested.getFailMessage() : '');
  const { iterations, requestTime, persistedItems, blockingItems } = tested.get();
  // The stock bind join's formula, probed rows scaled by its 0.0001 modifier, except that the target's
  // request is charged once per block of 256 (three blocks) instead of once per row (600 requests).
  const probed = 300_000 * 0.001 * 0.0001;
  assert.equal(iterations, 600 * probed);
  assert.equal(requestTime, 0 + 600 * (10 / 1_000) + 3 * 400 + 600 * probed * 0);
  assert.equal(persistedItems, 256, 'one block is held');
  assert.equal(blockingItems, 0, 'only a block, never the input, so a LIMIT above is not penalised');
});

test('it refuses what it cannot help with', async() => {
  const ubergraph = source('ubergraph', [], 'filterBindings');
  const wikidata = source('wikidata', [], 'joinBindings');
  const refusal = async(entries, ctx = context()) => {
    const tested = await actor().test({ type: 'inner', entries, context: ctx });
    assert.ok(tested.isFailed());
    return tested.getFailMessage();
  };
  const cells = entry(on(ubergraph, v('cell'), n('part_of'), n('abdomen')), 838, [ 'cell' ]);
  const target = entry(on(wikidata, v('w'), n('P7963'), v('cell')), 300_000, [ 'w', 'cell' ]);
  assert.match(await refusal([ cells, target ], context().set(KeysRdfJoin.lastPhysicalJoin, 'multi-bind-block')), /recursively/u);
  assert.match(await refusal([ cells, entry(on(wikidata, v('w'), n('P921'), v('article')), 300_000, [ 'w', 'article' ]) ]),
    /common variable|found no entry/u, 'nothing to bind on');
  const computed = { ...entry(af.createJoin([]), 1_000, [ 'cell' ]), operationModified: true };
  assert.match(await refusal([ computed, entry(on(wikidata, v('w'), n('P7963'), v('cell')), 500, [ 'w', 'cell' ]) ]),
    /found no entry/u, 'an entry smaller than the bound one is cheaper to fetch whole');
  assert.match(await refusal([ entry(on(ubergraph, v('cell'), n('label'), v('l')), Number.POSITIVE_INFINITY, [ 'cell', 'l' ]),
    entry(on(wikidata, v('w'), n('P7963'), v('cell')), Number.POSITIVE_INFINITY, [ 'w', 'cell' ]) ]), /known, non-zero size/u);
});

test('the local join matches literals by language and datatype', () => {
  const title = (value, language) => bf.bindings([[ v('a'), n('a1') ], [ v('t'), df.literal(value, language) ]]);
  const left = [ title('Neuron', 'en') ];
  const right = [ title('Neuron', 'en'), title('Neuron', 'de'), title('Neuron') ];
  assert.equal(ActorRdfJoinMultiBindBlock.hashJoin(left, right, [ 'a', 't' ]).length, 1);
});

test('a value repeated in later blocks is sent once', async() => {
  const ubergraph = source('ubergraph', [], 'filterBindings');
  const nasa = source('nasa', [[ n('d1'), n('keyword'), n('k1') ], [ n('d2'), n('keyword'), n('k2') ]], 'filterBindings');
  // Publications by dataset, the repeated dataset spread over blocks of two.
  const uses = [ 'd1', 'd2', 'd1', 'd1', 'd2', 'd1' ].map((dataset, i) => row([ 'pub', `p${i}` ], [ 'dataset', dataset ]));
  const { rows } = await run(actor(2), [
    entry(on(ubergraph, v('pub'), n('uses'), v('dataset')), 6, [ 'pub', 'dataset' ], {}, uses),
    entry(on(nasa, v('dataset'), n('keyword'), v('k')), 50_000, [ 'dataset', 'k' ]),
  ]);
  assert.equal(rows.length, 6);
  assert.deepEqual(nasa.calls.flatMap(call => call.bindings.map(binding => binding.get('dataset').value)).sort(),
    [ 'urn:d1', 'urn:d2' ]);
});

test('destroying the output stops the probes, as a LIMIT above the join does', async() => {
  const ubergraph = source('ubergraph', [], 'filterBindings');
  const triples = Array.from({ length: 1_000 }, (_, i) => [ n(`c${i}`), n('label'), n(`l${i}`) ]);
  const labels = source('labels', triples, 'filterBindings');
  const cells = Array.from({ length: 1_000 }, (_, i) => row([ 'cell', `c${i}` ]));
  const joinActor = actor(10);
  const entries = [
    entry(on(ubergraph, v('cell'), n('part_of'), n('abdomen')), 1_000, [ 'cell' ], {}, cells),
    entry(on(labels, v('cell'), n('label'), v('l')), 1_000_000, [ 'cell', 'l' ]),
  ];
  const action = { type: 'inner', entries, context: context() };
  const tested = await joinActor.test(action);
  const output = await joinActor.run(action, tested.getSideData());
  const first = await new Promise(resolve => output.bindingsStream.once('data', resolve));
  output.bindingsStream.destroy();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(first);
  assert.ok(labels.calls.length <= 2 * joinActor.blocksInFlight, `${labels.calls.length} of 100 blocks probed`);
});

test('a probe that fails fails the join, rather than ending it early', async() => {
  // A batch sent while its step was still filling, as a fan-out sends one, left the set of
  // batches in flight as soon as it failed, before the block waited on that set; its error
  // was lost and the join ended with the rows the other batches made. In a browser, where
  // the yield between chunks threw, every batch failed and a query "completed" with none.
  // One cell links to 1,500 values. They reach the labels step in two chunks, so the first
  // 1,000 values go out while the second chunk is still on its way, and fail. The last 500
  // went out when the block's rows were all in, and succeeded; now they are not sent.
  const ubergraph = source('ubergraph', [], 'filterBindings');
  const values = Array.from({ length: 1_500 }, (_, i) => `x${i}`);
  const links = source('links', values.map(x => [ n('c1'), n('has'), n(x) ]), 'filterBindings');
  const labels = source('labels', values.map(x => [ n(x), n('label'), n(`l${x}`) ]), 'filterBindings');
  const answer = labels.wrapper.source.queryBindings.bind(labels.wrapper.source);
  let calls = 0;
  labels.wrapper.source.queryBindings = (...args) => calls++ === 0 ?
    wrap(Promise.reject(new Error('HTTP 500'))) :
    answer(...args);
  await assert.rejects(run(actor(1_000), [
    entry(on(ubergraph, v('cell'), n('part_of'), n('abdomen')), 1, [ 'cell' ], {}, [ row([ 'cell', 'c1' ]) ]),
    entry(on(links, v('cell'), n('has'), v('x')), 10_000, [ 'cell', 'x' ]),
    entry(on(labels, v('x'), n('label'), v('l')), 10_000, [ 'x', 'l' ]),
  ]), { message: 'HTTP 500' });
  assert.equal(calls, 1, 'nothing more goes out once a batch has failed');
});

test('a bound entry that fails fails the join with its own error', async() => {
  // As a SERVICE clause refused with 403 does. Destroying the join used to destroy the
  // failed entry again with the same error, which it emitted again, until the stack ran out.
  const ubergraph = source('ubergraph', [], 'filterBindings');
  const labels = source('labels', [], 'filterBindings');
  const failing = new BufferedIterator({ autoStart: false });
  failing._read = () => setImmediate(() => failing.destroy(new Error('HTTP 403')));
  const bound = entry(on(ubergraph, v('cell'), n('part_of'), n('abdomen')), 3, [ 'cell' ]);
  bound.output.bindingsStream = failing;
  await assert.rejects(run(actor(2), [
    bound,
    entry(on(labels, v('cell'), n('label'), v('l')), 1_000, [ 'cell', 'l' ]),
  ]), { message: 'HTTP 403' });
});

test('blocks queued ahead are probed at once, up to blocksInFlight', async() => {
  const ubergraph = source('ubergraph', [], 'filterBindings');
  let open = 0;
  let most = 0;
  const slow = { source: {
    referenceValue: 'urn:source:slow',
    getSelectorShape: async() => ({ type: 'operation', operation: { operationType: 'wildcard' }, joinBindings: true }),
    queryBindings: (_operation, _context, options) => wrap((async() => {
      open++;
      most = Math.max(most, open);
      await new Promise(resolve => setTimeout(resolve, 20));
      open--;
      const bindings = await options.joinBindings.bindings.toArray();
      return new ArrayIterator(bindings, { autoStart: false });
    })()),
  } };
  const cells = Array.from({ length: 40 }, (_, i) => row([ 'cell', `c${i}` ]));
  const { rows } = await run(actor(2, undefined, { blocksInFlight: 4 }), [
    entry(on(ubergraph, v('cell'), n('part_of'), n('abdomen')), 40, [ 'cell' ], {}, cells),
    entry(assignOperationSource(af.createPattern(v('cell'), n('label'), v('l')), slow), 1_000_000, [ 'cell' ]),
  ]);
  assert.equal(rows.length, 40);
  assert.ok(most > 1 && most <= 4, `${most} probes in flight`);
});

test('a chain is bound in one pass: each entry is probed with the rows joined so far', async() => {
  const ubergraph = source('ubergraph', [], 'filterBindings');
  const wikidata = source('wikidata', [
    [ n('w1'), n('P7963'), n('c1') ], [ n('w2'), n('P7963'), n('c2') ],
    [ n('a1'), n('P921'), n('w1') ], [ n('a2'), n('P921'), n('w1') ], [ n('a9'), n('P921'), n('w9') ],
  ], 'joinBindings');
  const cells = [ row([ 'cell', 'c1' ]), row([ 'cell', 'c2' ]), row([ 'cell', 'c3' ]) ];
  const { rows } = await run(actor(256), [
    entry(on(ubergraph, v('cell'), n('part_of'), n('abdomen')), 3, [ 'cell' ], {}, cells),
    entry(on(wikidata, v('w'), n('P7963'), v('cell')), 300_000, [ 'w', 'cell' ]),
    entry(on(wikidata, v('article'), n('P921'), v('w')), 35_000_000, [ 'article', 'w' ]),
  ]);
  assert.deepEqual(sorted(rows), sorted([
    row([ 'cell', 'c1' ], [ 'w', 'w1' ], [ 'article', 'a1' ]), row([ 'cell', 'c1' ], [ 'w', 'w1' ], [ 'article', 'a2' ]),
  ]));
  assert.deepEqual(wikidata.calls.map(call => call.variables), [[ 'cell' ], [ 'w' ]]);
  assert.deepEqual(wikidata.calls[1].bindings.map(binding => binding.get('w').value).sort(), [ 'urn:w1', 'urn:w2' ],
    'the second probe carries only the values the first one found');
});

test('a block that empties is not probed further', async() => {
  const ubergraph = source('ubergraph', [], 'filterBindings');
  const wikidata = source('wikidata', [[ n('w1'), n('P7963'), n('c1') ]], 'joinBindings');
  const cells = [ row([ 'cell', 'c1' ]), row([ 'cell', 'c2' ]), row([ 'cell', 'c3' ]), row([ 'cell', 'c4' ]) ];
  await run(actor(2), [
    entry(on(ubergraph, v('cell'), n('part_of'), n('abdomen')), 4, [ 'cell' ], {}, cells),
    entry(on(wikidata, v('w'), n('P7963'), v('cell')), 300_000, [ 'w', 'cell' ]),
    entry(on(wikidata, v('article'), n('P921'), v('w')), 35_000_000, [ 'article', 'w' ]),
  ]);
  // Two blocks reach the first step; only the block holding c1 reaches the second.
  assert.deepEqual(wikidata.calls.map(call => call.variables.join()), [ 'cell', 'cell', 'w' ]);
});

test('a block is emitted when it is done, not after the blocks before it', async() => {
  const ubergraph = source('ubergraph', [], 'filterBindings');
  const delayed = { source: {
    referenceValue: 'urn:source:delayed',
    getSelectorShape: async() => ({ type: 'operation', operation: { operationType: 'wildcard' }, joinBindings: true }),
    queryBindings: (_operation, _context, options) => wrap((async() => {
      const bindings = await options.joinBindings.bindings.toArray();
      // The first block's probe is slow, the second's fast.
      await new Promise(resolve => setTimeout(resolve, bindings[0].get('cell').value === 'urn:c1' ? 60 : 5));
      return new ArrayIterator(bindings.map(binding => binding.set(v('l'), n('label'))), { autoStart: false });
    })()),
  } };
  const cells = [ row([ 'cell', 'c1' ]), row([ 'cell', 'c2' ]) ];
  const { rows } = await run(actor(1, undefined, { blocksInFlight: 2 }), [
    entry(on(ubergraph, v('cell'), n('part_of'), n('abdomen')), 2, [ 'cell' ], {}, cells),
    entry(assignOperationSource(af.createPattern(v('cell'), n('label'), v('l')), delayed), 1_000_000, [ 'cell', 'l' ]),
  ]);
  assert.deepEqual(rows.map(binding => binding.get('cell').value), [ 'urn:c2', 'urn:c1' ]);
});

test('a step that fans out sends its requests a few at a time, not all at once', async() => {
  const ubergraph = source('ubergraph', [], 'filterBindings');
  // One cell has ten wikicells; with two values per request, the second step needs five requests.
  const wikidata = source('wikidata', Array.from({ length: 10 }, (_, i) => [ n(`w${i}`), n('P7963'), n('c1') ]), 'joinBindings');
  let open = 0;
  let most = 0;
  const articles = { source: {
    referenceValue: 'urn:source:articles',
    getSelectorShape: async() => ({ type: 'operation', operation: { operationType: 'wildcard' }, joinBindings: true }),
    queryBindings: (_operation, _context, options) => wrap((async() => {
      open++;
      most = Math.max(most, open);
      const bindings = await options.joinBindings.bindings.toArray();
      await new Promise(resolve => setTimeout(resolve, 20));
      open--;
      return new ArrayIterator(bindings.map(binding => binding.set(v('article'), n(`a-${binding.get('w').value.slice(4)}`))),
        { autoStart: false });
    })()),
  } };
  const { rows } = await run(actor(2, undefined, { requestsInFlight: 2 }), [
    entry(on(ubergraph, v('cell'), n('part_of'), n('abdomen')), 1, [ 'cell' ], {}, [ row([ 'cell', 'c1' ]) ]),
    entry(on(wikidata, v('w'), n('P7963'), v('cell')), 300_000, [ 'w', 'cell' ]),
    entry(assignOperationSource(af.createPattern(v('article'), n('P921'), v('w')), articles), 35_000_000, [ 'article', 'w' ]),
  ]);
  assert.equal(rows.length, 10);
  assert.equal(most, 2, 'five requests for one step, two at a time');
});

/** Yields `perBinding` statements for each binding, made only as the reader asks for them. */
class Statements extends BufferedIterator {
  constructor(bindings, perBinding) {
    super({ autoStart: false });
    this.bindings = bindings;
    this.perBinding = perBinding;
    this.made = 0;
  }

  _read(count, done) {
    const total = this.bindings.length * this.perBinding;
    for (; count > 0 && this.made < total; count--, this.made++) {
      this._push(this.bindings[Math.floor(this.made / this.perBinding)].set(v('stmt'), n(`s${this.made}`)));
    }
    if (this.made >= total) {
      this.close();
    }
    done();
  }
}

/** A VALUES source whose answer for each bound row is `perBinding` statements. */
function bulky(perBinding) {
  const calls = [];
  return {
    calls,
    wrapper: { source: {
      referenceValue: 'urn:source:bulky',
      getSelectorShape: async() => ({ type: 'operation', operation: { operationType: 'wildcard' }, joinBindings: true }),
      queryBindings: (_operation, _context, options) => wrap((async() => {
        const bindings = await options.joinBindings.bindings.toArray();
        calls.push(bindings.length);
        return new Statements(bindings, perBinding);
      })()),
    } },
  };
}

test('a value matching many rows streams through without holding the event loop', async() => {
  const ubergraph = source('ubergraph', [], 'filterBindings');
  const statements = bulky(50_000);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  const { rows } = await run(actor(256), [
    entry(on(ubergraph, v('e'), n('in'), n('study')), 1, [ 'e' ], {}, [ row([ 'e', 'experiment' ]) ]),
    entry(assignOperationSource(af.createPattern(v('stmt'), n('object'), v('e')), statements.wrapper), 1e9, [ 'stmt', 'e' ]),
  ]);
  clearInterval(timer);
  assert.equal(rows.length, 50_000);
  assert.ok(ticks > 0, 'timers ran while the rows streamed');
});

test('an answer too large to keep is fetched again by the block that wanted it too', async() => {
  const ubergraph = source('ubergraph', [], 'filterBindings');
  const statements = bulky(200);
  // Blocks of one row: the second block wants the value the first block's request is carrying.
  const { rows } = await run(actor(1, undefined, { blocksInFlight: 2 }), [
    entry(on(ubergraph, v('e'), n('in'), n('study')), 2, [ 'e', 'p' ], {},
      [ row([ 'e', 'experiment' ], [ 'p', 'p1' ]), row([ 'e', 'experiment' ], [ 'p', 'p2' ]) ]),
    entry(assignOperationSource(af.createPattern(v('stmt'), n('object'), v('e')), statements.wrapper), 1e9, [ 'stmt', 'e' ]),
  ]);
  assert.equal(rows.length, 400, 'both blocks joined all 200 statements');
  assert.deepEqual(statements.calls, [ 1, 1 ], 'too many rows to keep for one row of blocks of one, so it was asked for twice');
});

test('a request does not hold its slot while its rows go on to the next step', async() => {
  const ubergraph = source('ubergraph', [], 'filterBindings');
  // The first step's answer spans three chunks; each chunk's rows need a request of the
  // second step. With one slot, holding it across the hand-off would wait forever.
  const statements = bulky(3_000);
  const labels = source('labels', [], 'joinBindings');
  const { rows } = await run(actor(256, undefined, { requestsInFlight: 1 }), [
    entry(on(ubergraph, v('e'), n('in'), n('study')), 1, [ 'e' ], {}, [ row([ 'e', 'experiment' ]) ]),
    entry(assignOperationSource(af.createPattern(v('stmt'), n('object'), v('e')), statements.wrapper), 1e9, [ 'stmt', 'e' ]),
    entry(on(labels, v('stmt'), n('label'), v('l')), 2e9, [ 'stmt', 'l' ]),
  ]);
  assert.equal(rows.length, 0, 'no statement has a label');
  assert.ok(labels.calls.length >= 3, `${labels.calls.length} label probes, one per chunk at least`);
});

/** Yields `count` statements for the one binding it is given, one per turn of the event loop. */
class Trickle extends BufferedIterator {
  constructor(binding, count) {
    super({ autoStart: false, maxBufferSize: 1 });
    this.binding = binding;
    this.count = count;
    this.made = 0;
  }

  _read(_count, done) {
    setImmediate(() => {
      if (this.made < this.count) {
        this._push(this.binding.set(v('stmt'), n(`s${this.made++}`)));
      }
      if (this.made >= this.count) {
        this.close();
      }
      done();
    });
  }
}

test('rows handed on a few at a time still reach the next step in full requests', async() => {
  const ubergraph = source('ubergraph', [], 'filterBindings');
  const trickle = { source: {
    referenceValue: 'urn:source:trickle',
    getSelectorShape: async() => ({ type: 'operation', operation: { operationType: 'wildcard' }, joinBindings: true }),
    queryBindings: (_operation, _context, options) => wrap((async() =>
      new Trickle((await options.joinBindings.bindings.toArray())[0], 600))()),
  } };
  const labels = source('labels', [], 'joinBindings');
  await run(actor(256), [
    entry(on(ubergraph, v('e'), n('in'), n('study')), 1, [ 'e' ], {}, [ row([ 'e', 'experiment' ]) ]),
    entry(assignOperationSource(af.createPattern(v('stmt'), n('object'), v('e')), trickle), 1e9, [ 'stmt', 'e' ]),
    entry(on(labels, v('stmt'), n('label'), v('l')), 2e9, [ 'stmt', 'l' ]),
  ]);
  // 600 statements arrive one at a time; 256 distinct values per request makes three requests.
  assert.deepEqual(labels.calls.map(call => call.bindings.length), [ 256, 256, 88 ]);
});
