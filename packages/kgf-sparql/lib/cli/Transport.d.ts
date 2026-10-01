/** A fetch whose connections to each origin are pooled, reused, and capped. */
export interface IPooledFetch {
    fetch: typeof fetch;
    /** Tears the pool down. By the time a run closes it, nothing still in flight is wanted. */
    close: () => Promise<void>;
}
/** Requests allowed in flight per origin: one default, and overrides by host (`host` or `host:port`). */
export interface IInFlightLimits {
    default: number;
    hosts?: Record<string, number>;
}
/**
 * Node's own fetch pools keep-alive connections per origin but caps nothing, so a plan
 * that fans out opens a connection per request: 1,209 at once on one corpus query, which
 * is what produced the bursts of connection failures against the public server. undici's
 * `Agent` takes a `connections` cap and queues the rest.
 *
 * A connection cap is not a request cap. undici 8 negotiates HTTP/2 wherever the server
 * offers it, as the public KGF server's load balancer does, and one HTTP/2 connection
 * carries any number of requests at once: on 2026-09-30 the server's access log saw about
 * 650 of one run's requests in flight while the connection cap was 32, and refused the
 * overflow with 429. So each origin also has a gate on requests in flight. A request
 * holds its place until its response headers arrive, by which time a KGF server has done
 * its work; the body is read outside the gate.
 *
 * The npm package's fetch is used with the agent rather than the global one: the global
 * fetch is Node's bundled undici, a different major version, which rejects a foreign
 * dispatcher passed per request; setting the global dispatcher would reach beyond the run.
 */
export declare function createPooledFetch(maxConnections: number, inFlight?: IInFlightLimits): IPooledFetch;
//# sourceMappingURL=Transport.d.ts.map