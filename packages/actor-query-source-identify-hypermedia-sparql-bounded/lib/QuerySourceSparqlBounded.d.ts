import { QuerySourceSparql } from '@comunica/actor-query-source-identify-hypermedia-sparql';
import type { BindingsStream, IActionContext, IQueryBindingsOptions } from '@comunica/types';
import { Algebra } from '@comunica/utils-algebra';
import type { AsyncIterator } from 'asynciterator';
/**
 * Comunica's SPARQL endpoint source, with two changes to the COUNT query it sends for each
 * operation's cardinality.
 *
 * ## The count is bounded
 *
 * `SELECT (COUNT(*) AS ?count) WHERE { SELECT * WHERE { … } LIMIT cap+1 }`, so the endpoint
 * can stop at the cap. A count under it is exact; one that reaches it is reported as an
 * estimate of cap+1, a lower bound. The cap is the one the call's context gives the endpoint:
 * Comunica keeps an identified source for later queries, and a cap fixed when the source was
 * identified held for every query after the first, whatever their contexts said. A planner
 * needs to know which side of a join is small, not how large a large side is: on QLever's Wikidata endpoint,
 * counting every `rdfs:label` took 4.4 s, while counting up to 1,000,000 of them took 28 ms
 * and up to 10,000,000 took 79 ms.
 *
 * ## The count is timed by the server
 *
 * Comunica gives a COUNT `countTimeout` (3 s) from the moment it asks, and then reports the
 * cardinality as unknown (an infinite estimate), which made one query's plan differ from run
 * to run: time spent queued behind a host's other requests, or waiting to retry a refusal,
 * counted against the server. Here the timeout runs only while an attempt is with the server,
 * from when `@kgf/actor-http-throttle` sends it until its count arrives, body included, and
 * restarts with each attempt; the time a refused attempt waits to be sent again does not
 * count. `deadline` bounds the whole wait, queue included. (An earlier version stopped the
 * timer when the response headers arrived, and a server that sends them before it has counted
 * then had the whole deadline.)
 *
 * ## The metadata says what a request costs
 *
 * Comunica's SPARQL source reports no `requestTime`, so a join's cost model charges nothing
 * for each request to an endpoint, and a bind join that sends one per row looks as cheap as
 * one that sends a block of rows at a time. With uncapped counts the difference was hidden by
 * accident, since large counts timed out to an unknown size; with every count answered, the
 * two came out equal but for the block held, and the per-row join won. The time the COUNT
 * spent with the server, until its count arrived or the timeout reported it unknown, is the
 * metadata's `requestTime`, or, for a count already known, the time of this source's last.
 *
 * ## Bindings are not counted
 *
 * A call that carries bindings, sent as `VALUES`, is a bind join's probe, and Comunica counts
 * it before selecting, so each block of bindings cost the endpoint two requests. Nothing reads
 * that count: the bind joins that send blocks take their cardinality from their own entries,
 * and the COUNT, which carries the block, never matches a cached one. Such a call reports an
 * unknown cardinality, as Comunica's source does with count queries turned off.
 */
export declare class QuerySourceSparqlBounded extends QuerySourceSparql {
    private readonly capFor;
    private readonly attemptTimeout;
    private readonly endpoint;
    private readonly countDataFactory;
    private readonly countAlgebraFactory;
    /** The cap for a COUNT built with no call's context: the one the source was identified with. */
    private readonly identifiedCap;
    /** Each COUNT's cap, by the copy of its operation that `attachMetadata` hands Comunica. */
    private readonly caps;
    /** Milliseconds this source's last COUNT spent with the server. */
    private lastRequestTime?;
    /**
     * @param capFor The cap on a COUNT sent with the given context; `Infinity` for none.
     * @param attemptTimeout Milliseconds a COUNT attempt may spend with the server.
     * @param args Comunica's `QuerySourceSparql` arguments.
     */
    constructor(capFor: (context: IActionContext) => number, attemptTimeout: number, ...args: ConstructorParameters<typeof QuerySourceSparql>);
    queryBindings(operation: Algebra.Operation, context: IActionContext, options?: IQueryBindingsOptions): BindingsStream;
    /**
     * The COUNT for an operation, bounded at its call's cap. A pattern's variables are renamed,
     * as Comunica renames them, so that its count is cached whatever its variables are called;
     * its graph is kept, which Comunica's drops, counting a `GRAPH` pattern in the default graph.
     */
    operationToNormalizedCountQuery(operation: Algebra.Operation): Promise<string>;
    protected attachMetadata(target: AsyncIterator<any>, context: IActionContext, operationPromise: Promise<Algebra.Operation>): void;
    /** A count that reached the cap is an estimate, a lower bound, not an exact count. */
    private static bound;
}
//# sourceMappingURL=QuerySourceSparqlBounded.d.ts.map