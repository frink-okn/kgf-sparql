import * as fs from 'node:fs';
import type { AsyncIterator } from 'asynciterator';
import { TransformIterator } from 'asynciterator';
import type { RunAccount } from './Budget';
/**
 * Short names for the media types of Comunica's result serializers. Any media type the
 * engine knows may also be given verbatim; the engine's own serializers write every format.
 */
export declare const FORMATS: Record<string, string>;
/** SPARQL Results JSON by default, because `kgfq` and the corpus scripts read it; N-Triples for quads. */
export declare function mediaTypeFor(format: string | undefined, resultType: string): string;
/**
 * Results go to a file, never to a pipe: Node truncates unflushed writes at exit and pipes
 * cap at 64 KB. `close` returns once the descriptor is closed, so nothing written is lost.
 */
export declare class FileSink {
    readonly stream: fs.WriteStream;
    private failure?;
    private constructor();
    /** Opens the file before the query runs, so an unwritable path fails before the work, not after it. */
    static open(path: string): Promise<FileSink>;
    close(): Promise<void>;
}
/**
 * Counts rows on their way to the serializer and ends the stream cleanly at the row budget,
 * so the serializer closes its document and the rows before the budget are a well-formed file.
 */
export declare class BudgetIterator<T> extends TransformIterator<T, T> {
    private readonly account;
    constructor(source: AsyncIterator<T>, account: RunAccount);
    protected _transform(item: T, done: () => void, push: (item: T) => void): void;
}
/**
 * Pipes serialized output to the file with backpressure. A budget abort fails or destroys the
 * source, never the file, so what was written before the abort is flushed and kept.
 */
export declare function pump(data: NodeJS.ReadableStream, sink: FileSink, account: RunAccount): Promise<void>;
//# sourceMappingURL=Output.d.ts.map