import type { IActionHttp, IActorHttpArgs, IActorHttpOutput, MediatorHttp } from '@comunica/bus-http';
import { ActorHttp } from '@comunica/bus-http';
import type { ActorHttpInvalidateListenable } from '@comunica/bus-http-invalidate';
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
export class ActorHttpThrottle extends ActorHttp {
  public readonly mediatorHttp: MediatorHttp;
  public readonly inFlight: number;
  public readonly retries: number;
  public readonly hosts: Record<string, IHostLimits>;
  public readonly userAgent?: string;
  /** The queues requests wait in, per host or group and the limits they were given. */
  private readonly queues = new Map<string, HostQueue>();
  /** What refusals taught, per host or group, shared by its queues. */
  private readonly pacings = new Map<string, Pacing>();

  public constructor(args: IActorHttpThrottleArgs) {
    super(args);
    this.mediatorHttp = args.mediatorHttp;
    this.inFlight = args.inFlight ?? 32;
    this.retries = args.retries ?? 5;
    this.hosts = args.hosts ?? {};
    this.userAgent = args.userAgent;
    args.httpInvalidator?.addInvalidateListener(action => this.invalidate(action.url));
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
    const queues = this.queuesFor(url, action.context);
    try {
      return await this.attempts(action, url, queues);
    } finally {
      for (const queue of queues) {
        queue.release();
      }
    }
  }

  /** Sends the request through its queues, again for each refusal or failure it may retry. */
  private async attempts(action: IActionHttp, url: URL, queues: HostQueue[]): Promise<IActorHttpOutput> {
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
    const leave = (): void => {
      for (const queue of queues) {
        queue.leave();
      }
      listener?.settled();
    };
    for (let attempt = 0; ; attempt++) {
      await queues[0].enter(queues, signal, attempt > 0);
      const started = Date.now();
      listener?.sent();
      let response: IActorHttpOutput;
      try {
        response = await this.mediatorHttp.mediate({ ...action, context });
      } catch (error: unknown) {
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
        } else if (wait === undefined) {
          pacing.refused(started);
        } else {
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
  private identified(action: IActionHttp): IActionHttp {
    if (this.userAgent === undefined || ActorHttp.isBrowser()) {
      return action;
    }
    // fetch sends a Request's own headers only when the init gives none, and replaces them all
    // when it does: the headers to keep are the init's, or else the Request's.
    const input: unknown = action.input;
    const request = typeof input === 'object' && input !== null && 'headers' in input ? <Request> input : undefined;
    const headers = new Headers(action.init?.headers ?? request?.headers);
    if (headers.has('user-agent')) {
      return action;
    }
    headers.set('user-agent', this.userAgent);
    return { ...action, init: { ...action.init, headers }};
  }

  /**
   * The queues a request waits in: its host's, with the limits named by its host and port or
   * else its hostname, then the queue of each group it is in that has limits. The context's
   * limits for a name override the actor's, field by field.
   */
  private queuesFor(url: URL, context: IActionContext): HostQueue[] {
    const given = context.get(KEY_HTTP_HOST_LIMITS);
    const limitsOf = (name: string): IHostLimits | undefined =>
      (given?.[name] ?? this.hosts[name]) ? { ...this.hosts[name], ...given?.[name] } : undefined;
    const [ host, hostname, ...groups ] = hostNames(url);
    const own = limitsOf(host) ?? limitsOf(hostname) ?? {};
    const queues = [ this.queue(url.host, own.inFlight ?? context.get(KEY_HTTP_IN_FLIGHT) ?? this.inFlight, own.perSecond) ];
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
  private queue(name: string, inFlight: number, perSecond: number | undefined): HostQueue {
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
      const created: HostQueue = new HostQueue(limit, spacing, pacing, () => {
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
  private invalidate(url: string | undefined): void {
    let names: Set<string> | undefined;
    if (url !== undefined) {
      try {
        names = new Set(hostNames(new URL(url)));
      } catch {
        return;
      }
    }
    for (const [ name, pacing ] of this.pacings) {
      if (!names || names.has(name)) {
        pacing.reset();
      }
    }
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
export function hostNames(url: URL): string[] {
  const labels = url.hostname.split('.');
  return [ url.host, url.hostname, ...labels.slice(1, -1).map((_, i) => `*.${labels.slice(i + 1).join('.')}`) ];
}

interface IWaiter {
  /** The request's queues: its host's, in whose waiting list it is, then its groups'. */
  queues: HostQueue[];
  admit: () => void;
}

/**
 * What one host's or group's refusals taught, and when it last started a request: shared by
 * every queue of the name, since the server sees all of them.
 */
class Pacing {
  /** Milliseconds between starts learned from refusals without `Retry-After`. */
  public learned = 0;
  /** No request starts before this time, which a `Retry-After` set. */
  public until = 0;
  public lastStart = Number.NEGATIVE_INFINITY;
  /** When `learned` last grew. Requests started before then were sent at the old rate. */
  private raisedAt = Number.NEGATIVE_INFINITY;
  /** The name's queues, to wake when a pause is forgotten. */
  public readonly queues = new Set<HostQueue>();

  /** A refusal without `Retry-After` of a request started at `started`: start less often. */
  public refused(started: number): void {
    if (started < this.raisedAt) {
      return;
    }
    this.learned = this.learned === 0 ? FIRST_INTERVAL_MS : Math.min(this.learned * 2, LONGEST_INTERVAL_MS);
    this.raisedAt = Date.now();
  }

  /** A refusal with `Retry-After`: start nothing for this long. */
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

  /** Forgets the learned interval and any pause, and lets the queues waiting on them go on. */
  public reset(): void {
    this.learned = 0;
    this.until = 0;
    this.raisedAt = Number.NEGATIVE_INFINITY;
    for (const queue of this.queues) {
      queue.unblock();
    }
  }
}

/**
 * Requests to one host or group with one set of limits: at most `limit` in flight, starts
 * spaced, waiters in order. Requests wait in their host's queue; a group's queue has none of
 * its own, and only counts and spaces the starts of its hosts' requests.
 */
class HostQueue {
  private active = 0;
  /** Requests that hold this queue, waiting, in flight, or between attempts. */
  private holders = 0;
  private readonly waiting: IWaiter[] = [];
  /** Host queues whose next waiter this queue holds back, to pump when it may start one. */
  private readonly blocked = new Set<HostQueue>();
  private timer?: ReturnType<typeof setTimeout>;
  private timerAt = 0;

  /**
   * @param limit Requests in flight at most.
   * @param spacing Milliseconds between starts that a configured rate asks for.
   * @param pacing What the host's or group's refusals taught, shared with its other queues.
   * @param idle Called once no request holds the queue any longer.
   */
  public constructor(
    private readonly limit: number,
    private readonly spacing: number,
    public readonly pacing: Pacing,
    private readonly idle: () => void,
  ) {
    pacing.queues.add(this);
  }

  public get interval(): number {
    return Math.max(this.spacing, this.pacing.learned);
  }

  /** Taken by each request that waits in or counts against this queue, until it calls `release`. */
  public hold(): void {
    this.holders++;
  }

  /** The request is done with the queue; once none holds it, it is let go. */
  public release(): void {
    if (--this.holders === 0) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.pacing.queues.delete(this);
      this.idle();
    }
  }

  /**
   * Waits until the request may start in this queue, its host's, and in each of `queues`, at
   * the back of this queue or, for a retry, at the front. It then holds a place in all of them.
   */
  public async enter(queues: HostQueue[], signal: AbortSignal | undefined, front: boolean): Promise<void> {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) {
          this.waiting.splice(index, 1);
        }
        reject(signal!.reason);
        // The waiter may have held back the ones behind it.
        this.pump();
      };
      const waiter: IWaiter = {
        queues,
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
    this.unblock();
  }

  /** Pumps this queue, and the host queues whose waiters it held back. */
  public unblock(): void {
    this.pump();
    const blocked = [ ...this.blocked ];
    this.blocked.clear();
    for (const queue of blocked) {
      queue.pump();
    }
  }

  /**
   * Admits the waiters that may start now in every one of their queues, and arranges to look
   * again for the next one that may not: a timer for a spacing or a pause, or a word from the
   * queue that is full. Admission takes a place in all of a request's queues at once, and
   * stamps each one's last start, so that each queue's rate counts from the actual start.
   */
  public pump(): void {
    while (this.waiting.length > 0) {
      const waiter = this.waiting[0];
      const now = Date.now();
      let start = Number.NEGATIVE_INFINITY;
      let holder: HostQueue = this;
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
        if (Number.isFinite(start)) {
          this.wake(start - now);
        } else {
          // Full: the queue that is full pumps this one when it has room.
          this.unwake();
        }
        return;
      }
      this.waiting.shift();
      for (const queue of waiter.queues) {
        queue.active++;
        queue.pacing.lastStart = now;
      }
      waiter.admit();
    }
    // Nothing waits on a timer now: a pause forgotten early must not leave one set for its end.
    this.unwake();
  }

  /** When this queue could next start a request, or never while it is full. */
  private earliest(): number {
    if (this.active >= this.limit) {
      return Number.POSITIVE_INFINITY;
    }
    return Math.max(this.pacing.lastStart + this.interval, this.pacing.until);
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

  private unwake(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
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
