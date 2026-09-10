/** A fetch whose connections to each origin are pooled, reused, and capped. */
export interface IPooledFetch {
    fetch: typeof fetch;
    /** Tears the pool down. By the time a run closes it, nothing still in flight is wanted. */
    close: () => Promise<void>;
}
/**
 * Node's own fetch pools keep-alive connections per origin but caps nothing, so a plan
 * that fans out opens a connection per request: 1,209 at once on one corpus query, which
 * is what produced the bursts of connection failures against the public server. undici's
 * `Agent` takes a `connections` cap and queues the rest.
 *
 * The npm package's fetch is used with the agent rather than the global one: the global
 * fetch is Node's bundled undici, a different major version, which rejects a foreign
 * dispatcher passed per request; setting the global dispatcher would reach beyond the run.
 */
export declare function createPooledFetch(maxConnections: number): IPooledFetch;
//# sourceMappingURL=Transport.d.ts.map