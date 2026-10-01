import type { MediatorHttp } from '@comunica/bus-http';
import { quadsToBindings } from '@comunica/bus-query-source-identify';
import { KeysInitQuery } from '@comunica/context-entries';
import type {
  BindingsStream, ComunicaDataFactory, FragmentSelectorShape, IActionContext, IQueryBindingsOptions,
  IQuerySource, MetadataQuads,
} from '@comunica/types';
import { Algebra, AlgebraFactory } from '@comunica/utils-algebra';
import type { BindingsFactory } from '@comunica/utils-bindings-factory';
import { MetadataValidationState } from '@comunica/utils-metadata';
import { VOID_STATISTICS_PROVIDER } from '@kgf/actor-rdf-join-selectivity-void';
import type * as RDF from '@rdfjs/types';
import type { AsyncIterator } from 'asynciterator';
import { termToString } from 'rdf-string-ttl';
import { KEY_KGF_BINDINGS_SIZE, KEY_KGF_PAGE_SIZE, KEY_KGF_VOID_STATISTICS } from './Context';
import type { KgfPage, KgfService, KgfTerm } from './KgfClient';
import { KgfClient, positiveInteger, readCount } from './KgfClient';
import { LazyQuadIterator } from './LazyQuadIterator';

const POSITIONS = ['subject', 'predicate', 'object'] as const;
const WIRE_POSITIONS = ['s', 'p', 'o'] as const;
type BindingRow = (RDF.Term | undefined)[];
interface Batch { rows: BindingRow[]; offset: number }
interface Prepared {
  client: KgfClient;
  service: KgfService;
  pageSize: number;
  variables: string[];
  rows?: BindingRow[];
  batches: Batch[];
  metadata: MetadataQuads;
}

/** Native KGF JSON triple source. Its published union is the SPARQL default graph. */
export class QuerySourceKgf implements IQuerySource {
  private readonly clients = new WeakMap<object, KgfClient>();
  private readonly selectorShape: FragmentSelectorShape;

  public constructor(
    public readonly referenceValue: string,
    private readonly mediatorHttp: MediatorHttp,
    private readonly dataFactory: ComunicaDataFactory,
    private readonly bindingsFactory: BindingsFactory,
  ) {
    const variables = ['s', 'p', 'o', 'g'].map(name => dataFactory.variable(name));
    this.selectorShape = {
      type: 'operation',
      operation: {
        operationType: 'pattern',
        pattern: new AlgebraFactory(dataFactory).createPattern(variables[0], variables[1], variables[2], variables[3]),
      },
      variablesOptional: variables,
      filterBindings: true,
    };
  }

  public async getFilterFactor(): Promise<number> { return 1; }
  public async getSelectorShape(): Promise<FragmentSelectorShape> { return this.selectorShape; }
  public toString(): string { return `QuerySourceKgf(${this.referenceValue})`; }

  public queryBindings(operation: Algebra.Operation, context: IActionContext, options?: IQueryBindingsOptions): BindingsStream {
    if (operation.type !== Algebra.Types.PATTERN) {
      throw new Error(`QuerySourceKgf only supports triple patterns, received '${operation.type}'`);
    }
    if (options?.joinBindings) {
      throw new Error('QuerySourceKgf supports filterBindings, not joinBindings');
    }
    const pattern = <Algebra.Pattern> operation;
    let prepared: Promise<Prepared | undefined>;
    const quads = new LazyQuadIterator(signal => this.readPages(pattern, prepared, signal));
    // Metadata starts independently of row consumption. Planning never opens a fragment page.
    prepared = Promise.resolve().then(async() => {
      if (pattern.graph.termType !== 'DefaultGraph') {
        quads.setProperty('metadata', emptyMetadata());
        return undefined;
      }
      const result = await this.prepare(pattern, context, options, quads.abortController.signal);
      quads.setProperty('metadata', result?.metadata ?? emptyMetadata());
      return result;
    });
    void prepared.catch((error: Error) => quads.destroy(error));
    return quadsToBindings(quads, pattern, this.dataFactory, this.bindingsFactory, false);
  }

  private client(context: IActionContext): KgfClient {
    // The engine caches source objects. Keep transport choices and credentials scoped to a query.
    const key = context.get(KeysInitQuery.queryTimestamp) ?? context;
    let client = this.clients.get(key);
    if (!client) {
      client = new KgfClient(this.referenceValue, this.mediatorHttp, context);
      this.clients.set(key, client);
    }
    return client;
  }

  private async prepare(
    pattern: Algebra.Pattern, context: IActionContext, options: IQueryBindingsOptions | undefined, signal: AbortSignal,
  ): Promise<Prepared | undefined> {
    const variables = [...new Set(POSITIONS.map(position => pattern[position])
      .filter(term => term.termType === 'Variable').map(term => term.value))];
    let rows: BindingRow[] | undefined;
    if (options?.filterBindings) {
      const bindings = await options.filterBindings.bindings.toArray();
      if (bindings.length === 0) {
        return undefined;
      }
      const seen = new Set<string>();
      rows = bindings.map(binding => variables.map(variable => binding.get(variable))).filter(row => {
        const key = JSON.stringify(row.map(term => term && encodeTerm(term)));
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
      if (variables.length === 0) {
        rows = undefined;
      }
    }
    const client = this.client(context);
    const service = await client.discover();
    const pageSize = Math.min(setting(context.get(KEY_KGF_PAGE_SIZE), 1_000, 'pageSize'), service.maxLimit);
    const batchSize = Math.min(setting(context.get(KEY_KGF_BINDINGS_SIZE), service.maxBindings, 'bindingsSize'), service.maxBindings);
    const batches: Batch[] = [];
    if (rows) {
      // Split on both row count and encoded UTF-8 bytes. A little headroom accommodates cursors.
      // The body's size is counted as it grows: the body without rows, plus each row's encoding
      // and a comma between rows, which is the length of the whole body exactly. Encoding the
      // whole batch again for every row added took 11.5 s of a 30 s query that sent a few
      // thousand bindings requests.
      const budget = service.maxRequestBytes - 512;
      const empty = bytes({ ...bindingBody(pattern, variables, []), limit: pageSize });
      let batch: Batch = { rows: [], offset: 0 };
      let size = empty;
      for (const row of rows) {
        const rowSize = bytes(bindingRow(row));
        if (batch.rows.length && (batch.rows.length + 1 > batchSize || size + 1 + rowSize > budget)) {
          batches.push(batch);
          batch = { rows: [], offset: batch.offset + batch.rows.length };
          size = empty;
        }
        size += (batch.rows.length ? 1 : 0) + rowSize;
        batch.rows.push(row);
        if (size > budget) {
          throw new Error('A KGF binding exceeds max_request_bytes (including pagination headroom)');
        }
      }
      batches.push(batch);
    } else {
      batches.push({ rows: [], offset: 0 });
    }
    const start = performance.now();
    let value = 0;
    let exact = true;
    for (const batch of batches) {
      const response = rows ?
        await client.json(service.count, bindingBody(pattern, variables, batch.rows), signal) :
        await client.json(patternUrl(service.count, pattern).href, undefined, signal);
      if (rows) {
        if (response.complete !== true || !Array.isArray(response.counts) || response.counts.length !== batch.rows.length) {
          throw new Error('Incomplete KGF per-binding count response');
        }
        const indices = new Set<number>();
        for (const entry of response.counts) {
          if (!Number.isInteger(entry.binding) || entry.binding < 0 || entry.binding >= batch.rows.length || indices.has(entry.binding)) {
            throw new Error('Invalid KGF per-binding count index');
          }
          indices.add(entry.binding);
          const count = readCount(entry);
          value += count.value;
          exact &&= count.exact;
        }
      } else {
        const count = readCount(response);
        value += count.value;
        exact &&= count.exact;
      }
    }
    // Native binding rows form a bag; filterBindings requires the union of matching triples.
    // Its summed count is an upper estimate when input rows can overlap.
    exact &&= value === 0 || !rows || rows.length <= 1;
    if (!Number.isSafeInteger(value)) {
      value = Number.MAX_SAFE_INTEGER;
      exact = false;
    }
    // Comunica may prune a source with a zero estimate. An incomplete count is
    // only a lower bound and must not turn an unexplored source into an empty one.
    if (!exact) {
      value = Math.max(1, value);
    }
    const metadata: MetadataQuads = {
      state: new MetadataValidationState(),
      cardinality: { type: exact ? 'exact' : 'estimate', value },
      pageSize,
      requestTime: (performance.now() - start) / batches.length,
    };
    if (context.get(KEY_KGF_VOID_STATISTICS) !== false) {
      metadata[VOID_STATISTICS_PROVIDER] = () => client.getVoidStatistics(
        pattern.predicate.termType === 'NamedNode' ? pattern.predicate.value : undefined,
      );
    }
    return { client, service, pageSize, variables, rows, batches, metadata };
  }

  private async *readPages(
    pattern: Algebra.Pattern, prepared: Promise<Prepared | undefined>, signal: AbortSignal,
  ): AsyncGenerator<RDF.Quad> {
    const plan = await prepared;
    if (!plan || (plan.metadata.cardinality.type === 'exact' && plan.metadata.cardinality.value === 0)) {
      return;
    }
    for (const batch of plan.batches) {
      let cursor: string | undefined;
      const cursors = new Set<string>();
      do {
        if (signal.aborted) {
          return;
        }
        let page: KgfPage;
        if (plan.rows) {
          const body = { ...bindingBody(pattern, plan.variables, batch.rows), limit: plan.pageSize, ...(cursor ? { cursor } : {}) };
          if (bytes(body) > plan.service.maxRequestBytes) {
            throw new Error('KGF paginated request exceeds max_request_bytes');
          }
          page = await plan.client.json(plan.service.fragment, body, signal);
        } else {
          const url = patternUrl(plan.service.fragment, pattern);
          url.searchParams.set('limit', String(plan.pageSize));
          if (cursor) {
            url.searchParams.set('cursor', cursor);
          }
          page = await plan.client.json(url.href, undefined, signal);
        }
        if (!Array.isArray(page.rows) || typeof page.complete !== 'boolean') {
          throw new Error('Invalid KGF fragment response');
        }
        for (const row of page.rows) {
          if (signal.aborted) {
            return;
          }
          const terms = POSITIONS.map((position, index) => pattern[position].termType === 'Variable' ?
            decodeTerm(row[WIRE_POSITIONS[index]], this.dataFactory) : pattern[position]);
          const quad = this.dataFactory.quad(
            <RDF.Quad_Subject> terms[0], <RDF.Quad_Predicate> terms[1], <RDF.Quad_Object> terms[2],
          );
          if (plan.rows) {
            const index = row.binding;
            if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= batch.rows.length) {
              throw new Error('Invalid KGF fragment binding index');
            }
            // Emit a triple only for its first compatible input row, including across batches.
            // This handles duplicate/partially bound VALUES without retaining every result triple.
            if (plan.rows.some((binding, prior) => prior < batch.offset + index && matchesBinding(quad, pattern, plan.variables, binding))) {
              continue;
            }
          }
          yield quad;
        }
        if (page.complete) {
          if (page.next) {
            throw new Error('KGF fragment is complete but also supplies a continuation cursor');
          }
          break;
        }
        if (typeof page.next !== 'string' || !page.next || cursors.has(page.next)) {
          throw new Error('Incomplete KGF fragment has no advancing continuation cursor');
        }
        cursor = page.next;
        cursors.add(cursor);
      } while (true);
    }
  }

  public queryQuads(_operation: Algebra.Operation, _context: IActionContext): AsyncIterator<RDF.Quad> {
    throw new Error('queryQuads is not supported by QuerySourceKgf');
  }
  public async queryBoolean(_operation: Algebra.Ask, _context: IActionContext): Promise<boolean> {
    throw new Error('queryBoolean is not supported by QuerySourceKgf');
  }
  public async queryVoid(_operation: Algebra.Operation, _context: IActionContext): Promise<void> {
    throw new Error('queryVoid is not supported by QuerySourceKgf');
  }
}

function emptyMetadata(): MetadataQuads {
  return { state: new MetadataValidationState(), cardinality: { type: 'exact', value: 0 } };
}

function patternUrl(endpoint: string, pattern: Algebra.Pattern): URL {
  const url = new URL(endpoint);
  POSITIONS.forEach((position, index) => {
    const term = pattern[position];
    if (term.termType !== 'Variable') {
      encodeTerm(term); // Reject unsupported terms consistently for GET and QUERY.
      url.searchParams.set(WIRE_POSITIONS[index], termToString(term));
    }
  });
  return url;
}

function encodeTerm(term: RDF.Term): KgfTerm {
  switch (term.termType) {
    case 'NamedNode': return { type: 'iri', value: term.value };
    case 'BlankNode': return { type: 'bnode', value: term.value };
    case 'Literal':
      if (term.direction) {
        throw new Error('KGF does not support directional language literals');
      }
      return {
        type: 'literal', value: term.value,
        ...(term.language ? { lang: term.language } : { datatype: term.datatype.value }),
      };
    default: throw new Error(`KGF does not support ${term.termType} terms in triple positions`);
  }
}

function decodeTerm(cell: KgfTerm | number | undefined, factory: ComunicaDataFactory): RDF.Term {
  if (!cell || typeof cell !== 'object' || typeof cell.value !== 'string') {
    throw new Error('Invalid or missing RDF term in KGF fragment');
  }
  switch (cell.type) {
    case 'iri': return factory.namedNode(cell.value);
    case 'bnode': return factory.blankNode(cell.value);
    case 'literal': return factory.literal(cell.value, cell.lang ?? (cell.datatype ? factory.namedNode(cell.datatype) : undefined));
    default: throw new Error('Unsupported RDF term in KGF fragment');
  }
}

function bindingBody(pattern: Algebra.Pattern, variables: string[], rows: BindingRow[]): object {
  return {
    pattern: Object.fromEntries(POSITIONS.map((position, index) => [WIRE_POSITIONS[index],
      pattern[position].termType === 'Variable' ? `?${pattern[position].value}` : encodeTerm(pattern[position])])),
    bindings: { vars: variables.map(variable => `?${variable}`), rows: rows.map(bindingRow) },
  };
}

/** One row of a bindings body, as it is sent. */
function bindingRow(row: BindingRow): unknown[] {
  return row.map(term => term ? encodeTerm(term) : null);
}

function matchesBinding(quad: RDF.Quad, pattern: Algebra.Pattern, variables: string[], row: BindingRow): boolean {
  return POSITIONS.every(position => {
    const term = pattern[position];
    const bound = term.termType === 'Variable' ? row[variables.indexOf(term.value)] : undefined;
    return !bound || bound.equals(quad[position]);
  });
}

const encoder = new TextEncoder();

function bytes(body: object): number { return encoder.encode(JSON.stringify(body)).length; }

function setting(value: number | undefined, fallback: number, name: string): number {
  if (value !== undefined && positiveInteger(value, 0) === 0) {
    throw new Error(`KGF ${name} must be a positive safe integer`);
  }
  return value ?? fallback;
}
