import type { ActorInitQueryBase } from '@comunica/actor-init-query';
import { QueryEngineBase } from '@comunica/actor-init-query';
import type { IQueryContextCommon } from '@comunica/types';
/**
 * A Comunica SPARQL query engine configured for Knowledge Graph Fragments endpoints.
 *
 * Adds a native KGF triple source with count-first planning, bindings pushdown,
 * and lazy VoID join statistics alongside the standard Comunica sources.
 */
export declare class QueryEngine<QueryContext extends IQueryContextCommon = IQueryContextCommon> extends QueryEngineBase<QueryContext> {
    constructor(engine?: ActorInitQueryBase);
}
//# sourceMappingURL=QueryEngine.d.ts.map