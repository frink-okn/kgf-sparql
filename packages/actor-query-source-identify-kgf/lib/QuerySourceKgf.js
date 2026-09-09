"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QuerySourceKgf = void 0;
const bus_query_source_identify_1 = require("@comunica/bus-query-source-identify");
const context_entries_1 = require("@comunica/context-entries");
const utils_algebra_1 = require("@comunica/utils-algebra");
const utils_metadata_1 = require("@comunica/utils-metadata");
const actor_rdf_join_selectivity_void_1 = require("@kgf/actor-rdf-join-selectivity-void");
const rdf_string_ttl_1 = require("rdf-string-ttl");
const Context_1 = require("./Context");
const KgfClient_1 = require("./KgfClient");
const LazyQuadIterator_1 = require("./LazyQuadIterator");
const POSITIONS = ['subject', 'predicate', 'object'];
const WIRE_POSITIONS = ['s', 'p', 'o'];
/** Native KGF JSON triple source. Its published union is the SPARQL default graph. */
class QuerySourceKgf {
    referenceValue;
    mediatorHttp;
    dataFactory;
    bindingsFactory;
    clients = new WeakMap();
    selectorShape;
    constructor(referenceValue, mediatorHttp, dataFactory, bindingsFactory) {
        this.referenceValue = referenceValue;
        this.mediatorHttp = mediatorHttp;
        this.dataFactory = dataFactory;
        this.bindingsFactory = bindingsFactory;
        const variables = ['s', 'p', 'o', 'g'].map(name => dataFactory.variable(name));
        this.selectorShape = {
            type: 'operation',
            operation: {
                operationType: 'pattern',
                pattern: new utils_algebra_1.AlgebraFactory(dataFactory).createPattern(variables[0], variables[1], variables[2], variables[3]),
            },
            variablesOptional: variables,
            filterBindings: true,
        };
    }
    async getFilterFactor() { return 1; }
    async getSelectorShape() { return this.selectorShape; }
    toString() { return `QuerySourceKgf(${this.referenceValue})`; }
    queryBindings(operation, context, options) {
        if (operation.type !== utils_algebra_1.Algebra.Types.PATTERN) {
            throw new Error(`QuerySourceKgf only supports triple patterns, received '${operation.type}'`);
        }
        if (options?.joinBindings) {
            throw new Error('QuerySourceKgf supports filterBindings, not joinBindings');
        }
        const pattern = operation;
        let prepared;
        const quads = new LazyQuadIterator_1.LazyQuadIterator(signal => this.readPages(pattern, prepared, signal));
        // Metadata starts independently of row consumption. Planning never opens a fragment page.
        prepared = Promise.resolve().then(async () => {
            if (pattern.graph.termType !== 'DefaultGraph') {
                quads.setProperty('metadata', emptyMetadata());
                return undefined;
            }
            const result = await this.prepare(pattern, context, options, quads.abortController.signal);
            quads.setProperty('metadata', result?.metadata ?? emptyMetadata());
            return result;
        });
        void prepared.catch((error) => quads.destroy(error));
        return (0, bus_query_source_identify_1.quadsToBindings)(quads, pattern, this.dataFactory, this.bindingsFactory, false);
    }
    client(context) {
        // The engine caches source objects. Keep transport choices and credentials scoped to a query.
        const key = context.get(context_entries_1.KeysInitQuery.queryTimestamp) ?? context;
        let client = this.clients.get(key);
        if (!client) {
            client = new KgfClient_1.KgfClient(this.referenceValue, this.mediatorHttp, context);
            this.clients.set(key, client);
        }
        return client;
    }
    async prepare(pattern, context, options, signal) {
        const variables = [...new Set(POSITIONS.map(position => pattern[position])
                .filter(term => term.termType === 'Variable').map(term => term.value))];
        let rows;
        if (options?.filterBindings) {
            const bindings = await options.filterBindings.bindings.toArray();
            if (bindings.length === 0) {
                return undefined;
            }
            const seen = new Set();
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
        const pageSize = Math.min(setting(context.get(Context_1.KEY_KGF_PAGE_SIZE), 1_000, 'pageSize'), service.maxLimit);
        const batchSize = Math.min(setting(context.get(Context_1.KEY_KGF_BINDINGS_SIZE), service.maxBindings, 'bindingsSize'), service.maxBindings);
        const batches = [];
        if (rows) {
            // Split on both row count and encoded UTF-8 bytes. A little headroom accommodates cursors.
            let batch = { rows: [], offset: 0 };
            for (const row of rows) {
                const candidate = [...batch.rows, row];
                const fits = bytes({ ...bindingBody(pattern, variables, candidate), limit: pageSize }) <= service.maxRequestBytes - 512;
                if (batch.rows.length && (candidate.length > batchSize || !fits)) {
                    batches.push(batch);
                    batch = { rows: [], offset: batch.offset + batch.rows.length };
                }
                batch.rows.push(row);
                if (bytes({ ...bindingBody(pattern, variables, batch.rows), limit: pageSize }) > service.maxRequestBytes - 512) {
                    throw new Error('A KGF binding exceeds max_request_bytes (including pagination headroom)');
                }
            }
            batches.push(batch);
        }
        else {
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
                const indices = new Set();
                for (const entry of response.counts) {
                    if (!Number.isInteger(entry.binding) || entry.binding < 0 || entry.binding >= batch.rows.length || indices.has(entry.binding)) {
                        throw new Error('Invalid KGF per-binding count index');
                    }
                    indices.add(entry.binding);
                    const count = (0, KgfClient_1.readCount)(entry);
                    value += count.value;
                    exact &&= count.exact;
                }
            }
            else {
                const count = (0, KgfClient_1.readCount)(response);
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
        const metadata = {
            state: new utils_metadata_1.MetadataValidationState(),
            cardinality: { type: exact ? 'exact' : 'estimate', value },
            pageSize,
            requestTime: (performance.now() - start) / batches.length,
        };
        if (context.get(Context_1.KEY_KGF_VOID_STATISTICS) !== false) {
            metadata[actor_rdf_join_selectivity_void_1.VOID_STATISTICS_PROVIDER] = () => client.getVoidStatistics(pattern.predicate.termType === 'NamedNode' ? pattern.predicate.value : undefined);
        }
        return { client, service, pageSize, variables, rows, batches, metadata };
    }
    async *readPages(pattern, prepared, signal) {
        const plan = await prepared;
        if (!plan || (plan.metadata.cardinality.type === 'exact' && plan.metadata.cardinality.value === 0)) {
            return;
        }
        for (const batch of plan.batches) {
            let cursor;
            const cursors = new Set();
            do {
                if (signal.aborted) {
                    return;
                }
                let page;
                if (plan.rows) {
                    const body = { ...bindingBody(pattern, plan.variables, batch.rows), limit: plan.pageSize, ...(cursor ? { cursor } : {}) };
                    if (bytes(body) > plan.service.maxRequestBytes) {
                        throw new Error('KGF paginated request exceeds max_request_bytes');
                    }
                    page = await plan.client.json(plan.service.fragment, body, signal);
                }
                else {
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
                    const quad = this.dataFactory.quad(terms[0], terms[1], terms[2]);
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
    queryQuads(_operation, _context) {
        throw new Error('queryQuads is not supported by QuerySourceKgf');
    }
    async queryBoolean(_operation, _context) {
        throw new Error('queryBoolean is not supported by QuerySourceKgf');
    }
    async queryVoid(_operation, _context) {
        throw new Error('queryVoid is not supported by QuerySourceKgf');
    }
}
exports.QuerySourceKgf = QuerySourceKgf;
function emptyMetadata() {
    return { state: new utils_metadata_1.MetadataValidationState(), cardinality: { type: 'exact', value: 0 } };
}
function patternUrl(endpoint, pattern) {
    const url = new URL(endpoint);
    POSITIONS.forEach((position, index) => {
        const term = pattern[position];
        if (term.termType !== 'Variable') {
            encodeTerm(term); // Reject unsupported terms consistently for GET and QUERY.
            url.searchParams.set(WIRE_POSITIONS[index], (0, rdf_string_ttl_1.termToString)(term));
        }
    });
    return url;
}
function encodeTerm(term) {
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
function decodeTerm(cell, factory) {
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
function bindingBody(pattern, variables, rows) {
    return {
        pattern: Object.fromEntries(POSITIONS.map((position, index) => [WIRE_POSITIONS[index],
            pattern[position].termType === 'Variable' ? `?${pattern[position].value}` : encodeTerm(pattern[position])])),
        bindings: { vars: variables.map(variable => `?${variable}`), rows: rows.map(row => row.map(term => term ? encodeTerm(term) : null)) },
    };
}
function matchesBinding(quad, pattern, variables, row) {
    return POSITIONS.every(position => {
        const term = pattern[position];
        const bound = term.termType === 'Variable' ? row[variables.indexOf(term.value)] : undefined;
        return !bound || bound.equals(quad[position]);
    });
}
function bytes(body) { return new TextEncoder().encode(JSON.stringify(body)).length; }
function setting(value, fallback, name) {
    if (value !== undefined && (0, KgfClient_1.positiveInteger)(value, 0) === 0) {
        throw new Error(`KGF ${name} must be a positive safe integer`);
    }
    return value ?? fallback;
}
//# sourceMappingURL=QuerySourceKgf.js.map