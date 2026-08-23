"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ActorRdfJoinSelectivityKgf = exports.KEY_KGF_STATISTICS = void 0;
const bus_rdf_join_selectivity_1 = require("@comunica/bus-rdf-join-selectivity");
const core_1 = require("@comunica/core");
const utils_algebra_1 = require("@comunica/utils-algebra");
const utils_query_operation_1 = require("@comunica/utils-query-operation");
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
/**
 * Context key carrying per-endpoint statistics. Preferred over the config
 * parameter, because a client discovers its sources at runtime.
 */
exports.KEY_KGF_STATISTICS = new core_1.ActionContextKey('@kgf/actor-rdf-join-selectivity-kgf:statistics');
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
class ActorRdfJoinSelectivityKgf extends bus_rdf_join_selectivity_1.ActorRdfJoinSelectivity {
    accuracy;
    staticStatistics;
    constructor(args) {
        super(args);
        this.accuracy = args.accuracy ?? 0.9;
        this.staticStatistics = args.statistics ? JSON.parse(args.statistics) : {};
    }
    async test(action) {
        if (action.entries.length !== 2) {
            return (0, core_1.failTest)(`${this.name} only estimates pairwise joins`);
        }
        if (!action.entries.every(entry => entry.operation.type === utils_algebra_1.Algebra.Types.PATTERN)) {
            return (0, core_1.failTest)(`${this.name} only estimates joins between triple patterns`);
        }
        if (!action.entries.some(entry => this.statsFor(entry, action))) {
            return (0, core_1.failTest)(`${this.name} found no source with published statistics`);
        }
        return (0, core_1.passTest)({ accuracy: this.accuracy });
    }
    async run(action) {
        const [left, right] = action.entries;
        // Cardinality is already memoized by ActorRdfJoin, so this costs no HTTP.
        const [leftMeta, rightMeta] = await Promise.all(action.entries.map(async (entry) => entry.output.metadata()));
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
    distinctValues(entry, variable, cardinality, action) {
        const pattern = entry.operation;
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
    statsFor(entry, action) {
        const wrapper = (0, utils_query_operation_1.getOperationSource)(entry.operation);
        if (!wrapper) {
            return undefined;
        }
        const url = String(wrapper.source.referenceValue);
        const fromContext = action.context.get(exports.KEY_KGF_STATISTICS);
        return fromContext?.[url] ?? this.staticStatistics[url];
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
exports.ActorRdfJoinSelectivityKgf = ActorRdfJoinSelectivityKgf;
//# sourceMappingURL=ActorRdfJoinSelectivityKgf.js.map