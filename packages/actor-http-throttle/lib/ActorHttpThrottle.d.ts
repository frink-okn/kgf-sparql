import type { IActionHttp, IActorHttpArgs, IActorHttpOutput, MediatorHttp } from '@comunica/bus-http';
import { ActorHttp } from '@comunica/bus-http';
import type { ActorHttpInvalidateListenable } from '@comunica/bus-http-invalidate';
import type { TestResult } from '@comunica/core';
import { ActionContextKey } from '@comunica/core';
import type { IMediatorTypeTime } from '@comunica/mediatortype-time';
/**
 * Limits for one host, named as `URL.host` (with its port) or `URL.hostname`, or for a group
 * of hosts, named `*.` and a domain: `*.wikidata.org` limits all of its subdomains together.
 */
export interface IHostLimits {
    /** Requests sent and not yet answered, at most. */
    inFlight?: number;
    /** Requests started per second, at most. */
    perSecond?: number;
}
/** Requests in flight per host, for every host without a limit of its own. */
export declare const KEY_HTTP_IN_FLIGHT: ActionContextKey<number>;
/**
 * Limits for particular hosts, keyed by `URL.host`, `URL.hostname`, or `*.` and a domain. They
 * take precedence, field by field, over the actor's own `hosts`.
 */
export declare const KEY_HTTP_HOST_LIMITS: ActionContextKey<Record<string, IHostLimits>>;
/**
 * Told when each attempt at a request leaves its host's queue (`sent`), when its response
 * headers arrive or it fails (`settled`), and when its response is let go for another attempt
 * (`retrying`), so that a caller can time a request by how long the server takes rather than
 * how long it waited its turn. A SPARQL source times its COUNT queries this way.
 */
export interface IHttpAttemptListener {
    sent: () => void;
    settled: () => void;
    /** The attempt's response is discarded, and the request waits its turn for the next one. */
    retrying?: () => void;
}
/** An `IHttpAttemptListener` for the request this context goes with. */
export declare const KEY_HTTP_ATTEMPT_LISTENER: ActionContextKey<IHttpAttemptListener>;
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
 * limits a client across its hosts. A request waits in its host's queue, and starts only when
 * its host and every such group it is in can all start it at that moment, so a host's own
 * limits hold within its group's, never in place of them. (A request used to take its host's
 * turn and then wait for the group's, and a group that held several back let them all start
 * at once, past the host's rate.) Requests with other limits for the same host or group, as
 * another query's context gives, wait in a queue of their own, so each query's limits hold for
 * its requests; a queue no request holds is let go.
 *
 * The spacing is the larger of a configured rate (`perSecond`) and one learned from refusals,
 * which a host's or group's queues share, as they share the time of its last start. A 429 or
 * 503 with `Retry-After` pauses the host and its groups until then, or for the context's
 * `httpRetryDelayLimit` at most, and teaches nothing else: the server said when to come back,
 * as KGF's admission gate does. One without `Retry-After` doubles the interval between starts,
 * from 250 ms up to 10 s, and every answer that is not a refusal takes a tenth off it, so the
 * host settles near the rate it accepts. An answer teaches before its request gives up its
 * place, so the next request starts at the new pace. Only a request started since the last change counts:
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
export declare class ActorHttpThrottle extends ActorHttp {
    readonly mediatorHttp: MediatorHttp;
    readonly inFlight: number;
    readonly retries: number;
    readonly hosts: Record<string, IHostLimits>;
    readonly userAgent?: string;
    /** The queues requests wait in, per host or group and the limits they were given. */
    private readonly queues;
    /** What refusals taught, per host or group, shared by its queues. */
    private readonly pacings;
    constructor(args: IActorHttpThrottleArgs);
    test(action: IActionHttp): Promise<TestResult<IMediatorTypeTime>>;
    run(action: IActionHttp): Promise<IActorHttpOutput>;
    /** Sends the request through its queues, again for each refusal or failure it may retry. */
    private attempts;
    /** The action, with the actor's `User-Agent` if it has none and runs outside a browser. */
    private identified;
    /**
     * The queues a request waits in: its host's, with the limits named by its host and port or
     * else its hostname, then the queue of each group it is in that has limits. The context's
     * limits for a name override the actor's, field by field.
     */
    private queuesFor;
    /**
     * The queue of a host or group for these limits, held for the caller until it calls
     * `release`. Each set of limits has its own, so that a query's limits hold whatever another
     * query's say, and the name's queues share its pacing. A queue no request holds is dropped,
     * so the limits of past queries do not keep queues for good; the pacing stays, since the
     * time of the host's last start and what refusals taught outlive any one queue.
     */
    private queue;
    /** Forgets what refusals taught about the URL's host and its groups, or about every host without one. */
    private invalidate;
    /** A refusal to serve the request now: 429, 503, or a 405 with `Retry-After`, as DBpedia sends. */
    static refusal(response: Response): boolean;
    /** Milliseconds a `Retry-After` value asks for, in seconds or as an HTTP date. */
    static retryAfter(value: string | null): number | undefined;
    /** Whether a request body can be sent again. A stream is read once. */
    static replayable(body: unknown): boolean;
    /** Lets go of a response that will not be read, so its connection can carry the retry. */
    private static discard;
}
export interface IActorHttpThrottleArgs extends IActorHttpArgs {
    /** The HTTP mediator, which sends each request on to the actors below this one. */
    mediatorHttp: MediatorHttp;
    /**
     * Requests in flight per host when the context sets no limit.
     * @range {integer}
     * @default {32}
     */
    inFlight?: number;
    /**
     * Retries of a request refused with 429 or 503 when the context sets no `httpRetryCount`.
     * @range {integer}
     * @default {5}
     */
    retries?: number;
    /**
     * Limits for particular hosts or groups of hosts, as `KEY_HTTP_HOST_LIMITS` gives them,
     * which overrides these field by field; `{}` for none. Components.js reads a JSON
     * parameter only when it is required.
     * @range {json}
     */
    hosts: Record<string, IHostLimits>;
    /** The `User-Agent` of requests that have none, under Node. */
    userAgent?: string;
    /**
     * Tells the actor when the HTTP cache is invalidated, upon which it forgets what refusals taught.
     * @default {<default_invalidator> a <npmd:@comunica/bus-http-invalidate/^5.0.0/components/ActorHttpInvalidateListenable.jsonld#ActorHttpInvalidateListenable>}
     */
    httpInvalidator?: ActorHttpInvalidateListenable;
}
/**
 * The names a limit for a URL's host may be given under, most particular first: the host with
 * its port, then without, then `*.` and each shorter domain the host is in (`*.wikidata.org`
 * for `query.wikidata.org`, never `*.org`).
 */
export declare function hostNames(url: URL): string[];
//# sourceMappingURL=ActorHttpThrottle.d.ts.map