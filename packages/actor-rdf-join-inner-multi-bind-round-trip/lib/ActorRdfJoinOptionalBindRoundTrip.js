"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ActorRdfJoinOptionalBindRoundTrip = void 0;
const actor_rdf_join_optional_bind_1 = require("@comunica/actor-rdf-join-optional-bind");
const core_1 = require("@comunica/core");
/**
 * Comunica's `OPTIONAL` bind join, with each bound probe against a paged source charged one
 * request. The stock actor's formula has the shape of the inner bind join's and the same
 * zero for a paged right-hand side; on the registry corpus that put 10,004 `telephone`
 * probes and 9,533 `serviceLocation` probes, a count and a page each, behind one query's
 * two `OPTIONAL` patterns. This actor adds the missing term and changes nothing else.
 */
class ActorRdfJoinOptionalBindRoundTrip extends actor_rdf_join_optional_bind_1.ActorRdfJoinOptionalBind {
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
        const [left, right] = side.metadatas;
        // A non-paged right-hand side is already charged its request per probe by the stock formula.
        const requestPerProbe = right.pageSize ? right.requestTime ?? 0 : 0;
        return (0, core_1.passTestWithSideData)({
            ...coefficients,
            requestTime: coefficients.requestTime + left.cardinality.value * requestPerProbe,
        }, side);
    }
}
exports.ActorRdfJoinOptionalBindRoundTrip = ActorRdfJoinOptionalBindRoundTrip;
//# sourceMappingURL=ActorRdfJoinOptionalBindRoundTrip.js.map