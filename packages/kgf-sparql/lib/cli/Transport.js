"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPooledFetch = createPooledFetch;
const undici_1 = require("undici");
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
function createPooledFetch(maxConnections) {
    const agent = new undici_1.Agent({ connections: maxConnections });
    const pooled = (input, init = {}) => (0, undici_1.fetch)(input, { ...init, dispatcher: agent });
    return {
        fetch: pooled,
        close: () => agent.destroy(),
    };
}
//# sourceMappingURL=Transport.js.map