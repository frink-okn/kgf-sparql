import type { MediatorHttp } from '@comunica/bus-http';
import type { IActionContext } from '@comunica/types';
import type { IVoidDatasetStatistics } from '@kgf/actor-rdf-join-selectivity-void';
export interface KgfCount {
    value: number;
    exact: boolean;
}
export interface KgfTerm {
    type: 'iri' | 'bnode' | 'literal';
    value: string;
    lang?: string;
    datatype?: string;
}
export interface KgfPage {
    rows: Record<string, KgfTerm | number>[];
    complete: boolean;
    next: string | null;
}
export interface KgfService {
    fragment: string;
    count: string;
    schema: string;
    maxLimit: number;
    maxBindings: number;
    maxRequestBytes: number;
}
/** A client per query: promises deduplicate discovery/statistics without caching result pages. */
export declare class KgfClient {
    private readonly endpoint;
    private readonly mediatorHttp;
    private readonly context;
    private discovery?;
    private readonly statistics;
    private method;
    constructor(endpoint: string, mediatorHttp: MediatorHttp, context: IActionContext);
    discover(): Promise<KgfService>;
    private discoverService;
    json(url: string, body?: object, signal?: AbortSignal): Promise<any>;
    getVoidStatistics(predicate?: string): Promise<IVoidDatasetStatistics | undefined>;
    private schemaCounts;
}
export declare function positiveInteger(value: unknown, fallback: number): number;
export declare function readCount(response: any): KgfCount;
//# sourceMappingURL=KgfClient.d.ts.map