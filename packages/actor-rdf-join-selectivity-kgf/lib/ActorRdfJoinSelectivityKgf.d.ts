import type { IActionRdfJoinSelectivity, IActorRdfJoinSelectivityOutput } from '@comunica/bus-rdf-join-selectivity';
import { ActorRdfJoinSelectivity } from '@comunica/bus-rdf-join-selectivity';
import type { IActorArgs, TestResult } from '@comunica/core';
import { ActionContextKey } from '@comunica/core';
import type { IMediatorTypeAccuracy } from '@comunica/mediatortype-accuracy';
import type { KgfStatisticsRegistry } from './KgfStatistics';
/**
 * Context key carrying per-endpoint statistics. Preferred over the config
 * parameter, because a client discovers its sources at runtime.
 */
export declare const KEY_KGF_STATISTICS: ActionContextKey<KgfStatisticsRegistry>;
/**
 * Estimates join selectivity from published KGF statistics instead of from the
 * shape of the query.
 *
 * The bus asks for a *ratio to the cross product*, not for a cardinality:
 * `ActorRdfJoin.constructResultMetadata` multiplies the input cardinalities and
 * then multiplies by whatever this returns. So for the containment estimate
 *
 *   |A join B| = |A| * |B| / max(d_v(A), d_v(B))
 *
 * the value to return is simply `1 / max(d_v(A), d_v(B))`.
 *
 * Registered at a higher `accuracy` than the shipped variable-counting actor,
 * which wins the `MediatorNumber` on `accuracy`. Declining is safe: the mediator
 * sets `ignoreFailures`, so the default actor answers for anything this one does
 * not recognise.
 */
export declare class ActorRdfJoinSelectivityKgf extends ActorRdfJoinSelectivity {
    private readonly accuracy;
    private readonly staticStatistics;
    constructor(args: IActorRdfJoinSelectivityKgfArgs);
    test(action: IActionRdfJoinSelectivity): Promise<TestResult<IMediatorTypeAccuracy>>;
    run(action: IActionRdfJoinSelectivity): Promise<IActorRdfJoinSelectivityOutput>;
    /**
     * Estimated number of distinct values a join variable takes in one pattern.
     * Falls through tiers: per-predicate count, then rdf:type reasoning, then the
     * dataset-wide ceiling, then the pattern cardinality.
     */
    private distinctValues;
    /** Statistics for the endpoint this entry is assigned to, if it is a known KGF source. */
    private statsFor;
    private static sharedVariables;
}
export interface IActorRdfJoinSelectivityKgfArgs extends IActorArgs<IActionRdfJoinSelectivity, IMediatorTypeAccuracy, IActorRdfJoinSelectivityOutput> {
    /**
     * Declared accuracy. Must exceed the shipped variable-counting actor's 0.5 to win the mediator.
     * @range {double}
     * @default {0.9}
     */
    accuracy?: number;
    /**
     * Default statistics as a JSON string, keyed by endpoint URL.
     * The context key takes precedence when both are present.
     * @range {string}
     */
    statistics?: string;
}
//# sourceMappingURL=ActorRdfJoinSelectivityKgf.d.ts.map