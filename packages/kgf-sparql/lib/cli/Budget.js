"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RunAccount = exports.BudgetExceeded = void 0;
/** What a run's abort signal carries once a budget is exceeded; in-flight fetches reject with it. */
class BudgetExceeded extends Error {
    budget;
    constructor(budget, detail) {
        super(`Aborted at ${budget}: ${detail}`);
        this.budget = budget;
        this.name = 'BudgetExceeded';
    }
}
exports.BudgetExceeded = BudgetExceeded;
/**
 * Accounts for every request a run makes and enforces its budgets.
 *
 * Installing `fetch` in the query context under Comunica's `KeysHttp.fetch` routes every
 * request the engine makes through it, because the HTTP actor prefers a fetch supplied
 * in context. No actor, config, or Comunica package changes; the engine simply cannot
 * make a request this object does not see.
 */
class RunAccount {
    budget;
    baseFetch;
    requests = [];
    bytes = 0;
    rows = 0;
    /** The budget that ended the run, once one has. */
    exceeded;
    /** A failure raised from outside the engine's own error path: a process-level error or signal. */
    failure;
    signal;
    controller = new AbortController();
    timer;
    constructor(budget, baseFetch = globalThis.fetch) {
        this.budget = budget;
        this.baseFetch = baseFetch;
        this.signal = this.controller.signal;
    }
    /** Starts the wall clock; the timeout budget counts from here. */
    startClock() {
        if (this.budget.timeoutSeconds !== undefined && !this.timer) {
            this.timer = setTimeout(() => this.abort('timeout', `${this.budget.timeoutSeconds} s elapsed`), this.budget.timeoutSeconds * 1_000);
        }
    }
    stopClock() {
        clearTimeout(this.timer);
        this.timer = undefined;
    }
    /** Ends the run at a budget: every in-flight request is aborted through its signal. */
    abort(budget, detail) {
        this.exceeded ??= budget;
        if (!this.signal.aborted) {
            this.controller.abort(new BudgetExceeded(this.exceeded, detail));
        }
    }
    /** Ends the run for a reason that is not a budget. The receipt reports it as an error. */
    fail(error) {
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
    countRow() {
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
    fetch = async (input, init = {}) => {
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
        const request = {
            method: (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(),
            url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
            status: null,
            request_id: null,
            bytes: 0,
            elapsed_ms: 0,
            bindings: carriesBindings(init.body),
            complete: null,
            truncation_reason: null,
        };
        this.requests.push(request);
        const started = performance.now();
        const elapsed = () => {
            request.elapsed_ms = Math.round((performance.now() - started) * 10) / 10;
        };
        const signal = init.signal ? AbortSignal.any([init.signal, this.signal]) : this.signal;
        let response;
        try {
            response = await this.baseFetch(input, { ...init, signal });
        }
        catch (error) {
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
        const counted = response.body.pipeThrough(new TransformStream({
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
exports.RunAccount = RunAccount;
/** True when a request body pushes bindings, which is how KGF `QUERY` carries a join's input rows. */
function carriesBindings(body) {
    if (typeof body !== 'string' || !body.includes('"bindings"')) {
        return false;
    }
    try {
        const parsed = JSON.parse(body);
        return typeof parsed === 'object' && parsed !== null && 'bindings' in parsed;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=Budget.js.map