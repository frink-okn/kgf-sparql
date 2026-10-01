import type { IActionHttp, IActorHttpArgs, IActorHttpOutput, MediatorHttp } from '@comunica/bus-http';
import { ActorHttp } from '@comunica/bus-http';
import type { TestResult } from '@comunica/core';
import { ActionContextKey } from '@comunica/core';
import type { IMediatorTypeTime } from '@comunica/mediatortype-time';
/** Limits for one host, named as `URL.host` (with its port) or `URL.hostname`. */
export interface IHostLimits {
    /** Requests sent and not yet answered, at most. */
    inFlight?: number;
    /** Requests started per second, at most. */
    perSecond?: number;
}
/** Requests in flight per host, for every host without a limit of its own. */
export declare const KEY_HTTP_IN_FLIGHT: ActionContextKey<number>;
/** Limits for particular hosts, keyed by `URL.host` or `URL.hostname`. */
export declare const KEY_HTTP_HOST_LIMITS: ActionContextKey<Record<string, IHostLimits>>;
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
 * (`KEY_HTTP_IN_FLIGHT`, or the host's own in `KEY_HTTP_HOST_LIMITS`, else `inFlight`), and
 * no sooner after the previous start than the host's spacing allows. It holds its place until
 * its response headers arrive; the body is read outside the queue.
 *
 * The spacing is the larger of a configured rate (`perSecond`) and one learned from refusals.
 * A 429 or 503 with `Retry-After` pauses the host until then, and teaches nothing else: the
 * server said when to come back, as KGF's admission gate does. One without `Retry-After`
 * doubles the host's interval between starts, from 250 ms up to 10 s, and every answer that
 * is not a refusal takes a tenth off it, so the host settles near the rate it accepts. Only a
 * request started since the last change counts: the requests of one burst are refused
 * together, and each doubling the interval again took QLever to 10 s within seconds. A
 * timeout or network failure changes nothing: it says nothing about the host's rate.
 *
 * A refused request is retried through the queue, ahead of requests not yet sent, up to the
 * context's `httpRetryCount` or else `retries` times. Comunica's own retry actor is told to
 * stand aside, and this one keeps its other duties: with `httpRetryCount` set, a 504 or a
 * status in `httpRetryStatusCodes` is retried after `httpRetryDelayFallback`. When retries run
 * out, the last response is returned as it is, rather than a bare "Request failed", so the
 * caller reports the status. A request whose body is a stream is not retried.
 *
 * Nothing here is particular to Node: the actor runs the same in a browser.
 */
export declare class ActorHttpThrottle extends ActorHttp {
    readonly mediatorHttp: MediatorHttp;
    readonly inFlight: number;
    readonly retries: number;
    private readonly queues;
    constructor(args: IActorHttpThrottleArgs);
    test(action: IActionHttp): Promise<TestResult<IMediatorTypeTime>>;
    run(action: IActionHttp): Promise<IActorHttpOutput>;
    /** The host's queue, with the limits this request's context gives it. */
    private queueFor;
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
}
//# sourceMappingURL=ActorHttpThrottle.d.ts.map