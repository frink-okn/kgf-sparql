import type {
  IActorOptimizeQueryOperationPruneEmptySourceOperationsArgs,
} from '@comunica/actor-optimize-query-operation-prune-empty-source-operations';
import {
  ActorOptimizeQueryOperationPruneEmptySourceOperations,
} from '@comunica/actor-optimize-query-operation-prune-empty-source-operations';
import { KeysInitQuery, KeysQueryOperation, KeysQuerySourceIdentify } from '@comunica/context-entries';
import type { IActionContext, IQuerySourceWrapper, QueryResultCardinality } from '@comunica/types';
import type { Algebra, AlgebraFactory } from '@comunica/utils-algebra';
import { doesShapeAcceptOperation } from '@comunica/utils-query-operation';

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
export class ActorOptimizeQueryOperationPruneEmptySourceOperationsBounded
  extends ActorOptimizeQueryOperationPruneEmptySourceOperations {
  private readonly askIfSupported: boolean;

  public constructor(args: IActorOptimizeQueryOperationPruneEmptySourceOperationsArgs) {
    super(args);
    this.askIfSupported = args.useAskIfSupported;
  }

  public override async hasSourceResults(
    algebraFactory: AlgebraFactory,
    source: IQuerySourceWrapper,
    input: Algebra.Operation,
    context: IActionContext,
  ): Promise<boolean> {
    const mergedContext = source.context ? context.merge(source.context) : context;
    const wildcardAcceptAllExtensionFunctions = mergedContext.get(KeysInitQuery.extensionFunctionsAlwaysPushdown);
    // Traversal contexts are never empty at optimization time.
    if (mergedContext.get(KeysQuerySourceIdentify.traverse)) {
      return true;
    }
    // The target of a SERVICE SILENT clause is never dropped: when it fails, the clause must
    // give one empty solution rather than none, as Comunica's own source selection keeps it.
    if (mergedContext.get(KeysQueryOperation.silent)) {
      return true;
    }
    const askOperation = (): Algebra.Ask => algebraFactory.createAsk(input);
    const askSupported = async(): Promise<boolean> => doesShapeAcceptOperation(
      await source.source.getSelectorShape(context),
      askOperation(),
      { wildcardAcceptAllExtensionFunctions },
    );
    if (this.askIfSupported && await askSupported()) {
      return source.source.queryBoolean(askOperation(), mergedContext);
    }
    const bindingsStream = source.source.queryBindings(input, mergedContext);
    const cardinality = await new Promise<QueryResultCardinality>((resolve, reject) => {
      bindingsStream.on('error', reject);
      bindingsStream.getProperty('metadata', (metadata: { cardinality: QueryResultCardinality }) => {
        bindingsStream.destroy();
        resolve(metadata.cardinality);
      });
    });
    if (cardinality.type === 'estimate' && cardinality.value === Number.POSITIVE_INFINITY && await askSupported()) {
      return source.source.queryBoolean(askOperation(), mergedContext);
    }
    return cardinality.value > 0;
  }
}
