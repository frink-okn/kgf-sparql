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
import { hostNames } from '@frink-okn/actor-http-throttle';
import { QuerySourceSparqlBounded } from './QuerySourceSparqlBounded';

/** The cap on the COUNT queries sent to every SPARQL endpoint without a cap of its own. */
export const KEY_SPARQL_COUNT_CAP = new ActionContextKey<number>(
  '@frink-okn/actor-query-source-identify-hypermedia-sparql-bounded:countCap',
);

/**
 * Caps for particular endpoints, keyed by `URL.host`, `URL.hostname`, or `*.` and a domain: a
 * store that walks the matches to count them may want a lower cap than one that counts from
 * its indexes. `Infinity` or `null` sends the unbounded COUNT Comunica sends. They take
 * precedence over the actor's own `countCapHosts`.
 */
export const KEY_SPARQL_COUNT_CAP_HOSTS = new ActionContextKey<Record<string, number | null>>(
  '@frink-okn/actor-query-source-identify-hypermedia-sparql-bounded:countCapHosts',
);

/**
 * Comunica's SPARQL endpoint identification, creating `QuerySourceSparqlBounded` sources:
 * COUNT queries bounded at a cap, and timed only while the server has them.
 *
 * The cap suits a store that stops at a `LIMIT` and walks the matches to count them, as
 * QLever does. It does not suit one that counts a single pattern from its indexes and reads
 * every row of a subquery: Blazegraph, behind Wikidata's query services, counts every
 * `wdt:P921` statement (2,463,228) in 0.12 s and takes 10 s to count to a cap of a million.
 * `countCapHosts` names such endpoints, with `null` for no cap.
 *
 * `countTimeout` is the time a COUNT attempt may spend with the server before its
 * cardinality is reported unknown, as in Comunica; `countDeadline` bounds the whole wait,
 * time queued behind the host's other requests included.
 */
export class ActorQuerySourceIdentifyHypermediaSparqlBounded extends ActorQuerySourceIdentifyHypermediaSparql {
  public readonly countCap: number;
  public readonly countCapHosts: Record<string, number | null>;
  public readonly countDeadline: number;

  public constructor(args: IActorQuerySourceIdentifyHypermediaSparqlBoundedArgs) {
    super(args);
    this.countCap = args.countCap ?? 1_000_000;
    this.countCapHosts = args.countCapHosts ?? {};
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
      // Each COUNT's cap is the one its query's context gives: Comunica keeps the source for later queries.
      context => this.capFor(endpoint, context),
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

  /** The most particular name the context or the actor gives a cap for decides, as the throttle's limits do. */
  private capFor(endpoint: string, context: IActionContext): number {
    const given = context.get(KEY_SPARQL_COUNT_CAP_HOSTS);
    let names: string[] = [];
    try {
      names = hostNames(new URL(endpoint));
    } catch {
      // Not a URL Comunica could fetch anyway; the default applies.
    }
    for (const name of names) {
      const cap = given && name in given ? given[name] : this.countCapHosts[name];
      if (cap !== undefined) {
        return cap ?? Number.POSITIVE_INFINITY;
      }
    }
    return context.get(KEY_SPARQL_COUNT_CAP) ?? this.countCap;
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
   * Caps for particular endpoints, keyed as `KEY_SPARQL_COUNT_CAP_HOSTS` keys them, which
   * overrides these; `null` sends an unbounded COUNT, and `{}` sets none. Components.js reads
   * a JSON parameter only when it is required.
   * @range {json}
   */
  countCapHosts: Record<string, number | null>;
  /**
   * Milliseconds a COUNT may take in all, waiting its turn included, before its cardinality
   * is reported unknown.
   * @range {integer}
   * @default {30000}
   */
  countDeadline?: number;
}
