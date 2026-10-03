# @kgf/actor-query-source-identify-hypermedia-sparql-bounded

[Comunica](https://comunica.dev/)'s SPARQL endpoint source, changed so that query plans
over a SPARQL endpoint come out the same from run to run, and cost the endpoint less.

When a query has more than one source, Comunica asks each SPARQL endpoint for the
cardinality of every operation with a COUNT query, prunes the sources that answer 0, and
plans its joins from the counts. On QLever's Wikidata endpoint that went wrong three ways.
An exact count of a large pattern is slow (4.4 s for every `rdfs:label`), past Comunica's
3 second timeout, after which the cardinality is unknown. A count that waited behind the
host's other requests, or to retry a 429, timed out the same way. And an unknown or
estimated cardinality is confirmed with a second request, an ASK. Which counts came back in
time decided the plan: one federated query returned 1,000 rows in 21 s on one run and timed
out after 375 requests on the next.

## Bounded counts

`SELECT (COUNT(*) AS ?count) WHERE { SELECT * WHERE { … } LIMIT cap+1 }`. A count under the
cap is exact; one that reaches it is an estimate of cap+1, at least that many. A planner
needs to know which side of a join is small, not how large a large side is. On QLever,
counting up to 1,000,000 labels took 28 ms and up to 10,000,000 took 79 ms, both computed
rather than cached by its own report.

- `countCap` (default 1,000,000) in the config, or `KEY_SPARQL_COUNT_CAP` in the query
  context, for every endpoint.
- `KEY_SPARQL_COUNT_CAP_HOSTS` gives endpoints their own cap, keyed by `host`, `hostname`,
  or `*.` and a domain, the most particular first: a store that walks the matches to count
  them may want a lower one. `Infinity` or `null` sends Comunica's unbounded COUNT.
- `countCapHosts` in the config gives defaults of the same form, which the context
  overrides. `kgf-sparql` counts `*.wikidata.org` in full. The cap suits a store that stops
  at a `LIMIT`, as QLever does, and not one that counts a single pattern from its indexes
  but reads every row of a subquery: Blazegraph, behind Wikidata's query services, counts
  every `wdt:P921` statement (2,463,228) in 0.12 s, and takes 10 s to count them to a
  million.

## Counts timed by the server

With [`@kgf/actor-http-throttle`](../actor-http-throttle/) pacing requests, a COUNT's
`countTimeout` (3 s) runs only while an attempt is with the server: from when the throttle
sends it until its count arrives, restarting with each attempt. The headers do not stop it,
since a server may send them before it has counted, and the wait of a refused attempt for
its retry does not count. `countDeadline` (default 30 s) bounds the whole wait, time queued
and retries included.

## Request time

The source reports the time its COUNT spent with the server, until the count arrived, as
the metadata's `requestTime`. A count it already knew, or one that timed out or failed,
reports the time of its last answered COUNT: a COUNT that timed out took as long as it was
let, and when it stood for the endpoint's requests it charged every later probe 3 s. Comunica's
SPARQL source reports none, so a join's cost model charged nothing per request to an
endpoint, and a bind join sending one request per row costed the same as one sending a
block of rows. Once counts were bounded, the two came out equal but for the block held, and
the per-row join won; with request time priced, the block join's estimate is 1,416 where
the per-row join's is 296,652.

## Bindings are not counted

A bind join that sends rows to an endpoint as `VALUES` calls the source with those
bindings, and Comunica counted each such call before selecting it, two requests for every
block where one does. No join reads that count: the joins that send blocks, Comunica's and
`kgf-sparql`'s, take their cardinality from their own entries, and a COUNT that carries a
block never matches a cached one. A call with bindings reports an unknown cardinality, as
Comunica's source does with count queries turned off, and sends only its SELECT. Counts
for planning are unchanged.

## Source selection

`ActorOptimizeQueryOperationPruneEmptySourceOperationsBounded` replaces Comunica's
source-selection actor, so that only an unknown cardinality, an infinite estimate from a
COUNT that failed or timed out, is confirmed with an ASK. A finite estimate is accepted as
it is: from these sources it is a count that reached its cap, which proves there are matches.
Skipping an ASK never loses results, since an ASK can only let source selection drop a
source.

## Configuration

`kgf-sparql` installs both actors with overrides of Comunica's
`urn:comunica:default:query-source-identify-hypermedia/actors#sparql` and
`urn:comunica:default:optimize-query-operation/actors#prune-empty-source-operations`, and
the command line's `--count-cap n` or `--count-cap host=n`, with `none` for no cap, sets the
context keys.

Most users want [`kgf-sparql`](https://www.npmjs.com/package/kgf-sparql), with these actors
already installed.

## License

MIT
