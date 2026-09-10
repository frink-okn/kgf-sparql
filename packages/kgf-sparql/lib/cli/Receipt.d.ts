import type { BudgetName } from './Budget';
export declare const RECEIPT_SCHEMA = "kgf-sparql.receipt/1";
/** One request the run made, as the counting fetch saw it. */
export interface IReceiptRequest {
    method: string;
    url: string;
    /** HTTP status, or null when no response arrived. */
    status: number | null;
    /** The server's `KGF-Request-Id`, which joins this entry to its line in the server's access log. */
    request_id: string | null;
    /** Decoded body bytes the engine received. */
    bytes: number;
    /** The `Content-Length` the server sent, when it sent one: the wire size, compressed when the body was. */
    bytes_wire?: number;
    /** From the request's start to the end of its body, or to the failure. */
    elapsed_ms: number;
    /** Whether the request pushed bindings: a join's input rows in a KGF `QUERY` body, or brTPF's `values=`. */
    bindings: boolean;
    /** The server's `KGF-Complete` header, when present. */
    complete: boolean | null;
    /** The server's `KGF-Truncation-Reason` header, when present. */
    truncation_reason: string | null;
    /** Set when the request failed before any response arrived. */
    error?: string;
}
export interface IReceiptSource {
    /** The source kind as given on the command line: `kgf`, `sparql`, or another Comunica source type. */
    kind: string;
    /** For a KGF source, the pinned release's fragment URL the engine read. */
    url: string;
    dataset?: string;
    version?: string;
    content_digest?: string | null;
}
/**
 * `complete`: the output is exactly the solution set the query denotes.
 * `aborted`: a budget ended the run; the output holds the rows written before it did.
 * `error`: the query, a source, or the process failed; the output is whatever was written.
 * Nothing in between: no partial result is ever labelled complete.
 */
export type ReceiptContract = 'complete' | 'aborted' | 'error';
export interface IReceiptOutcome {
    contract: ReceiptContract;
    /** Rows written to the output before the run ended. */
    rows: number;
    /** For an aborted run, the budget that ended it. */
    budget?: BudgetName;
    /** For an errored run, why; for an aborted run, only when the engine then stopped without ending it. */
    error?: string;
    /** Comunica's result type, once the query was planned: bindings, quads, or boolean. */
    result_type?: string;
}
export interface IReceiptOutput {
    path: string;
    format: string;
    /** For bindings, the projected variables, so a JSON Lines or empty output still names its columns. */
    variables?: string[];
}
export interface IReceipt {
    schema: typeof RECEIPT_SCHEMA;
    query: string;
    sources: IReceiptSource[];
    outcome: IReceiptOutcome;
    output: IReceiptOutput | null;
    requests: IReceiptRequest[];
    totals: {
        requests: number;
        bindings_requests: number;
        bytes: number;
        /** Wall clock from `started` to `finished`. */
        elapsed_ms: number;
    };
    statistics: {
        /** Whether lazy VoID join statistics were enabled for KGF sources. */
        void: boolean;
        /** How many `/schema` requests the lazy statistics provider made: the run's planning cost, apart from its data cost. */
        schema_requests: number;
    };
    budget: {
        max_requests: number | null;
        max_bytes: number | null;
        max_rows: number | null;
        timeout_s: number | null;
        /** Concurrent connections per origin the run's transport allowed. Not an abort budget. */
        max_connections: number;
    };
    engine: {
        kgf_sparql: string;
        comunica: string;
        node: string;
    };
    started: string;
    finished: string;
}
export declare function writeReceipt(path: string, receipt: IReceipt): void;
//# sourceMappingURL=Receipt.d.ts.map