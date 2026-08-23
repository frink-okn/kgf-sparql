import type { ActorInitQueryBase } from '@comunica/actor-init-query';
import { QueryEngineBase } from '@comunica/actor-init-query';
import type { IQueryContextCommon } from '@comunica/types';
/**
 * A Comunica SPARQL query engine configured for Knowledge Graph Fragments endpoints.
 *
 * Identical to `@comunica/query-sparql` except that the KGF join-selectivity
 * actor is registered alongside the default one. Where KGF statistics are
 * supplied it estimates joins from data; everywhere else the shipped
 * variable-counting heuristic answers exactly as before.
 */
export declare class QueryEngine<QueryContext extends IQueryContextCommon = IQueryContextCommon> extends QueryEngineBase<QueryContext> {
    constructor(engine?: ActorInitQueryBase);
}
//# sourceMappingURL=QueryEngine.d.ts.map