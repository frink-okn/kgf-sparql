# kgf-sparql

A [Comunica](https://comunica.dev/) SPARQL engine with a native
[Knowledge Graph Fragments (KGF)](https://apps.okn.us/kgf/) triple source, join actors for
federated queries over KGF and SPARQL endpoints, per-host request pacing, and a command line
that runs a query under budgets and accounts for every request it made.

Use `type: 'kgf'` to query KGF's JSON API. The source gets cardinalities from
`/count` before opening fragment pages, passes bindings using HTTP `QUERY`, and
follows opaque cursors. Standard Comunica sources, including brTPF, RDF/JS stores,
files, and SPARQL endpoints, remain available.

```bash
npm install @frink-okn/kgf-sparql
```

The library and the command line need Node.js 22.19 or later.

## Use as a library

```js
import { QueryEngine } from '@frink-okn/kgf-sparql';

const engine = new QueryEngine();
const bindings = await engine.queryBindings(`
  SELECT ?s ?label WHERE {
    VALUES ?s { <http://identifiers.org/cas/100-00-5> }
    ?s <http://www.w3.org/2000/01/rdf-schema#label> ?label
  }
`, {
  sources: [{
    type: 'kgf',
    value: 'https://apps.okn.us/kgf/biobricks-tox21/v/v0.0.2/fragment',
  }],
});

for await (const binding of bindings) {
  console.log(binding.toString());
}
```

A dataset URL such as `https://apps.okn.us/kgf/biobricks-tox21` or its
`/latest/fragment` alias also works. Its current release is resolved through the
dataset descriptor and pinned for the duration of each query.
A version URL ending in `/v/v0.0.2/` is accepted too. The service root lists
datasets; select a dataset rather than using the root as a triple source.

The engine also runs in a browser. Bundlers that honour the package's `browser` field, as
Vite and esbuild do, take `lib/index-browser.js`, which leaves out the command line and its
Node-only transport. The public KGF server allows any origin, and the `QUERY` method that
bindings requests use. Requests are paced per host in the engine, so a page gets the same
caps and retries as the command line (see [Request pacing](#request-pacing)).

## Use as a CLI

`kgf-sparql` runs one query to completion, or fails, and accounts for every request it
made. Results go to a file and a receipt describes the run:

```bash
kgf-sparql -f query.rq \
  --source kgf@https://apps.okn.us/kgf/phaseskg/v/v0.0.1/fragment \
  --out results.srj --receipt receipt.json \
  --max-requests 5000 --max-bytes 256M --timeout 120
```

- **Query:** `-q '<sparql>'` or `-f query.rq` (`-f -` reads standard input). SELECT, ASK,
  CONSTRUCT, and DESCRIBE are run; updates are refused.
- **Sources** are `kind@url`, repeatable. `kgf@` takes a fragment URL, a version URL, a
  dataset URL, or its `/latest/fragment` alias; a dataset URL is pinned to its current
  release through the dataset descriptor before the query runs, and the receipt names the
  release. `sparql@` names a SPARQL endpoint explicitly, for a graph that has one; other
  Comunica source types pass through. A bare URL is refused rather than guessed at.
- **Output** goes to `--out`, never to a pipe: Node truncates unflushed writes at exit and
  pipes cap at 64 KB. The file is closed before the process exits. `--format` is `srj`
  (SPARQL Results JSON, the default), `csv`, `tsv`, or `xml` for SELECT and ASK; `nt` (the
  default), `nq`, `ttl`, or `jsonld` for CONSTRUCT and DESCRIBE; or any media type the
  engine serializes. Comunica's own serializers write every format.
- **Transport:** `--http-method QUERY|POST`, `--page-size`, `--bindings-size`, and
  `--no-void-statistics` set the context keys described below. `--http-retries N` retries
  429, 502, 503, and 504 responses up to N times; without it, 429 and 503 are retried up to
  5 times and the others not at all. Network errors are not retried. `--count-cap N`, or
  `host=N` for one endpoint and `'*.domain=N'` for a domain's, caps the COUNT queries sent
  to SPARQL endpoints while planning (default 1,000,000, and none for `*.wikidata.org`); `none`
  in place of N counts in full.
- **Connections:** `--max-connections N` (default 32) caps concurrent connections per
  origin. `--max-in-flight N` (default: the connection cap) caps requests in flight per
  host, `--max-in-flight host=N`, repeatable, one host's, and `--max-in-flight
  '*.domain=N'` the domain's hosts together (`'*.wikidata.org=5'`); `--max-rate host=N`
  starts at most N requests a second to a host, as the engine does for QLever's hosts
  (`qlever.dev`, `qlever.cs.uni-freiburg.de`) at 1 unless told otherwise. A plan that fans out can
  put hundreds of requests in flight at once, which a shared server answers with connection
  failures or 429s. The two caps differ because the transport speaks HTTP/2 where the
  server offers it, as the public KGF server does, and one HTTP/2 connection carries any
  number of requests: the connection cap alone let about 650 requests reach that server at
  once. The in-flight and rate caps are the engine's, so a page in a browser has them too.
  A request holds its place until its response headers arrive, and requests beyond a cap
  are queued; request counts are the plan's, plus the retries of refused requests.
- `kgf-sparql-comunica` is Comunica's own command line over this engine, for scripts
  written against it.

### Budgets

Comunica has no plan-level budget: a query whose plan goes wrong runs until something
outside it stops the process, a timeout or an exhausted heap, and a heap of several
gigabytes can be exhausted after receiving a few hundred megabytes. Each budget is optional
and unlimited when absent, so a run without budgets behaves as the engine does.

| flag | checked | counts |
|---|---|---|
| `--max-requests N` | before each request | every request the run makes, including the descriptor request that pins a release |
| `--max-bytes B` (`k`, `M`, `G` suffixes) | before each request and while each body streams | decoded bytes received, which is what occupies the heap; the wire size is recorded beside it |
| `--max-rows R` | as each result row is written | rows of the result |
| `--timeout S` | wall clock from the start of the run | seconds, fractions allowed |

Exceeding a budget aborts the run: in-flight requests are aborted through their signal,
no further request is made, the receipt is written, and the exit status is 3. The row
budget ends the result stream cleanly, so the output holds exactly `R` rows as a
well-formed document. The other budgets fail the stream, and the output is whatever was
serialized before the abort, possibly cut mid-document: it cannot be mistaken for a
complete answer, and the receipt is the account of what it is.

Exit status: **0** complete, the output is exactly the solution set the query denotes;
**1** the query, a source, or the process was wrong; **2** the command line was wrong;
**3** aborted at a budget, receipt written. An engine that stops without ending the run
(Comunica does, on some failures) cannot make the command exit 0: when the event loop
drains with a run open, the receipt is written with that reason and the status is 1, or 3
if a budget had already ended the run.

### The receipt

`--receipt receipt.json` is written on every exit path, including abort and error:

```json
{
  "schema": "kgf-sparql.receipt/1",
  "query": "SELECT ...",
  "sources": [{ "kind": "kgf", "url": "https://apps.okn.us/kgf/phaseskg/v/v0.0.1/fragment",
                "dataset": "phaseskg", "version": "v0.0.1", "content_digest": "sha256:..." }],
  "outcome": { "contract": "complete", "rows": 2750, "result_type": "bindings" },
  "output": { "path": "results.srj", "format": "application/sparql-results+json", "variables": ["s", "p", "o"] },
  "requests": [{ "method": "GET", "url": ".../fragment?limit=10000", "status": 200,
                 "request_id": "837a18811bab11fb-0000cecb", "bytes": 48213, "elapsed_ms": 41.2,
                 "bindings": false, "complete": false, "truncation_reason": "page_limit" }],
  "totals": { "requests": 4, "bindings_requests": 0, "bytes": 903114, "elapsed_ms": 1812 },
  "statistics": { "void": true, "schema_requests": 0 },
  "budget": { "max_requests": 5000, "max_bytes": 268435456, "max_rows": null, "timeout_s": 120,
              "max_connections": 32, "max_in_flight": 32, "max_in_flight_hosts": {},
              "max_rate_hosts": {} },
  "engine": { "kgf_sparql": "0.1.0", "comunica": "5.4.1", "node": "v25.9.0" },
  "started": "2026-09-09T22:14:03.000Z",
  "finished": "2026-09-09T22:14:04.812Z"
}
```

- `outcome.contract` is `complete`, `aborted` (with `budget` naming which one), or
  `error` (with `error`). Nothing in between: no partial result is ever labelled complete.
  `rows` is how many rows were written before the run ended.
- `sources[]` for a KGF source carries the dataset, the pinned version, and the release's
  `content_digest` from one request to its dataset descriptor.
- `requests[]` is every request, in order, as the engine's HTTP actor saw it: the server's
  `KGF-Request-Id`, which joins the entry to the server's access log; `bytes` the engine
  received, with `bytes_wire` beside it when the server sent a `Content-Length`; whether the
  request pushed `bindings`; and the server's `KGF-Complete` and `KGF-Truncation-Reason`
  headers. A request that failed before any response carries `error` instead of a status.
- `statistics.schema_requests` counts the `/schema` requests the lazy VoID provider made,
  the run's planning cost apart from its data cost.

Every request the engine makes passes through a `fetch` the command installs in the query
context under Comunica's `KeysHttp.fetch`; the HTTP actor prefers a fetch supplied there.
No actor or configuration changes for the budget, the receipt, or the connection cap. The
same pieces are exported for programs: `RunAccount` is the counting fetch with its
budgets, `createPooledFetch` the capped transport to hand it, and `runCli` runs the
command line in-process.

## Planning and transport

- Each triple pattern supplies metadata from `GET /count`. Planning does not
  download a fragment page. Fragment pages are fetched only as results are consumed.
- Pages default to **1,000 rows**, capped by the service descriptor. Bindings
  batches default to the server's advertised **max_bindings** (200 if absent),
  and also respect its request-byte budget. Comunica may supply smaller batches.
- Comunica's `filterBindings` interface maps to KGF's pattern-and-bindings JSON
  body. Restricted queries go straight to `QUERY /fragment`: they are a bind join's
  probes, which report an unknown cardinality rather than spend a `/count` on each block.
  Comunica supports the custom HTTP method through its HTTP mediator.
- HTTP 405 or 501 on QUERY triggers a POST retry, remembered for the query.
  Other errors propagate. POST can also be explicitly selected.
- Cursor requests preserve the original pattern and bindings. Incomplete pages
  without an advancing cursor fail rather than silently returning partial answers.
- Duplicate and overlapping binding rows are handled as a set of matching triples
  for `filterBindings`; Comunica performs the join and preserves SPARQL duplicate
  solutions. Per-binding counts are upper estimates when those rows may overlap.
- The source exposes KGF's published union as the default graph. Named graphs have
  no triples in this source. Quoted triple terms and graph-scoped KGF operations are
  not implemented.

Requests use Comunica's HTTP mediator, so its `fetch`, authentication, timeout,
and logging settings apply. Destroying a result stream stops further pagination.

## Named graphs

A bare pattern reads a KGF dataset's union, and `GRAPH` reaches its named graphs and
its unnamed graph through two reserved IRIs. This holds for the native `kgf` source
and for a stock `brtpf` source pointed at a dataset's TPF route, with no engine
configuration: do not set Comunica's `unionDefaultGraph` context key for either. The
contract the native source must implement, and what it does today, is in
[docs/graph-semantics.md](https://github.com/frink-okn/kgf-sparql/blob/main/docs/graph-semantics.md).

## VoID without preloading

Automatic VoID join estimates are enabled for native KGF sources. No statistics
registry or config-generation step is required.

Pattern metadata carries a lazy statistics provider. The join-selectivity actor
invokes it only when comparing two triple patterns with a shared variable. It
requests `/schema?view=queryable&predicate=<IRI>` for the predicates involved.
When a partition lacks distinct-subject or distinct-object counts, it also reads
the dataset root `/schema?view=queryable` as a fallback. It never requests
`/void`, lists all predicates, or traverses the partition tree.

Requests are memoized within each query. The `queryable` view describes the same
merged graph as the fragments. Missing statistics or schema errors leave
Comunica's default estimator available.

These estimates assume uniformity and containment, and may still worsen plans
on skewed data. They apply only to pairwise triple-pattern joins, not arbitrary
multiway or OPTIONAL joins. Disable automatic statistics when that tradeoff is
undesirable:

```js
import {
  QueryEngine,
  KEY_KGF_PAGE_SIZE,
  KEY_KGF_BINDINGS_SIZE,
  KEY_KGF_HTTP_METHOD,
  KEY_KGF_VOID_STATISTICS,
} from '@frink-okn/kgf-sparql';

const engine = new QueryEngine();
const context = {
  sources: [{ type: 'kgf', value: 'https://apps.okn.us/kgf/biobricks-tox21' }],
  [KEY_KGF_PAGE_SIZE.name]: 5000,
  [KEY_KGF_BINDINGS_SIZE.name]: 200, // Optional override; omit to use the server limit.
  [KEY_KGF_HTTP_METHOD.name]: 'POST',
  [KEY_KGF_VOID_STATISTICS.name]: false,
};
```

The corresponding raw context keys are `@kgf:pageSize`,
`@kgf:bindingsSize`, `@kgf:httpMethod`, and `@kgf:voidStatistics`.
Settings may also be placed in a source's `context`.

The existing `KEY_VOID_STATISTICS` registry and the actor's static `statistics`
configuration remain supported, including for non-KGF sources. Explicit entries,
keyed by the configured source URL, take precedence over automatic loading.
Disabling automatic loading does not disable explicitly supplied statistics.

The estimator uses `1 / max(distinctValuesLeft, distinctValuesRight)` for each
shared variable. Distinct counts fall through predicate partitions, `rdf:type`
reasoning, dataset totals, and pattern cardinality. The actor's `safetyFactor`
(default 1) can raise estimates to compensate for skew; its `accuracy` (0.8)
outbids Comunica's syntactic heuristic (0.5) when statistics are available.

## Join planning and request cost

Comunica's bind join prices a bound probe against a paged source at a fraction of a
request: it takes the source's per-request cost as already paid, which is true of the
entry being planned and false of the probes the join will send. With the native source's
exact cardinalities, 888 probes on one query were priced at a few milliseconds, and
per-row binding beat pushing the bindings in blocks by two orders of magnitude, at 1,791
requests instead of 22. The engine config replaces the stock bind join in place, through a
Components.js `Override`, with
[`@frink-okn/actor-rdf-join-multi-bind-round-trip`](https://www.npmjs.com/package/@frink-okn/actor-rdf-join-multi-bind-round-trip),
which adds one request per probe per paged entry to the stock formula and changes nothing
else; the `OPTIONAL` bind join, whose formula has the same zero, is replaced the same way.
That query then takes 45 requests. Comunica's own defaults, weights, and refusals are
untouched; the override keeps the actor's identifier so the join actors' ordering still
refers to it.

Two further actors address federated joins.
[`@frink-okn/actor-rdf-join-selectivity-bound`](https://www.npmjs.com/package/@frink-okn/actor-rdf-join-selectivity-bound)
caps whatever join-size estimate the selectivity bus gives with an upper bound: an entry
whose variables all occur in the others cannot make the join larger, so `?cell
rdfs:subClassOf cell:` joined with `?cell part_of: abdomen:` has at most 838 rows where the
shape heuristic estimated 7.4 million. It never raises an estimate, so its error can only
shrink, except a cross product's, which it sets to the product, as that size is exact.
[`@frink-okn/actor-rdf-join-multi-bind-block`](https://www.npmjs.com/package/@frink-okn/actor-rdf-join-multi-bind-block)
sends the smallest entry in blocks through every entry that accepts bindings, a SPARQL
endpoint through `VALUES` and a union across sources included, in one pass, as FedX's bound
joins do. A query joining Ubergraph with QLever's Wikidata endpoint, which stock Comunica had
not finished after four minutes, returns its 3,332 rows in 56 requests. The same package's
`OPTIONAL` join sends the left rows to the optional pattern in blocks too, where Comunica
either probes it once per left row or reads it whole.

## Request pacing

[`@frink-okn/actor-http-throttle`](https://www.npmjs.com/package/@frink-okn/actor-http-throttle)
paces requests per host, in place of Comunica's rate limiter. A host has at most
`KEY_HTTP_IN_FLIGHT` requests in flight (default 32); `KEY_HTTP_HOST_LIMITS` gives
particular hosts their own `inFlight` and `perSecond`, and `*.domain` a cap the domain's
hosts share, within which each host's own limits still hold. QLever's hosts start at most
one request a second unless the context says otherwise: QLever publishes no limit, and
learning it from refusals cost every run its first requests. Under Node, requests name
`kgf-sparql/<version> (+https://github.com/frink-okn/kgf-sparql)` as their user agent:
Wikidata's query service asks clients to name themselves, and UniProt turned Comunica's
default away. A 429 or 503 with `Retry-After`, as KGF's admission gate sends, pauses the host
until then, or for the context's `httpRetryDelayLimit` at most; one without, as QLever
sends, doubles the interval between the host's requests, and later answers shorten it again.
Refused requests are retried through the same queue, up to 5 times unless the context sets
`httpRetryCount`, and Comunica's retry actor stands aside, so retries are paced and never
multiplied. Timeouts and network errors do not slow a host: Comunica's limiter slowed a
whole host after any failure, so a SPARQL endpoint that timed out on its service description
held every other request to its host, a KGF server's included, to one every 1 to 3 seconds.

```js
import { KEY_HTTP_HOST_LIMITS, QueryEngine } from '@frink-okn/kgf-sparql';

await new QueryEngine().queryBindings(query, {
  sources,
  [KEY_HTTP_HOST_LIMITS.name]: { 'qlever.dev': { inFlight: 1, perSecond: 1 } },
});
```

## SPARQL endpoints

[`@frink-okn/actor-query-source-identify-hypermedia-sparql-bounded`](https://www.npmjs.com/package/@frink-okn/actor-query-source-identify-hypermedia-sparql-bounded)
makes plans over SPARQL endpoints come out the same from run to run. Comunica plans a
federated query from a COUNT per pattern per endpoint; an exact count of a large pattern
outlasts its 3 second timeout (4.4 s for every `rdfs:label` on QLever's Wikidata), the
cardinality becomes unknown, and which counts came back in time decided the plan: the
Ubergraph and Wikidata cells query returned 1,000 rows in 21 s on one run and timed out after
375 requests on the next. Counts are bounded at a cap (`KEY_SPARQL_COUNT_CAP`, per host
`KEY_SPARQL_COUNT_CAP_HOSTS`, `--count-cap`; default 1,000,000, none for Wikidata's query
services, whose Blazegraph counts a pattern from its indexes in 0.12 s and takes 10 s to count
one to a million), timed only while the server has them, and reported with their request
time, so that a bind join sending a request per row no longer costs the same as one sending
a block of rows; a count at the cap is accepted without the ASK Comunica would confirm it
with. A probe that sends bindings as `VALUES` is not counted at all: nothing reads that
count, and it doubled the requests of every block. The cells query now takes the block join
on every run, 1,000 rows in 13 to 16 s and about 21 requests to QLever.

## Packages

The engine is assembled from these actors, each published on its own for other Comunica
configurations:

| package | |
|---|---|
| [`@frink-okn/actor-query-source-identify-kgf`](https://www.npmjs.com/package/@frink-okn/actor-query-source-identify-kgf) | the native KGF JSON source and its HTTP transport |
| [`@frink-okn/actor-rdf-join-selectivity-void`](https://www.npmjs.com/package/@frink-okn/actor-rdf-join-selectivity-void) | join selectivity from VoID statistics |
| [`@frink-okn/actor-rdf-join-selectivity-bound`](https://www.npmjs.com/package/@frink-okn/actor-rdf-join-selectivity-bound) | an upper bound on any join-size estimate |
| [`@frink-okn/actor-rdf-join-multi-bind-block`](https://www.npmjs.com/package/@frink-okn/actor-rdf-join-multi-bind-block) | block bind joins: inner, through every entry that takes bindings, and `OPTIONAL` |
| [`@frink-okn/actor-rdf-join-multi-bind-round-trip`](https://www.npmjs.com/package/@frink-okn/actor-rdf-join-multi-bind-round-trip) | Comunica's bind joins, charging a request per probe |
| [`@frink-okn/actor-http-throttle`](https://www.npmjs.com/package/@frink-okn/actor-http-throttle) | per-host pacing, and retries of refused requests |
| [`@frink-okn/actor-query-source-identify-hypermedia-sparql-bounded`](https://www.npmjs.com/package/@frink-okn/actor-query-source-identify-hypermedia-sparql-bounded) | Comunica's SPARQL source with bounded, server-timed COUNTs |

The engine's Components.js configuration is `config/config-default.json` in this package.

## License

MIT
