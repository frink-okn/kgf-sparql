import { QueryEngineFactoryBase } from '@comunica/actor-init-query';
import { QueryEngine } from './QueryEngine';

/** Builds a KGF query engine from an arbitrary Components.js config path. */
export class QueryEngineFactory extends QueryEngineFactoryBase<QueryEngine> {
  public constructor() {
    super(
      `${__dirname}/../`,
      `${__dirname}/../config/config-default.json`,
      actorInitQuery => new QueryEngine(actorInitQuery),
    );
  }
}
