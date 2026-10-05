import type { IActorRdfJoinOptionalBindArgs } from '@comunica/actor-rdf-join-optional-bind';
import { ActorRdfJoinOptionalBind } from '@comunica/actor-rdf-join-optional-bind';
import type { IActionRdfJoin, IActorRdfJoinTestSideData } from '@comunica/bus-rdf-join';
import type { TestResult } from '@comunica/core';
import { failTest, passTestWithSideData } from '@comunica/core';
import type { IMediatorTypeJoinCoefficients } from '@comunica/mediatortype-join-coefficients';
import { blockJoinOn } from '@frink-okn/actor-rdf-join-multi-bind-block';
import { probeRequestTimes } from './ProbeRequestTime';

/**
 * Comunica's `OPTIONAL` bind join, with each bound probe charged the requests it sends. The stock
 * actor's formula has the shape of the inner bind join's and the same zeros, for a paged
 * right-hand side and for one the engine computes (see {@link probeRequestTimes}); on the
 * registry corpus the first put 10,004 `telephone` probes and 9,533 `serviceLocation` probes, a
 * count and a page each, behind one query's two `OPTIONAL` patterns. This actor adds the missing
 * term and changes nothing else.
 *
 * Like the inner round-trip join, it refuses an `OPTIONAL` that the block join named `blockJoin`
 * takes: both bind from the left rows and probe the optional pattern, which the block join does
 * a block at a time. One the block join refuses, such as an `OPTIONAL` with a `FILTER` inside,
 * is weighed as before.
 */
export class ActorRdfJoinOptionalBindRoundTrip extends ActorRdfJoinOptionalBind {
  public readonly patternRequestTime: number;
  public readonly blockJoin?: string;

  public constructor(args: IActorRdfJoinOptionalBindRoundTripArgs) {
    super(args);
    this.patternRequestTime = args.patternRequestTime ?? 100;
    this.blockJoin = args.blockJoin;
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
    const blockJoin = this.blockJoin === undefined ? undefined : blockJoinOn(this.bus, this.blockJoin);
    if (blockJoin && await blockJoin.bindsEveryEntryFrom(action) === action.entries[0].operation) {
      return failTest(`${this.name} leaves to ${blockJoin.name} an OPTIONAL it joins in blocks`);
    }
    const [ left ] = side.metadatas;
    const [ , requestPerProbe ] = probeRequestTimes(
      action.entries.map((entry, index) => ({ operation: entry.operation, metadata: side.metadatas[index] })),
      this.patternRequestTime,
    );
    return passTestWithSideData({
      ...coefficients,
      requestTime: coefficients.requestTime + left.cardinality.value * requestPerProbe,
    }, side);
  }
}

export interface IActorRdfJoinOptionalBindRoundTripArgs extends IActorRdfJoinOptionalBindArgs {
  /**
   * The time charged per pattern of a probe into an entry the engine computes, in milliseconds,
   * when no entry of the join reports a request time to measure one by.
   * @default {100}
   */
  patternRequestTime?: number;
  /**
   * The name of the OPTIONAL block join, on this actor's bus, that this actor leaves every
   * `OPTIONAL` to that it takes.
   */
  blockJoin?: string;
}
