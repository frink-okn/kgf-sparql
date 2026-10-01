"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ActorOptimizeQueryOperationPruneEmptySourceOperationsBounded = void 0;
const actor_optimize_query_operation_prune_empty_source_operations_1 = require("@comunica/actor-optimize-query-operation-prune-empty-source-operations");
const context_entries_1 = require("@comunica/context-entries");
const utils_query_operation_1 = require("@comunica/utils-query-operation");
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
class ActorOptimizeQueryOperationPruneEmptySourceOperationsBounded extends actor_optimize_query_operation_prune_empty_source_operations_1.ActorOptimizeQueryOperationPruneEmptySourceOperations {
    askIfSupported;
    constructor(args) {
        super(args);
        this.askIfSupported = args.useAskIfSupported;
    }
    async hasSourceResults(algebraFactory, source, input, context) {
        const mergedContext = source.context ? context.merge(source.context) : context;
        const wildcardAcceptAllExtensionFunctions = mergedContext.get(context_entries_1.KeysInitQuery.extensionFunctionsAlwaysPushdown);
        // Traversal contexts are never empty at optimization time.
        if (mergedContext.get(context_entries_1.KeysQuerySourceIdentify.traverse)) {
            return true;
        }
        const askOperation = () => algebraFactory.createAsk(input);
        const askSupported = async () => (0, utils_query_operation_1.doesShapeAcceptOperation)(await source.source.getSelectorShape(context), askOperation(), { wildcardAcceptAllExtensionFunctions });
        if (this.askIfSupported && await askSupported()) {
            return source.source.queryBoolean(askOperation(), mergedContext);
        }
        const bindingsStream = source.source.queryBindings(input, mergedContext);
        const cardinality = await new Promise((resolve, reject) => {
            bindingsStream.on('error', reject);
            bindingsStream.getProperty('metadata', (metadata) => {
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
exports.ActorOptimizeQueryOperationPruneEmptySourceOperationsBounded = ActorOptimizeQueryOperationPruneEmptySourceOperationsBounded;
//# sourceMappingURL=ActorOptimizeQueryOperationPruneEmptySourceOperationsBounded.js.map