import type { IActorRdfJoinOptionalBindArgs } from '@comunica/actor-rdf-join-optional-bind';
import { ActorRdfJoinOptionalBind } from '@comunica/actor-rdf-join-optional-bind';
import type { IActionRdfJoin, IActorRdfJoinTestSideData } from '@comunica/bus-rdf-join';
import type { TestResult } from '@comunica/core';
import type { IMediatorTypeJoinCoefficients } from '@comunica/mediatortype-join-coefficients';
/**
 * Comunica's `OPTIONAL` bind join, with each bound probe against a paged source charged one
 * request. The stock actor's formula has the shape of the inner bind join's and the same
 * zero for a paged right-hand side; on the registry corpus that put 10,004 `telephone`
 * probes and 9,533 `serviceLocation` probes, a count and a page each, behind one query's
 * two `OPTIONAL` patterns. This actor adds the missing term and changes nothing else.
 */
export declare class ActorRdfJoinOptionalBindRoundTrip extends ActorRdfJoinOptionalBind {
    constructor(args: IActorRdfJoinOptionalBindRoundTripArgs);
    getJoinCoefficients(action: IActionRdfJoin, sideData: IActorRdfJoinTestSideData): Promise<TestResult<IMediatorTypeJoinCoefficients, IActorRdfJoinTestSideData>>;
}
export interface IActorRdfJoinOptionalBindRoundTripArgs extends IActorRdfJoinOptionalBindArgs {
}
//# sourceMappingURL=ActorRdfJoinOptionalBindRoundTrip.d.ts.map