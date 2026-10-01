import type { IActionRdfJoin, IActorRdfJoinArgs, IActorRdfJoinOutputInner, IActorRdfJoinTestSideData, MediatorRdfJoin } from '@comunica/bus-rdf-join';
import { ActorRdfJoin } from '@comunica/bus-rdf-join';
import type { MediatorRdfJoinEntriesSort } from '@comunica/bus-rdf-join-entries-sort';
import type { TestResult } from '@comunica/core';
import type { IMediatorTypeJoinCoefficients } from '@comunica/mediatortype-join-coefficients';
import type { Bindings, ComunicaDataFactory, IActionContext, IJoinEntryWithMetadata, IQuerySourceWrapper, MetadataBindings } from '@comunica/types';
import { Algebra } from '@comunica/utils-algebra';
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
 *   leaves behind. Each input is probed and joined in turn, never to each other.
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
export declare class ActorRdfJoinMultiBindBlock extends ActorRdfJoin<IActorRdfJoinMultiBindBlockTestSideData> {
    readonly blockSize: number;
    readonly blocksInFlight: number;
    readonly requestsInFlight: number;
    readonly probeCacheRows: number;
    readonly selectivityModifier: number;
    readonly mediatorJoinEntriesSort: MediatorRdfJoinEntriesSort;
    readonly mediatorJoin: MediatorRdfJoin;
    constructor(args: IActorRdfJoinMultiBindBlockArgs);
    getJoinCoefficients(action: IActionRdfJoin, sideData: IActorRdfJoinTestSideData): Promise<TestResult<IMediatorTypeJoinCoefficients, IActorRdfJoinMultiBindBlockTestSideData>>;
    protected getOutput(action: IActionRdfJoin, sideData: IActorRdfJoinMultiBindBlockTestSideData): Promise<IActorRdfJoinOutputInner>;
    /**
     * Choose the entry to bind (the smallest) and, in order, the entries to probe with it.
     */
    protected plan(action: IActionRdfJoin, metadatas: MetadataBindings[]): Promise<TestResult<IBindBlockPlan>>;
    /**
     * How to probe an operation with rows binding the `known` variables, as separately
     * probed parts, or `undefined` when it cannot be probed.
     */
    protected probeParts(operation: Algebra.Operation, known: Set<string>, context: IActionContext): Promise<IProbePart[] | undefined>;
    /**
     * The source requests one probe of an operation sends, or `undefined` when one of
     * them cannot take bindings or would not be restricted by them.
     */
    protected probeLeaves(operation: Algebra.Operation, known: Set<string>, context: IActionContext): Promise<IProbeLeaf[] | undefined>;
    /**
     * Run one block through every step. Rows move on in chunks as soon as they are joined,
     * so neither a probe's results nor a step's joined rows are ever held whole: a value that
     * matches millions of rows streams through rather than filling memory, and the event loop
     * gets a turn between chunks, so a budget, a LIMIT, or a signal can stop the work. An
     * earlier version materialized both and joined them in one synchronous pass; on a probe of
     * a handful of experiments with millions of statements each it held the event loop for
     * minutes, past the run's own timeout and its SIGTERM handler, at 9.4 GB.
     */
    protected joinBlock(rows: Bindings[], steps: IBindStep[], metadata: MetadataBindings, dataFactory: ComunicaDataFactory, context: IActionContext, probes: IProbeRun, emit: (rows: Bindings[]) => Promise<void>): Promise<void>;
    /** Join one batch to a part: index the batch, and stream each probe's rows past it. */
    private probeBatch;
    /**
     * Hand `onRows` the leaf's rows that match some of the given rows, a chunk at a time.
     * Values an earlier block already sent are answered from the cache, or from the request
     * still carrying them, and not sent again; an answer too large to keep is sent for again.
     * New values go out in requests of at most `blockSize` values, at most `requestsInFlight`
     * of them at once across the join: a step whose rows fan out to many values would
     * otherwise send all its requests together.
     */
    protected probe(leaf: IProbeLeaf, rows: Bindings[], run: IBlockRun, onRows: (rows: Bindings[]) => Promise<void>): Promise<void>;
    /**
     * One request carrying the given values. Its rows go to `onRows` a chunk at a time as
     * they arrive. While they stay few they are also kept per value, and settle each value's
     * answer for other blocks; once they pass `blockSize` times 64 rows the values' answers
     * are settled as too large to keep, so blocks waiting on them send for them themselves.
     */
    protected request(leaf: IProbeLeaf, values: IProbeValue[], metadata: MetadataBindings, run: IBlockRun, onRows: (rows: Bindings[]) => Promise<void>, cacheable: boolean): Promise<void>;
    /** The rows indexed by the values of `variables`, for streaming another side past them. */
    private static index;
    /** The indexed rows that may join with `row`; `joinBindings` makes the final check. */
    private static matches;
    /** Join two lists of solutions on the given variables, which every row is expected to bind. */
    static hashJoin(left: Bindings[], right: Bindings[], variables: string[]): Bindings[];
    /** A string identifying the values of the given variables, or `undefined` when one is unbound. */
    static keyOf(bindings: Bindings, variables: string[]): string | undefined;
    private static variablesOf;
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
     * again. Once the cache holds this many rows, new values are still probed but no longer kept.
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
/**
 * Probe answers for one join, per source request and bound values. A value in flight is
 * shared by every block that needs it; answered values are kept until `limit` rows are held.
 */
declare class ProbeCache {
    private readonly limit;
    private readonly answers;
    private rows;
    constructor(limit: number);
    get(leaf: IProbeLeaf, key: string): Promise<Bindings[] | undefined> | undefined;
    set(leaf: IProbeLeaf, key: string, answer: Promise<Bindings[] | undefined>): void;
    /** Keep an answered value if there is room for its rows, else drop it. */
    retain(leaf: IProbeLeaf, key: string, rows: number): void;
    forget(leaf: IProbeLeaf, key: string): void;
}
/** At most `limit` holders at once; the rest wait in arrival order. */
declare class Slots {
    private readonly limit;
    private active;
    private readonly waiting;
    constructor(limit: number);
    enter(): Promise<void>;
    /** Hands the place to the next waiter, if any, rather than freeing it. */
    leave(): void;
}
export {};
//# sourceMappingURL=ActorRdfJoinMultiBindBlock.d.ts.map