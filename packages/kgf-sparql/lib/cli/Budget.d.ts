import type { IReceiptRequest } from './Receipt';
/** The budgets a run may be given. An absent budget is unlimited. */
export interface IBudget {
    maxRequests?: number;
    /** Decoded bytes received, which is what occupies the engine's heap. */
    maxBytes?: number;
    maxRows?: number;
    timeoutSeconds?: number;
}
export type BudgetName = 'max_requests' | 'max_bytes' | 'max_rows' | 'timeout';
/** What a run's abort signal carries once a budget is exceeded; in-flight fetches reject with it. */
export declare class BudgetExceeded extends Error {
    readonly budget: BudgetName;
    constructor(budget: BudgetName, detail: string);
}
/**
 * Accounts for every request a run makes and enforces its budgets.
 *
 * Installing `fetch` in the query context under Comunica's `KeysHttp.fetch` routes every
 * request the engine makes through it, because the HTTP actor prefers a fetch supplied
 * in context. No actor, config, or Comunica package changes; the engine simply cannot
 * make a request this object does not see.
 */
export declare class RunAccount {
    readonly budget: IBudget;
    private readonly baseFetch;
    readonly requests: IReceiptRequest[];
    bytes: number;
    rows: number;
    /** The budget that ended the run, once one has. */
    exceeded?: BudgetName;
    /** A failure raised from outside the engine's own error path: a process-level error or signal. */
    failure?: Error;
    readonly signal: AbortSignal;
    private readonly controller;
    private timer?;
    constructor(budget: IBudget, baseFetch?: typeof fetch);
    /** Starts the wall clock; the timeout budget counts from here. */
    startClock(): void;
    stopClock(): void;
    /** Ends the run at a budget: every in-flight request is aborted through its signal. A run already ended keeps its reason. */
    abort(budget: BudgetName, detail: string): void;
    /** Ends the run for a reason that is not a budget. The receipt reports it as an error. */
    fail(error: Error): void;
    /**
     * Accounts for one result row about to be written; false once the run has ended or the
     * row budget forbids the row. The row budget is the one budget that ends the result
     * stream cleanly rather than failing it: the rows before it are a well-formed document,
     * and the run aborts whatever is still in flight once that document is written.
     */
    countRow(): boolean;
    /** The counting fetch. Budgets are checked before each request and, for bytes, while its body streams. */
    readonly fetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>;
}
//# sourceMappingURL=Budget.d.ts.map