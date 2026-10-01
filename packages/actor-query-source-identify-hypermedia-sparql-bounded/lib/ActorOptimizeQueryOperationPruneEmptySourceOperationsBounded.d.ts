import type { IActorOptimizeQueryOperationPruneEmptySourceOperationsArgs } from '@comunica/actor-optimize-query-operation-prune-empty-source-operations';
import { ActorOptimizeQueryOperationPruneEmptySourceOperations } from '@comunica/actor-optimize-query-operation-prune-empty-source-operations';
import type { IActionContext, IQuerySourceWrapper } from '@comunica/types';
import type { Algebra, AlgebraFactory } from '@comunica/utils-algebra';
/**
 * Comunica's source selection, which drops a source from an operation it has no results for,
 * confirming with an ASK only a cardinality that is unknown.
 *
 * Comunica learns whether a source has results for an operation from the operation's
 * cardinality. An exact one decides; an estimate above zero is confirmed with an ASK, since
 * statistics such as VoID can promise matches a particular pattern lacks. Here only an
 * infinite estimate is: what a SPARQL source reports when its COUNT failed or timed out. A
 * finite one is accepted as it is. From this engine's SPARQL sources it is a COUNT that
 * reached its cap, which proves there are matches, and the ASK would be one more request to
 * an endpoint that may limit its clients' rate. (Comunica's own finite estimates for SPARQL
 * endpoints, built locally from service descriptions, are off in this engine.) Skipping an ASK
 * never loses results: it can only let source selection drop a source, so keeping one that
 * turns out empty costs requests, not answers.
 */
export declare class ActorOptimizeQueryOperationPruneEmptySourceOperationsBounded extends ActorOptimizeQueryOperationPruneEmptySourceOperations {
    private readonly askIfSupported;
    constructor(args: IActorOptimizeQueryOperationPruneEmptySourceOperationsArgs);
    hasSourceResults(algebraFactory: AlgebraFactory, source: IQuerySourceWrapper, input: Algebra.Operation, context: IActionContext): Promise<boolean>;
}
//# sourceMappingURL=ActorOptimizeQueryOperationPruneEmptySourceOperationsBounded.d.ts.map