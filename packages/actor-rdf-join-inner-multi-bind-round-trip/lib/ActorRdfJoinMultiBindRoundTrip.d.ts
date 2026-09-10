import type { IActorRdfJoinMultiBindArgs, IActorRdfJoinMultiBindTestSideData } from '@comunica/actor-rdf-join-inner-multi-bind';
import { ActorRdfJoinMultiBind } from '@comunica/actor-rdf-join-inner-multi-bind';
import type { IActionRdfJoin, IActorRdfJoinTestSideData } from '@comunica/bus-rdf-join';
import type { TestResult } from '@comunica/core';
import type { IMediatorTypeJoinCoefficients } from '@comunica/mediatortype-join-coefficients';
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
export declare class ActorRdfJoinMultiBindRoundTrip extends ActorRdfJoinMultiBind {
    constructor(args: IActorRdfJoinMultiBindRoundTripArgs);
    getJoinCoefficients(action: IActionRdfJoin, sideData: IActorRdfJoinTestSideData): Promise<TestResult<IMediatorTypeJoinCoefficients, IActorRdfJoinMultiBindTestSideData>>;
}
export interface IActorRdfJoinMultiBindRoundTripArgs extends IActorRdfJoinMultiBindArgs {
}
//# sourceMappingURL=ActorRdfJoinMultiBindRoundTrip.d.ts.map