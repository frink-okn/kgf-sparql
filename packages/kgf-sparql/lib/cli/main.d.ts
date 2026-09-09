/** The run returned exactly the solution set the query denotes. */
export declare const EXIT_COMPLETE = 0;
/** The query or a source was wrong, or the process failed. */
export declare const EXIT_ERROR = 1;
/** The command line was wrong. */
export declare const EXIT_USAGE = 2;
/** A budget ended the run; the receipt says which. */
export declare const EXIT_ABORTED = 3;
export declare const USAGE: string;
export interface IRunOptions {
    /** The fetch to count, the global one by default. Tests pass a fake. */
    fetch?: typeof fetch;
    /** Aborting this signal fails the run with its reason; the process entry point wires fatal errors and signals to it. */
    fatal?: AbortSignal;
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
}
/** Runs the command line and returns its exit status. Files are closed and the receipt written before it returns. */
export declare function runCli(argv: string[], options?: IRunOptions): Promise<number>;
/** The process entry point: fatal errors and signals end the run through the receipt, not around it. */
export declare function main(): void;
//# sourceMappingURL=main.d.ts.map