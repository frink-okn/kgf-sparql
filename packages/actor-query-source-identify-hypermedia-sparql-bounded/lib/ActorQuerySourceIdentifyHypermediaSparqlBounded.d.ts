import type { IActorQuerySourceIdentifyHypermediaSparqlArgs } from '@comunica/actor-query-source-identify-hypermedia-sparql';
import { ActorQuerySourceIdentifyHypermediaSparql } from '@comunica/actor-query-source-identify-hypermedia-sparql';
import type { IActionQuerySourceIdentifyHypermedia, IActorQuerySourceIdentifyHypermediaOutput } from '@comunica/bus-query-source-identify-hypermedia';
import { ActionContextKey } from '@comunica/core';
/** The cap on the COUNT queries sent to every SPARQL endpoint without a cap of its own. */
export declare const KEY_SPARQL_COUNT_CAP: ActionContextKey<number>;
/**
 * Caps for particular endpoints, keyed by `URL.host` or `URL.hostname`: a store that walks
 * the matches to count them may want a lower cap than one that counts from its indexes.
 * `Infinity` sends the unbounded COUNT Comunica sends.
 */
export declare const KEY_SPARQL_COUNT_CAP_HOSTS: ActionContextKey<Record<string, number>>;
/**
 * Comunica's SPARQL endpoint identification, creating `QuerySourceSparqlBounded` sources:
 * COUNT queries bounded at a cap, and timed only while the server has them.
 *
 * `countTimeout` is the time a COUNT attempt may spend with the server before its
 * cardinality is reported unknown, as in Comunica; `countDeadline` bounds the whole wait,
 * time queued behind the host's other requests included.
 */
export declare class ActorQuerySourceIdentifyHypermediaSparqlBounded extends ActorQuerySourceIdentifyHypermediaSparql {
    readonly countCap: number;
    readonly countDeadline: number;
    constructor(args: IActorQuerySourceIdentifyHypermediaSparqlBoundedArgs);
    run(action: IActionQuerySourceIdentifyHypermedia): Promise<IActorQuerySourceIdentifyHypermediaOutput>;
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
     * Milliseconds a COUNT may take in all, waiting its turn included, before its cardinality
     * is reported unknown.
     * @range {integer}
     * @default {30000}
     */
    countDeadline?: number;
}
//# sourceMappingURL=ActorQuerySourceIdentifyHypermediaSparqlBounded.d.ts.map