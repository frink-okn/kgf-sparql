"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ActorQuerySourceIdentifyKgf = void 0;
const bus_query_source_identify_1 = require("@comunica/bus-query-source-identify");
const context_entries_1 = require("@comunica/context-entries");
const core_1 = require("@comunica/core");
const utils_bindings_factory_1 = require("@comunica/utils-bindings-factory");
const QuerySourceKgf_1 = require("./QuerySourceKgf");
/** Identifies explicitly typed KGF sources without fetching any fragment or statistics. */
class ActorQuerySourceIdentifyKgf extends bus_query_source_identify_1.ActorQuerySourceIdentify {
    mediatorHttp;
    mediatorMergeBindingsContext;
    constructor(args) {
        super(args);
        this.mediatorHttp = args.mediatorHttp;
        this.mediatorMergeBindingsContext = args.mediatorMergeBindingsContext;
    }
    async test(action) {
        if (action.querySourceUnidentified.type !== 'kgf' || typeof action.querySourceUnidentified.value !== 'string') {
            return (0, core_1.failTest)(`${this.name} requires a URL source with type 'kgf'`);
        }
        return (0, core_1.passTestVoid)();
    }
    async run(action) {
        const dataFactory = action.context.getSafe(context_entries_1.KeysInitQuery.dataFactory);
        return {
            querySource: {
                source: new QuerySourceKgf_1.QuerySourceKgf(action.querySourceUnidentified.value, this.mediatorHttp, dataFactory, await utils_bindings_factory_1.BindingsFactory.create(this.mediatorMergeBindingsContext, action.context, dataFactory)),
                context: action.querySourceUnidentified.context ?? new core_1.ActionContext(),
            },
        };
    }
}
exports.ActorQuerySourceIdentifyKgf = ActorQuerySourceIdentifyKgf;
//# sourceMappingURL=ActorQuerySourceIdentifyKgf.js.map