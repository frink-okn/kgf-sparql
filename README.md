# kgf-sparql

A [Comunica](https://comunica.dev/) SPARQL engine with a native
[Knowledge Graph Fragments (KGF)](https://apps.okn.us/kgf/) triple source.

Use `type: 'kgf'` to query KGF's JSON API. The source gets cardinalities from
`/count` before opening fragment pages, passes bindings using HTTP `QUERY`, and
follows opaque cursors. Standard Comunica sources, including brTPF, RDF/JS stores,
files, and SPARQL endpoints, remain available.

## Use as a library

```js
import { QueryEngine } from 'kgf-sparql';

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
  429, 502, 503, and 504 responses; network errors are not retried.
- **Connections:** `--max-connections N` (default 32) caps concurrent connections per
  origin. Comunica has no in-flight limit and a plan that fans out can put hundreds of
  requests in flight at once, which a shared server answers with bursts of connection
  failures. The run's fetch pools its connections through undici's `Agent`, reuses them,
  and queues requests beyond the cap. Request counts are the plan's and do not change.
- `kgf-sparql-comunica` is Comunica's own command line over this engine, for scripts
  written against it.

### Budgets

Comunica has no plan-level budget: in the public-deployment evaluation, every task that
never finished died in the client, at a timeout or with an 8 GB heap exhausted after
receiving between 68 MB and 514 MB. Each budget is optional and unlimited when absent, so a
run without budgets behaves as the engine does.

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
              "max_connections": 32 },
  "engine": { "kgf_sparql": "0.1.0", "comunica": "5.3.0", "node": "v25.9.0" },
  "started": "2026-09-09T22:14:03.000Z",
  "finished": "2026-09-09T22:14:04.812Z"
}
```

- `outcome.contract` is `complete`, `aborted` (with `budget` naming which one), or
  `error` (with `error`). Nothing in between: no partial result is ever labelled complete.
  `rows` is how many rows were written before the run ended.
- `sources[]` for a KGF source carries the dataset, the pinned version, and the release's
  `content_digest` from one request to its dataset descriptor, the same identity every
  `kgfq` receipt carries, so the two join.
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
  body. Restricted queries use `QUERY /count` before `QUERY /fragment`.
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
} from 'kgf-sparql';

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
exact cardinalities, 888 probes on one registry query were priced at a few milliseconds,
and per-row binding beat pushing the bindings in blocks by two orders of magnitude, at
1,791 requests instead of 22. The engine config replaces the stock bind join in place,
through a Components.js `Override`, with
[`@kgf/actor-rdf-join-inner-multi-bind-round-trip`](packages/actor-rdf-join-inner-multi-bind-round-trip/),
which adds one request per probe per paged entry to the stock formula and changes
nothing else; the `OPTIONAL` bind join, whose formula has the same zero, is replaced the same way. On the registry corpus that query drops to 45 requests, `ubergraph/adrenal-gland`
from 79 to 9, and `sockg/fields_on_sites` from a 5,000-request abort to 119 and complete;
over the corpus, requests fell by a fifth and no query that completed before fails.
Comunica's own defaults, weights, and refusals are untouched; the override keeps the
actor's identifier so the join actors' ordering still refers to it.

## Development

```bash
npm install --ignore-scripts
npm test
npm run test:live
```

`--ignore-scripts` allows npm to link the workspaces before compiling their
Components.js configurations. `npm test` builds all packages and runs deterministic
protocol, SPARQL regression, and command-line tests against a mock KGF server, the
latter through both the in-process entry point and the executable. `test:live` is an
opt-in, bounded run against the public KGF server; it checks count-first QUERY bindings
and pagination, then runs the command line on a small graph and asserts a complete
receipt with request ids and a budget abort. Set `KGF_ROOT` and `KGF_DATASET` to test
another deployment.

`python3 test/registry-corpus-cli.py` runs the okn-registry query corpus through the
command line with budgets and receipts, and compares the outcome with the earlier brTPF
run in `test/registry-query-results-20260827.json`. `test/registry-corpus.py` is that
earlier runner.

```text
packages/actor-query-source-identify-kgf/          Native JSON source and HTTP transport
packages/actor-rdf-join-selectivity-void/          Generic VoID join-selectivity actor
packages/actor-rdf-join-inner-multi-bind-round-trip/  Bind join charging a request per probe
packages/kgf-sparql/                              Engine configuration, library, and CLI
```

## Earlier brTPF benchmarks

The original VoID-only engine rescued some expensive brTPF plans: one benchmark
went from 14,928 requests to 59; across a 60-query corpus, totals fell from 82,186
to 56,772, with most savings concentrated in one query. Some queries regressed
because Comunica's join-cost modifiers were calibrated for its syntactic estimator.
Those measurements describe the earlier brTPF integration, **not the native
source**. Native throughput has not yet been benchmarked across that corpus.

## License

MIT
