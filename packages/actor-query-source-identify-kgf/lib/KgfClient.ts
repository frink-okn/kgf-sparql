import type { MediatorHttp } from '@comunica/bus-http';
import type { IActionContext } from '@comunica/types';
import type { IVoidDatasetStatistics, IVoidPropertyPartition } from '@frink-okn/actor-rdf-join-selectivity-void';
import { KEY_KGF_HTTP_METHOD } from './Context';

export interface KgfCount { value: number; exact: boolean }
/** A pattern's size, and how long the request that learned it took. */
export interface KgfSize { count: KgfCount; requestTime: number }
export interface KgfTerm { type: 'iri' | 'bnode' | 'literal'; value: string; lang?: string; datatype?: string }
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

/**
 * A client per query: promises deduplicate discovery, statistics, and patterns' sizes without
 * caching result pages.
 */
export class KgfClient {
  private discovery?: Promise<KgfService>;
  private readonly statistics = new Map<string, Promise<IVoidPropertyPartition | undefined>>();
  /** Patterns' sizes this query has learned, by the URL that asks for them. */
  private readonly sizes = new Map<string, Promise<KgfSize>>();
  private method: 'QUERY' | 'POST';

  public constructor(
    private readonly endpoint: string,
    private readonly mediatorHttp: MediatorHttp,
    private readonly context: IActionContext,
  ) {
    this.method = context.get(KEY_KGF_HTTP_METHOD) ?? 'QUERY';
    if (this.method !== 'QUERY' && this.method !== 'POST') {
      throw new Error('KGF httpMethod must be QUERY or POST');
    }
  }

  public discover(): Promise<KgfService> {
    return this.discovery ??= this.discoverService();
  }

  private async discoverService(): Promise<KgfService> {
    const url = new URL(this.endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash) {
      throw new Error('KGF sources must be HTTP(S) dataset or versioned fragment URLs without query parameters');
    }
    const path = url.pathname.replace(/\/$/u, '');
    const versioned = /^(.*)\/[^/]+\/v\/[^/]+(?:\/fragment)?$/u.exec(path);
    let fragment: string;
    let serviceRoot: string;
    if (versioned) {
      fragment = new URL(path.endsWith('/fragment') ? path : `${path}/fragment`, url).href;
      serviceRoot = new URL(`${versioned[1]}/`, url).href;
    } else {
      // Dataset descriptors pin 'current' once for this query, including body-carrying reads.
      // Resolve a latest alias through that descriptor rather than fetching a fragment
      // merely to follow its redirect. Planning must still start with /count.
      const datasetPath = path.replace(/\/latest\/fragment$/u, '');
      const datasetUrl = new URL(datasetPath, url).href;
      const descriptor = await this.json(datasetUrl);
      const release = descriptor.releases?.find((entry: { version: string }) => entry.version === descriptor.current);
      if (typeof release?.links?.fragment !== 'string') {
        throw new Error(`No current KGF fragment in dataset descriptor ${datasetUrl}`);
      }
      fragment = new URL(release.links.fragment, `${datasetUrl}/`).href;
      serviceRoot = new URL(`${datasetPath.slice(0, datasetPath.lastIndexOf('/'))}/`, url).href;
    }
    const descriptor = await this.json(serviceRoot);
    return {
      fragment,
      count: new URL('count', fragment).href,
      schema: new URL('schema', fragment).href,
      maxLimit: positiveInteger(descriptor.caps?.max_limit, 1_000),
      maxBindings: positiveInteger(descriptor.caps?.max_bindings, 200),
      maxRequestBytes: positiveInteger(descriptor.budgets?.max_request_bytes, 1_048_576),
    };
  }

  public async json(url: string, body?: object, signal?: AbortSignal): Promise<any> {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const request = (method: string) => this.mediatorHttp.mediate({
      context: this.context,
      input: url,
      init: {
        method, body: encoded, signal,
        headers: { accept: 'application/json', ...(encoded === undefined ? {} : { 'content-type': 'application/json' }) },
      },
    });
    const method = encoded === undefined ? 'GET' : this.method;
    let response = await request(method);
    if (method === 'QUERY' && [405, 501].includes(response.status)) {
      await response.body?.cancel();
      this.method = 'POST';
      response = await request('POST');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`KGF request failed: ${response.status} ${response.statusText} (${url})`);
    }
    return response.json();
  }

  /** A pattern's size if this query has learned it or is learning it, by the URL that asks for it. */
  public size(key: string): Promise<KgfSize> | undefined {
    return this.sizes.get(key);
  }

  /**
   * Keep a pattern's size for the rest of the query, which takes the same request to give the
   * same answer while it runs. A size that failed to arrive, as a destroyed stream's aborted
   * request does, is forgotten, and the next plan of the pattern asks again.
   */
  public rememberSize(key: string, size: Promise<KgfSize>): void {
    this.sizes.set(key, size);
    size.catch(() => {
      if (this.sizes.get(key) === size) {
        this.sizes.delete(key);
      }
    });
  }

  public async getVoidStatistics(predicate?: string): Promise<IVoidDatasetStatistics | undefined> {
    const partition = predicate ? await this.schemaCounts(predicate) : undefined;
    // Only fetch dataset-wide ceilings if the predicate partition cannot supply both divisors.
    const dataset = partition?.distinctSubjects !== undefined && partition.distinctObjects !== undefined ?
      undefined : await this.schemaCounts('');
    if (!partition && !dataset) {
      return undefined;
    }
    return { ...dataset, ...(partition && predicate ? { propertyPartitions: { [predicate]: partition } } : {}) };
  }

  private schemaCounts(predicate: string): Promise<IVoidPropertyPartition | undefined> {
    let result = this.statistics.get(predicate);
    if (!result) {
      result = (async() => {
        const url = new URL((await this.discover()).schema);
        // Planning must use the merged graph, not the default designed-schema subset.
        url.searchParams.set('view', 'queryable');
        if (predicate) {
          url.searchParams.set('predicate', `<${predicate}>`);
        }
        const response = await this.json(url.href);
        const counts = response.complete === true ? response.node?.counts : undefined;
        if (!counts) {
          return undefined;
        }
        const stats: IVoidPropertyPartition = {};
        for (const [ wire, name ] of [
          ['triples', 'triples'], ['distinct_subjects', 'distinctSubjects'], ['distinct_objects', 'distinctObjects'],
        ] as const) {
          if (Number.isSafeInteger(counts[wire]) && counts[wire] > 0) {
            stats[name] = counts[wire];
          }
        }
        return Object.keys(stats).length ? stats : undefined;
      })().catch(() => undefined); // Optional statistics never make a query fail.
      this.statistics.set(predicate, result);
    }
    return result;
  }
}

export function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function readCount(response: any): KgfCount {
  const count = typeof response.count === 'number' ? { value: response.count, exact: response.exact } : response.count;
  if (!count || !Number.isSafeInteger(count.value) || count.value < 0 || typeof count.exact !== 'boolean') {
    throw new Error('Invalid KGF count response');
  }
  return { value: count.value, exact: count.exact && response.complete !== false };
}
