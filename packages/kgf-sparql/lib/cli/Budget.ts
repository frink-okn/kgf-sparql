import type { IReceiptRequest } from './Receipt';

/** The budgets a run may be given. An absent budget is unlimited. */
export interface IBudget {
  maxRequests?: number;
  /**
   * Decoded bytes received. This bounds what the sources hand the engine, not what the engine
   * builds from it: a join's output can be many times its inputs, and hash tables, sorts,
   * DISTINCT, and cloned streams hold rows on the heap. `maxHeap` bounds that.
   */
  maxBytes?: number;
  maxRows?: number;
  timeoutSeconds?: number;
  /**
   * Heap in use, in bytes, sampled every `HEAP_SAMPLE_MS` while the run is open, as the heap
   * reader given to `RunAccount` reads it; the command line passes `heapInUse` from `./Heap`.
   */
  maxHeap?: number;
}

export type BudgetName = 'max_requests' | 'max_bytes' | 'max_rows' | 'timeout' | 'max_heap';

/**
 * How often the heap budget samples the heap. The engine yields to the event loop every
 * hundred or so iterator tasks, so the sample runs even while a join is producing rows from
 * memory; a run growing its heap at the 150 MB/s the benchmark's crashes did overshoots the
 * budget by a few megabytes.
 */
export const HEAP_SAMPLE_MS = 50;

/** What a run's abort signal carries once a budget is exceeded; in-flight fetches reject with it. */
export class BudgetExceeded extends Error {
  public constructor(public readonly budget: BudgetName, detail: string) {
    super(`Aborted at ${budget}: ${detail}`);
    this.name = 'BudgetExceeded';
  }
}

/**
 * Accounts for every request a run makes and enforces its budgets.
 *
 * Installing `fetch` in the query context under Comunica's `KeysHttp.fetch` routes every
 * request the engine makes through it, because the HTTP actor prefers a fetch supplied
 * in context. No actor, config, or Comunica package changes; the engine simply cannot
 * make a request this object does not see.
 */
export class RunAccount {
  public readonly requests: IReceiptRequest[] = [];
  public bytes = 0;
  public rows = 0;
  /** The most heap in use at any sample while the run was open; undefined without a heap reader. */
  public heapPeak?: number;
  /** The budget that ended the run, once one has. */
  public exceeded?: BudgetName;
  /** A failure raised from outside the engine's own error path: a process-level error or signal. */
  public failure?: Error;
  public readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private timer?: NodeJS.Timeout;
  private sampler?: NodeJS.Timeout;

  public constructor(
    public readonly budget: IBudget,
    private readonly baseFetch: typeof fetch = globalThis.fetch,
    /**
     * Reads the heap in use, for the heap budget. There is no default: this module is also
     * bundled for browsers, which have no heap to read, and Node's is read by `./Heap`.
     */
    private readonly readHeap?: () => number,
  ) {
    this.signal = this.controller.signal;
    if (budget.maxHeap !== undefined && !readHeap) {
      throw new TypeError('A heap budget needs a heap reader to sample');
    }
  }

  /** Starts the wall clock and the heap sampler; the timeout and heap budgets count from here. */
  public startClock(): void {
    if (this.budget.timeoutSeconds !== undefined && !this.timer) {
      this.timer = setTimeout(
        () => this.abort('timeout', `${this.budget.timeoutSeconds} s elapsed`),
        this.budget.timeoutSeconds * 1_000,
      );
    }
    if (this.readHeap && !this.sampler) {
      this.sampleHeap();
      // Unreferenced: the sampler must not keep a stalled engine's event loop from draining.
      this.sampler = setInterval(() => this.sampleHeap(), HEAP_SAMPLE_MS).unref();
    }
  }

  public stopClock(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    clearInterval(this.sampler);
    this.sampler = undefined;
  }

  /**
   * Samples the heap in use and ends the run once it exceeds the heap budget. A sample counts
   * garbage not yet collected as well as what the engine holds, which is why the command's
   * default budget sits a quarter below the heap limit rather than at it.
   */
  public sampleHeap(): void {
    if (!this.readHeap) {
      return;
    }
    const used = this.readHeap();
    this.heapPeak = Math.max(this.heapPeak ?? 0, used);
    if (this.budget.maxHeap !== undefined && used > this.budget.maxHeap) {
      this.abort('max_heap', `${used} heap bytes in use`);
    }
  }

  /**
   * Settles as `promise` does, or rejects with the run's reason as soon as the run ends,
   * whichever comes first. Only the engine's requests observe the run's signal: a join or a
   * sort working from memory runs on after an abort, so the run must not wait for it.
   */
  public until<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(this.signal.reason);
      if (this.signal.aborted) {
        onAbort();
      } else {
        this.signal.addEventListener('abort', onAbort, { once: true });
      }
      promise.then(
        (value) => {
          this.signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: unknown) => {
          this.signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  /** Ends the run at a budget: every in-flight request is aborted through its signal. A run already ended keeps its reason. */
  public abort(budget: BudgetName, detail: string): void {
    if (this.signal.aborted) {
      return;
    }
    this.exceeded ??= budget;
    this.controller.abort(new BudgetExceeded(this.exceeded, detail));
  }

  /** Ends the run for a reason that is not a budget. The receipt reports it as an error. */
  public fail(error: Error): void {
    if (this.signal.aborted) {
      return;
    }
    this.failure = error;
    this.controller.abort(error);
  }

  /**
   * Accounts for one result row about to be written; false once the run has ended or the
   * row budget forbids the row. The row budget is the one budget that ends the result
   * stream cleanly rather than failing it: the rows before it are a well-formed document,
   * and the run aborts whatever is still in flight once that document is written.
   */
  public countRow(): boolean {
    if (this.exceeded || this.signal.aborted) {
      return false;
    }
    if (this.budget.maxRows !== undefined && this.rows >= this.budget.maxRows) {
      this.exceeded = 'max_rows';
      return false;
    }
    this.rows++;
    return true;
  }

  /** The counting fetch. Budgets are checked before each request and, for bytes, while its body streams. */
  public readonly fetch = async(input: Parameters<typeof fetch>[0], init: RequestInit = {}): Promise<Response> => {
    if (this.exceeded) {
      this.abort(this.exceeded, 'no further requests');
    }
    if (this.signal.aborted) {
      throw this.signal.reason;
    }
    if (this.budget.maxRequests !== undefined && this.requests.length >= this.budget.maxRequests) {
      this.abort('max_requests', `${this.requests.length} requests made`);
      throw this.signal.reason;
    }
    if (this.budget.maxBytes !== undefined && this.bytes >= this.budget.maxBytes) {
      this.abort('max_bytes', `${this.bytes} bytes received`);
      throw this.signal.reason;
    }
    const request: IReceiptRequest = {
      method: (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(),
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      status: null,
      request_id: null,
      bytes: 0,
      elapsed_ms: 0,
      bindings: carriesBindings(init.body) || /[?&]values=/u.test(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url),
      complete: null,
      truncation_reason: null,
    };
    this.requests.push(request);
    const started = performance.now();
    const elapsed = (): void => {
      request.elapsed_ms = Math.round((performance.now() - started) * 10) / 10;
    };
    const signal = init.signal ? AbortSignal.any([ init.signal, this.signal ]) : this.signal;
    let response: Response;
    try {
      response = await this.baseFetch(input, { ...init, signal });
    } catch (error: unknown) {
      elapsed();
      request.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
    elapsed();
    request.status = response.status;
    request.request_id = response.headers.get('kgf-request-id');
    const wire = response.headers.get('content-length');
    if (wire !== null && /^\d+$/u.test(wire)) {
      request.bytes_wire = Number(wire);
    }
    const complete = response.headers.get('kgf-complete');
    if (complete !== null) {
      request.complete = complete === 'true';
    }
    request.truncation_reason = response.headers.get('kgf-truncation-reason');
    if (!response.body) {
      return response;
    }
    // Count what the engine actually receives, after transport decoding, and stop a single
    // oversized body before it lands in memory: the heap deaths in the benchmark came from
    // responses of tens to hundreds of megabytes, not from any request count.
    const counted = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        request.bytes += chunk.byteLength;
        this.bytes += chunk.byteLength;
        if (this.budget.maxBytes !== undefined && this.bytes > this.budget.maxBytes) {
          this.abort('max_bytes', `${this.bytes} bytes received`);
          controller.error(this.signal.reason);
          return;
        }
        controller.enqueue(chunk);
      },
      flush: elapsed,
    }));
    const wrapped = new Response(counted, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    Object.defineProperty(wrapped, 'url', { value: response.url });
    return wrapped;
  };
}

/**
 * True when a request body pushes bindings, which is how KGF `QUERY` carries a join's input
 * rows. brTPF carries them in the URL instead, as `values=`, which the caller checks.
 */
function carriesBindings(body: RequestInit['body']): boolean {
  if (typeof body !== 'string' || !body.includes('"bindings"')) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null && 'bindings' in parsed;
  } catch {
    return false;
  }
}
