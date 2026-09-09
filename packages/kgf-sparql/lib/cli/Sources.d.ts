import type { IReceiptSource } from './Receipt';
export interface ISourceSpec {
    kind: string;
    url: string;
}
/**
 * Parses a `kind@url` source argument: `kgf@` for a KGF fragment or dataset URL,
 * `sparql@` for a SPARQL endpoint named explicitly, or another Comunica source type.
 * A bare URL is refused: a tool that writes provenance should not guess what it queried.
 */
export declare function parseSource(argument: string): ISourceSpec;
/**
 * Describes a KGF source for the receipt from one request to its dataset descriptor,
 * pinning a `latest` alias or bare dataset URL to the release the engine will read.
 * Accepts every URL form the engine does: a versioned fragment or version URL, a dataset
 * URL, or its `/latest/fragment` alias.
 */
export declare function describeKgfSource(url: string, fetchFunction: typeof fetch): Promise<IReceiptSource>;
//# sourceMappingURL=Sources.d.ts.map