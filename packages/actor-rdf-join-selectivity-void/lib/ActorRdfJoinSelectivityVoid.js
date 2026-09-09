"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ActorRdfJoinSelectivityVoid = exports.KEY_VOID_STATISTICS = void 0;
const bus_rdf_join_selectivity_1 = require("@comunica/bus-rdf-join-selectivity");
const core_1 = require("@comunica/core");
const utils_algebra_1 = require("@comunica/utils-algebra");
const utils_query_operation_1 = require("@comunica/utils-query-operation");
const VoidStatistics_1 = require("./VoidStatistics");
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
/**
 * Context key carrying VoID statistics, keyed by endpoint URL.
 *
 * Endpoint URL is `IQuerySource.referenceValue`. Comunica query sources expose no
 * type field and the concrete class is a wrapper stack, so URL identity is the
 * only sound way to attach statistics to a source.
 */
exports.KEY_VOID_STATISTICS = new core_1.ActionContextKey('@kgf/actor-rdf-join-selectivity-void:statistics');
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
class ActorRdfJoinSelectivityVoid extends bus_rdf_join_selectivity_1.ActorRdfJoinSelectivity {
    accuracy;
    safetyFactor;
    staticStatistics;
    constructor(args) {
        super(args);
        this.accuracy = args.accuracy ?? 0.8;
        this.safetyFactor = args.safetyFactor ?? 1;
        this.staticStatistics = args.statistics ? JSON.parse(args.statistics) : {};
    }
    async test(action) {
        if (action.entries.length !== 2) {
            return (0, core_1.failTest)(`${this.name} only estimates pairwise joins`);
        }
        if (!action.entries.every(entry => entry.operation.type === utils_algebra_1.Algebra.Types.PATTERN)) {
            return (0, core_1.failTest)(`${this.name} only estimates joins between triple patterns`);
        }
        if (ActorRdfJoinSelectivityVoid.sharedVariables(action.entries[0], action.entries[1]).length === 0) {
            return (0, core_1.failTest)(`${this.name} found no shared variables`);
        }
        const statistics = await Promise.all(action.entries.map(entry => this.statsFor(entry, action)));
        if (!statistics.some(Boolean)) {
            return (0, core_1.failTest)(`${this.name} found no source with published VoID statistics`);
        }
        return (0, core_1.passTest)({ accuracy: this.accuracy });
    }
    async run(action) {
        const [left, right] = action.entries;
        // Cardinality is memoized by ActorRdfJoin, so reading it costs no HTTP.
        const metadatas = await Promise.all(action.entries.map(async (entry) => entry.output.metadata()));
        const [leftCard, rightCard] = metadatas.map(meta => meta.cardinality.value);
        const [leftStats, rightStats] = await Promise.all(action.entries.map(entry => this.statsFor(entry, action)));
        if (![leftCard, rightCard].every(card => Number.isFinite(card) && card > 0)) {
            return { selectivity: 1 };
        }
        const shared = ActorRdfJoinSelectivityVoid.sharedVariables(left, right);
        if (shared.length === 0) {
            return { selectivity: 1 };
        }
        const crossProduct = leftCard * rightCard;
        let estimate = crossProduct;
        for (const variable of shared) {
            estimate /= Math.max(this.distinctValues(left, variable, leftCard, leftStats), this.distinctValues(right, variable, rightCard, rightStats), 1);
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
    distinctValues(entry, variable, cardinality, stats) {
        const pattern = entry.operation;
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
    async statsFor(entry, action) {
        const wrapper = (0, utils_query_operation_1.getOperationSource)(entry.operation);
        if (!wrapper) {
            return undefined;
        }
        const url = String(wrapper.source.referenceValue);
        const supplied = action.context.get(exports.KEY_VOID_STATISTICS)?.[url] ?? this.staticStatistics[url];
        if (supplied) {
            return supplied;
        }
        const metadata = await entry.output.metadata();
        const provider = metadata[VoidStatistics_1.VOID_STATISTICS_PROVIDER];
        if (typeof provider === 'function') {
            try {
                return await provider();
            }
            catch {
                // Missing or unavailable statistics must leave the default estimator usable.
            }
        }
        return undefined;
    }
    static sharedVariables(left, right) {
        const names = (entry) => {
            const pattern = entry.operation;
            const out = new Set();
            for (const term of [pattern.subject, pattern.predicate, pattern.object, pattern.graph]) {
                if (term.termType === 'Variable') {
                    out.add(term.value);
                }
            }
            return out;
        };
        const rightNames = names(right);
        return [...names(left)].filter(name => rightNames.has(name));
    }
}
exports.ActorRdfJoinSelectivityVoid = ActorRdfJoinSelectivityVoid;
//# sourceMappingURL=ActorRdfJoinSelectivityVoid.js.map