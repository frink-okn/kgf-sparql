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
function createPooledFetch(maxConnections, inFlight = { default: maxConnections }) {
    const agent = new undici_1.Agent({ connections: maxConnections });
    const gates = new Map();
    const gateFor = (url) => {
        let gate = gates.get(url.host);
        if (!gate) {
            gate = new Gate(inFlight.hosts?.[url.host] ?? inFlight.hosts?.[url.hostname] ?? inFlight.default);
            gates.set(url.host, gate);
        }
        return gate;
    };
    const pooled = async (input, init = {}) => {
        const gate = gateFor(new URL(typeof input === 'string' ? input : 'href' in input ? input.href : input.url));
        await gate.enter(init.signal ?? undefined);
        try {
            return await (0, undici_1.fetch)(input, { ...init, dispatcher: agent });
        }
        finally {
            gate.leave();
        }
    };
    return {
        fetch: pooled,
        close: () => agent.destroy(),
    };
}
/** At most `limit` holders at once; the rest wait in arrival order, or leave when their signal aborts. */
class Gate {
    limit;
    active = 0;
    waiting = [];
    constructor(limit) {
        this.limit = limit;
    }
    async enter(signal) {
        if (this.active < this.limit) {
            this.active++;
            return;
        }
        signal?.throwIfAborted();
        await new Promise((resolve, reject) => {
            const abort = () => {
                this.waiting.splice(this.waiting.indexOf(admit), 1);
                reject(signal.reason);
            };
            const admit = () => {
                signal?.removeEventListener('abort', abort);
                resolve();
            };
            signal?.addEventListener('abort', abort, { once: true });
            this.waiting.push(admit);
        });
    }
    /** Hands the place to the next waiter, if any, rather than freeing it. */
    leave() {
        const next = this.waiting.shift();
        if (next) {
            next();
        }
        else {
            this.active--;
        }
    }
}
//# sourceMappingURL=Transport.js.map