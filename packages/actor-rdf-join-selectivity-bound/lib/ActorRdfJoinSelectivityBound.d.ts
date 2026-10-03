import type { IActionRdfJoinSelectivity, IActorRdfJoinSelectivityOutput, MediatorRdfJoinSelectivity } from '@comunica/bus-rdf-join-selectivity';
import { ActorRdfJoinSelectivity } from '@comunica/bus-rdf-join-selectivity';
import type { IActorArgs, TestResult } from '@comunica/core';
import { ActionContextKey } from '@comunica/core';
import type { IMediatorTypeAccuracy } from '@comunica/mediatortype-accuracy';
import type { IJoinEntry, MetadataBindings } from '@comunica/types';
import { Algebra } from '@comunica/utils-algebra';
/**
 * Set while this actor asks the selectivity bus for the estimate it bounds, so that the
 * nested mediation reaches the actor that would otherwise have answered.
 */
export declare const KEY_SELECTIVITY_BOUND_DELEGATING: ActionContextKey<boolean>;
/**
 * Caps any other join-selectivity estimate with an upper bound on the join's size.
 *
 * ## The bound
 *
 * An entry whose variables all occur in the other entries cannot make the join larger
 * than the join of those others: each of their result rows fixes every variable of the
 * entry, and a set of solutions matches a fixed assignment at most once. With
 * `?cell rdfs:subClassOf cell:` (31,721 rows) and `?cell part_of: abdomen:` (838 rows),
 * either pattern is such a filter on the other, so the join has at most 838 rows. The
 * shape-only `variable-counting` heuristic puts it at about 7.4 million, and that
 * estimate made a 307,784-row subquery look like the smaller side of the plan.
 *
 * Entries are removed greedily, largest first, while each removed entry's variables
 * stay covered by the entries that remain. The bound is the product of the remaining
 * cardinalities, so every entry that remains must have an exact one: an estimate may be a
 * lower bound, as a SPARQL count that reached its cap or an incomplete KGF count is, and a
 * product of lower bounds bounds nothing. Only a size its sources counted is exact here:
 * Comunica labels a join's result exact whenever its inputs are, though its size is their
 * product times an estimated selectivity, which may be far below the true one. So an entry
 * that a join computed, or any operation that is not a source's (or a union of them), counts
 * as estimated. Entries with an estimate are removed first, and when one cannot be, there is
 * no bound. A union of `k` set-valued branches can match a fixed assignment up to `k` times,
 * so removing it multiplies the bound by `k`; entries whose multiplicity is unknown are never
 * removed.
 *
 * ## How it composes
 *
 * The selectivity bus answers through the single most accurate actor. This one declares
 * the highest accuracy, asks the bus again with `KEY_SELECTIVITY_BOUND_DELEGATING` set
 * (which makes its own test fail), and returns the smaller of that answer and the bound.
 * The VoID actor, the shipped heuristic, or anything else registered keeps doing the
 * estimating; this actor only stops it from exceeding what the join can produce.
 *
 * ## Limits
 *
 * The bus asks for a ratio of the product of the input cardinalities. When an input's
 * cardinality is unknown (infinite) no ratio can express a finite bound, and the
 * delegate's answer is returned unchanged. Solutions that may leave a variable unbound
 * match more than one row, so entries with such variables disable the bound.
 */
export declare class ActorRdfJoinSelectivityBound extends ActorRdfJoinSelectivity {
    readonly mediatorJoinSelectivity: MediatorRdfJoinSelectivity;
    private readonly accuracy;
    constructor(args: IActorRdfJoinSelectivityBoundArgs);
    test(action: IActionRdfJoinSelectivity): Promise<TestResult<IMediatorTypeAccuracy>>;
    run(action: IActionRdfJoinSelectivity): Promise<IActorRdfJoinSelectivityOutput>;
    /**
     * The estimate this actor caps: whatever the bus answers without it. When no other actor
     * answers, the product is the only estimate there is; one that fails while answering fails
     * the estimate, as it would without this actor.
     */
    private delegate;
    /**
     * An upper bound on the number of rows the join of `entries` produces, or `Infinity`
     * when no entry qualifies as a filter, or an entry whose size is only estimated cannot
     * be removed.
     */
    static upperBound(entries: IJoinEntry[], metadatas: MetadataBindings[]): number;
    /**
     * Whether an entry's size is the count its sources gave: the entry was not computed by a
     * join, and its operation is a source's, or a union of sources' operations, whose size is
     * the sum of theirs.
     */
    static counted(entry: IJoinEntry): boolean;
    private static sourced;
    /**
     * How many times one solution can occur in the operation's output, assuming every
     * source answers a triple pattern with a set. `Infinity` when it cannot be told.
     */
    static multiplicity(operation: Algebra.Operation): number;
}
export interface IActorRdfJoinSelectivityBoundArgs extends IActorArgs<IActionRdfJoinSelectivity, IMediatorTypeAccuracy, IActorRdfJoinSelectivityOutput> {
    /**
     * The selectivity mediator this actor is registered on. It is asked again for the
     * estimate to bound, with this actor excluded.
     */
    mediatorJoinSelectivity: MediatorRdfJoinSelectivity;
    /**
     * Declared accuracy. Must exceed every other selectivity actor's so that this one
     * answers and delegates to the next best.
     * @range {double}
     * @default {0.9}
     */
    accuracy?: number;
}
//# sourceMappingURL=ActorRdfJoinSelectivityBound.d.ts.map