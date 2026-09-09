"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KgfClient = void 0;
exports.positiveInteger = positiveInteger;
exports.readCount = readCount;
const Context_1 = require("./Context");
/** A client per query: promises deduplicate discovery/statistics without caching result pages. */
class KgfClient {
    endpoint;
    mediatorHttp;
    context;
    discovery;
    statistics = new Map();
    method;
    constructor(endpoint, mediatorHttp, context) {
        this.endpoint = endpoint;
        this.mediatorHttp = mediatorHttp;
        this.context = context;
        this.method = context.get(Context_1.KEY_KGF_HTTP_METHOD) ?? 'QUERY';
        if (this.method !== 'QUERY' && this.method !== 'POST') {
            throw new Error('KGF httpMethod must be QUERY or POST');
        }
    }
    discover() {
        return this.discovery ??= this.discoverService();
    }
    async discoverService() {
        const url = new URL(this.endpoint);
        if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash) {
            throw new Error('KGF sources must be HTTP(S) dataset or versioned fragment URLs without query parameters');
        }
        const path = url.pathname.replace(/\/$/u, '');
        const versioned = /^(.*)\/[^/]+\/v\/[^/]+(?:\/fragment)?$/u.exec(path);
        let fragment;
        let serviceRoot;
        if (versioned) {
            fragment = new URL(path.endsWith('/fragment') ? path : `${path}/fragment`, url).href;
            serviceRoot = new URL(`${versioned[1]}/`, url).href;
        }
        else {
            // Dataset descriptors pin 'current' once for this query, including body-carrying reads.
            // Resolve a latest alias through that descriptor rather than fetching a fragment
            // merely to follow its redirect. Planning must still start with /count.
            const datasetPath = path.replace(/\/latest\/fragment$/u, '');
            const datasetUrl = new URL(datasetPath, url).href;
            const descriptor = await this.json(datasetUrl);
            const release = descriptor.releases?.find((entry) => entry.version === descriptor.current);
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
    async json(url, body, signal) {
        const encoded = body === undefined ? undefined : JSON.stringify(body);
        const request = (method) => this.mediatorHttp.mediate({
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
    async getVoidStatistics(predicate) {
        const partition = predicate ? await this.schemaCounts(predicate) : undefined;
        // Only fetch dataset-wide ceilings if the predicate partition cannot supply both divisors.
        const dataset = partition?.distinctSubjects !== undefined && partition.distinctObjects !== undefined ?
            undefined : await this.schemaCounts('');
        if (!partition && !dataset) {
            return undefined;
        }
        return { ...dataset, ...(partition && predicate ? { propertyPartitions: { [predicate]: partition } } : {}) };
    }
    schemaCounts(predicate) {
        let result = this.statistics.get(predicate);
        if (!result) {
            result = (async () => {
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
                const stats = {};
                for (const [wire, name] of [
                    ['triples', 'triples'], ['distinct_subjects', 'distinctSubjects'], ['distinct_objects', 'distinctObjects'],
                ]) {
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
exports.KgfClient = KgfClient;
function positiveInteger(value, fallback) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
function readCount(response) {
    const count = typeof response.count === 'number' ? { value: response.count, exact: response.exact } : response.count;
    if (!count || !Number.isSafeInteger(count.value) || count.value < 0 || typeof count.exact !== 'boolean') {
        throw new Error('Invalid KGF count response');
    }
    return { value: count.value, exact: count.exact && response.complete !== false };
}
//# sourceMappingURL=KgfClient.js.map