import type { IActionRdfJoinSelectivity, IActorRdfJoinSelectivityOutput } from '@comunica/bus-rdf-join-selectivity';
import { ActorRdfJoinSelectivity } from '@comunica/bus-rdf-join-selectivity';
import type { IActorArgs, TestResult } from '@comunica/core';
import { ActionContextKey, failTest, passTest } from '@comunica/core';
import type { IMediatorTypeAccuracy } from '@comunica/mediatortype-accuracy';
import type { IJoinEntry } from '@comunica/types';
import { Algebra } from '@comunica/utils-algebra';
import { getOperationSource } from '@comunica/utils-query-operation';
import type { IVoidDatasetStatistics, VoidStatisticsRegistry } from './VoidStatistics';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/**
 * Context key carrying VoID statistics, keyed by endpoint URL.
 *
 * Endpoint URL is `IQuerySource.referenceValue`. Comunica query sources expose no
 * type field and the concrete class is a wrapper stack, so URL identity is the
 * only sound way to attach statistics to a source.
 */
export const KEY_VOID_STATISTICS = new ActionContextKey<VoidStatisticsRegistry>(
  '@kgf/actor-rdf-join-selectivity-void:statistics',
);

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
 * It never estimates |A| or |B|. Those come from `hydra:totalItems`, which on an LDF
 * endpoint is an *exact* per-pattern count; VoID's own pattern-cardinality formulae
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
export class ActorRdfJoinSelectivityVoid extends ActorRdfJoinSelectivity {
  private readonly accuracy: number;
  private readonly safetyFactor: number;
  private readonly staticStatistics: VoidStatisticsRegistry;

  public constructor(args: IActorRdfJoinSelectivityVoidArgs) {
    super(args);
    this.accuracy = args.accuracy ?? 0.8;
    this.safetyFactor = args.safetyFactor ?? 1;
    this.staticStatistics = args.statistics ? <VoidStatisticsRegistry> JSON.parse(args.statistics) : {};
  }

  public async test(action: IActionRdfJoinSelectivity): Promise<TestResult<IMediatorTypeAccuracy>> {
    if (action.entries.length !== 2) {
      return failTest(`${this.name} only estimates pairwise joins`);
    }
    if (!action.entries.every(entry => entry.operation.type === Algebra.Types.PATTERN)) {
      return failTest(`${this.name} only estimates joins between triple patterns`);
    }
    if (!action.entries.some(entry => this.statsFor(entry, action))) {
      return failTest(`${this.name} found no source with published VoID statistics`);
    }
    return passTest({ accuracy: this.accuracy });
  }

  public async run(action: IActionRdfJoinSelectivity): Promise<IActorRdfJoinSelectivityOutput> {
    const [ left, right ] = action.entries;
    // Cardinality is memoized by ActorRdfJoin, so reading it costs no HTTP.
    const metadatas = await Promise.all(action.entries.map(async entry => entry.output.metadata()));
    const [ leftCard, rightCard ] = metadatas.map(meta => meta.cardinality.value);
    if (![ leftCard, rightCard ].every(card => Number.isFinite(card) && card > 0)) {
      return { selectivity: 1 };
    }

    const shared = ActorRdfJoinSelectivityVoid.sharedVariables(left, right);
    if (shared.length === 0) {
      return { selectivity: 1 };
    }

    const crossProduct = leftCard * rightCard;
    let estimate = crossProduct;
    for (const variable of shared) {
      estimate /= Math.max(
        this.distinctValues(left, variable, leftCard, action),
        this.distinctValues(right, variable, rightCard, action),
        1,
      );
    }

    // Guard the dangerous direction: never predict fewer than one row, and allow a
    // deliberate over-estimate as insurance against skew the statistics cannot express.
    estimate = Math.max(estimate * this.safetyFactor, 1);
    return { selectivity: Math.min(Math.max(estimate / crossProduct, Number.MIN_VALUE), 1) };
  }

  /**
   * Estimated number of distinct values a join variable takes within one pattern.
   * Falls through: property partition, then rdf:type reasoning, then the dataset-wide
   * count, then the pattern cardinality.
   */
  private distinctValues(
    entry: IJoinEntry,
    variable: string,
    cardinality: number,
    action: IActionRdfJoinSelectivity,
  ): number {
    const pattern = <Algebra.Pattern> entry.operation;
    const stats = this.statsFor(entry, action);
    const predicate = pattern.predicate.termType === 'NamedNode' ? pattern.predicate.value : undefined;
    const partition = predicate ? stats?.propertyPartitions?.[predicate] : undefined;

    if (pattern.subject.termType === 'Variable' && pattern.subject.value === variable) {
      // A bound object narrows the pattern, so the partition count is a ceiling.
      if (partition?.distinctSubjects !== undefined) {
        return Math.min(partition.distinctSubjects, cardinality);
      }
      // `?s rdf:type <C>` names each subject at most once, so distinct == cardinality.
      if (predicate === RDF_TYPE && pattern.object.termType !== 'Variable') {
        return cardinality;
      }
      return Math.min(cardinality, stats?.distinctSubjects ?? Number.POSITIVE_INFINITY);
    }

    if (pattern.object.termType === 'Variable' && pattern.object.value === variable) {
      if (partition?.distinctObjects !== undefined) {
        return Math.min(partition.distinctObjects, cardinality);
      }
      return Math.min(cardinality, stats?.distinctObjects ?? Number.POSITIVE_INFINITY);
    }

    // Variable in predicate or graph position: no VoID statistic applies.
    return cardinality;
  }

  /** VoID statistics for the endpoint this entry is assigned to, if any are known. */
  private statsFor(entry: IJoinEntry, action: IActionRdfJoinSelectivity): IVoidDatasetStatistics | undefined {
    const wrapper = getOperationSource(entry.operation);
    if (!wrapper) {
      return undefined;
    }
    const url = String(wrapper.source.referenceValue);
    return action.context.get(KEY_VOID_STATISTICS)?.[url] ?? this.staticStatistics[url];
  }

  private static sharedVariables(left: IJoinEntry, right: IJoinEntry): string[] {
    const names = (entry: IJoinEntry): Set<string> => {
      const pattern = <Algebra.Pattern> entry.operation;
      const out = new Set<string>();
      for (const term of [ pattern.subject, pattern.predicate, pattern.object, pattern.graph ]) {
        if (term.termType === 'Variable') {
          out.add(term.value);
        }
      }
      return out;
    };
    const rightNames = names(right);
    return [ ...names(left) ].filter(name => rightNames.has(name));
  }
}

export interface IActorRdfJoinSelectivityVoidArgs
  extends IActorArgs<IActionRdfJoinSelectivity, IMediatorTypeAccuracy, IActorRdfJoinSelectivityOutput> {
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
