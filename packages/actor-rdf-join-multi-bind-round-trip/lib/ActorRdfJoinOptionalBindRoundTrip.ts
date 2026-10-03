import type { IActorRdfJoinOptionalBindArgs } from '@comunica/actor-rdf-join-optional-bind';
import { ActorRdfJoinOptionalBind } from '@comunica/actor-rdf-join-optional-bind';
import type { IActionRdfJoin, IActorRdfJoinTestSideData } from '@comunica/bus-rdf-join';
import type { TestResult } from '@comunica/core';
import { passTestWithSideData } from '@comunica/core';
import type { IMediatorTypeJoinCoefficients } from '@comunica/mediatortype-join-coefficients';

/**
 * Comunica's `OPTIONAL` bind join, with each bound probe against a paged source charged one
 * request. The stock actor's formula has the shape of the inner bind join's and the same
 * zero for a paged right-hand side; on the registry corpus that put 10,004 `telephone`
 * probes and 9,533 `serviceLocation` probes, a count and a page each, behind one query's
 * two `OPTIONAL` patterns. This actor adds the missing term and changes nothing else.
 */
export class ActorRdfJoinOptionalBindRoundTrip extends ActorRdfJoinOptionalBind {
  public constructor(args: IActorRdfJoinOptionalBindRoundTripArgs) {
    super(args);
  }

  public override async getJoinCoefficients(
    action: IActionRdfJoin,
    sideData: IActorRdfJoinTestSideData,
  ): Promise<TestResult<IMediatorTypeJoinCoefficients, IActorRdfJoinTestSideData>> {
    const result = await super.getJoinCoefficients(action, sideData);
    if (result.isFailed()) {
      return result;
    }
    const coefficients = result.get();
    const side = result.getSideData();
    const [ left, right ] = side.metadatas;
    // A non-paged right-hand side is already charged its request per probe by the stock formula.
    const requestPerProbe = right.pageSize ? right.requestTime ?? 0 : 0;
    return passTestWithSideData({
      ...coefficients,
      requestTime: coefficients.requestTime + left.cardinality.value * requestPerProbe,
    }, side);
  }
}

export interface IActorRdfJoinOptionalBindRoundTripArgs extends IActorRdfJoinOptionalBindArgs {}
