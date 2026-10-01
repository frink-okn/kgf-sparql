"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QuerySourceSparqlBounded = void 0;
const actor_query_source_identify_hypermedia_sparql_1 = require("@comunica/actor-query-source-identify-hypermedia-sparql");
const utils_algebra_1 = require("@comunica/utils-algebra");
const utils_metadata_1 = require("@comunica/utils-metadata");
const actor_http_throttle_1 = require("@kgf/actor-http-throttle");
/**
 * Comunica's SPARQL endpoint source, with two changes to the COUNT query it sends for each
 * operation's cardinality.
 *
 * ## The count is bounded
 *
 * `SELECT (COUNT(*) AS ?count) WHERE { SELECT * WHERE { … } LIMIT cap+1 }`, so the endpoint
 * can stop at the cap. A count under it is exact; one that reaches it is reported as an
 * estimate of cap+1, a lower bound. A planner needs to know which
 * side of a join is small, not how large a large side is: on QLever's Wikidata endpoint,
 * counting every `rdfs:label` took 4.4 s, while counting up to 1,000,000 of them took 28 ms
 * and up to 10,000,000 took 79 ms.
 *
 * ## The count is timed by the server
 *
 * Comunica gives a COUNT `countTimeout` (3 s) from the moment it asks, and then reports the
 * cardinality as unknown (an infinite estimate), which made one query's plan differ from run
 * to run: time spent queued behind a host's other requests, or waiting to retry a refusal,
 * counted against the server. Here the timeout runs only while an attempt is with the server,
 * from when `@kgf/actor-http-throttle` sends it to when its response headers arrive, and
 * restarts with each attempt. `deadline` bounds the whole wait, queue included.
 *
 * ## The metadata says what a request costs
 *
 * Comunica's SPARQL source reports no `requestTime`, so a join's cost model charges nothing
 * for each request to an endpoint, and a bind join that sends one per row looks as cheap as
 * one that sends a block of rows at a time. With uncapped counts the difference was hidden by
 * accident, since large counts timed out to an unknown size; with every count answered, the
 * two came out equal but for the block held, and the per-row join won. The time the COUNT
 * spent with the server is reported as the metadata's `requestTime`, or, for a count already
 * known, the time of this source's last request.
 */
class QuerySourceSparqlBounded extends actor_query_source_identify_hypermedia_sparql_1.QuerySourceSparql {
    cap;
    attemptTimeout;
    endpoint;
    /** Milliseconds this source's last COUNT spent with the server. */
    lastRequestTime;
    constructor(cap, attemptTimeout, ...args) {
        super(...args);
        this.cap = cap;
        this.attemptTimeout = attemptTimeout;
        this.endpoint = args[0];
    }
    operationToCountQuery(dataFactory, algebraFactory, operation) {
        if (!Number.isFinite(this.cap)) {
            return super.operationToCountQuery(dataFactory, algebraFactory, operation);
        }
        const bounded = algebraFactory.createSlice(algebraFactory.createProject(operation, utils_algebra_1.algebraUtils.inScopeVariables(operation)), 0, this.cap + 1);
        return super.operationToCountQuery(dataFactory, algebraFactory, bounded);
    }
    attachMetadata(target, context, operationPromise) {
        let written = false;
        let timer;
        let sentAt;
        let requestTime;
        const write = (metadata) => {
            if (!written) {
                written = true;
                clearTimeout(timer);
                const time = requestTime ?? this.lastRequestTime;
                target.setProperty('metadata', this.bound(time === undefined ? metadata : { ...metadata, requestTime: time }));
            }
        };
        // The server took too long on this attempt: the cardinality is unknown, as Comunica
        // reports a COUNT that timed out. The COUNT itself carries on, and its answer is cached.
        const giveUp = async () => {
            const operation = await operationPromise;
            const undefs = actor_query_source_identify_hypermedia_sparql_1.QuerySourceSparql.getOperationUndefs(operation);
            write({
                state: new utils_metadata_1.MetadataValidationState(),
                cardinality: { type: 'estimate', value: Number.POSITIVE_INFINITY, dataset: this.endpoint },
                variables: utils_algebra_1.algebraUtils.inScopeVariables(operation).map(variable => ({
                    variable,
                    canBeUndef: undefs.some(undef => undef.equals(variable)),
                })),
            });
        };
        const listener = {
            sent: () => {
                clearTimeout(timer);
                sentAt = Date.now();
                timer = setTimeout(() => void giveUp().catch(() => undefined), this.attemptTimeout);
            },
            settled: () => {
                clearTimeout(timer);
                timer = undefined;
                if (sentAt !== undefined) {
                    requestTime = Date.now() - sentAt;
                    this.lastRequestTime = requestTime;
                }
            },
        };
        const metadataOnly = {
            setProperty: (name, value) => {
                if (name === 'metadata') {
                    write(value);
                }
                else {
                    target.setProperty(name, value);
                }
            },
        };
        super.attachMetadata(metadataOnly, context.set(actor_http_throttle_1.KEY_HTTP_ATTEMPT_LISTENER, listener), operationPromise);
    }
    /** A count that reached the cap is an estimate, a lower bound, not an exact count. */
    bound(metadata) {
        const { cardinality } = metadata;
        if (cardinality.type !== 'exact' || cardinality.value <= this.cap) {
            return metadata;
        }
        return { ...metadata, cardinality: { ...cardinality, type: 'estimate' } };
    }
}
exports.QuerySourceSparqlBounded = QuerySourceSparqlBounded;
//# sourceMappingURL=QuerySourceSparqlBounded.js.map