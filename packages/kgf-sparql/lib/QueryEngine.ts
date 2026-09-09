import type { ActorInitQueryBase } from '@comunica/actor-init-query';
import { QueryEngineBase } from '@comunica/actor-init-query';
import type { IQueryContextCommon } from '@comunica/types';

// eslint-disable-next-line ts/no-require-imports,ts/no-var-requires,import/extensions
const engineDefault = require('../engine-default.js');

/**
 * A Comunica SPARQL query engine configured for Knowledge Graph Fragments endpoints.
 *
 * Adds a native KGF triple source with count-first planning, bindings pushdown,
 * and lazy VoID join statistics alongside the standard Comunica sources.
 */
export class QueryEngine<QueryContext extends IQueryContextCommon = IQueryContextCommon>
  extends QueryEngineBase<QueryContext> {
  public constructor(engine: ActorInitQueryBase = engineDefault()) {
    super(engine);
  }
}
