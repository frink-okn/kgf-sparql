"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QueryEngineFactory = void 0;
const actor_init_query_1 = require("@comunica/actor-init-query");
const QueryEngine_1 = require("./QueryEngine");
/** Builds a KGF query engine from an arbitrary Components.js config path. */
class QueryEngineFactory extends actor_init_query_1.QueryEngineFactoryBase {
    constructor() {
        super(`${__dirname}/../`, `${__dirname}/../config/config-default.json`, actorInitQuery => new QueryEngine_1.QueryEngine(actorInitQuery));
    }
}
exports.QueryEngineFactory = QueryEngineFactory;
//# sourceMappingURL=QueryEngineFactory.js.map