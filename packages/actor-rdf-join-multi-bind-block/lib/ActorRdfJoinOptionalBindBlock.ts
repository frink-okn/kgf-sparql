import type {
  IActionRdfJoin,
  IActorRdfJoinInternalOptions,
  IActorRdfJoinOutputInner,
} from '@comunica/bus-rdf-join';
import { ActorRdfJoin } from '@comunica/bus-rdf-join';
import type { TestResult } from '@comunica/core';
import { failTest, passTest } from '@comunica/core';
import type { IJoinEntryWithMetadata, MetadataBindings } from '@comunica/types';
import type {
  IActorRdfJoinMultiBindBlockArgs,
  IActorRdfJoinMultiBindBlockTestSideData,
  IBindBlockPlan,
} from './ActorRdfJoinMultiBindBlock';
import { ActorRdfJoinMultiBindBlock } from './ActorRdfJoinMultiBindBlock';

/**
 * An `OPTIONAL` joined in blocks: the left rows' values go to the optional pattern's source
 * 256 at a time, as the inner block join sends them, and each left row comes back with what
 * it matched, or alone when it matched nothing.
 *
 * Comunica joins an `OPTIONAL` one of three ways: per left row (`optional-bind`), each row's
 * values sent on their own, a `/count` and a page apiece against KGF; or by reading the
 * optional pattern whole (`optional-hash`, `optional-nested-loop`). Of 38 agent-written
 * queries that ran out of budget, 13 spent it on per-row probes, mostly labels and types
 * fetched one subject at a time, and 6 on reading a whole predicate, such as `rdfs:comment`,
 * for a few hundred rows. Only inner joins had a way between the two.
 *
 * The left entry is always the one bound, since every left row is in the output whether or
 * not it matched. The optional pattern must be one this actor can probe: an operation on a
 * source that takes bindings, a union of such, or a join of such, as for the inner block
 * join. It is refused when it carries the `OPTIONAL`'s filter, which Comunica marks as an
 * operation that must be bound per row; and, as the inner block join is, when a variable it
 * shares with the left rows may be unbound: a left row's matches are told by its values, and
 * such a row would match on values its probe filled in.
 */
export class ActorRdfJoinOptionalBindBlock extends ActorRdfJoinMultiBindBlock {
  protected static override readonly joinOptions: IActorRdfJoinInternalOptions = {
    ...ActorRdfJoinMultiBindBlock.joinOptions,
    logicalType: 'optional',
    physicalName: 'bind-block',
    limitEntriesMin: false,
  };

  public constructor(args: IActorRdfJoinOptionalBindBlockArgs) {
    // Comunica's OPTIONAL bind join scales its selectivities by 0.000001 where its inner one uses
    // 0.0001, and this actor's cost is the inner block join's formula: with the inner modifier it
    // priced its rows at a hundred times the stock join's, and lost even where it sent a
    // thirteenth of the requests. Components.js fills in the inherited default, so the engine's
    // config sets the OPTIONAL one; built without a value, the actor takes it here.
    super({ ...args, selectivityModifier: args.selectivityModifier ?? 0.000001 });
  }

  protected override async plan(
    action: IActionRdfJoin,
    metadatas: MetadataBindings[],
  ): Promise<TestResult<IBindBlockPlan>> {
    const [ left, right ] = action.entries
      .map((entry, i): IJoinEntryWithMetadata => ({ ...entry, metadata: metadatas[i] }));
    const rows = left.metadata.cardinality.value;
    if (!Number.isFinite(rows) || rows <= 0) {
      return failTest(`${this.name} needs a left entry of known, non-zero size`);
    }
    const known = new Set(left.metadata.variables.map(variable => variable.variable.value));
    const parts = await this.probeParts(right.operation, known, action.context, new Map());
    if (!parts) {
      return failTest(`${this.name} found no source that takes bindings for the optional pattern and a variable it shares`);
    }
    return passTest({ first: left, steps: [{ entry: right, parts }], remaining: [], firstIndex: 0, stepIndexes: [ 1 ]});
  }

  protected override async getOutput(
    action: IActionRdfJoin,
    sideData: IActorRdfJoinMultiBindBlockTestSideData,
  ): Promise<IActorRdfJoinOutputInner> {
    const { first, steps } = sideData.plan;
    // A left row is told by its values, which every row it joins to keeps: the variables it
    // shares are bound in it, and the others are the optional pattern's alone.
    const variables = first.metadata.variables.map(variable => variable.variable.value);
    const bindingsStream = this.blockStream(first, steps, action.context, async(rows, join, emit) => {
      const matched = new Set<string>();
      await join(rows, async(joined) => {
        for (const row of joined) {
          matched.add(ActorRdfJoinMultiBindBlock.partialKeyOf(row, variables));
        }
        await emit(joined);
      });
      const alone = rows.filter(row => !matched.has(ActorRdfJoinMultiBindBlock.partialKeyOf(row, variables)));
      if (alone.length > 0) {
        await emit(alone);
      }
    });
    return {
      result: {
        type: 'bindings',
        bindingsStream,
        metadata: async() => await this.constructResultMetadata(
          action.entries,
          await ActorRdfJoin.getMetadatas(action.entries),
          action.context,
          {},
          true,
        ),
      },
      physicalPlanMetadata: {
        probes: steps[0].parts.reduce((sum, part) => sum + part.leaves.length, 0),
        blockSize: this.blockSize,
        blocksInFlight: this.blocksInFlight,
      },
    };
  }
}

export interface IActorRdfJoinOptionalBindBlockArgs extends IActorRdfJoinMultiBindBlockArgs {}
