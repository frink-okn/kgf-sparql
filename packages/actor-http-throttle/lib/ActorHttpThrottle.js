"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ActorHttpThrottle = exports.KEY_HTTP_ATTEMPT_LISTENER = exports.KEY_HTTP_HOST_LIMITS = exports.KEY_HTTP_IN_FLIGHT = void 0;
exports.hostNames = hostNames;
const bus_http_1 = require("@comunica/bus-http");
const context_entries_1 = require("@comunica/context-entries");
const core_1 = require("@comunica/core");
/** Requests in flight per host, for every host without a limit of its own. */
exports.KEY_HTTP_IN_FLIGHT = new core_1.ActionContextKey('@kgf/actor-http-throttle:inFlight');
/**
 * Limits for particular hosts, keyed by `URL.host`, `URL.hostname`, or `*.` and a domain. They
 * take precedence, field by field, over the actor's own `hosts`.
 */
exports.KEY_HTTP_HOST_LIMITS = new core_1.ActionContextKey('@kgf/actor-http-throttle:hosts');
/** An `IHttpAttemptListener` for the request this context goes with. */
exports.KEY_HTTP_ATTEMPT_LISTENER = new core_1.ActionContextKey('@kgf/actor-http-throttle:attemptListener');
/** Set on the requests this actor sends on, so that it paces each request once. */
const KEY_WRAPPED = new core_1.ActionContextKey('@kgf/actor-http-throttle:wrapped');
/**
 * Comunica's retry actor's marker for a request it has wrapped (`ActorHttpRetry.keyWrapped`),
 * set so that actor stands aside: inside this one its retries would skip the pacing, and
 * around it they would multiply this actor's own. Context keys match by name.
 */
const KEY_STOCK_RETRY_WRAPPED = new core_1.ActionContextKey('urn:comunica:actor-http-retry#wrapped');
/** The interval between starts after a host's first refusal without `Retry-After`. */
const FIRST_INTERVAL_MS = 250;
/** The longest interval refusals can push a host to. */
const LONGEST_INTERVAL_MS = 10_000;
/** Each answer shortens a learned interval by this factor, until it is under `SHORTEST_INTERVAL_MS`. */
const INTERVAL_DECAY = 0.9;
const SHORTEST_INTERVAL_MS = 10;
/**
 * Paces the requests to each host, and retries those a host refuses as too many.
 *
 * ## Why
 *
 * A Comunica plan can put hundreds of requests in flight at once, and over HTTP/2 nothing
 * below it caps them: one connection carries any number. Servers answer with 429, as the
 * public KGF server did to about 650 of one run's requests at once, and QLever's Wikidata
 * endpoint allows about one request a second from a client. Comunica's own pacing does not
 * help. Its retry actor waits a fixed delay unless the server sends `Retry-After`, which
 * QLever does not, so retries arrive as fast as the refusals. Its rate limiter slows a whole
 * host after any failure, a timeout included: two SPARQL endpoints on the KGF server's host
 * timed out on their service descriptions, and every request to KGF on that host then waited
 * 1 to 3 seconds, so three registry queries made 12 to 19 requests in 30 seconds.
 *
 * ## What it does
 *
 * Each host has a queue. A request starts when the host has fewer than its limit in flight
 * (the host's own in `KEY_HTTP_HOST_LIMITS` or the actor's `hosts`, else `KEY_HTTP_IN_FLIGHT`,
 * else `inFlight`), and no sooner after the previous start than the host's spacing allows. It
 * holds its place until its response headers arrive; the body is read outside the queue. A
 * limit named `*.` and a domain is a queue the hosts in that domain share, for a service that
 * limits a client across its hosts: a request waits its turn in its host's queue, then in the
 * queue of each such group it is in, so a host's own limits hold within its group's, never in
 * place of them. Requests with other limits for the same host or group, as another query's
 * context gives, wait in a queue of their own, so each query's limits hold for its requests.
 *
 * The spacing is the larger of a configured rate (`perSecond`) and one learned from refusals,
 * which a host's or group's queues share, as they share the time of its last start. A 429 or
 * 503 with `Retry-After` pauses the host and its groups until then, or for the context's
 * `httpRetryDelayLimit` at most, and teaches nothing else: the server said when to come back,
 * as KGF's admission gate does. One without `Retry-After` doubles the interval between starts,
 * from 250 ms up to 10 s, and every answer that is not a refusal takes a tenth off it, so the
 * host settles near the rate it accepts. Only a request started since the last change counts:
 * the requests of one burst are refused together, and each doubling the interval again took
 * QLever to 10 s within seconds. A timeout or network failure changes nothing: it says nothing
 * about the host's rate. Invalidating the HTTP cache, for a URL or for all, forgets what
 * refusals taught, as it clears Comunica's retry actor's delays.
 *
 * A refused request is retried through the queue, ahead of requests not yet sent, up to the
 * context's `httpRetryCount` or else `retries` times. Comunica's own retry actor is told to
 * stand aside, and this one keeps its other duties: with `httpRetryCount` set, a 504 or a
 * status in `httpRetryStatusCodes` is retried after `httpRetryDelayFallback`. When retries run
 * out, the last response is returned as it is, rather than a bare "Request failed", so the
 * caller reports the status. A request whose body is a stream is not retried.
 *
 * ## Who is asking
 *
 * Under Node, a request without a `User-Agent` header is sent with the actor's `userAgent`,
 * in place of Comunica's generic one. Some endpoints ask clients to name themselves and a
 * contact (Wikidata's query service does), and some turn generic clients away (UniProt). A
 * browser sends its own, and the actor leaves it alone there.
 *
 * Nothing else here is particular to Node: the actor runs the same in a browser.
 */
class ActorHttpThrottle extends bus_http_1.ActorHttp {
    mediatorHttp;
    inFlight;
    retries;
    hosts;
    userAgent;
    /** The queues requests wait in, per host or group and the limits they were given. */
    queues = new Map();
    /** What refusals taught, per host or group, shared by its queues. */
    pacings = new Map();
    constructor(args) {
        super(args);
        this.mediatorHttp = args.mediatorHttp;
        this.inFlight = args.inFlight ?? 32;
        this.retries = args.retries ?? 5;
        this.hosts = args.hosts ?? {};
        this.userAgent = args.userAgent;
        args.httpInvalidator?.addInvalidateListener(action => this.invalidate(action.url));
    }
    async test(action) {
        if (action.context.has(KEY_WRAPPED)) {
            return (0, core_1.failTest)(`${this.name} paces each request once`);
        }
        return (0, core_1.passTest)({ time: 0 });
    }
    async run(action) {
        action = this.identified(action);
        const url = bus_http_1.ActorHttp.getInputUrl(action.input);
        const queues = this.queuesFor(url, action.context);
        const signal = action.init?.signal ?? undefined;
        const retryCount = action.context.get(context_entries_1.KeysHttp.httpRetryCount);
        const refusalRetries = retryCount ?? this.retries;
        const failureRetries = retryCount ?? 0;
        const forced = action.context.get(context_entries_1.KeysHttp.httpRetryStatusCodes) ?? [];
        const fallbackDelay = action.context.get(context_entries_1.KeysHttp.httpRetryDelayFallback) ?? 0;
        const delayLimit = action.context.get(context_entries_1.KeysHttp.httpRetryDelayLimit);
        const replayable = ActorHttpThrottle.replayable(action.init?.body);
        const listener = action.context.get(exports.KEY_HTTP_ATTEMPT_LISTENER);
        const context = action.context.set(KEY_WRAPPED, true).set(KEY_STOCK_RETRY_WRAPPED, true);
        for (let attempt = 0;; attempt++) {
            await ActorHttpThrottle.enter(queues, signal, attempt > 0);
            const started = Date.now();
            listener?.sent();
            let response;
            try {
                response = await this.mediatorHttp.mediate({ ...action, context });
            }
            finally {
                for (const queue of queues) {
                    queue.leave();
                }
                listener?.settled();
            }
            if (ActorHttpThrottle.refusal(response)) {
                const wait = ActorHttpThrottle.retryAfter(response.headers.get('retry-after'));
                for (const { pacing } of queues) {
                    if (wait === undefined) {
                        pacing.refused(started);
                    }
                    else {
                        // Past the limit this request gives up, and the others must not wait longer either.
                        pacing.pause(delayLimit === undefined ? wait : Math.min(wait, delayLimit));
                    }
                }
                if (attempt >= refusalRetries || !replayable || (delayLimit !== undefined && (wait ?? 0) > delayLimit)) {
                    return response;
                }
                this.logDebug(action.context, 'Refused, retrying', () => ({
                    url: url.href,
                    status: response.status,
                    attempt: attempt + 1,
                    retryAfterMs: wait,
                    intervalMs: Math.max(...queues.map(queue => queue.interval)),
                }));
                await ActorHttpThrottle.discard(response);
                listener?.retrying?.();
                continue;
            }
            for (const { pacing } of queues) {
                pacing.answered(started);
            }
            if ((response.status === 504 || forced.includes(response.status)) && attempt < failureRetries && replayable) {
                await ActorHttpThrottle.discard(response);
                listener?.retrying?.();
                await sleep(fallbackDelay, signal);
                continue;
            }
            return response;
        }
    }
    /** Waits for a place in each queue in turn, the host's first; gives back those it had if it stops waiting. */
    static async enter(queues, signal, front) {
        let entered = 0;
        try {
            for (const queue of queues) {
                await queue.enter(signal, front);
                entered++;
            }
        }
        catch (error) {
            for (const queue of queues.slice(0, entered)) {
                queue.leave();
            }
            throw error;
        }
    }
    /** The action, with the actor's `User-Agent` if it has none and runs outside a browser. */
    identified(action) {
        if (this.userAgent === undefined || bus_http_1.ActorHttp.isBrowser()) {
            return action;
        }
        const headers = new Headers(action.init?.headers);
        if (headers.has('user-agent')) {
            return action;
        }
        headers.set('user-agent', this.userAgent);
        return { ...action, init: { ...action.init, headers } };
    }
    /**
     * The queues a request waits in: its host's, with the limits named by its host and port or
     * else its hostname, then the queue of each group it is in that has limits. The context's
     * limits for a name override the actor's, field by field.
     */
    queuesFor(url, context) {
        const given = context.get(exports.KEY_HTTP_HOST_LIMITS);
        const limitsOf = (name) => (given?.[name] ?? this.hosts[name]) ? { ...this.hosts[name], ...given?.[name] } : undefined;
        const [host, hostname, ...groups] = hostNames(url);
        const own = limitsOf(host) ?? limitsOf(hostname) ?? {};
        const queues = [this.queue(url.host, own.inFlight ?? context.get(exports.KEY_HTTP_IN_FLIGHT) ?? this.inFlight, own.perSecond)];
        for (const name of groups) {
            const limits = limitsOf(name);
            if (limits) {
                queues.push(this.queue(name, limits.inFlight ?? Number.POSITIVE_INFINITY, limits.perSecond));
            }
        }
        return queues;
    }
    /**
     * The queue of a host or group for these limits. Each set of limits has its own, so that a
     * query's limits hold whatever another query's say, and the name's queues share its pacing.
     */
    queue(name, inFlight, perSecond) {
        const limit = Math.max(1, inFlight);
        const spacing = perSecond ? 1_000 / perSecond : 0;
        const key = `${name} ${limit} ${spacing}`;
        let queue = this.queues.get(key);
        if (!queue) {
            let pacing = this.pacings.get(name);
            if (!pacing) {
                pacing = new Pacing();
                this.pacings.set(name, pacing);
            }
            queue = new HostQueue(limit, spacing, pacing);
            this.queues.set(key, queue);
        }
        return queue;
    }
    /** Forgets what refusals taught about the URL's host and its groups, or about every host without one. */
    invalidate(url) {
        let names;
        if (url !== undefined) {
            try {
                names = new Set(hostNames(new URL(url)));
            }
            catch {
                return;
            }
        }
        for (const [name, pacing] of this.pacings) {
            if (!names || names.has(name)) {
                pacing.reset();
            }
        }
    }
    /** A refusal to serve the request now: 429, 503, or a 405 with `Retry-After`, as DBpedia sends. */
    static refusal(response) {
        return response.status === 429 || response.status === 503 ||
            (response.status === 405 && response.headers.has('retry-after'));
    }
    /** Milliseconds a `Retry-After` value asks for, in seconds or as an HTTP date. */
    static retryAfter(value) {
        if (value === null) {
            return undefined;
        }
        const trimmed = value.trim();
        const wait = /^\d+$/u.test(trimmed) ? Number(trimmed) * 1_000 : Date.parse(trimmed) - Date.now();
        return Number.isNaN(wait) ? undefined : Math.max(0, wait);
    }
    /** Whether a request body can be sent again. A stream is read once. */
    static replayable(body) {
        return body === undefined || body === null || typeof body === 'string' ||
            body instanceof URLSearchParams || body instanceof ArrayBuffer || ArrayBuffer.isView(body) ||
            (typeof Blob !== 'undefined' && body instanceof Blob) ||
            (typeof FormData !== 'undefined' && body instanceof FormData);
    }
    /** Lets go of a response that will not be read, so its connection can carry the retry. */
    static async discard(response) {
        try {
            await response.body?.cancel();
        }
        catch {
            // Already read or errored: nothing is held.
        }
    }
}
exports.ActorHttpThrottle = ActorHttpThrottle;
/**
 * The names a limit for a URL's host may be given under, most particular first: the host with
 * its port, then without, then `*.` and each shorter domain the host is in (`*.wikidata.org`
 * for `query.wikidata.org`, never `*.org`).
 */
function hostNames(url) {
    const labels = url.hostname.split('.');
    return [url.host, url.hostname, ...labels.slice(1, -1).map((_, i) => `*.${labels.slice(i + 1).join('.')}`)];
}
/**
 * What one host's or group's refusals taught, and when it last started a request: shared by
 * every queue of the name, since the server sees all of them.
 */
class Pacing {
    /** Milliseconds between starts learned from refusals without `Retry-After`. */
    learned = 0;
    /** No request starts before this time, which a `Retry-After` set. */
    until = 0;
    lastStart = Number.NEGATIVE_INFINITY;
    /** When `learned` last grew. Requests started before then were sent at the old rate. */
    raisedAt = Number.NEGATIVE_INFINITY;
    /** The name's queues, to wake when a pause is forgotten. */
    queues = new Set();
    /** A refusal without `Retry-After` of a request started at `started`: start less often. */
    refused(started) {
        if (started < this.raisedAt) {
            return;
        }
        this.learned = this.learned === 0 ? FIRST_INTERVAL_MS : Math.min(this.learned * 2, LONGEST_INTERVAL_MS);
        this.raisedAt = Date.now();
    }
    /** A refusal with `Retry-After`: start nothing for this long. */
    pause(milliseconds) {
        this.until = Math.max(this.until, Date.now() + milliseconds);
    }
    /** Any answer but a refusal, to a request started at `started`: start a little more often again. */
    answered(started) {
        if (this.learned > 0 && started >= this.raisedAt) {
            this.learned *= INTERVAL_DECAY;
            if (this.learned < SHORTEST_INTERVAL_MS) {
                this.learned = 0;
            }
        }
    }
    /** Forgets the learned interval and any pause, and lets the queues waiting on them go on. */
    reset() {
        this.learned = 0;
        this.until = 0;
        this.raisedAt = Number.NEGATIVE_INFINITY;
        for (const queue of this.queues) {
            queue.pump();
        }
    }
}
/** Requests to one host or group with one set of limits: at most `limit` in flight, starts spaced, waiters in order. */
class HostQueue {
    limit;
    spacing;
    pacing;
    active = 0;
    waiting = [];
    timer;
    timerAt = 0;
    /**
     * @param limit Requests in flight at most.
     * @param spacing Milliseconds between starts that a configured rate asks for.
     * @param pacing What the host's or group's refusals taught, shared with its other queues.
     */
    constructor(limit, spacing, pacing) {
        this.limit = limit;
        this.spacing = spacing;
        this.pacing = pacing;
        pacing.queues.add(this);
    }
    get interval() {
        return Math.max(this.spacing, this.pacing.learned);
    }
    /** Waits for a place, at the back of the queue or, for a retry, at the front. */
    async enter(signal, front) {
        signal?.throwIfAborted();
        await new Promise((resolve, reject) => {
            const abort = () => {
                const index = this.waiting.indexOf(waiter);
                if (index >= 0) {
                    this.waiting.splice(index, 1);
                }
                reject(signal.reason);
            };
            const waiter = {
                admit: () => {
                    signal?.removeEventListener('abort', abort);
                    resolve();
                },
            };
            signal?.addEventListener('abort', abort, { once: true });
            if (front) {
                this.waiting.unshift(waiter);
            }
            else {
                this.waiting.push(waiter);
            }
            this.pump();
        });
    }
    leave() {
        this.active--;
        this.pump();
    }
    /** Admits the waiters that may start now, and sets a timer for the next one that may not. */
    pump() {
        while (this.waiting.length > 0 && this.active < this.limit) {
            const now = Date.now();
            const start = Math.max(this.pacing.lastStart + this.interval, this.pacing.until);
            if (start > now) {
                this.wake(start - now);
                return;
            }
            this.active++;
            this.pacing.lastStart = now;
            this.waiting.shift().admit();
        }
        // Nothing waits on a timer now: a pause forgotten early must not leave one set for its end.
        clearTimeout(this.timer);
        this.timer = undefined;
    }
    /** Pumps again after `delay`, unless an earlier wake is already set. */
    wake(delay) {
        const at = Date.now() + delay;
        if (this.timer !== undefined) {
            if (this.timerAt <= at) {
                return;
            }
            clearTimeout(this.timer);
        }
        this.timerAt = at;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.pump();
        }, delay);
    }
}
async function sleep(milliseconds, signal) {
    if (milliseconds <= 0) {
        return;
    }
    signal?.throwIfAborted();
    await new Promise((resolve, reject) => {
        const abort = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', abort);
            resolve();
        }, milliseconds);
        signal?.addEventListener('abort', abort, { once: true });
    });
}
//# sourceMappingURL=ActorHttpThrottle.js.map