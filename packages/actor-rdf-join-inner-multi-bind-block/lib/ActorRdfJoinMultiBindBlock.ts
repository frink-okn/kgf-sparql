import type {
  IActionRdfJoin,
  IActorRdfJoinArgs,
  IActorRdfJoinOutputInner,
  IActorRdfJoinTestSideData,
  MediatorRdfJoin,
} from '@comunica/bus-rdf-join';
import { ActorRdfJoin } from '@comunica/bus-rdf-join';
import type { MediatorRdfJoinEntriesSort } from '@comunica/bus-rdf-join-entries-sort';
import { KeysInitQuery, KeysRdfJoin } from '@comunica/context-entries';
import type { TestResult } from '@comunica/core';
import { failTest, passTest, passTestWithSideData } from '@comunica/core';
import type { IMediatorTypeJoinCoefficients } from '@comunica/mediatortype-join-coefficients';
import type {
  Bindings,
  BindingsStream,
  ComunicaDataFactory,
  IActionContext,
  IJoinEntry,
  IJoinEntryWithMetadata,
  IQuerySourceWrapper,
  MetadataBindings,
} from '@comunica/types';
import { Algebra, AlgebraFactory, algebraUtils } from '@comunica/utils-algebra';
import { ChunkedIterator } from '@comunica/utils-iterator';
import { doesShapeAcceptOperation, getOperationSource } from '@comunica/utils-query-operation';
import type { AsyncIterator } from 'asynciterator';
import { ArrayIterator, BufferedIterator } from 'asynciterator';

/**
 * A bind join that sends the smallest entry's rows in blocks through every other entry
 * that can take bindings, one after another, as FedX's bound joins do.
 *
 * Comunica binds in blocks only when every entry but the smallest lives on one source
 * that accepts `joinBindings` (`multi-bind-source`), or when the join has a pattern on a
 * source that accepts `filterBindings` (`multi-smallest-filter-bindings`). A federated
 * join rarely meets either condition, and the fallback is a bind join that sends one
 * request per row, plus a COUNT per row against a SPARQL endpoint.
 *
 * ## The plan
 *
 * Starting from the smallest entry, the actor repeatedly picks the entry that shares the
 * most variables with what is bound so far (then the smallest) among those it can probe:
 *
 * - an operation on one source that accepts `filterBindings` (KGF, brTPF) or
 *   `joinBindings` (a SPARQL endpoint, through `VALUES`);
 * - a union whose branches are each such an operation, as source assignment produces for
 *   a pattern several sources can answer: every branch is probed;
 * - a join no source was given, whose inputs are each of the above, as `group-sources`
 *   leaves behind. Each input is probed and joined in turn, never to each other, in an
 *   order where each shares a variable with the rows bound by then.
 *
 * Each block of the smallest entry then runs through those entries in that order. Every
 * probe carries the values of the variables it shares with the rows joined so far,
 * projected and deduplicated, so either kind of source returns the entry's own rows that
 * match some row; those are joined locally, and a block that empties stops. Binding all
 * the entries in one pass needs no estimate of an intermediate result: a previous version
 * bound one entry at a time and handed the rest back to the planner, whose compounded
 * estimate of the intermediate (10^21 rows for a few dozen) then chose to scan a label
 * pattern whole. Entries that cannot be probed, or are smaller than the bound entry, are
 * joined afterwards through the join mediator.
 *
 * Up to `blocksInFlight` blocks are probed at once and each is emitted as soon as it is
 * joined. A value an earlier block already sent is answered from a per-join cache.
 *
 * ## Cost
 *
 * The coefficients are the stock bind join's formula over the probed entries, so the two
 * compare on equal terms, except that a probe request is charged per block instead of per
 * row (one request time per entry, paged or not, as the round-trip bind join charges it) and
 * one block of rows is held. Nothing counts as blocking: the join mediator penalises
 * blocking joins below a LIMIT, and this one only ever waits for a block, not its input.
 */
export class ActorRdfJoinMultiBindBlock extends ActorRdfJoin<IActorRdfJoinMultiBindBlockTestSideData> {
  public readonly blockSize: number;
  public readonly blocksInFlight: number;
  public readonly requestsInFlight: number;
  public readonly probeCacheRows: number;
  public readonly selectivityModifier: number;
  public readonly mediatorJoinEntriesSort: MediatorRdfJoinEntriesSort;
  public readonly mediatorJoin: MediatorRdfJoin;

  public constructor(args: IActorRdfJoinMultiBindBlockArgs) {
    super(args, {
      logicalType: 'inner',
      physicalName: 'multi-bind-block',
      limitEntries: 2,
      limitEntriesMin: true,
      canHandleUndefs: false,
      isLeaf: false,
    });
    this.blockSize = args.blockSize ?? 256;
    this.blocksInFlight = args.blocksInFlight ?? 4;
    this.requestsInFlight = args.requestsInFlight ?? 8;
    this.probeCacheRows = args.probeCacheRows ?? 100_000;
    this.selectivityModifier = args.selectivityModifier ?? 0.0001;
    this.mediatorJoinEntriesSort = args.mediatorJoinEntriesSort;
    this.mediatorJoin = args.mediatorJoin;
  }

  public override async getJoinCoefficients(
    action: IActionRdfJoin,
    sideData: IActorRdfJoinTestSideData,
  ): Promise<TestResult<IMediatorTypeJoinCoefficients, IActorRdfJoinMultiBindBlockTestSideData>> {
    if (action.context.get(KeysRdfJoin.lastPhysicalJoin) === this.physicalName) {
      return failTest(`${this.name} can not be called recursively`);
    }
    const planned = await this.plan(action, sideData.metadatas);
    if (planned.isFailed()) {
      return planned;
    }
    const plan = planned.get();
    const { first, steps } = plan;
    const rows = first.metadata.cardinality.value;
    const blocks = Math.ceil(rows / this.blockSize);
    const metadatas = [ first.metadata, ...steps.map(step => step.entry.metadata) ];
    const initial = ActorRdfJoin.getRequestInitialTimes(metadatas);
    const item = ActorRdfJoin.getRequestItemTimes(metadatas);
    // The stock bind join's formula over the probed entries, with its selectivity modifier...
    const selectivities = await Promise.all(steps.map(async step => (await this.mediatorJoinSelectivity.mediate({
      entries: [ first, step.entry ],
      context: action.context,
    })).selectivity));
    let probed = 0;
    let probeRequest = 0;
    let receive = 0;
    for (const [ i, step ] of steps.entries()) {
      const stepRows = step.entry.metadata.cardinality.value;
      // An unknown entry size says nothing about what its probes return; one row per bound row is the guess.
      probed += Number.isFinite(stepRows) ? stepRows * selectivities[i] * this.selectivityModifier : 1;
      // A probe is a new request whether or not the entry is paged, as the round-trip bind join charges it.
      probeRequest += step.entry.metadata.requestTime ?? initial[i + 1];
      receive += item[i + 1];
    }
    // ...except that a probe request is sent per block instead of per row, and a block is held to join it.
    // Only a block is held, never the whole input, so nothing counts as blocking for a LIMIT above.
    return passTestWithSideData({
      iterations: rows * probed,
      persistedItems: Math.min(rows, this.blockSize),
      blockingItems: 0,
      requestTime: initial[0] + rows * item[0] + blocks * probeRequest + rows * probed * receive,
    }, { ...sideData, plan });
  }

  protected override async getOutput(
    action: IActionRdfJoin,
    sideData: IActorRdfJoinMultiBindBlockTestSideData,
  ): Promise<IActorRdfJoinOutputInner> {
    const { first, steps, remaining } = sideData.plan;
    const dataFactory = action.context.getSafe(KeysInitQuery.dataFactory);
    const algebraFactory = new AlgebraFactory(dataFactory);

    // The bound entries are only probed; their own streams are never read.
    for (const step of steps) {
      step.entry.output.bindingsStream.destroy();
    }
    const probes: IProbeRun = {
      cache: new ProbeCache(this.probeCacheRows),
      slots: new Slots(this.requestsInFlight),
      readers: new Set(),
      stopped: false,
    };
    const bindingsStream: BindingsStream = new BlockJoinIterator(
      new ChunkedIterator(first.output.bindingsStream, this.blockSize, { autoStart: false }),
      async(rows, emit) => await this.joinBlock(rows, steps, first.metadata, dataFactory, action.context, probes, emit),
      () => ActorRdfJoinMultiBindBlock.stop(probes),
      this.blocksInFlight,
      this.blocksInFlight * this.blockSize,
    );
    const bound = [ first, ...steps.map(step => step.entry) ];
    const joined: IJoinEntry = {
      output: {
        type: 'bindings',
        bindingsStream,
        metadata: async() => await this.constructResultMetadata(
          bound,
          bound.map(entry => entry.metadata),
          action.context,
        ),
      },
      operation: algebraFactory.createJoin(bound.map(entry => entry.operation), false),
      operationModified: true,
    };
    const physicalPlanMetadata = {
      firstIndex: sideData.plan.firstIndex,
      stepIndexes: sideData.plan.stepIndexes,
      probes: steps.reduce((sum, step) => sum + step.parts.reduce((parts, part) => parts + part.leaves.length, 0), 0),
      blockSize: this.blockSize,
      blocksInFlight: this.blocksInFlight,
    };
    if (remaining.length === 0) {
      return { result: joined.output, physicalPlanMetadata };
    }
    return {
      result: await this.mediatorJoin.mediate({
        type: action.type,
        entries: [ joined, ...remaining ],
        // Marked as Comunica's filter-bindings join marks its own, so this actor does not take
        // the leftover join too: it would bind the computed result into entries it just left out.
        context: action.context.set(KeysRdfJoin.lastPhysicalJoin, this.physicalName),
      }),
      physicalPlanMetadata,
    };
  }

  /**
   * Stops a join's probes once its output is closed: a request waiting for a slot sends
   * nothing, and one waiting on its source stops reading it. Without this, the requests queued
   * behind the slots all went out after a LIMIT above the join was met, and the rows they
   * returned sent the next step's.
   */
  private static stop(probes: IProbeRun): void {
    probes.stopped = true;
    for (const reader of probes.readers) {
      reader.cancel();
    }
  }

  /**
   * Choose the entry to bind (the smallest) and, in order, the entries to probe with it.
   */
  protected async plan(
    action: IActionRdfJoin,
    metadatas: MetadataBindings[],
  ): Promise<TestResult<IBindBlockPlan>> {
    const entriesUnsorted: IJoinEntryWithMetadata[] = action.entries
      .map((entry, i) => ({ ...entry, metadata: metadatas[i] }));
    const sortedTest = await ActorRdfJoin.sortJoinEntries(this.mediatorJoinEntriesSort, entriesUnsorted, action.context);
    if (sortedTest.isFailed()) {
      return sortedTest;
    }
    // An entry already computed locally cannot be probed, so it is the one to bind if there is one.
    const sorted = [ ...sortedTest.get() ]
      .sort((left, right) => Number(Boolean(right.operationModified)) - Number(Boolean(left.operationModified)));
    // Of known size: an entry whose count failed or timed out, reported as an infinite
    // estimate, cannot be bound in blocks, but it can still be probed. Refusing whenever
    // such an entry came first let a slow COUNT hand the join to a per-row bind join.
    const first = sorted.find(entry => Number.isFinite(entry.metadata.cardinality.value));
    const rows = first?.metadata.cardinality.value ?? Number.NaN;
    if (!first || rows <= 0) {
      return failTest(`${this.name} needs an entry of known, non-zero size`);
    }
    const others = sorted.filter(entry => entry !== first);

    const known = new Set(first.metadata.variables.map(variable => variable.variable.value));
    const pool = others.filter(entry => !entry.operationModified &&
      // An entry smaller than the bound one is cheaper to fetch whole and join afterwards.
      !(Number.isFinite(entry.metadata.cardinality.value) && entry.metadata.cardinality.value < rows));
    const steps: IBindStep[] = [];
    for (;;) {
      let best: { step: IBindStep; shared: number } | undefined;
      for (const entry of pool) {
        if (steps.some(step => step.entry === entry)) {
          continue;
        }
        const parts = await this.probeParts(entry.operation, known, action.context);
        if (!parts) {
          continue;
        }
        const shared = new Set(parts.flatMap(part => part.shared)).size;
        if (!best || shared > best.shared ||
          (shared === best.shared && entry.metadata.cardinality.value < best.step.entry.metadata.cardinality.value)) {
          best = { step: { entry, parts }, shared };
        }
      }
      if (!best) {
        break;
      }
      steps.push(best.step);
      for (const variable of best.step.entry.metadata.variables) {
        known.add(variable.variable.value);
      }
    }
    if (steps.length === 0) {
      return failTest(`${this.name} found no entry that accepts bindings and shares a variable with the smallest`);
    }
    return passTest({
      first,
      steps,
      remaining: others.filter(entry => !steps.some(step => step.entry === entry)),
      firstIndex: entriesUnsorted.indexOf(first),
      stepIndexes: steps.map(step => entriesUnsorted.indexOf(step.entry)),
    });
  }

  /**
   * How to probe an operation with rows binding the `known` variables, as separately
   * probed parts, or `undefined` when it cannot be probed.
   */
  protected async probeParts(
    operation: Algebra.Operation,
    known: Set<string>,
    context: IActionContext,
  ): Promise<IProbePart[] | undefined> {
    const leaves = await this.probeLeaves(operation, known, context);
    if (leaves) {
      const variables = ActorRdfJoinMultiBindBlock.variablesOf(operation);
      const shared = variables.filter(name => known.has(name));
      return shared.length > 0 ? [{ operation, shared, leaves }] : undefined;
    }
    if (operation.type === Algebra.Types.JOIN && !getOperationSource(operation)) {
      // Inputs are probed in turn, each with the rows the ones before it joined, so an input
      // may share a variable only with an earlier one: a label pattern on ?article after the
      // pattern that binds ?article from the block's ?wikicell. Each next input is the one
      // sharing the most variables with what is bound by then; an input that never shares
      // one leaves the join to another actor. Checking every input against the block's own
      // variables alone refused such a join, and the per-row bind join that took it sent a
      // COUNT per row to every source of every pattern.
      const pending = [ ...(<Algebra.Join> operation).input ];
      const bound = new Set(known);
      const parts: IProbePart[] = [];
      while (pending.length > 0) {
        let best: { input: Algebra.Operation; parts: IProbePart[]; shared: number } | undefined;
        for (const input of pending) {
          const inner = await this.probeParts(input, bound, context);
          const shared = inner ? new Set(inner.flatMap(part => part.shared)).size : 0;
          if (inner && (!best || shared > best.shared)) {
            best = { input, parts: inner, shared };
          }
        }
        if (!best) {
          return undefined;
        }
        parts.push(...best.parts);
        pending.splice(pending.indexOf(best.input), 1);
        for (const name of ActorRdfJoinMultiBindBlock.variablesOf(best.input)) {
          bound.add(name);
        }
      }
      return parts;
    }
    return undefined;
  }

  /**
   * The source requests one probe of an operation sends, or `undefined` when one of
   * them cannot take bindings or would not be restricted by them.
   */
  protected async probeLeaves(
    operation: Algebra.Operation,
    known: Set<string>,
    context: IActionContext,
  ): Promise<IProbeLeaf[] | undefined> {
    const source = getOperationSource(operation);
    if (source) {
      const shared = ActorRdfJoinMultiBindBlock.variablesOf(operation).filter(name => known.has(name));
      if (shared.length === 0) {
        return undefined;
      }
      const shape = await source.source.getSelectorShape(context);
      const wildcardAcceptAllExtensionFunctions = context.get(KeysInitQuery.extensionFunctionsAlwaysPushdown);
      for (const mode of <const> [ 'filterBindings', 'joinBindings' ]) {
        if (doesShapeAcceptOperation(shape, operation, { [mode]: true, wildcardAcceptAllExtensionFunctions })) {
          return [{ operation, source, mode, shared }];
        }
      }
      return undefined;
    }
    if (operation.type === Algebra.Types.UNION) {
      const leaves: IProbeLeaf[] = [];
      for (const input of (<Algebra.Union> operation).input) {
        const inner = await this.probeLeaves(input, known, context);
        if (!inner) {
          return undefined;
        }
        leaves.push(...inner);
      }
      return leaves.length > 0 ? leaves : undefined;
    }
    return undefined;
  }

  /**
   * Run one block through every step. Rows move on in chunks as soon as they are joined,
   * so neither a probe's results nor a step's joined rows are ever held whole: a value that
   * matches millions of rows streams through rather than filling memory, and the event loop
   * gets a turn between chunks, so a budget, a LIMIT, or a signal can stop the work. An
   * earlier version materialized both and joined them in one synchronous pass; on a probe of
   * a handful of experiments with millions of statements each it held the event loop for
   * minutes, past the run's own timeout and its SIGTERM handler, at 9.4 GB.
   */
  protected async joinBlock(
    rows: Bindings[],
    steps: IBindStep[],
    metadata: MetadataBindings,
    dataFactory: ComunicaDataFactory,
    context: IActionContext,
    probes: IProbeRun,
    emit: (rows: Bindings[]) => Promise<void>,
  ): Promise<void> {
    const run: IBlockRun = { metadata, dataFactory, context, probes, emit };
    const parts = steps.flatMap(step => step.parts);
    // Each part collects the rows reaching it until they carry `blockSize` distinct values
    // (or `BATCH_ROWS` rows), so its requests stay full however finely the part before it
    // hands rows on; what is left is sent when the block's rows are all in.
    let batches = parts.map(() => new Batch());
    // Batches sent and not yet joined, per part; a part sends a few at once, not one after another.
    const sent = parts.map(() => new Set<Promise<void>>());
    // A batch leaves `sent` once it settles, so one that failed before anything waited on it
    // took its error with it, and the block ended with the rows the other batches made: in a
    // browser, where every batch failed, a query "completed" with none. The first failure
    // is kept here and thrown at the next chance.
    let failure: { error: unknown } | undefined;
    const check = (): void => {
      if (failure) {
        throw failure.error;
      }
      if (probes.stopped) {
        throw STOPPED;
      }
    };
    const feed = async(level: number, incoming: Bindings[]): Promise<void> => {
      check();
      if (incoming.length === 0) {
        return;
      }
      if (level === parts.length) {
        await run.emit(incoming);
        return;
      }
      const { shared } = parts[level];
      for (const row of incoming) {
        const key = ActorRdfJoinMultiBindBlock.keyOf(row, shared);
        if (batches[level].isFull(key, this.blockSize)) {
          await send(level);
        }
        batches[level].add(key, row);
      }
    };
    const send = async(level: number): Promise<void> => {
      const batch = batches[level];
      if (batch.rows.length === 0) {
        return;
      }
      // Swapped out before any await, so rows arriving meanwhile start the next batch.
      batches = batches.map((current, i) => i === level ? new Batch() : current);
      const joining = this.probeBatch(batch, parts[level], run, async joined => await feed(level + 1, joined))
        .catch((error: unknown) => {
          failure ??= { error };
        });
      sent[level].add(joining);
      void joining.finally(() => sent[level].delete(joining));
      if (sent[level].size >= BATCHES_IN_FLIGHT) {
        await Promise.race(sent[level]);
      }
      check();
    };
    await feed(0, rows);
    for (let level = 0; level < parts.length; level++) {
      // A part's last batch can go once every batch of the part before it has been joined.
      await send(level);
      await Promise.all(sent[level]);
      check();
    }
  }

  /** Join one batch to a part: index the batch, and stream each probe's rows past it. */
  private async probeBatch(
    batch: Batch,
    part: IProbePart,
    run: IBlockRun,
    onJoined: (rows: Bindings[]) => Promise<void>,
  ): Promise<void> {
    // The batch's rows are keyed on the part's variables already; a leaf on the same ones reuses the keys.
    const index = ActorRdfJoinMultiBindBlock.index(batch.rows, batch.keys);
    let joined: Bindings[] = [];
    const pass = async(): Promise<void> => {
      const chunk = joined;
      joined = [];
      await onJoined(chunk);
    };
    const onRows = async(probed: Bindings[]): Promise<void> => {
      for (const row of probed) {
        for (const match of ActorRdfJoinMultiBindBlock.matches(index, row, part.shared)) {
          const merged = ActorRdfJoin.joinBindings(match, row);
          if (merged) {
            joined.push(merged);
            if (joined.length >= CHUNK_ROWS) {
              await pass();
            }
          }
        }
      }
      await yieldToEventLoop();
    };
    await Promise.all(part.leaves.map(async(leaf) => {
      const keys = ActorRdfJoinMultiBindBlock.sameVariables(leaf.shared, part.shared) ? batch.keys : undefined;
      await this.probe(leaf, batch.rows, keys, run, onRows);
    }));
    if (joined.length > 0) {
      await pass();
    }
  }

  /**
   * Hand `onRows` the leaf's rows that match some of the given rows, a chunk at a time.
   * Values an earlier block already sent are answered from the cache, or from the request
   * still carrying them, and not sent again; an answer too large to keep is sent for again.
   * New values go out in requests of at most `blockSize` values, at most `requestsInFlight`
   * of them at once across the join: a step whose rows fan out to many values would
   * otherwise send all its requests together. `keys`, when given, are the rows' keys on the
   * leaf's variables.
   */
  protected async probe(
    leaf: IProbeLeaf,
    rows: Bindings[],
    keys: (string | undefined)[] | undefined,
    run: IBlockRun,
    onRows: (rows: Bindings[]) => Promise<void>,
  ): Promise<void> {
    const { cache } = run.probes;
    const keep = new Set(leaf.shared);
    const seen = new Set<string>();
    const elsewhere: { key: string; bindings: Bindings; answer: Promise<Bindings[] | undefined> }[] = [];
    const send: IProbeValue[] = [];
    for (const [ i, row ] of rows.entries()) {
      const key = keys ? keys[i] : ActorRdfJoinMultiBindBlock.keyOf(row, leaf.shared);
      // Each value's rows are handed on once; the local join pairs them with every row that carries it.
      if (key === undefined || seen.has(key)) {
        continue;
      }
      seen.add(key);
      const bindings = row.filter((_, variable) => keep.has(variable.value));
      const known = cache.get(leaf, key);
      if (known) {
        elsewhere.push({ key, bindings, answer: known });
        continue;
      }
      const answer = deferred();
      cache.set(leaf, key, answer.promise);
      send.push({ key, bindings, answer });
    }
    const metadata = {
      ...run.metadata,
      variables: leaf.shared.map(name => ({ variable: run.dataFactory.variable(name), canBeUndef: false })),
    };
    const requests: Promise<void>[] = [];
    const track = (request: Promise<void>): void => {
      // Awaited at the end, after the values other blocks are fetching; a failure meanwhile
      // must not also surface as an unhandled rejection.
      request.catch(() => undefined);
      requests.push(request);
    };
    for (let start = 0; start < send.length; start += this.blockSize) {
      track(this.request(leaf, send.slice(start, start + this.blockSize), metadata, run, onRows, true));
    }
    const answered = await Promise.all(elsewhere.map(async value => ({ value, rows: await value.answer })));
    const kept = answered.flatMap(({ rows: answer }) => answer ?? []);
    if (kept.length > 0) {
      await onRows(kept);
    }
    // Answers that turned out too large to keep: ask for those values here too, uncached.
    const resend = answered.filter(({ rows: answer }) => !answer)
      .map(({ value }) => ({ key: value.key, bindings: value.bindings, answer: deferred() }));
    for (let start = 0; start < resend.length; start += this.blockSize) {
      track(this.request(leaf, resend.slice(start, start + this.blockSize), metadata, run, onRows, false));
    }
    await Promise.all(requests);
  }

  /**
   * One request carrying the given values. Its rows go to `onRows` a chunk at a time as
   * they arrive. While they stay few they are also kept per value, and settle each value's
   * answer for other blocks; once they pass `blockSize` times 64 rows the values' answers
   * are settled as too large to keep, so blocks waiting on them send for them themselves.
   */
  protected async request(
    leaf: IProbeLeaf,
    values: IProbeValue[],
    metadata: MetadataBindings,
    run: IBlockRun,
    onRows: (rows: Bindings[]) => Promise<void>,
    cacheable: boolean,
  ): Promise<void> {
    const { cache, slots } = run.probes;
    let keeping = cacheable;
    let kept = 0;
    const byKey = new Map<string, Bindings[]>();
    const tooLarge = (): void => {
      keeping = false;
      byKey.clear();
      for (const { key, answer } of values) {
        cache.forget(leaf, key);
        answer.resolve(undefined);
      }
    };
    let stream: BindingsStream | undefined;
    let reader: ChunkReader<Bindings> | undefined;
    // A slot is held while waiting on the source, never while rows move on: the next step's
    // probes need slots too, and holding one across `onRows` let every slot end up held by a
    // request waiting for a slot. That deadlock left a corpus query idle past its budget, with
    // nothing in flight for the abort to cancel.
    let holding = false;
    // Once the join's output is closed, a request that gets its slot sends nothing, and one
    // that was reading ends there.
    const running = (): void => {
      if (run.probes.stopped) {
        throw STOPPED;
      }
    };
    try {
      await slots.enter();
      holding = true;
      running();
      stream = leaf.source.source.queryBindings(
        leaf.operation,
        leaf.source.context ? run.context.merge(leaf.source.context) : run.context,
        { [leaf.mode]: {
          bindings: new ArrayIterator(values.map(value => value.bindings), { autoStart: false }),
          metadata: { ...metadata, cardinality: { type: 'exact', value: values.length }},
        }},
      );
      reader = new ChunkReader(stream);
      run.probes.readers.add(reader);
      for (;;) {
        if (!holding) {
          await slots.enter();
          holding = true;
          running();
        }
        const chunk = await reader.next(CHUNK_ROWS);
        slots.leave();
        holding = false;
        running();
        if (!chunk) {
          break;
        }
        if (keeping) {
          for (const row of chunk) {
            const key = ActorRdfJoinMultiBindBlock.keyOf(row, leaf.shared);
            if (key !== undefined) {
              const bucket = byKey.get(key);
              if (bucket) {
                bucket.push(row);
              } else {
                byKey.set(key, [ row ]);
              }
            }
          }
          kept += chunk.length;
          if (kept > this.blockSize * 64) {
            tooLarge();
          }
        }
        await onRows(chunk);
      }
      if (keeping) {
        for (const { key, answer } of values) {
          const matched = byKey.get(key) ?? [];
          cache.retain(leaf, key, matched.length);
          answer.resolve(matched);
        }
      } else if (!cacheable) {
        for (const { answer } of values) {
          answer.resolve(undefined);
        }
      }
    } catch (error: unknown) {
      stream?.destroy();
      if (keeping) {
        for (const { key, answer } of values) {
          cache.forget(leaf, key);
          answer.reject(error);
        }
      }
      throw error;
    } finally {
      if (reader) {
        run.probes.readers.delete(reader);
      }
      if (holding) {
        slots.leave();
      }
    }
  }

  /** The rows indexed by their keys, for streaming another side past them. */
  private static index(rows: Bindings[], keys: (string | undefined)[]): IRowIndex {
    const byKey = new Map<string, Bindings[]>();
    const loose: Bindings[] = [];
    for (const [ i, row ] of rows.entries()) {
      const key = keys[i];
      if (key === undefined) {
        loose.push(row);
      } else {
        const bucket = byKey.get(key);
        if (bucket) {
          bucket.push(row);
        } else {
          byKey.set(key, [ row ]);
        }
      }
    }
    return { byKey, loose, all: rows };
  }

  /** The indexed rows that may join with `row`; `joinBindings` makes the final check. */
  private static matches(index: IRowIndex, row: Bindings, variables: string[]): Bindings[] {
    const key = ActorRdfJoinMultiBindBlock.keyOf(row, variables);
    if (key === undefined) {
      return index.all;
    }
    const bucket = index.byKey.get(key) ?? NO_ROWS;
    return index.loose.length === 0 ? bucket : [ ...bucket, ...index.loose ];
  }

  /**
   * A string identifying the values of the given variables, or `undefined` when one is unbound.
   * Equal terms give equal keys and different ones different keys, so a key stands for its
   * values: a probe sends each key once.
   */
  public static keyOf(bindings: Bindings, variables: string[]): string | undefined {
    let key = '';
    for (const name of variables) {
      const term = bindings.get(name);
      if (!term) {
        return undefined;
      }
      key += termKey(term);
    }
    return key;
  }

  private static sameVariables(left: string[], right: string[]): boolean {
    return left.length === right.length && left.every((name, i) => name === right[i]);
  }

  private static variablesOf(operation: Algebra.Operation): string[] {
    return algebraUtils.inScopeVariables(operation).map(variable => variable.value);
  }
}

type Term = NonNullable<ReturnType<Bindings['get']>>;

/**
 * One term's part of a key. Each value is prefixed with its length, so that no two lists of
 * terms run together into the same key, and a quoted triple is keyed by its own terms.
 */
function termKey(term: Term): string {
  switch (term.termType) {
    case 'Literal':
      return `L${term.value.length}:${term.value}@${term.language}@${term.direction ?? ''}` +
        `${term.datatype.value.length}:${term.datatype.value}`;
    case 'Quad':
      return `Q${termKey(term.subject)}${termKey(term.predicate)}${termKey(term.object)}${termKey(term.graph)}`;
    default:
      return `${term.termType.charAt(0)}${term.value.length}:${term.value}`;
  }
}

/** One source request of a probe. */
export interface IProbeLeaf {
  operation: Algebra.Operation;
  source: IQuerySourceWrapper;
  mode: 'filterBindings' | 'joinBindings';
  /** Variables the request's bindings carry: those it shares with the rows bound so far. */
  shared: string[];
}

/** A unit the rows are joined to: one operation, probed through one or more source requests. */
export interface IProbePart {
  operation: Algebra.Operation;
  /** Variables the part shares with the rows bound so far, which the local join matches on. */
  shared: string[];
  leaves: IProbeLeaf[];
}

/** An entry probed in the pass, and how. */
export interface IBindStep {
  entry: IJoinEntryWithMetadata;
  parts: IProbePart[];
}

export interface IBindBlockPlan {
  first: IJoinEntryWithMetadata;
  steps: IBindStep[];
  remaining: IJoinEntryWithMetadata[];
  firstIndex: number;
  stepIndexes: number[];
}

export interface IActorRdfJoinMultiBindBlockTestSideData extends IActorRdfJoinTestSideData {
  plan: IBindBlockPlan;
}

export interface IActorRdfJoinMultiBindBlockArgs extends IActorRdfJoinArgs<IActorRdfJoinMultiBindBlockTestSideData> {
  /**
   * Rows of the smallest entry per block, and values per probe request.
   * @range {integer}
   * @default {256}
   */
  blockSize?: number;
  /**
   * Blocks probed at once. Each block is emitted as soon as it is joined.
   * @range {integer}
   * @default {4}
   */
  blocksInFlight?: number;
  /**
   * Probe requests in flight at once across the join, whatever the blocks and steps they serve.
   * @range {integer}
   * @default {8}
   */
  requestsInFlight?: number;
  /**
   * Probe result rows kept per join so that a value repeated in a later block is not sent
   * again. Each value kept counts one more than its rows, so values with no rows count too.
   * Once the cache holds this many, new values are still probed but no longer kept.
   * @range {integer}
   * @default {100000}
   */
  probeCacheRows?: number;
  /**
   * Multiplier on probed rows for the iteration coefficient, matching the stock bind join's.
   * @range {double}
   * @default {0.0001}
   */
  selectivityModifier?: number;
  /**
   * The join entries sort mediator.
   */
  mediatorJoinEntriesSort: MediatorRdfJoinEntriesSort;
  /**
   * The join mediator, for the entries that are not bound.
   */
  mediatorJoin: MediatorRdfJoin;
}

/** What the probes of one join share: answers already fetched, and places for requests in flight. */
interface IProbeRun {
  cache: ProbeCache;
  slots: Slots;
  /** The requests reading their sources now, to cancel once the output is closed. */
  readers: Set<ChunkReader<Bindings>>;
  /** Whether the output is closed, after which no request is sent. */
  stopped: boolean;
}

/** What one block's work needs as it moves through the steps. */
interface IBlockRun {
  metadata: MetadataBindings;
  dataFactory: ComunicaDataFactory;
  context: IActionContext;
  probes: IProbeRun;
  /** Hands joined rows out of the actor; waits while the reader is behind, and throws `STOPPED` once it is gone. */
  emit: (rows: Bindings[]) => Promise<void>;
}

/** Rows waiting to be sent to one part, their keys on its variables, and the distinct values they carry. */
class Batch {
  public readonly rows: Bindings[] = [];
  /** Each row's key, `undefined` where the row leaves one of the part's variables unbound. */
  public readonly keys: (string | undefined)[] = [];
  private readonly distinct = new Set<string | undefined>();

  /** Whether `key` would take the batch past `limit` distinct values, or it already holds `BATCH_ROWS` rows. */
  public isFull(key: string | undefined, limit: number): boolean {
    return this.rows.length >= BATCH_ROWS || (!this.distinct.has(key) && this.distinct.size >= limit);
  }

  public add(key: string | undefined, row: Bindings): void {
    this.distinct.add(key);
    this.keys.push(key);
    this.rows.push(row);
  }
}

interface IRowIndex {
  byKey: Map<string, Bindings[]>;
  loose: Bindings[];
  all: Bindings[];
}

/** Rows joined, read, or emitted at a time between turns of the event loop. */
const CHUNK_ROWS = 1024;
/** Rows a part collects before sending, however few distinct values they carry. */
const BATCH_ROWS = 4 * CHUNK_ROWS;
/** Batches one part of one block may have sent and not yet joined. */
const BATCHES_IN_FLIGHT = 4;
/** Turns of the event loop a read waits on a stream readable with nothing to read, before it waits on a timer. */
const IDLE_YIELDS = 8;
/** The longest a read waits on that timer before looking again. */
const IDLE_WAIT_MS = 16;
const NO_ROWS: Bindings[] = [];

/** Thrown into a block's work once the joined stream is closed, as a LIMIT above it does. */
const STOPPED = new Error('The joined stream was closed');

/**
 * Lets timers, I/O, and signal handlers run before continuing. Browsers have no
 * `setImmediate`, and a `setTimeout` chain is held to 4 ms a step there, so they get a
 * message to themselves instead, which runs as soon as pending input and network events have.
 */
const yieldToEventLoop: () => Promise<void> = typeof setImmediate === 'function' ?
  async() => await new Promise<void>(resolve => setImmediate(resolve)) :
  messageYield();

function messageYield(): () => Promise<void> {
  const channel = new MessageChannel();
  const waiting: (() => void)[] = [];
  // The browser's port, which Node's types (the only ones this package compiles with) lack.
  (<{ onmessage: () => void }> <unknown> channel.port1).onmessage = () => waiting.shift()?.();
  return async() => await new Promise<void>((resolve) => {
    waiting.push(resolve);
    channel.port2.postMessage(undefined);
  });
}

/**
 * Reads a stream a chunk at a time: whatever is ready now, or the first items to arrive.
 * Its listeners stay attached for the stream's life, and it waits for an event only when the
 * stream says it is not readable: a wrapping iterator that reports readable with nothing to
 * read never announces `readable` again, and a read that waited for it stalled a query.
 */
class ChunkReader<T> {
  private wake?: () => void;
  private failure?: Error;
  private ended = false;
  private cancelled = false;

  public constructor(private readonly stream: AsyncIterator<T>) {
    stream.on('readable', () => this.notify());
    stream.on('end', () => {
      this.ended = true;
      this.notify();
    });
    stream.on('error', (error: Error) => {
      this.failure = error;
      this.notify();
    });
  }

  /**
   * Stops reading: destroys the stream, and ends a read waiting on it. A stream destroyed
   * without an error never announces its end, so such a read would wait for good.
   */
  public cancel(): void {
    this.cancelled = true;
    this.stream.destroy();
    this.notify();
  }

  /** Up to `size` items, or `undefined` once the stream has ended or the reader was cancelled. */
  public async next(size: number): Promise<T[] | undefined> {
    for (let idle = 0; ; idle++) {
      if (this.failure) {
        throw this.failure;
      }
      if (this.cancelled) {
        return undefined;
      }
      const chunk: T[] = [];
      let item: T | null;
      while (chunk.length < size && (item = this.stream.read()) !== null) {
        chunk.push(item);
      }
      if (chunk.length > 0) {
        return chunk;
      }
      if (this.ended || this.stream.done) {
        return undefined;
      }
      if (this.stream.readable) {
        // Readable yet nothing to read: an iterator wrapping another one can stay in this
        // state, and it announces `readable` only on becoming readable, so waiting for the
        // event alone would wait forever. Let its source make progress, then look again: at
        // once for a few turns, then after a timer or an event, whichever comes first, so a
        // response that takes seconds does not keep a core busy looking.
        if (idle < IDLE_YIELDS) {
          await yieldToEventLoop();
        } else {
          await this.event(Math.min(2 ** (idle - IDLE_YIELDS), IDLE_WAIT_MS));
        }
        continue;
      }
      await this.event();
    }
  }

  /** Waits for the stream's next event, or at most `milliseconds` when given. */
  private async event(milliseconds?: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = milliseconds === undefined ? undefined : setTimeout(() => this.notify(), milliseconds);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}

interface IProbeValue {
  key: string;
  bindings: Bindings;
  answer: IDeferred;
}

/** A value's answer: its rows, or `undefined` when they were too many to keep. */
interface IDeferred {
  promise: Promise<Bindings[] | undefined>;
  resolve: (rows: Bindings[] | undefined) => void;
  reject: (error: unknown) => void;
}

function deferred(): IDeferred {
  let resolve!: (rows: Bindings[] | undefined) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Bindings[] | undefined>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  // A failure is reported by whichever block awaits it; one no block awaits must not crash the process.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/**
 * Probe answers for one join, per source request and bound values. A value in flight is
 * shared by every block that needs it; answered values are kept until `limit` is held, each
 * counting its rows and one more for itself.
 */
class ProbeCache {
  private readonly answers = new Map<IProbeLeaf, Map<string, Promise<Bindings[] | undefined>>>();
  private held = 0;

  public constructor(private readonly limit: number) {}

  public get(leaf: IProbeLeaf, key: string): Promise<Bindings[] | undefined> | undefined {
    return this.answers.get(leaf)?.get(key);
  }

  public set(leaf: IProbeLeaf, key: string, answer: Promise<Bindings[] | undefined>): void {
    let forLeaf = this.answers.get(leaf);
    if (!forLeaf) {
      forLeaf = new Map();
      this.answers.set(leaf, forLeaf);
    }
    forLeaf.set(key, answer);
  }

  /**
   * Keep an answered value if there is room for it, else drop it. The value itself counts
   * one: counting rows alone kept every value with no rows, without limit.
   */
  public retain(leaf: IProbeLeaf, key: string, rows: number): void {
    if (this.held + rows + 1 > this.limit) {
      this.forget(leaf, key);
    } else {
      this.held += rows + 1;
    }
  }

  public forget(leaf: IProbeLeaf, key: string): void {
    this.answers.get(leaf)?.delete(key);
  }
}

/** At most `limit` holders at once; the rest wait in arrival order. */
class Slots {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  public constructor(private readonly limit: number) {}

  public async enter(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>(resolve => this.waiting.push(resolve));
  }

  /** Hands the place to the next waiter, if any, rather than freeing it. */
  public leave(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
    } else {
      this.active--;
    }
  }
}

/**
 * Joins blocks of the bound entry with up to `maxActive` in progress at once. Each block
 * hands its joined rows out through `deliver` as it produces them, whatever the order the
 * blocks came in; `deliver` waits while `maxReady` rows are unread, so a slow reader holds
 * the probes back. Destroying the stream (a LIMIT above it was reached) starts no further
 * block, wakes the waiting blocks with `STOPPED`, and calls `stop` so that their requests end.
 */
class BlockJoinIterator extends BufferedIterator<Bindings> {
  /**
   * Whether this iterator has been read. Until then no block starts, however readable the
   * blocks say they are, as asynciterator's own iterators wait for a read before reading their
   * source: a lazy iterator says it is readable as soon as it exists. A join the planner built
   * and never read, inside an entry another join only probed, otherwise read its first entry:
   * every `wdt:P921` statement on two of Wikidata's query services, until the heap gave out.
   */
  private started = false;
  private active = 0;
  private readonly ready: Bindings[][] = [];
  private readyRows = 0;
  private head = 0;
  private pending?: { count: number; done: () => void };
  private readonly drained: (() => void)[] = [];

  public constructor(
    private readonly blocks: AsyncIterator<AsyncIterator<Bindings>>,
    private readonly join: (rows: Bindings[], emit: (rows: Bindings[]) => Promise<void>) => Promise<void>,
    private readonly stop: () => void,
    private readonly maxActive: number,
    private readonly maxReady: number,
  ) {
    super({ autoStart: false });
    blocks.on('readable', () => {
      if (this.started) {
        this.startBlocks();
      }
    });
    blocks.on('end', () => this.settle());
    blocks.on('error', (error: Error) => this.destroy(error));
  }

  protected override _read(count: number, done: () => void): void {
    this.started = true;
    this.pending = { count, done };
    this.startBlocks();
    this.settle();
  }

  protected override _destroy(cause: Error | undefined, callback: (error?: Error) => void): void {
    // Without the cause: destroyed with one, the blocks emit it as an error, and when the
    // error came from them in the first place that destroys this iterator again, without end.
    this.blocks.destroy();
    this.stop();
    this.wake();
    super._destroy(cause, callback);
  }

  private async deliver(rows: Bindings[]): Promise<void> {
    if (this.done) {
      throw STOPPED;
    }
    if (rows.length > 0) {
      this.ready.push(rows);
      this.readyRows += rows.length;
      this.settle();
    }
    while (!this.done && this.readyRows >= this.maxReady) {
      await new Promise<void>(resolve => this.drained.push(resolve));
    }
    if (this.done) {
      throw STOPPED;
    }
  }

  private wake(): void {
    for (const resolve of this.drained.splice(0)) {
      resolve();
    }
  }

  private startBlocks(): void {
    while (!this.done && this.active < this.maxActive && this.readyRows < this.maxReady) {
      const block = this.blocks.read();
      if (block === null) {
        break;
      }
      this.active++;
      block.toArray()
        .then(async rows => await this.join(rows, async joined => await this.deliver(joined)))
        .then(() => {
          this.active--;
          this.settle();
          this.startBlocks();
        }, (error: unknown) => {
          this.active--;
          if (error !== STOPPED) {
            this.destroy(<Error> error);
          }
        });
    }
  }

  private settle(): void {
    if (!this.pending || this.done) {
      return;
    }
    const { count, done } = this.pending;
    if (this.readyRows > 0) {
      this.pending = undefined;
      for (let pushed = 0; pushed < count && this.ready.length > 0; pushed++) {
        const rows = this.ready[0];
        this._push(rows[this.head++]);
        this.readyRows--;
        if (this.head === rows.length) {
          this.ready.shift();
          this.head = 0;
        }
      }
      if (this.readyRows < this.maxReady) {
        this.wake();
      }
      done();
      this.startBlocks();
    } else if (this.blocks.done && this.active === 0) {
      this.pending = undefined;
      this.close();
      done();
    }
  }
}
