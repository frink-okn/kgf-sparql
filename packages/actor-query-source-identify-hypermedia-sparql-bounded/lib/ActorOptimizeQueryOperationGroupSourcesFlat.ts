import {
  ActorOptimizeQueryOperationGroupSources,
} from '@comunica/actor-optimize-query-operation-group-sources';
import type { IActorOptimizeQueryOperationArgs } from '@comunica/bus-optimize-query-operation';
import type { IActionContext } from '@comunica/types';
import type { Algebra } from '@comunica/utils-algebra';
import { getOperationSource } from '@comunica/utils-query-operation';

/**
 * Comunica's grouping of operations by source, which hands a source the operations only it
 * answers as one operation, but leaves every other operation where it was.
 *
 * Comunica clusters a join's operations by source: one cluster per source, and one for the
 * operations several sources answer. A cluster whose source accepts it whole, such as a SPARQL
 * endpoint's, becomes one operation for that source. Once one has, Comunica also nests each
 * other cluster as a join of its own, though no source takes it and nothing is gained. The
 * operations several sources answer then join one another before the rest of the query, even
 * when they share no variable: two label patterns become a cross product of millions of rows by
 * millions, which no join can bind in blocks, so its rows are bound one at a time. Here a
 * cluster no source takes stays as separate operations of the join it came from, which plans
 * them with the rest. Where no source takes any cluster, the grouping is Comunica's own.
 */
export class ActorOptimizeQueryOperationGroupSourcesFlat extends ActorOptimizeQueryOperationGroupSources {
  public constructor(args: IActorOptimizeQueryOperationArgs) {
    super(args);
  }

  protected override async groupOperationMulti(
    clusters: Algebra.Operation[][],
    factoryMethod: (children: Algebra.Operation[], flatten: boolean) => Algebra.Operation,
    context: IActionContext,
  ): Promise<Algebra.Operation> {
    const merges = await Promise.all(clusters.map(async(cluster) => {
      const source = getOperationSource(cluster[0]);
      return await this.moveSourceAnnotationUpwardsIfPossible(factoryMethod(cluster, true), cluster, source, context);
    }));
    if (!merges.some(merged => getOperationSource(merged))) {
      return factoryMethod(merges, true);
    }
    return factoryMethod(merges.flatMap(merged => (getOperationSource(merged) ? [ merged ] : (<Algebra.Multi> merged).input)), false);
  }
}
