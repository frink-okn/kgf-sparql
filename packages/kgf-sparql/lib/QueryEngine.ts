import type { ActorInitQueryBase } from '@comunica/actor-init-query';
import { QueryEngineBase } from '@comunica/actor-init-query';
import type { IQueryContextCommon } from '@comunica/types';

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
export class QueryEngine<QueryContext extends IQueryContextCommon = IQueryContextCommon>
  extends QueryEngineBase<QueryContext> {
  public constructor(engine: ActorInitQueryBase = engineDefault()) {
    super(engine);
  }
}
