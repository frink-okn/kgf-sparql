"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ActorRdfJoinSelectivityBound = exports.KEY_SELECTIVITY_BOUND_DELEGATING = void 0;
const bus_rdf_join_selectivity_1 = require("@comunica/bus-rdf-join-selectivity");
const core_1 = require("@comunica/core");
const utils_algebra_1 = require("@comunica/utils-algebra");
const utils_query_operation_1 = require("@comunica/utils-query-operation");
/**
 * Set while this actor asks the selectivity bus for the estimate it bounds, so that the
 * nested mediation reaches the actor that would otherwise have answered.
 */
exports.KEY_SELECTIVITY_BOUND_DELEGATING = new core_1.ActionContextKey('@kgf/actor-rdf-join-selectivity-bound:delegating');
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
class ActorRdfJoinSelectivityBound extends bus_rdf_join_selectivity_1.ActorRdfJoinSelectivity {
    mediatorJoinSelectivity;
    accuracy;
    constructor(args) {
        super(args);
        this.mediatorJoinSelectivity = args.mediatorJoinSelectivity;
        this.accuracy = args.accuracy ?? 0.9;
    }
    async test(action) {
        if (action.context.get(exports.KEY_SELECTIVITY_BOUND_DELEGATING)) {
            return (0, core_1.failTest)(`${this.name} is asking the other selectivity actors`);
        }
        if (action.entries.length < 2) {
            return (0, core_1.failTest)(`${this.name} only bounds joins of two or more entries`);
        }
        return (0, core_1.passTest)({ accuracy: this.accuracy });
    }
    async run(action) {
        const delegated = await this.delegate(action);
        // Cardinality is memoized by ActorRdfJoin, so reading it costs no HTTP.
        const metadatas = await Promise.all(action.entries.map(async (entry) => entry.output.metadata()));
        const cardinalities = metadatas.map(metadata => metadata.cardinality.value);
        const product = cardinalities.reduce((acc, value) => acc * value, 1);
        if (!Number.isFinite(product) || product <= 0) {
            return { selectivity: delegated };
        }
        const bound = ActorRdfJoinSelectivityBound.upperBound(action.entries, metadatas);
        if (bound >= product * delegated) {
            return { selectivity: delegated };
        }
        this.logDebug(action.context, 'Bounded join selectivity', () => ({
            entries: action.entries.length,
            cardinalities,
            estimate: product * delegated,
            bound,
        }));
        return { selectivity: Math.max(bound / product, Number.MIN_VALUE) };
    }
    /**
     * The estimate this actor caps: whatever the bus answers without it. When no other actor
     * answers, the product is the only estimate there is; one that fails while answering fails
     * the estimate, as it would without this actor.
     */
    async delegate(action) {
        const delegated = await this.mediatorJoinSelectivity.mediateTestable({
            ...action,
            context: action.context.set(exports.KEY_SELECTIVITY_BOUND_DELEGATING, true),
        });
        return delegated.isPassed() ? delegated.get().selectivity : 1;
    }
    /**
     * An upper bound on the number of rows the join of `entries` produces, or `Infinity`
     * when no entry qualifies as a filter, or an entry whose size is only estimated cannot
     * be removed.
     */
    static upperBound(entries, metadatas) {
        if (metadatas.some(metadata => metadata.variables.some(variable => variable.canBeUndef))) {
            return Number.POSITIVE_INFINITY;
        }
        const variables = metadatas.map(metadata => new Set(metadata.variables.map(variable => variable.variable.value)));
        const cardinalities = metadatas.map(metadata => metadata.cardinality.value);
        const exact = metadatas.map((metadata, i) => metadata.cardinality.type === 'exact' && ActorRdfJoinSelectivityBound.counted(entries[i]));
        const multiplicities = entries.map(entry => ActorRdfJoinSelectivityBound.multiplicity(entry.operation));
        const remaining = new Set(entries.map((_, i) => i));
        let factor = 1;
        let removed = true;
        while (removed && remaining.size > 1) {
            removed = false;
            // Estimates first, since none may remain; then the largest.
            const candidates = [...remaining]
                .filter(i => Number.isFinite(multiplicities[i]))
                .sort((left, right) => Number(exact[left]) - Number(exact[right]) || cardinalities[right] - cardinalities[left]);
            for (const i of candidates) {
                const others = new Set();
                for (const j of remaining) {
                    if (j !== i) {
                        for (const name of variables[j]) {
                            others.add(name);
                        }
                    }
                }
                if ([...variables[i]].every(name => others.has(name))) {
                    remaining.delete(i);
                    factor *= multiplicities[i];
                    removed = true;
                    break;
                }
            }
        }
        if (remaining.size === entries.length || [...remaining].some(i => !exact[i])) {
            return Number.POSITIVE_INFINITY;
        }
        return [...remaining].reduce((acc, i) => acc * cardinalities[i], factor);
    }
    /**
     * Whether an entry's size is the count its sources gave: the entry was not computed by a
     * join, and its operation is a source's, or a union of sources' operations, whose size is
     * the sum of theirs.
     */
    static counted(entry) {
        return !entry.operationModified && ActorRdfJoinSelectivityBound.sourced(entry.operation);
    }
    static sourced(operation) {
        return (0, utils_query_operation_1.getOperationSource)(operation) !== undefined || (operation.type === utils_algebra_1.Algebra.Types.UNION &&
            operation.input.every(input => ActorRdfJoinSelectivityBound.sourced(input)));
    }
    /**
     * How many times one solution can occur in the operation's output, assuming every
     * source answers a triple pattern with a set. `Infinity` when it cannot be told.
     */
    static multiplicity(operation) {
        switch (operation.type) {
            case utils_algebra_1.Algebra.Types.PATTERN:
            case utils_algebra_1.Algebra.Types.DISTINCT:
                return 1;
            case utils_algebra_1.Algebra.Types.JOIN:
                return operation.input
                    .reduce((acc, input) => acc * ActorRdfJoinSelectivityBound.multiplicity(input), 1);
            case utils_algebra_1.Algebra.Types.UNION:
                return operation.input
                    .reduce((acc, input) => acc + ActorRdfJoinSelectivityBound.multiplicity(input), 0);
            case utils_algebra_1.Algebra.Types.FILTER:
                return ActorRdfJoinSelectivityBound.multiplicity(operation.input);
            default:
                return Number.POSITIVE_INFINITY;
        }
    }
}
exports.ActorRdfJoinSelectivityBound = ActorRdfJoinSelectivityBound;
//# sourceMappingURL=ActorRdfJoinSelectivityBound.js.map