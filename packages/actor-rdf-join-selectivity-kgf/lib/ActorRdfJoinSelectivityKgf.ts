import type { IActionRdfJoinSelectivity, IActorRdfJoinSelectivityOutput } from '@comunica/bus-rdf-join-selectivity';
import { ActorRdfJoinSelectivity } from '@comunica/bus-rdf-join-selectivity';
import type { IActorArgs, TestResult } from '@comunica/core';
import { ActionContextKey, failTest, passTest } from '@comunica/core';
import type { IMediatorTypeAccuracy } from '@comunica/mediatortype-accuracy';
import type { IJoinEntry } from '@comunica/types';
import { Algebra } from '@comunica/utils-algebra';
import { getOperationSource } from '@comunica/utils-query-operation';
import type { IKgfDatasetStats, KgfStatisticsRegistry } from './KgfStatistics';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/**
 * Context key carrying per-endpoint statistics. Preferred over the config
 * parameter, because a client discovers its sources at runtime.
 */
export const KEY_KGF_STATISTICS = new ActionContextKey<KgfStatisticsRegistry>(
  '@kgf/actor-rdf-join-selectivity-kgf:statistics',
);

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
export class ActorRdfJoinSelectivityKgf extends ActorRdfJoinSelectivity {
  private readonly accuracy: number;
  private readonly staticStatistics: KgfStatisticsRegistry;

  public constructor(args: IActorRdfJoinSelectivityKgfArgs) {
    super(args);
    this.accuracy = args.accuracy ?? 0.9;
    this.staticStatistics = args.statistics ? <KgfStatisticsRegistry> JSON.parse(args.statistics) : {};
  }

  public async test(action: IActionRdfJoinSelectivity): Promise<TestResult<IMediatorTypeAccuracy>> {
    if (action.entries.length !== 2) {
      return failTest(`${this.name} only estimates pairwise joins`);
    }
    if (!action.entries.every(entry => entry.operation.type === Algebra.Types.PATTERN)) {
      return failTest(`${this.name} only estimates joins between triple patterns`);
    }
    if (!action.entries.some(entry => this.statsFor(entry, action))) {
      return failTest(`${this.name} found no source with published statistics`);
    }
    return passTest({ accuracy: this.accuracy });
  }

  public async run(action: IActionRdfJoinSelectivity): Promise<IActorRdfJoinSelectivityOutput> {
    const [ left, right ] = action.entries;
    // Cardinality is already memoized by ActorRdfJoin, so this costs no HTTP.
    const [ leftMeta, rightMeta ] = await Promise.all(action.entries.map(async entry => entry.output.metadata()));
    const leftCard = leftMeta.cardinality.value;
    const rightCard = rightMeta.cardinality.value;
    if (!Number.isFinite(leftCard) || !Number.isFinite(rightCard) || leftCard <= 0 || rightCard <= 0) {
      return { selectivity: 1 };
    }

    const shared = ActorRdfJoinSelectivityKgf.sharedVariables(left, right);
    if (shared.length === 0) {
      // No shared variable: the join really is a cross product.
      return { selectivity: 1 };
    }

    let selectivity = 1;
    for (const variable of shared) {
      const leftDistinct = this.distinctValues(left, variable, leftCard, action);
      const rightDistinct = this.distinctValues(right, variable, rightCard, action);
      selectivity *= 1 / Math.max(leftDistinct, rightDistinct, 1);
    }
    return { selectivity: Math.min(Math.max(selectivity, Number.MIN_VALUE), 1) };
  }

  /**
   * Estimated number of distinct values a join variable takes in one pattern.
   * Falls through tiers: per-predicate count, then rdf:type reasoning, then the
   * dataset-wide ceiling, then the pattern cardinality.
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
    const perPredicate = predicate ? stats?.predicates?.[predicate] : undefined;

    if (pattern.subject.termType === 'Variable' && pattern.subject.value === variable) {
      // ?s <p> <o> with a bound object selects a subset, so the count is a ceiling, not an equality.
      if (perPredicate?.distinctSubjects !== undefined) {
        return Math.min(perPredicate.distinctSubjects, cardinality);
      }
      // `?s rdf:type <C>` names each subject at most once, so distinct == cardinality.
      if (predicate === RDF_TYPE && pattern.object.termType !== 'Variable') {
        return cardinality;
      }
      return Math.min(cardinality, stats?.distinctSubjects ?? Number.POSITIVE_INFINITY);
    }

    if (pattern.object.termType === 'Variable' && pattern.object.value === variable) {
      if (perPredicate?.distinctObjects !== undefined) {
        return Math.min(perPredicate.distinctObjects, cardinality);
      }
      return Math.min(cardinality, stats?.distinctObjects ?? Number.POSITIVE_INFINITY);
    }

    // Variable in predicate or graph position: no statistic applies.
    return cardinality;
  }

  /** Statistics for the endpoint this entry is assigned to, if it is a known KGF source. */
  private statsFor(entry: IJoinEntry, action: IActionRdfJoinSelectivity): IKgfDatasetStats | undefined {
    const wrapper = getOperationSource(entry.operation);
    if (!wrapper) {
      return undefined;
    }
    const url = String(wrapper.source.referenceValue);
    const fromContext = action.context.get(KEY_KGF_STATISTICS);
    return fromContext?.[url] ?? this.staticStatistics[url];
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

export interface IActorRdfJoinSelectivityKgfArgs
  extends IActorArgs<IActionRdfJoinSelectivity, IMediatorTypeAccuracy, IActorRdfJoinSelectivityOutput> {
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
