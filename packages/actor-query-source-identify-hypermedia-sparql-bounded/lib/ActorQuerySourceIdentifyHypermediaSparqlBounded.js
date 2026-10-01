"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ActorQuerySourceIdentifyHypermediaSparqlBounded = exports.KEY_SPARQL_COUNT_CAP_HOSTS = exports.KEY_SPARQL_COUNT_CAP = void 0;
const actor_query_source_identify_hypermedia_sparql_1 = require("@comunica/actor-query-source-identify-hypermedia-sparql");
const context_entries_1 = require("@comunica/context-entries");
const core_1 = require("@comunica/core");
const utils_algebra_1 = require("@comunica/utils-algebra");
const utils_bindings_factory_1 = require("@comunica/utils-bindings-factory");
const QuerySourceSparqlBounded_1 = require("./QuerySourceSparqlBounded");
/** The cap on the COUNT queries sent to every SPARQL endpoint without a cap of its own. */
exports.KEY_SPARQL_COUNT_CAP = new core_1.ActionContextKey('@kgf/actor-query-source-identify-hypermedia-sparql-bounded:countCap');
/**
 * Caps for particular endpoints, keyed by `URL.host` or `URL.hostname`: a store that walks
 * the matches to count them may want a lower cap than one that counts from its indexes.
 * `Infinity` sends the unbounded COUNT Comunica sends.
 */
exports.KEY_SPARQL_COUNT_CAP_HOSTS = new core_1.ActionContextKey('@kgf/actor-query-source-identify-hypermedia-sparql-bounded:countCapHosts');
/**
 * Comunica's SPARQL endpoint identification, creating `QuerySourceSparqlBounded` sources:
 * COUNT queries bounded at a cap, and timed only while the server has them.
 *
 * `countTimeout` is the time a COUNT attempt may spend with the server before its
 * cardinality is reported unknown, as in Comunica; `countDeadline` bounds the whole wait,
 * time queued behind the host's other requests included.
 */
class ActorQuerySourceIdentifyHypermediaSparqlBounded extends actor_query_source_identify_hypermedia_sparql_1.ActorQuerySourceIdentifyHypermediaSparql {
    countCap;
    countDeadline;
    constructor(args) {
        super(args);
        this.countCap = args.countCap ?? 1_000_000;
        this.countDeadline = args.countDeadline ?? 30_000;
    }
    async run(action) {
        const endpoint = (action.forceSourceType ?? this.forceSourceType) ?
            action.url :
            action.metadata.sparqlService || action.url;
        this.logInfo(action.context, `Identified ${action.url} as sparql source with service URL: ${endpoint}`);
        const dataFactory = action.context.getSafe(context_entries_1.KeysInitQuery.dataFactory);
        const algebraFactory = new utils_algebra_1.AlgebraFactory(dataFactory);
        const isSingularSource = action.context.get(context_entries_1.KeysQueryOperation.querySources)?.length === 1;
        const source = new QuerySourceSparqlBounded_1.QuerySourceSparqlBounded(this.capFor(endpoint, action.context), this.countTimeout, endpoint, 
        // The original URL is the backup, as some endpoints misconfigure their service description.
        action.url, action.context, this.mediatorHttp, this.mediatorQuerySerialize, this.bindMethod, dataFactory, algebraFactory, await utils_bindings_factory_1.BindingsFactory.create(this.mediatorMergeBindingsContext, action.context, dataFactory), this.forceHttpGet, this.cacheSize, this.countDeadline, 
        // A single source's cardinalities do not matter, so it is not asked for them.
        this.cardinalityCountQueries && !isSingularSource, this.cardinalityEstimateConstruction, this.forceGetIfUrlLengthBelow, Boolean(action.context.get(context_entries_1.KeysInitQuery.parseUnsupportedVersions)), action.metadata);
        return { source };
    }
    capFor(endpoint, context) {
        const hosts = context.get(exports.KEY_SPARQL_COUNT_CAP_HOSTS);
        let url;
        try {
            url = new URL(endpoint);
        }
        catch {
            // Not a URL Comunica could fetch anyway; the default applies.
        }
        return (url && (hosts?.[url.host] ?? hosts?.[url.hostname])) ??
            context.get(exports.KEY_SPARQL_COUNT_CAP) ??
            this.countCap;
    }
}
exports.ActorQuerySourceIdentifyHypermediaSparqlBounded = ActorQuerySourceIdentifyHypermediaSparqlBounded;
//# sourceMappingURL=ActorQuerySourceIdentifyHypermediaSparqlBounded.js.map