import type { IActorQuerySourceIdentifyHypermediaSparqlArgs } from '@comunica/actor-query-source-identify-hypermedia-sparql';
import { ActorQuerySourceIdentifyHypermediaSparql } from '@comunica/actor-query-source-identify-hypermedia-sparql';
import type { IActionQuerySourceIdentifyHypermedia, IActorQuerySourceIdentifyHypermediaOutput } from '@comunica/bus-query-source-identify-hypermedia';
import { ActionContextKey } from '@comunica/core';
/** The cap on the COUNT queries sent to every SPARQL endpoint without a cap of its own. */
export declare const KEY_SPARQL_COUNT_CAP: ActionContextKey<number>;
/**
 * Caps for particular endpoints, keyed by `URL.host`, `URL.hostname`, or `*.` and a domain: a
 * store that walks the matches to count them may want a lower cap than one that counts from
 * its indexes. `Infinity` or `null` sends the unbounded COUNT Comunica sends. They take
 * precedence over the actor's own `countCapHosts`.
 */
export declare const KEY_SPARQL_COUNT_CAP_HOSTS: ActionContextKey<Record<string, number | null>>;
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
export declare class ActorQuerySourceIdentifyHypermediaSparqlBounded extends ActorQuerySourceIdentifyHypermediaSparql {
    readonly countCap: number;
    readonly countCapHosts: Record<string, number | null>;
    readonly countDeadline: number;
    constructor(args: IActorQuerySourceIdentifyHypermediaSparqlBoundedArgs);
    run(action: IActionQuerySourceIdentifyHypermedia): Promise<IActorQuerySourceIdentifyHypermediaOutput>;
    /** The most particular name the context or the actor gives a cap for decides, as the throttle's limits do. */
    private capFor;
}
export interface IActorQuerySourceIdentifyHypermediaSparqlBoundedArgs extends IActorQuerySourceIdentifyHypermediaSparqlArgs {
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
//# sourceMappingURL=ActorQuerySourceIdentifyHypermediaSparqlBounded.d.ts.map