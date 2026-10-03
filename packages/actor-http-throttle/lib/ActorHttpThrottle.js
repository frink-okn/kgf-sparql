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
 * Each host has a queue. A request starts when the host has fewer than its limit in flight (the
 * host's own in `KEY_HTTP_HOST_LIMITS` or the actor's `hosts`, else `KEY_HTTP_IN_FLIGHT`, else
 * `inFlight`), and no sooner after the previous start than the host's spacing allows. It holds
 * its place until its response headers arrive; the body is read outside the queue. A limit named
 * `*.` and a domain is a queue the hosts in that domain share, for a service that limits a client
 * across its hosts. A request waits in its host's queue, and starts only when its host and every
 * such group it is in can all start it at that moment, so a host's own limits hold within its
 * group's, never in place of them. (A request used to take its host's turn and then wait for the
 * group's, and a group that held several back let them all start at once, past the host's rate.)
 * A group starts its hosts' requests in the order they arrived. Requests with other limits for
 * the same host or group, as another query's context gives, wait in a queue of their own, so each
 * query's limits hold for its requests; a queue no request holds is let go. A host's or group's
 * queues start their requests in the order they arrived, too.
 *
 * A configured rate (`perSecond`) spaces the starts of the requests given it, counted from the
 * last of them, whichever queue it was in: a query's rate holds for its requests, and outlives
 * its queue. (Counted from the host's last start of any request, each request of a query allowed
 * 50 a second put off those of one allowed 10 again, until the other query was done.) The
 * interval learned from refusals, and a pause, hold for all of a host's or group's requests,
 * counted from its last start, since the server sees all of them. A 429 or 503 with `Retry-After`
 * pauses the host and its groups until then, or for the context's `httpRetryDelayLimit` at most,
 * and teaches nothing else: the server said when to come back, as KGF's admission gate does. One
 * without `Retry-After` doubles the interval between starts, from 250 ms up to 10 s, and every
 * answer that is not a refusal takes a tenth off it, so the host settles near the rate it
 * accepts. An answer teaches before its request gives up its place, so the next request starts at
 * the new pace. Only a request started since the last change counts: the requests of one burst
 * are refused together, and each doubling the interval again took QLever to 10 s within seconds.
 * A timeout or network failure changes nothing: it says nothing about the host's rate.
 * Invalidating the HTTP cache, for a URL or for all, forgets what refusals taught, as it clears
 * Comunica's retry actor's delays.
 *
 * A refused request is retried through the queue, ahead of requests that arrived after it, up to
 * the context's `httpRetryCount` or else `retries` times. Comunica's own retry actor is told to
 * stand aside, and this one keeps its other duties: with `httpRetryCount` set, a 504 or a status
 * in `httpRetryStatusCodes` is retried after `httpRetryDelayFallback`. When retries run out, the
 * last response is returned as it is, rather than a bare "Request failed", so the caller reports
 * the status. A request whose body is a stream is not retried; a Request whose own body is sent
 * is sent a copy of it each attempt. A Request's own signal aborts it while it waits, as the
 * init's does.
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
    /** The order requests arrived in, which a group keeps across its hosts' queues. */
    arrivals = 0;
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
        try {
            return await this.attempts(action, url, queues);
        }
        finally {
            for (const queue of queues) {
                queue.release();
            }
        }
    }
    /** Sends the request through its queues, again for each refusal or failure it may retry. */
    async attempts(action, url, queues) {
        const request = requestOf(action.input);
        // The signal fetch heeds: the init's when it gives one, else the Request's own.
        const signal = action.init?.signal === undefined ? request?.signal : action.init.signal ?? undefined;
        const retryCount = action.context.get(context_entries_1.KeysHttp.httpRetryCount);
        const refusalRetries = retryCount ?? this.retries;
        const failureRetries = retryCount ?? 0;
        const forced = action.context.get(context_entries_1.KeysHttp.httpRetryStatusCodes) ?? [];
        const fallbackDelay = action.context.get(context_entries_1.KeysHttp.httpRetryDelayFallback) ?? 0;
        const delayLimit = action.context.get(context_entries_1.KeysHttp.httpRetryDelayLimit);
        // fetch sends the init's body when it gives one, and else the Request's, which is read once:
        // each attempt is then sent a copy, and the Request stays unread for the next.
        const own = action.init?.body == null ? request : undefined;
        const copied = own?.body && !own.bodyUsed ? own : undefined;
        const replayable = copied !== undefined || (!own?.body && ActorHttpThrottle.replayable(action.init?.body));
        const listener = action.context.get(exports.KEY_HTTP_ATTEMPT_LISTENER);
        const context = action.context.set(KEY_WRAPPED, true).set(KEY_STOCK_RETRY_WRAPPED, true);
        // A retry keeps the request's place in arrival order, ahead of those that came after it.
        const arrival = this.arrivals++;
        const leave = () => {
            for (const queue of queues) {
                queue.leave();
            }
            listener?.settled();
        };
        for (let attempt = 0;; attempt++) {
            await queues[0].enter(queues, signal, arrival);
            const started = Date.now();
            listener?.sent();
            let response;
            try {
                response = await this.mediatorHttp.mediate({ ...action, ...(copied ? { input: copied.clone() } : {}), context });
            }
            catch (error) {
                leave();
                throw error;
            }
            // Learned before the request gives up its place: the queues start the next one as soon
            // as it does, and a refusal learned after that let one more request go at the old pace.
            const refusal = ActorHttpThrottle.refusal(response);
            const wait = refusal ? ActorHttpThrottle.retryAfter(response.headers.get('retry-after')) : undefined;
            for (const { pacing } of queues) {
                if (!refusal) {
                    pacing.answered(started);
                }
                else if (wait === undefined) {
                    pacing.refused(started);
                }
                else {
                    // Past the limit this request gives up, and the others must not wait longer either.
                    pacing.pause(delayLimit === undefined ? wait : Math.min(wait, delayLimit));
                }
            }
            leave();
            if (refusal) {
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
            if ((response.status === 504 || forced.includes(response.status)) && attempt < failureRetries && replayable) {
                await ActorHttpThrottle.discard(response);
                listener?.retrying?.();
                await sleep(fallbackDelay, signal);
                continue;
            }
            return response;
        }
    }
    /** The action, with the actor's `User-Agent` if it has none and runs outside a browser. */
    identified(action) {
        if (this.userAgent === undefined || bus_http_1.ActorHttp.isBrowser()) {
            return action;
        }
        // fetch sends a Request's own headers only when the init gives none, and replaces them all
        // when it does: the headers to keep are the init's, or else the Request's.
        const headers = new Headers(action.init?.headers ?? requestOf(action.input)?.headers);
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
     * The queue of a host or group for these limits, held for the caller until it calls
     * `release`. Each set of limits has its own, so that a query's limits hold whatever another
     * query's say, and the name's queues share its pacing. A queue no request holds is dropped,
     * so the limits of past queries do not keep queues for good; the pacing stays, since the
     * time of the host's last start and what refusals taught outlive any one queue.
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
            const created = new HostQueue(limit, spacing, pacing, () => {
                if (this.queues.get(key) === created) {
                    this.queues.delete(key);
                }
            });
            queue = created;
            this.queues.set(key, queue);
        }
        queue.hold();
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
    /**
     * Milliseconds a `Retry-After` value asks for, in seconds (whole, or with a fraction, as some
     * servers send) or as an HTTP date, which names its day or month. Anything else asks for
     * nothing: `Date.parse` reads `0.5` as a date in 2000, which would retry at once.
     */
    static retryAfter(value) {
        if (value === null) {
            return undefined;
        }
        const trimmed = value.trim();
        let wait = Number.NaN;
        if (/^\d+(?:\.\d+)?$/u.test(trimmed)) {
            wait = Number(trimmed) * 1_000;
        }
        else if (/[a-z]/iu.test(trimmed)) {
            wait = Date.parse(trimmed) - Date.now();
        }
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
/** The input as a Request, when it is one rather than a URL. */
function requestOf(input) {
    return typeof input === 'object' && input !== null && 'headers' in input ? input : undefined;
}
/**
 * When one host or group may start a request, shared by every queue of the name. What refusals
 * taught, and a pause, hold for all of its requests, counted from its last start, since the
 * server sees all of them. A configured rate holds for the requests given it, counted from the
 * last of them: counted from any start, each request of a query allowed 50 a second put off
 * those of one allowed 10 again, and they waited until the other query was done.
 */
class Pacing {
    /** Milliseconds between starts learned from refusals without `Retry-After`. */
    learned = 0;
    /** No request starts before this time, which a `Retry-After` set. */
    until = 0;
    lastStart = Number.NEGATIVE_INFINITY;
    /** The last start of the requests given each configured spacing. */
    starts = new Map();
    /** When `learned` last grew. Requests started before then were sent at the old rate. */
    raisedAt = Number.NEGATIVE_INFINITY;
    /** The name's queues, pumped together in the order their requests arrived. */
    queues = new Set();
    timer;
    timerAt = 0;
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
    /** When a request given `spacing` may next start. */
    earliest(spacing) {
        return Math.max((this.starts.get(spacing) ?? Number.NEGATIVE_INFINITY) + spacing, this.lastStart + this.learned, this.until);
    }
    /** A request given `spacing` starts `at`. */
    started(spacing, at) {
        this.lastStart = at;
        this.starts.set(spacing, at);
    }
    /**
     * Pumps the name's queues, the one whose next request arrived first going first. (Each queue
     * had a timer of its own, and the one that set it first started its next request first and
     * set its timer first again: another query's requests waited behind all of its.)
     */
    pump() {
        for (const queue of [...this.queues].sort(byNextArrival)) {
            queue.pump();
        }
    }
    /** Pumps the name's queues, and those they hold back, at `at`, unless an earlier wake is set. */
    wake(at) {
        if (this.timer !== undefined) {
            if (this.timerAt <= at) {
                return;
            }
            clearTimeout(this.timer);
        }
        this.timerAt = at;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.unblock();
        }, at - Date.now());
    }
    /** Drops the wake: no queue of the name is left to pump, or a pause it was set for is forgotten. */
    unwake() {
        clearTimeout(this.timer);
        this.timer = undefined;
    }
    /** Forgets the learned interval and any pause, and lets the queues waiting on them go on. */
    reset() {
        this.learned = 0;
        this.until = 0;
        this.raisedAt = Number.NEGATIVE_INFINITY;
        this.unwake();
        this.unblock();
    }
    /** Pumps the name's queues, and then the host queues they hold back. */
    unblock() {
        this.pump();
        for (const queue of [...this.queues]) {
            queue.pumpBlocked();
        }
    }
}
/** Orders queues by when the request waiting first in each arrived. */
function byNextArrival(left, right) {
    return (left.nextArrival() - right.nextArrival()) || 0;
}
/**
 * Requests to one host or group with one set of limits: at most `limit` in flight, starts
 * spaced, waiters in order. Requests wait in their host's queue; a group's queue has none of
 * its own, and only counts and spaces the starts of its hosts' requests.
 */
class HostQueue {
    limit;
    spacing;
    pacing;
    idle;
    active = 0;
    /** Requests that hold this queue, waiting, in flight, or between attempts. */
    holders = 0;
    waiting = [];
    /** Host queues whose next waiter this queue holds back, to pump when it may start one. */
    blocked = new Set();
    /**
     * @param limit Requests in flight at most.
     * @param spacing Milliseconds between starts that a configured rate asks for.
     * @param pacing When the host or group may start a request, shared with its other queues.
     * @param idle Called once no request holds the queue any longer.
     */
    constructor(limit, spacing, pacing, idle) {
        this.limit = limit;
        this.spacing = spacing;
        this.pacing = pacing;
        this.idle = idle;
        pacing.queues.add(this);
    }
    get interval() {
        return Math.max(this.spacing, this.pacing.learned);
    }
    /** Taken by each request that waits in or counts against this queue, until it calls `release`. */
    hold() {
        this.holders++;
    }
    /** The request is done with the queue; once none holds it, it is let go. */
    release() {
        if (--this.holders === 0) {
            this.pacing.queues.delete(this);
            if (this.pacing.queues.size === 0) {
                this.pacing.unwake();
            }
            this.idle();
        }
    }
    /**
     * Waits until the request may start in this queue, its host's, and in each of `queues`, in
     * order of `arrival`: at the back of this queue, or, for a retry, ahead of the requests that
     * arrived after it. It then holds a place in all of them.
     */
    async enter(queues, signal, arrival) {
        signal?.throwIfAborted();
        await new Promise((resolve, reject) => {
            const abort = () => {
                const index = this.waiting.indexOf(waiter);
                if (index >= 0) {
                    this.waiting.splice(index, 1);
                }
                reject(signal.reason);
                // The waiter may have held back the ones behind it.
                this.pacing.pump();
            };
            const waiter = {
                queues,
                arrival,
                admit: () => {
                    signal?.removeEventListener('abort', abort);
                    resolve();
                },
            };
            signal?.addEventListener('abort', abort, { once: true });
            const later = this.waiting.length > 0 && this.waiting.at(-1).arrival > arrival ?
                this.waiting.findIndex(other => other.arrival > arrival) :
                -1;
            if (later < 0) {
                this.waiting.push(waiter);
            }
            else {
                this.waiting.splice(later, 0, waiter);
            }
            this.pacing.pump();
        });
    }
    leave() {
        this.active--;
        this.unblock();
    }
    /** Pumps the queues of this one's name, and then the host queues it held back. */
    unblock() {
        this.pacing.pump();
        this.pumpBlocked();
    }
    /**
     * Pumps the host queues whose waiters this one held back, the one whose next request arrived
     * first going first. (In the order they were held back, a host whose next request was held
     * back again went first again: one host with requests to send kept every place in its group
     * from another host's request that had waited longer.)
     */
    pumpBlocked() {
        const blocked = [...this.blocked].sort(byNextArrival);
        this.blocked.clear();
        for (const queue of blocked) {
            queue.pacing.pump();
        }
    }
    /**
     * Admits the waiters that may start now in every one of their queues, and arranges to look
     * again for the next one that may not: a wake of the name whose time it waits for, or a word
     * from the queue that is full. Admission takes a place in all of a request's queues at once,
     * and stamps each one's start, so that each queue's rate counts from the actual start.
     */
    pump() {
        while (this.waiting.length > 0) {
            const waiter = this.waiting[0];
            const now = Date.now();
            let start = Number.NEGATIVE_INFINITY;
            let holder = this;
            for (const queue of waiter.queues) {
                const earliest = queue.earliest();
                if (earliest > start) {
                    start = earliest;
                    holder = queue;
                }
            }
            if (start > now) {
                if (holder !== this) {
                    holder.blocked.add(this);
                }
                // A spacing or a pause: the name that holds the waiter back pumps its queues, and those
                // they hold back, in the order their requests arrived. Full: the full queue pumps them
                // when it has room.
                if (Number.isFinite(start)) {
                    holder.pacing.wake(start);
                }
                return;
            }
            this.waiting.shift();
            for (const queue of waiter.queues) {
                queue.active++;
                queue.pacing.started(queue.spacing, now);
            }
            waiter.admit();
        }
    }
    /** When the request waiting first in this queue arrived, if one waits. */
    nextArrival() {
        return this.waiting[0]?.arrival ?? Number.POSITIVE_INFINITY;
    }
    /** When this queue could next start a request, or never while it is full. */
    earliest() {
        if (this.active >= this.limit) {
            return Number.POSITIVE_INFINITY;
        }
        return this.pacing.earliest(this.spacing);
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