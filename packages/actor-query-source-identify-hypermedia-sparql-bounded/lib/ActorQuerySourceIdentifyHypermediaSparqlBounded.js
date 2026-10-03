"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ActorQuerySourceIdentifyHypermediaSparqlBounded = exports.KEY_SPARQL_COUNT_CAP_HOSTS = exports.KEY_SPARQL_COUNT_CAP = void 0;
const actor_query_source_identify_hypermedia_sparql_1 = require("@comunica/actor-query-source-identify-hypermedia-sparql");
const context_entries_1 = require("@comunica/context-entries");
const core_1 = require("@comunica/core");
const utils_algebra_1 = require("@comunica/utils-algebra");
const utils_bindings_factory_1 = require("@comunica/utils-bindings-factory");
const actor_http_throttle_1 = require("@kgf/actor-http-throttle");
const QuerySourceSparqlBounded_1 = require("./QuerySourceSparqlBounded");
/** The cap on the COUNT queries sent to every SPARQL endpoint without a cap of its own. */
exports.KEY_SPARQL_COUNT_CAP = new core_1.ActionContextKey('@kgf/actor-query-source-identify-hypermedia-sparql-bounded:countCap');
/**
 * Caps for particular endpoints, keyed by `URL.host`, `URL.hostname`, or `*.` and a domain: a
 * store that walks the matches to count them may want a lower cap than one that counts from
 * its indexes. `Infinity` or `null` sends the unbounded COUNT Comunica sends. They take
 * precedence over the actor's own `countCapHosts`.
 */
exports.KEY_SPARQL_COUNT_CAP_HOSTS = new core_1.ActionContextKey('@kgf/actor-query-source-identify-hypermedia-sparql-bounded:countCapHosts');
/**
 * Comunica's SPARQL endpoint identification, creating `QuerySourceSparqlBounded` sources:
 * COUNT queries bounded at a cap, and timed only while the server has them.
 *
 * The cap suits a store that stops at a `LIMIT` and walks the matches to count them, as
 * QLever does. It does not suit one that counts a single pattern from its indexes and reads
 * every row of a subquery: Blazegraph, behind Wikidata's query services, counts every
 * `wdt:P921` statement (2,463,228) in 0.12 s and takes 10 s to count to a cap of a million.
 * `countCapHosts` names such endpoints, with `null` for no cap.
 *
 * `countTimeout` is the time a COUNT attempt may spend with the server before its
 * cardinality is reported unknown, as in Comunica; `countDeadline` bounds the whole wait,
 * time queued behind the host's other requests included.
 */
class ActorQuerySourceIdentifyHypermediaSparqlBounded extends actor_query_source_identify_hypermedia_sparql_1.ActorQuerySourceIdentifyHypermediaSparql {
    countCap;
    countCapHosts;
    countDeadline;
    constructor(args) {
        super(args);
        this.countCap = args.countCap ?? 1_000_000;
        this.countCapHosts = args.countCapHosts ?? {};
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
        const source = new QuerySourceSparqlBounded_1.QuerySourceSparqlBounded(
        // Each COUNT's cap is the one its query's context gives: Comunica keeps the source for later queries.
        context => this.capFor(endpoint, context), this.countTimeout, endpoint, 
        // The original URL is the backup, as some endpoints misconfigure their service description.
        action.url, action.context, this.mediatorHttp, this.mediatorQuerySerialize, this.bindMethod, dataFactory, algebraFactory, await utils_bindings_factory_1.BindingsFactory.create(this.mediatorMergeBindingsContext, action.context, dataFactory), this.forceHttpGet, this.cacheSize, this.countDeadline, 
        // A single source's cardinalities do not matter, so it is not asked for them.
        this.cardinalityCountQueries && !isSingularSource, this.cardinalityEstimateConstruction, this.forceGetIfUrlLengthBelow, Boolean(action.context.get(context_entries_1.KeysInitQuery.parseUnsupportedVersions)), action.metadata);
        return { source };
    }
    /** The most particular name the context or the actor gives a cap for decides, as the throttle's limits do. */
    capFor(endpoint, context) {
        const given = context.get(exports.KEY_SPARQL_COUNT_CAP_HOSTS);
        let names = [];
        try {
            names = (0, actor_http_throttle_1.hostNames)(new URL(endpoint));
        }
        catch {
            // Not a URL Comunica could fetch anyway; the default applies.
        }
        for (const name of names) {
            const cap = given && name in given ? given[name] : this.countCapHosts[name];
            if (cap !== undefined) {
                return cap ?? Number.POSITIVE_INFINITY;
            }
        }
        return context.get(exports.KEY_SPARQL_COUNT_CAP) ?? this.countCap;
    }
}
exports.ActorQuerySourceIdentifyHypermediaSparqlBounded = ActorQuerySourceIdentifyHypermediaSparqlBounded;
//# sourceMappingURL=ActorQuerySourceIdentifyHypermediaSparqlBounded.js.map