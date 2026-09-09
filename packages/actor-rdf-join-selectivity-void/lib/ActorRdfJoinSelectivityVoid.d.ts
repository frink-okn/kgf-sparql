import type { IActionRdfJoinSelectivity, IActorRdfJoinSelectivityOutput } from '@comunica/bus-rdf-join-selectivity';
import { ActorRdfJoinSelectivity } from '@comunica/bus-rdf-join-selectivity';
import type { IActorArgs, TestResult } from '@comunica/core';
import { ActionContextKey } from '@comunica/core';
import type { IMediatorTypeAccuracy } from '@comunica/mediatortype-accuracy';
import type { VoidStatisticsRegistry } from './VoidStatistics';
/**
 * Context key carrying VoID statistics, keyed by endpoint URL.
 *
 * Endpoint URL is `IQuerySource.referenceValue`. Comunica query sources expose no
 * type field and the concrete class is a wrapper stack, so URL identity is the
 * only sound way to attach statistics to a source.
 */
export declare const KEY_VOID_STATISTICS: ActionContextKey<VoidStatisticsRegistry>;
/**
 * Estimates join selectivity from published VoID statistics rather than from the
 * syntactic shape of the query.
 *
 * Applies to any endpoint that publishes VoID — plain TPF, brTPF, KGF alike.
 * Nothing here is KGF-specific.
 *
 * ## What it returns
 *
 * The bus asks for a ratio, not a cardinality: `ActorRdfJoin.constructResultMetadata`
 * multiplies the input cardinalities and then multiplies by this actor's answer. For
 * the containment estimate over a shared variable `v`,
 *
 *   |A join B| = |A| * |B| / max(d_v(A), d_v(B))
 *
 * so the value to return is `1 / max(d_v(A), d_v(B))`.
 *
 * ## What it deliberately does NOT do
 *
 * It never estimates |A| or |B|. Those come from source metadata (`hydra:totalItems`
 * on LDF, or KGF's `/count` endpoint); VoID's own pattern-cardinality formulae
 * would be a regression. VoID is used only for the divisor.
 *
 * ## Known limits of the estimate
 *
 * The containment estimate assumes (a) the smaller value set is contained in the
 * larger, and (b) values are uniformly distributed. Real data violates both:
 * disjoint value sets make it over-estimate, and skew makes it *under*-estimate.
 * Under-estimation is the dangerous direction, because it biases the planner toward
 * bind/pushdown plans that then issue far more requests than predicted. `safetyFactor`
 * is the knob for that; the estimate is also floored at one row.
 */
export declare class ActorRdfJoinSelectivityVoid extends ActorRdfJoinSelectivity {
    private readonly accuracy;
    private readonly safetyFactor;
    private readonly staticStatistics;
    constructor(args: IActorRdfJoinSelectivityVoidArgs);
    test(action: IActionRdfJoinSelectivity): Promise<TestResult<IMediatorTypeAccuracy>>;
    run(action: IActionRdfJoinSelectivity): Promise<IActorRdfJoinSelectivityOutput>;
    /**
     * Estimated number of distinct values a join variable takes within one pattern.
     * Falls through: property partition, then rdf:type reasoning, then the dataset-wide
     * count, then the pattern cardinality.
     */
    private distinctValues;
    /** VoID statistics for the endpoint this entry is assigned to, if any are known. */
    private statsFor;
    private static sharedVariables;
}
export interface IActorRdfJoinSelectivityVoidArgs extends IActorArgs<IActionRdfJoinSelectivity, IMediatorTypeAccuracy, IActorRdfJoinSelectivityOutput> {
    /**
     * Declared accuracy. Must exceed the shipped variable-counting actor's 0.5 to win the mediator.
     * @range {double}
     * @default {0.8}
     */
    accuracy?: number;
    /**
     * Multiplier applied to the estimate before converting to a selectivity. Values above 1
     * deliberately over-estimate, as insurance against data skew that VoID cannot express.
     * @range {double}
     * @default {1}
     */
    safetyFactor?: number;
    /**
     * Default statistics as a JSON string, keyed by endpoint URL.
     * The context key takes precedence where both supply an endpoint.
     * @range {string}
     */
    statistics?: string;
}
//# sourceMappingURL=ActorRdfJoinSelectivityVoid.d.ts.map