/**
 * Per-endpoint statistics used to estimate join selectivity.
 *
 * Keyed by the endpoint URL, which is what Comunica exposes as
 * `IQuerySource.referenceValue`. There is no source-type field on a Comunica
 * query source, so URL identity is the only sound discriminator; see the KGF
 * guidance doc, section 5.2.2.
 */
export interface IKgfPredicateStats {
    /** Number of distinct subjects of this predicate. */
    distinctSubjects?: number;
    /** Number of distinct objects of this predicate. */
    distinctObjects?: number;
    /** Number of triples with this predicate. */
    triples?: number;
}
export interface IKgfDatasetStats {
    /** Dataset-wide distinct subject count. Used as a ceiling when per-predicate counts are absent. */
    distinctSubjects?: number;
    /** Dataset-wide distinct object count. */
    distinctObjects?: number;
    /** Per-predicate counts, keyed by predicate IRI. The tier-1 input. */
    predicates?: Record<string, IKgfPredicateStats>;
}
/** Endpoint URL -> statistics. */
export type KgfStatisticsRegistry = Record<string, IKgfDatasetStats>;
//# sourceMappingURL=KgfStatistics.d.ts.map