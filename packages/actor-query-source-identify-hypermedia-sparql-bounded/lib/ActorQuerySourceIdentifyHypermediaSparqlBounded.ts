import type {
  IActorQuerySourceIdentifyHypermediaSparqlArgs,
} from '@comunica/actor-query-source-identify-hypermedia-sparql';
import { ActorQuerySourceIdentifyHypermediaSparql } from '@comunica/actor-query-source-identify-hypermedia-sparql';
import type {
  IActionQuerySourceIdentifyHypermedia,
  IActorQuerySourceIdentifyHypermediaOutput,
} from '@comunica/bus-query-source-identify-hypermedia';
import { KeysInitQuery, KeysQueryOperation } from '@comunica/context-entries';
import { ActionContextKey } from '@comunica/core';
import type { IActionContext } from '@comunica/types';
import { AlgebraFactory } from '@comunica/utils-algebra';
import { BindingsFactory } from '@comunica/utils-bindings-factory';
import { QuerySourceSparqlBounded } from './QuerySourceSparqlBounded';

/** The cap on the COUNT queries sent to every SPARQL endpoint without a cap of its own. */
export const KEY_SPARQL_COUNT_CAP = new ActionContextKey<number>(
  '@kgf/actor-query-source-identify-hypermedia-sparql-bounded:countCap',
);

/**
 * Caps for particular endpoints, keyed by `URL.host` or `URL.hostname`: a store that walks
 * the matches to count them may want a lower cap than one that counts from its indexes.
 * `Infinity` sends the unbounded COUNT Comunica sends.
 */
export const KEY_SPARQL_COUNT_CAP_HOSTS = new ActionContextKey<Record<string, number>>(
  '@kgf/actor-query-source-identify-hypermedia-sparql-bounded:countCapHosts',
);

/**
 * Comunica's SPARQL endpoint identification, creating `QuerySourceSparqlBounded` sources:
 * COUNT queries bounded at a cap, and timed only while the server has them.
 *
 * `countTimeout` is the time a COUNT attempt may spend with the server before its
 * cardinality is reported unknown, as in Comunica; `countDeadline` bounds the whole wait,
 * time queued behind the host's other requests included.
 */
export class ActorQuerySourceIdentifyHypermediaSparqlBounded extends ActorQuerySourceIdentifyHypermediaSparql {
  public readonly countCap: number;
  public readonly countDeadline: number;

  public constructor(args: IActorQuerySourceIdentifyHypermediaSparqlBoundedArgs) {
    super(args);
    this.countCap = args.countCap ?? 1_000_000;
    this.countDeadline = args.countDeadline ?? 30_000;
  }

  public override async run(action: IActionQuerySourceIdentifyHypermedia): Promise<IActorQuerySourceIdentifyHypermediaOutput> {
    const endpoint = (action.forceSourceType ?? this.forceSourceType) ?
      action.url :
      action.metadata.sparqlService || action.url;
    this.logInfo(action.context, `Identified ${action.url} as sparql source with service URL: ${endpoint}`);
    const dataFactory = action.context.getSafe(KeysInitQuery.dataFactory);
    const algebraFactory = new AlgebraFactory(dataFactory);
    const isSingularSource = action.context.get(KeysQueryOperation.querySources)?.length === 1;
    const source = new QuerySourceSparqlBounded(
      this.capFor(endpoint, action.context),
      this.countTimeout,
      endpoint,
      // The original URL is the backup, as some endpoints misconfigure their service description.
      action.url,
      action.context,
      this.mediatorHttp,
      this.mediatorQuerySerialize,
      this.bindMethod,
      dataFactory,
      algebraFactory,
      await BindingsFactory.create(this.mediatorMergeBindingsContext, action.context, dataFactory),
      this.forceHttpGet,
      this.cacheSize,
      this.countDeadline,
      // A single source's cardinalities do not matter, so it is not asked for them.
      this.cardinalityCountQueries && !isSingularSource,
      this.cardinalityEstimateConstruction,
      this.forceGetIfUrlLengthBelow,
      Boolean(action.context.get(KeysInitQuery.parseUnsupportedVersions)),
      action.metadata,
    );
    return { source };
  }

  private capFor(endpoint: string, context: IActionContext): number {
    const hosts = context.get(KEY_SPARQL_COUNT_CAP_HOSTS);
    let url: URL | undefined;
    try {
      url = new URL(endpoint);
    } catch {
      // Not a URL Comunica could fetch anyway; the default applies.
    }
    return (url && (hosts?.[url.host] ?? hosts?.[url.hostname])) ??
      context.get(KEY_SPARQL_COUNT_CAP) ??
      this.countCap;
  }
}

export interface IActorQuerySourceIdentifyHypermediaSparqlBoundedArgs
  extends IActorQuerySourceIdentifyHypermediaSparqlArgs {
  /**
   * The most matches a COUNT query counts; a count that reaches it is a lower bound.
   * @range {integer}
   * @default {1000000}
   */
  countCap?: number;
  /**
   * Milliseconds a COUNT may take in all, waiting its turn included, before its cardinality
   * is reported unknown.
   * @range {integer}
   * @default {30000}
   */
  countDeadline?: number;
}
