/**
 * VoID statistics, in the shape of the VoID vocabulary itself.
 *
 * Field names deliberately mirror `void:` terms and the `IVoidDataset` interface
 * that `@comunica/actor-rdf-metadata-extract-void` builds, so a parsed VoID
 * description can be handed over directly once upstream exposes it (it currently
 * captures the dataset in a closure and publishes only `getCardinality`).
 */
export interface IVoidPropertyPartition {
    /** void:triples */
    triples?: number;
    /** void:distinctSubjects */
    distinctSubjects?: number;
    /** void:distinctObjects */
    distinctObjects?: number;
}
export interface IVoidClassPartition {
    /** void:entities */
    entities?: number;
}
export interface IVoidDatasetStatistics {
    /** void:triples */
    triples?: number;
    /** void:distinctSubjects, dataset-wide */
    distinctSubjects?: number;
    /** void:distinctObjects, dataset-wide */
    distinctObjects?: number;
    /** void:propertyPartition, keyed by predicate IRI */
    propertyPartitions?: Record<string, IVoidPropertyPartition>;
    /** void:classPartition, keyed by class IRI */
    classPartitions?: Record<string, IVoidClassPartition>;
}
/** Endpoint URL -> VoID statistics for the dataset that endpoint serves. */
export type VoidStatisticsRegistry = Record<string, IVoidDatasetStatistics>;
/** Optional lazy provider on pattern metadata; invoked only when estimating a join. */
export declare const VOID_STATISTICS_PROVIDER = "@kgf:getVoidStatistics";
export type VoidStatisticsProvider = () => Promise<IVoidDatasetStatistics | undefined>;
//# sourceMappingURL=VoidStatistics.d.ts.map