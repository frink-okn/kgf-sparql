import type { IActionHttp, IActorHttpArgs, IActorHttpOutput, MediatorHttp } from '@comunica/bus-http';
import { ActorHttp } from '@comunica/bus-http';
import { KeysHttp } from '@comunica/context-entries';
import type { TestResult } from '@comunica/core';
import { ActionContextKey, failTest, passTest } from '@comunica/core';
import type { IMediatorTypeTime } from '@comunica/mediatortype-time';
import type { IActionContext } from '@comunica/types';

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
export const KEY_HTTP_IN_FLIGHT = new ActionContextKey<number>('@kgf/actor-http-throttle:inFlight');

/**
 * Limits for particular hosts, keyed by `URL.host`, `URL.hostname`, or `*.` and a domain. They
 * take precedence, field by field, over the actor's own `hosts`.
 */
export const KEY_HTTP_HOST_LIMITS = new ActionContextKey<Record<string, IHostLimits>>(
  '@kgf/actor-http-throttle:hosts',
);

/**
 * Told when each attempt at a request leaves its host's queue (`sent`) and when its response
 * headers arrive or it fails (`settled`), so that a caller can time a request by how long the
 * server takes rather than how long it waited its turn. A SPARQL source times its COUNT
 * queries this way.
 */
export interface IHttpAttemptListener {
  sent: () => void;
  settled: () => void;
}

/** An `IHttpAttemptListener` for the request this context goes with. */
export const KEY_HTTP_ATTEMPT_LISTENER = new ActionContextKey<IHttpAttemptListener>(
  '@kgf/actor-http-throttle:attemptListener',
);

/** Set on the requests this actor sends on, so that it paces each request once. */
const KEY_WRAPPED = new ActionContextKey<boolean>('@kgf/actor-http-throttle:wrapped');

/**
 * Comunica's retry actor's marker for a request it has wrapped (`ActorHttpRetry.keyWrapped`),
 * set so that actor stands aside: inside this one its retries would skip the pacing, and
 * around it they would multiply this actor's own. Context keys match by name.
 */
const KEY_STOCK_RETRY_WRAPPED = new ActionContextKey<boolean>('urn:comunica:actor-http-retry#wrapped');

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
 * limit named `*.` and a domain gives the hosts in that domain one queue between them, for a
 * service that limits a client across its hosts.
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
 * ## Who is asking
 *
 * Under Node, a request without a `User-Agent` header is sent with the actor's `userAgent`,
 * in place of Comunica's generic one. Some endpoints ask clients to name themselves and a
 * contact (Wikidata's query service does), and some turn generic clients away (UniProt). A
 * browser sends its own, and the actor leaves it alone there.
 *
 * Nothing else here is particular to Node: the actor runs the same in a browser.
 */
export class ActorHttpThrottle extends ActorHttp {
  public readonly mediatorHttp: MediatorHttp;
  public readonly inFlight: number;
  public readonly retries: number;
  public readonly hosts: Record<string, IHostLimits>;
  public readonly userAgent?: string;
  private readonly queues = new Map<string, HostQueue>();

  public constructor(args: IActorHttpThrottleArgs) {
    super(args);
    this.mediatorHttp = args.mediatorHttp;
    this.inFlight = args.inFlight ?? 32;
    this.retries = args.retries ?? 5;
    this.hosts = args.hosts ?? {};
    this.userAgent = args.userAgent;
  }

  public async test(action: IActionHttp): Promise<TestResult<IMediatorTypeTime>> {
    if (action.context.has(KEY_WRAPPED)) {
      return failTest(`${this.name} paces each request once`);
    }
    return passTest({ time: 0 });
  }

  public async run(action: IActionHttp): Promise<IActorHttpOutput> {
    action = this.identified(action);
    const url = ActorHttp.getInputUrl(action.input);
    const queue = this.queueFor(url, action.context);
    const signal = action.init?.signal ?? undefined;
    const retryCount = action.context.get(KeysHttp.httpRetryCount);
    const refusalRetries = retryCount ?? this.retries;
    const failureRetries = retryCount ?? 0;
    const forced = action.context.get(KeysHttp.httpRetryStatusCodes) ?? [];
    const fallbackDelay = action.context.get(KeysHttp.httpRetryDelayFallback) ?? 0;
    const delayLimit = action.context.get(KeysHttp.httpRetryDelayLimit);
    const replayable = ActorHttpThrottle.replayable(action.init?.body);
    const listener = action.context.get(KEY_HTTP_ATTEMPT_LISTENER);
    const context = action.context.set(KEY_WRAPPED, true).set(KEY_STOCK_RETRY_WRAPPED, true);
    for (let attempt = 0; ; attempt++) {
      await queue.enter(signal, attempt > 0);
      const started = Date.now();
      listener?.sent();
      let response: IActorHttpOutput;
      try {
        response = await this.mediatorHttp.mediate({ ...action, context });
      } finally {
        queue.leave();
        listener?.settled();
      }
      if (ActorHttpThrottle.refusal(response)) {
        const wait = ActorHttpThrottle.retryAfter(response.headers.get('retry-after'));
        if (wait === undefined) {
          queue.refused(started);
        } else {
          queue.pause(wait);
        }
        if (attempt >= refusalRetries || !replayable || (delayLimit !== undefined && (wait ?? 0) > delayLimit)) {
          return response;
        }
        this.logDebug(action.context, 'Refused, retrying', () => ({
          url: url.href,
          status: response.status,
          attempt: attempt + 1,
          retryAfterMs: wait,
          intervalMs: queue.interval,
        }));
        await ActorHttpThrottle.discard(response);
        continue;
      }
      queue.answered(started);
      if ((response.status === 504 || forced.includes(response.status)) && attempt < failureRetries && replayable) {
        await ActorHttpThrottle.discard(response);
        await sleep(fallbackDelay, signal);
        continue;
      }
      return response;
    }
  }

  /** The action, with the actor's `User-Agent` if it has none and runs outside a browser. */
  private identified(action: IActionHttp): IActionHttp {
    if (this.userAgent === undefined || ActorHttp.isBrowser()) {
      return action;
    }
    const headers = new Headers(action.init?.headers);
    if (headers.has('user-agent')) {
      return action;
    }
    headers.set('user-agent', this.userAgent);
    return { ...action, init: { ...action.init, headers }};
  }

  /**
   * The queue of the host, or of the group of hosts, with the limits the request's context and
   * the actor give it. The most particular name either knows decides: the host with its port,
   * then without, then `*.` and each shorter domain the host is in.
   */
  private queueFor(url: URL, context: IActionContext): HostQueue {
    const given = context.get(KEY_HTTP_HOST_LIMITS);
    const labels = url.hostname.split('.');
    const names = [ url.host, url.hostname, ...labels.slice(1, -1).map((_, i) => `*.${labels.slice(i + 1).join('.')}`) ];
    const name = names.find(candidate => given?.[candidate] ?? this.hosts[candidate]);
    const own: IHostLimits = name === undefined ? {} : { ...this.hosts[name], ...given?.[name] };
    const key = name?.startsWith('*.') ? name : url.host;
    let queue = this.queues.get(key);
    if (!queue) {
      queue = new HostQueue();
      this.queues.set(key, queue);
    }
    queue.configure(
      own.inFlight ?? context.get(KEY_HTTP_IN_FLIGHT) ?? this.inFlight,
      own.perSecond ? 1_000 / own.perSecond : 0,
    );
    return queue;
  }

  /** A refusal to serve the request now: 429, 503, or a 405 with `Retry-After`, as DBpedia sends. */
  public static refusal(response: Response): boolean {
    return response.status === 429 || response.status === 503 ||
      (response.status === 405 && response.headers.has('retry-after'));
  }

  /** Milliseconds a `Retry-After` value asks for, in seconds or as an HTTP date. */
  public static retryAfter(value: string | null): number | undefined {
    if (value === null) {
      return undefined;
    }
    const trimmed = value.trim();
    const wait = /^\d+$/u.test(trimmed) ? Number(trimmed) * 1_000 : Date.parse(trimmed) - Date.now();
    return Number.isNaN(wait) ? undefined : Math.max(0, wait);
  }

  /** Whether a request body can be sent again. A stream is read once. */
  public static replayable(body: unknown): boolean {
    return body === undefined || body === null || typeof body === 'string' ||
      body instanceof URLSearchParams || body instanceof ArrayBuffer || ArrayBuffer.isView(body) ||
      (typeof Blob !== 'undefined' && body instanceof Blob) ||
      (typeof FormData !== 'undefined' && body instanceof FormData);
  }

  /** Lets go of a response that will not be read, so its connection can carry the retry. */
  private static async discard(response: Response): Promise<void> {
    try {
      await response.body?.cancel();
    } catch {
      // Already read or errored: nothing is held.
    }
  }
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
}

interface IWaiter {
  admit: () => void;
}

/** One host's requests: at most `limit` in flight, starts spaced, waiters in order. */
class HostQueue {
  private active = 0;
  private limit = Number.POSITIVE_INFINITY;
  /** Milliseconds between starts that a configured rate asks for. */
  private spacing = 0;
  /** Milliseconds between starts learned from refusals without `Retry-After`. */
  private learned = 0;
  /** When `learned` last grew. Requests started before then were sent at the old rate. */
  private raisedAt = Number.NEGATIVE_INFINITY;
  /** No request starts before this time, which a `Retry-After` set. */
  private until = 0;
  private lastStart = Number.NEGATIVE_INFINITY;
  private readonly waiting: IWaiter[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private timerAt = 0;

  public get interval(): number {
    return Math.max(this.spacing, this.learned);
  }

  public configure(limit: number, spacing: number): void {
    this.limit = Math.max(1, limit);
    this.spacing = spacing;
    this.pump();
  }

  /** Waits for a place, at the back of the queue or, for a retry, at the front. */
  public async enter(signal: AbortSignal | undefined, front: boolean): Promise<void> {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) {
          this.waiting.splice(index, 1);
        }
        reject(signal!.reason);
      };
      const waiter: IWaiter = {
        admit: () => {
          signal?.removeEventListener('abort', abort);
          resolve();
        },
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (front) {
        this.waiting.unshift(waiter);
      } else {
        this.waiting.push(waiter);
      }
      this.pump();
    });
  }

  public leave(): void {
    this.active--;
    this.pump();
  }

  /** A refusal without `Retry-After` of a request started at `started`: start less often. */
  public refused(started: number): void {
    if (started < this.raisedAt) {
      return;
    }
    this.learned = this.learned === 0 ? FIRST_INTERVAL_MS : Math.min(this.learned * 2, LONGEST_INTERVAL_MS);
    this.raisedAt = Date.now();
  }

  /** A refusal with `Retry-After`: start nothing until then. */
  public pause(milliseconds: number): void {
    this.until = Math.max(this.until, Date.now() + milliseconds);
  }

  /** Any answer but a refusal, to a request started at `started`: start a little more often again. */
  public answered(started: number): void {
    if (this.learned > 0 && started >= this.raisedAt) {
      this.learned *= INTERVAL_DECAY;
      if (this.learned < SHORTEST_INTERVAL_MS) {
        this.learned = 0;
      }
    }
  }

  private pump(): void {
    while (this.waiting.length > 0 && this.active < this.limit) {
      const now = Date.now();
      const start = Math.max(this.lastStart + this.interval, this.until);
      if (start > now) {
        this.wake(start - now);
        return;
      }
      this.active++;
      this.lastStart = now;
      this.waiting.shift()!.admit();
    }
  }

  /** Pumps again after `delay`, unless an earlier wake is already set. */
  private wake(delay: number): void {
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

async function sleep(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  if (milliseconds <= 0) {
    return;
  }
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
