"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QueryEngine = void 0;
const actor_init_query_1 = require("@comunica/actor-init-query");
// eslint-disable-next-line ts/no-require-imports,ts/no-var-requires,import/extensions
const engineDefault = require('../engine-default.js');
/**
 * A Comunica SPARQL query engine configured for Knowledge Graph Fragments endpoints.
 *
 * Identical to `@comunica/query-sparql` except that the KGF join-selectivity
 * actor is registered alongside the default one. Where KGF statistics are
 * supplied it estimates joins from data; everywhere else the shipped
 * variable-counting heuristic answers exactly as before.
 */
class QueryEngine extends actor_init_query_1.QueryEngineBase {
    constructor(engine = engineDefault()) {
        super(engine);
    }
}
exports.QueryEngine = QueryEngine;
//# sourceMappingURL=QueryEngine.js.map