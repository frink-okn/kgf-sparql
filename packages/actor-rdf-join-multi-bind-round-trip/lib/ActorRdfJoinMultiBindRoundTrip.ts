import type { IActorRdfJoinMultiBindArgs, IActorRdfJoinMultiBindTestSideData } from '@comunica/actor-rdf-join-inner-multi-bind';
import { ActorRdfJoinMultiBind } from '@comunica/actor-rdf-join-inner-multi-bind';
import type { IActionRdfJoin, IActorRdfJoinTestSideData } from '@comunica/bus-rdf-join';
import type { TestResult } from '@comunica/core';
import { failTest, passTestWithSideData } from '@comunica/core';
import type { IMediatorTypeJoinCoefficients } from '@comunica/mediatortype-join-coefficients';
import { blockJoinOn } from '@frink-okn/actor-rdf-join-multi-bind-block';
import { probeRequestTimes } from './ProbeRequestTime';

/**
 * Comunica's bind join, with each bound probe charged the requests it sends: one against a paged
 * source, and one per pattern into an entry the engine computes (see {@link probeRequestTimes}).
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
 *
 * It refuses a join that the block join named `blockJoin` binds whole from the entry this actor
 * would bind from: the block join then sends the same probes, a block of rows to each where this
 * actor sends a row, and never more requests. The two were weighed by cost, and their formulas
 * drifted apart: Comunica 5.4 put the rows each of this join's probes returns at one at most,
 * the block join kept the selectivity's estimate, and on a query over Ubergraph and Wikidata
 * this join won and sent a COUNT and a SELECT for each row, 122 rows in 300 s where the block
 * join takes 46 requests. A join the block join cannot take, or binds from another entry, or
 * binds only in part, is weighed as before.
 */
export class ActorRdfJoinMultiBindRoundTrip extends ActorRdfJoinMultiBind {
  public readonly patternRequestTime: number;
  public readonly blockJoin?: string;

  public constructor(args: IActorRdfJoinMultiBindRoundTripArgs) {
    super(args);
    this.patternRequestTime = args.patternRequestTime ?? 100;
    this.blockJoin = args.blockJoin;
  }

  public override async getJoinCoefficients(
    action: IActionRdfJoin,
    sideData: IActorRdfJoinTestSideData,
  ): Promise<TestResult<IMediatorTypeJoinCoefficients, IActorRdfJoinMultiBindTestSideData>> {
    const result = await super.getJoinCoefficients(action, sideData);
    if (result.isFailed()) {
      return result;
    }
    const coefficients = result.get();
    const side = result.getSideData();
    const [ smallest ] = side.entriesSorted;
    const blockJoin = this.blockJoin === undefined ? undefined : blockJoinOn(this.bus, this.blockJoin);
    if (blockJoin && await blockJoin.bindsEveryEntryFrom(action) === smallest.operation) {
      return failTest(`${this.name} leaves to ${blockJoin.name} a join it binds whole, from the same entry, in blocks`);
    }
    const requestPerProbe = probeRequestTimes(side.entriesSorted, this.patternRequestTime)
      .slice(1)
      .reduce((sum, time) => sum + time, 0);
    return passTestWithSideData({
      ...coefficients,
      requestTime: coefficients.requestTime + smallest.metadata.cardinality.value * requestPerProbe,
    }, side);
  }
}

export interface IActorRdfJoinMultiBindRoundTripArgs extends IActorRdfJoinMultiBindArgs {
  /**
   * The time charged per pattern of a probe into an entry the engine computes, in milliseconds,
   * when no entry of the join reports a request time to measure one by.
   * @default {100}
   */
  patternRequestTime?: number;
  /**
   * The name of the block join, on this actor's bus, that this actor leaves every join to that
   * it binds whole from the same entry.
   */
  blockJoin?: string;
}
