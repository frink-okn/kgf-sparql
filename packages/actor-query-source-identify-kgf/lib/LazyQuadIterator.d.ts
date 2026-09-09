import type * as RDF from '@rdfjs/types';
import { BufferedIterator } from 'asynciterator';
/** Pulls rows only on demand, while allowing metadata to resolve independently. */
export declare class LazyQuadIterator extends BufferedIterator<RDF.Quad> {
    private readonly generate;
    readonly abortController: AbortController;
    private rows?;
    constructor(generate: (signal: AbortSignal) => AsyncGenerator<RDF.Quad>);
    protected _read(count: number, done: () => void): void;
    protected _destroy(cause: Error | undefined, callback: (error?: Error) => void): void;
}
//# sourceMappingURL=LazyQuadIterator.d.ts.map