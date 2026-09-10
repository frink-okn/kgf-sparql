"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ActorRdfJoinMultiBindRoundTrip = void 0;
const actor_rdf_join_inner_multi_bind_1 = require("@comunica/actor-rdf-join-inner-multi-bind");
const core_1 = require("@comunica/core");
/**
 * Comunica's bind join, with each bound probe against a paged source charged one request.
 *
 * The stock actor prices a probe against a remaining entry as that entry's initial request
 * cost plus a per-item cost. Comunica takes a paged source's initial cost as zero, because
 * by the time an entry's metadata is known its first page has been fetched. That holds for
 * the entry as planned; it does not hold for the bound probes the join will send, each of
 * which is a new request. Against a source that reports exact cardinalities and large
 * pages, 888 probes on one registry query were priced at a few milliseconds, and per-row
 * binding beat pushing the bindings in blocks by two orders of magnitude, at 1,791
 * requests instead of 22. This actor adds the term the stock formula already applies to
 * non-paged sources, and changes nothing else: same defaults, same other coefficients.
 */
class ActorRdfJoinMultiBindRoundTrip extends actor_rdf_join_inner_multi_bind_1.ActorRdfJoinMultiBind {
    constructor(args) {
        super(args);
    }
    async getJoinCoefficients(action, sideData) {
        const result = await super.getJoinCoefficients(action, sideData);
        if (result.isFailed()) {
            return result;
        }
        const coefficients = result.get();
        const side = result.getSideData();
        const [smallest, ...remaining] = side.entriesSorted;
        // A non-paged entry is already charged its request per probe by the stock formula.
        const requestPerProbe = remaining.reduce((sum, entry) => sum + (entry.metadata.pageSize ? entry.metadata.requestTime ?? 0 : 0), 0);
        return (0, core_1.passTestWithSideData)({
            ...coefficients,
            requestTime: coefficients.requestTime + smallest.metadata.cardinality.value * requestPerProbe,
        }, side);
    }
}
exports.ActorRdfJoinMultiBindRoundTrip = ActorRdfJoinMultiBindRoundTrip;
//# sourceMappingURL=ActorRdfJoinMultiBindRoundTrip.js.map