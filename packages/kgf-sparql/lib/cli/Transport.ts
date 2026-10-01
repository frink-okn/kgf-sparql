import { Agent, fetch as undiciFetch } from 'undici';

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
 * A connection cap is not a request cap: undici 8 negotiates HTTP/2 wherever the server
 * offers it, and one HTTP/2 connection carries any number of requests at once. Requests in
 * flight are capped in the engine, by `@kgf/actor-http-throttle`, so that a page using the
 * engine in a browser gets the same cap as this command line.
 *
 * The npm package's fetch is used with the agent rather than the global one: the global
 * fetch is Node's bundled undici, a different major version, which rejects a foreign
 * dispatcher passed per request; setting the global dispatcher would reach beyond the run.
 */
export function createPooledFetch(maxConnections: number): IPooledFetch {
  const agent = new Agent({ connections: maxConnections });
  const pooled = (
    input: Parameters<typeof undiciFetch>[0],
    init: Parameters<typeof undiciFetch>[1] = {},
  ): ReturnType<typeof undiciFetch> => undiciFetch(input, { ...init, dispatcher: agent });
  return {
    fetch: <typeof fetch> <unknown> pooled,
    close: () => agent.destroy(),
  };
}
