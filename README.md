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

```bash
npx kgf-sparql -q 'SELECT * WHERE { ?s ?p ?o } LIMIT 10' \
  kgf@https://apps.okn.us/kgf/biobricks-tox21/v/v0.0.2/fragment
```

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

## Development

```bash
npm install --ignore-scripts
npm test
npm run test:live
```

`--ignore-scripts` allows npm to link the workspaces before compiling their
Components.js configurations. `npm test` builds all packages and runs deterministic
protocol and SPARQL regression tests. `test:live` is an opt-in, bounded comparison
against the public KGF server; it also checks count-first QUERY bindings and
pagination. Set `KGF_ROOT` and `KGF_DATASET` to test another deployment.

```text
packages/actor-query-source-identify-kgf/  Native JSON source and HTTP transport
packages/actor-rdf-join-selectivity-void/  Generic VoID join-selectivity actor
packages/kgf-sparql/                      Engine configuration, library, and CLI
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
