# Query Planning and SPARQL Authoring for the KGF Client Suite

**Status:** design report  
**Date:** 2026-08-27  
**Scope:** client behavior, query structure, KGF planning inputs, and bounded KGF operations

## Executive summary

The `mcp-okn` benchmark failures are not one problem. They divide into three useful
classes:

1. **Avoidable client planning failures.** A query has a small selective anchor, but the
   engine enumerates a broad predicate, chooses a one-binding-at-a-time join, or scans the
   right side of an `OPTIONAL`.
2. **Work hidden behind SPARQL syntax.** Constants are expressed through `FILTER` or
   `BIND`, a finite predicate set is expressed as a namespace filter over `?p`, or text
   lookup is expressed as a filter over every label. The intended access path is not
   explicit to a fragment client.
3. **Genuinely blocking or malformed queries.** `DISTINCT`, `GROUP BY`, and `ORDER BY`
   can require the complete input before `LIMIT` applies. Disconnected mandatory graph
   patterns denote Cartesian products even when an `OPTIONAL` appears to relate them.

Ordinary VoID statistics improve some tail cases, but they are not a broad solution. On
the 43 tasks completed by both arms of the latest local run, request counts were nearly
identical: 56,184 without VoID and 56,051 with it. The important success was rescuing a
catastrophic BioBricks query, not improving the median query.

The client suite should therefore combine:

- concise SPARQL authoring guidance for coding agents;
- deterministic linting and explanation before execution;
- a native KGF query source that uses the operation and cap surface directly;
- schema-aware planning for multi-pattern and `OPTIONAL` joins;
- explicit staging and local, spillable execution for unavoidable large scans; and
- a small number of additional bounded KGF services, led by pattern-scoped distinct
  values/facets.

Deep automatic rewriting should not be the default response to poorly expressed intent.
When a query author knows a finite set of input IRIs, the preferred solution is to write
that intent explicitly with `VALUES`.

## 1. Evidence and scope

The local harness in [`test/corpus.py`](../test/corpus.py) runs the `auto` tasks from the
`mcp-okn` benchmark that map to exactly one KGF dataset. This currently exercises 60
single-KG queries. It does **not** yet evaluate the planned multi-endpoint client behavior.

The latest detailed results are in
[`test/corpus-results-fullcoverage.json`](../test/corpus-results-fullcoverage.json). The
existing KGF-wide measurements and hand-written native plans are documented in:

- [`benchmark-kgf-results.md`](../../kgf/docs/benchmark-kgf-results.md)
- [`benchmark-implications.md`](../../kgf/docs/benchmark-implications.md)

The current `kgf-sparql` package is stock Comunica 5.3 plus one extra actor,
[`ActorRdfJoinSelectivityVoid`](../packages/actor-rdf-join-selectivity-void/lib/ActorRdfJoinSelectivityVoid.ts).
That actor deliberately handles only pairwise joins between triple patterns. It cannot
directly change multiway BGP planning, left joins, filter placement, aggregation, or
blocking operators.

### 1.1 Representative findings

| Query shape | Measured behavior | Interpretation |
|---|---|---|
| BioBricks chemical names | Stock timed out after 26,029 requests; VoID returned 200 rows in 1.83 seconds and 722 requests | A genuine join-planning rescue |
| ProKN disease list | `rdf:type` has 14.2M triples, while the two requested classes contain 36,084 entities; replacing the finite equality filter with equivalent `VALUES` completed in 6.8 seconds and 1,849 requests instead of timing out after 19,694 requests | The missing information was already in the query, but hidden from source selection by its syntax |
| Hydrology downstream flow | The fixed `connectedTo` object matches four starting subjects, but a four-second trace spent 762 of 769 requests broadly reading `hasFTYPE` | The query is selective; the physical plan is not |
| SOCKG soil biological samples | The anchor class has 18,273 entities and its class-scoped core properties each have 18,273 triples, yet the query exhausts the client heap | Global pattern cardinality and pairwise selectivity do not capture the class-anchored star |
| FIO facilities | The bound subsector produces 54 codes, but a short trace was dominated by broad label enumeration | `OPTIONAL` label enrichment destroys an otherwise selective plan |
| ProKN Alzheimer query | Predicate-scoped text matching produces 471 label candidates instead of scanning 3.53M labels | Text candidate generation is an access operation, not a join statistic |
| NCIPID interactions | Six predicates in the requested namespace contain all 67,267 results; scanning `?s ?p ?o` reads 597,129 triples | Predicate inventory plus `VALUES` avoids the unrelated data |
| SCALES ontology labels | 1,679,138 matching triples collapse to 75 distinct object values; stock Comunica makes 16,793 requests | A count of 75 is insufficient: the client needs the 75 actual RDF terms |
| NASA keyword frequency | The query groups across three broad relations; VoID changed the join strategy but increased requests and time | Complete client-side aggregation must consume the relevant input; bind pushdown is not automatically useful |
| ProKN LINCS perturbations | Two mandatory components are disconnected and their apparent relationship occurs only in an `OPTIONAL` | The SPARQL denotes a Cartesian product; this is principally an authoring problem |

### 1.2 What the current cost model misses

Comunica's multi-pattern filter-bindings actor computes part of its cost by multiplying
the cardinalities of all remaining patterns. On the failing queries, captured estimates
reach values such as `10^41`, price the batched operator out, and select recursive
one-binding evaluation instead.

More global statistics do not repair this by themselves. The planner needs to know facts
such as:

```text
class C has 18,273 entities
18,273 subjects in C have property p
there are 18,273 C/p triples
```

That is a conditional statement about a class-anchored star. A global property count or
global distinct-subject count cannot express it.

## 2. Two client contracts

The client suite should keep two contracts visibly separate.

### 2.1 Complete SPARQL answering

This path returns the solution sequence denoted by the submitted query. It may change
physical operators, use equivalent algebraic normalizations, and push exact operations to
KGF, but it must not silently sample, push a `LIMIT` through an unsafe join, replace all
labels with one preferred label, or reinterpret multi-valued stars as arrays.

### 2.2 Agent-oriented integration

This path answers an intent under an explicit request, time, or result budget. It may
select a bounded candidate set before hydration or return a documented sample, but it must
return a receipt describing incompleteness and every approximation.

An optimization legal for the integration path is not automatically legal for complete
SPARQL. For example, applying `LIMIT 200` to an initial type pattern can produce a useful
200-row sample, but it is not a generally valid rewrite of `LIMIT 200` applied after a
multi-pattern join.

## 3. SPARQL authoring guide for coding agents

The central rule is:

> Make selectivity explicit in the SPARQL algebra. Do not rely on an engine inferring it
> from filters, strings, or textual pattern order.

### 3.1 Use constants and `VALUES` for finite inputs

Avoid:

```sparql
?entity a ?type .
FILTER(?type = ex:TypeA || ?type = ex:TypeB)
```

Prefer:

```sparql
VALUES ?type { ex:TypeA ex:TypeB }
?entity a ?type .
```

For one value, place it directly in the triple pattern:

```sparql
?entity a ex:TypeA .
```

Prefer constant `VALUES` to a constant `BIND` when the value should restrict remote
matching:

```sparql
VALUES ?date { "1998-04-20"^^xsd:date }
```

Input rows should be deduplicated and large sets should be split according to the
endpoint's advertised binding and request-byte caps.

### 3.2 Never scan a variable predicate to filter a finite vocabulary

Avoid:

```sparql
?source ?relation ?target .
FILTER(STRSTARTS(STR(?relation), STR(RO:)))
```

Read the predicate inventory from KGF `/schema`, select the relevant IRIs, and write:

```sparql
VALUES ?relation {
  RO:0002212
  RO:0002213
}
?source ?relation ?target .
```

This applies to any finite set of predicates or types, not only namespace prefixes.

### 3.3 Keep the mandatory graph pattern connected

Every mandatory component should share a variable with the rest unless a Cartesian
product is intentional.

Dangerous:

```sparql
?perturbagen a ex:Perturbagen ;
             ex:identifier ?identifier .

?compound a ex:Compound ;
          rdfs:label ?label .

OPTIONAL { ?compound ex:sameAs ?identifier }
```

`OPTIONAL` does not connect or constrain the two mandatory components. If the relationship
is required, make it mandatory:

```sparql
?perturbagen ex:identifier ?identifier .
?compound ex:sameAs ?identifier ;
          rdfs:label ?label .
```

Each `UNION` branch should also bind the variables required to connect downstream work.

### 3.4 Use `OPTIONAL` only for enrichment

Identify a small required result set before adding labels, descriptions, geometry, and
other secondary properties. A relationship needed to establish entity identity or join
two components is not optional.

For a large remote result, prefer two explicit stages:

1. query the entity IRIs from the selective required core;
2. hydrate those IRIs in binding-sized `VALUES` batches.

This also isolates preferred-label behavior from the complete SPARQL semantics of an
arbitrary multi-valued `rdfs:label` relation.

### 3.5 Do not use a broad text filter as the primary lookup

Avoid:

```sparql
?entity rdfs:label ?label .
FILTER(CONTAINS(LCASE(?label), "alzheimer"))
```

Use an exact object-bound triple when the literal is known. Otherwise, use KGF text/search
to obtain candidate IRIs and submit those candidates through `VALUES`. If the text service
only guarantees a candidate superset, retain the original SPARQL filter as a residual
correctness check.

### 3.6 Treat `DISTINCT`, `ORDER BY`, and aggregation as full-input operations

This query may read all 1.68M matching triples before returning 75 rows:

```sparql
SELECT DISTINCT ?label
WHERE { ?entity ex:label ?label }
LIMIT 100
```

Guidelines:

- do not add `DISTINCT` defensively; first identify the join producing duplicates;
- narrow the required graph before `GROUP BY`;
- aggregate before joining optional many-valued properties;
- omit `ORDER BY` when a small result can be sorted locally; and
- do not expect `LIMIT` to short-circuit `DISTINCT`, `GROUP BY`, or `ORDER BY`.

If a bounded arbitrary sample is the actual intent, express the bounded first stage
explicitly and treat that as the authored semantics rather than an engine rewrite.

### 3.7 Split large queries into IRI-producing stages

The benchmark shows an empirical cliff around six triple patterns. This is not a language
law, but it is a useful review threshold. A query with more than six patterns, nested
aggregation, or several `OPTIONAL`s should normally be decomposed into:

```text
selective IRI query -> bounded IRI set -> VALUES-based extension/hydration
```

For federation, resolve a bounded set in one KG and bind those IRIs into the next KG.
Cross-KG joins should use shared IRIs, not labels or computed strings.

### 3.8 Avoid accidental multiplicative joins

Several one-to-many properties in the same BGP multiply solution mappings. Before adding
aggregation, determine whether each relation is one-to-one, optional, or multi-valued.
Nested subqueries must expose every intended correlation key; grouping only by entity can
multiply against outer rows that also vary by date, parameter, treatment, or unit.

### 3.9 Avoid unconstrained property paths

Do not begin a large query with a broad `*` or `+` path. Prefer a fixed-length relation,
a published materialized closure predicate, or a selective bound endpoint before the
traversal.

### 3.10 Project only required variables

Avoid `SELECT *`. Extra variables increase transfer, grouping keys, distinctness cost, and
the chance of exposing unintended multiplicity.

## 4. Deterministic query linting

The authoring rules are more useful when enforced before a query reaches the network. A
client-side linter should parse SPARQL algebra, produce diagnostics, and offer examples. It
should not silently rewrite ambiguous intent.

| Rule | Default severity | Diagnostic |
|---|---|---|
| `KGFQ001` | warning | Finite equality/`IN` filter could be expressed as `VALUES` |
| `KGFQ002` | warning | Constant `BIND` is used as a remote selection constraint |
| `KGFQ003` | warning | Variable predicate is restricted only by namespace/string filtering |
| `KGFQ004` | strong warning | Required BGP has disconnected components and therefore a Cartesian product |
| `KGFQ005` | strong warning | An `OPTIONAL` is the only apparent bridge between required components |
| `KGFQ006` | warning | Broad label predicate is followed by an unanchored text filter |
| `KGFQ007` | information | `LIMIT` follows a blocking `DISTINCT`, `GROUP BY`, or `ORDER BY` |
| `KGFQ008` | information | Query exceeds the configurable complex-BGP review threshold |
| `KGFQ009` | warning | Aggregation follows multiple potentially multi-valued joins or optionals |
| `KGFQ010` | warning | Unbounded property path lacks a selective endpoint |
| `KGFQ011` | information | `SELECT *` projects variables not required by the caller |

Safe mechanical fixes may be offered for simple cases such as a definitely-bound equality
disjunction converted to a deduplicated `VALUES` table. Disconnected BGPs, optional bridges,
and aggregation changes require author confirmation because the intended semantics are not
recoverable from syntax alone.

## 5. KGF operations and statistics that would materially help

Statistics help the client choose among plans. Services let it avoid doing the work. The
largest remaining wins generally require the latter.

### 5.1 Pattern-scoped distinct values and facets

KGF currently publishes per-predicate distinct counts. A count of 75 tells a planner the
result size of the SCALES label query, but it does not provide the 75 actual RDF terms. The
client must still read 1,679,138 triples to discover them.

A bounded operation should project actual distinct values from one triple pattern,
optionally with frequencies. A provisional request shape is:

```http
QUERY /facet
```

```json
{
  "pattern": {
    "s": "?s",
    "p": "<http://schemas.scales-okn.org/rdf/scales#OntologyLabel>",
    "o": "?label"
  },
  "group_by": "o",
  "metrics": ["count"],
  "limit": 1000
}
```

The first version should remain deliberately narrower than SPARQL aggregation:

- one triple pattern;
- projection/grouping over one pattern position;
- optional binding restrictions;
- `count` and possibly `countDistinct` metrics whose exact semantics are specified;
- exact distinct cardinality in metadata;
- ordinary KGF pagination, cursors, byte caps, and completeness fields.

This supports SCALES, property-value exploration, faceting, and heavy-hitter discovery
without introducing a general server-side join engine.

### 5.2 Class-conditioned property statistics

Extend each `(class, predicate)` record in the queryable schema projection with:

- class entity count;
- property triple count within the class;
- distinct class subjects having the property;
- distinct property objects within the class;
- coverage: subjects having the property divided by class entities;
- average and maximum values per subject; and
- optionally a small set of fan-out quantiles.

These values tell the planner whether a class property is total, sparse, functional-like,
or highly multi-valued. They directly support class-anchored stars and `OPTIONAL` planning.

Publishing every pairwise property correlation would grow quadratically and is not a good
first step. Dynamic binding-restricted counts can resolve uncertainty after a selective
anchor is available.

### 5.3 Implement the existing star/hydration contract

`/star` already belongs to the KGF design and is advertised by current manifests, but the
current server router does not expose it. It is a natural fit for class-anchored entity
records and the star-shaped SOCKG queries.

The semantic boundary must remain explicit: KGF arrays are not SPARQL's Cartesian product
of multi-valued properties. A complete-SPARQL source actor must expand arrays into solution
mappings or use `/star` only as an internal hydration representation.

### 5.4 Exact and candidate filter pushdown

Standardize operation-level support and exactness metadata for:

- exact literal matching;
- predicate-scoped text matching;
- numeric and date ranges;
- language and datatype constraints; and
- finite predicate-prefix expansion through schema inventory.

An exact operation may replace the corresponding filter. A candidate operation must return
a guaranteed superset and leave the original SPARQL filter in the client plan.

Text pushdown has a large demonstrated benefit in ProKN. Range support is lower priority in
the present corpus because most numeric filters can be applied after another selective
anchor.

### 5.5 Explicit semijoin/existence support

The native binding-aware fragment and per-binding count operations already contain most of
the needed machinery. The client should have a documented path for:

```text
input bindings + triple pattern -> compatible input binding identities
```

This prevents transfer of repeated triples when the client only needs to filter its current
bindings. It may be a client-library abstraction over binding-aware `/count`, rather than a
new HTTP route.

### 5.6 Large-scan transport instead of general server aggregation

For broad multi-pattern aggregates such as NASA keyword frequency, the KGF-shaped solution
is initially:

- exact counts to recognize that most of a partition is required;
- maximum-size pages;
- Parquet or Arrow transport/export;
- local hash joins, `DISTINCT`, and aggregation in a spillable engine.

The existing native NASA plan required 29 requests rather than Comunica's 7,986. This is
strong evidence for improving transport and local execution before adding general SPARQL
aggregation to the server.

### 5.7 Capability declarations must be truthful

The live manifests advertise `star`, `terms`, and `export`, while the current server routes
return 404 for them. A planner must be able to trust capability discovery. Until these
operations are implemented, they should not be declared; a native source should also fail
gracefully when a claimed operation is unavailable.

## 6. Proposed client-suite architecture

```text
coding agent / application
          |
          v
SPARQL parser + lint + explain
          |
          v
semantic contract selection
  complete SPARQL | budgeted integration
          |
          v
KGF-aware planner
  schema + counts + caps + capability discovery
          |
          +------------------------------+
          |                              |
          v                              v
small streaming plan              large materialized plan
Comunica/native source            column fetch/export + local engine
```

### 6.1 Native `QuerySourceKgf`

The source described in [`docs/06-clients.md`](../../kgf/docs/06-clients.md) should be the
foundation:

- discover the service descriptor and immutable dataset manifest;
- use native `/fragment` and `/count` representations;
- request pages up to the advertised `max_limit`;
- send bindings through QUERY/POST instead of embedding a large table in a GET URL;
- size batches by both row count and encoded request bytes;
- expose exact cardinality and physical request-cost metadata; and
- preserve cursor, completeness, and blank-node identity rules.

The live server permits 10,000-row pages while stock Hydra enumeration uses the default
100. On the SCALES pattern this changes roughly 16,792 data pages into 168, even though it
does not eliminate the logical full scan.

Simply raising Comunica's GET-based binding block from 64 to 1,000 is not sufficient. A
diagnostic run with long ProKN IRIs produced an oversized request and failed. The native
body-carrying route is the correct place to exploit `max_bindings`.

### 6.2 Constraint normalization

A small optional optimization pass may perform only proven equivalent transformations,
including finite equality disjunctions on definitely-bound variables into deduplicated
`VALUES`. Every transformation should appear in `explain` output.

The client should prefer an author-facing lint when intent is ambiguous. It should not try
to repair disconnected BGPs or infer which side of a Cartesian product the author intended.

### 6.3 Schema-aware multiway and optional planning

The planner should recognize class anchors and subject-star topology, use class-property
coverage/fan-out, and compare two extension strategies:

```text
binding extension requests ~= ceil(distinct input keys / max_bindings)
column fetch requests       ~= ceil(pattern cardinality / max_limit)
```

Before each step it should project intermediate size. If the projection exceeds a client
budget, it should reorder, switch to materialization/column fetch, or stop with a useful
diagnostic.

Selective left joins should use binding batches. Preferred-label hydration may be offered
as an explicit integration convenience, but it must not silently replace complete
multi-valued label semantics.

### 6.4 Spillable local execution

JavaScript iterator state can amplify hundreds of megabytes of wire data into multiple
gigabytes of heap. The client should switch predicted-large plans to a columnar local engine
that supports spillable joins, grouping, distinctness, sorting, and left joins.

## 7. Evaluation plan

### 7.1 Preserve a frozen baseline

Record for every benchmark task:

- dataset version and query text;
- complete/timeout/error status;
- row count and a deterministic solution hash;
- requests, binding-bearing requests, and bytes;
- wall time and peak client heap;
- selected physical operators; and
- whether the plan used an exact or approximate contract.

Run arms back to back against the same immutable releases. Do not compare request totals
that silently exclude a task completed by only one arm.

### 7.2 Evaluate changes by failure class

Use representative gates rather than only a corpus total:

- finite filter to `VALUES`: ProKN disease list;
- class-star planning: SOCKG soil biological sample;
- selective `OPTIONAL`: FIO facilities and hydrology;
- predicate inventory: NCIPID interactions;
- text candidates: ProKN Alzheimer/kinase queries;
- blocking distinct: SCALES labels;
- broad aggregation: NASA keyword frequency; and
- malformed/disconnected query: ProKN LINCS, expected to produce a lint diagnostic.

### 7.3 Add federation coverage

The present harness filters to one mapped KG. The client suite needs a separate pinned
corpus for:

- two- and three-endpoint joins;
- namespace/identifier compatibility;
- lopsided bind joins;
- disjoint joins;
- endpoint-specific caps; and
- partial capability availability.

## 8. Recommended implementation order

1. Ship the SPARQL lint/explain rules and the concise author guide.
2. Build the minimal native KGF source over `/fragment`, `/count`, schema, caps, and
   body-based bindings.
3. Add safe finite-constraint normalization and rerun the frozen corpus.
4. Add class-property coverage/fan-out statistics and schema-aware star/optional planning.
5. Specify and prototype pattern-scoped distinct values/facets.
6. Implement truthful `/star` capability and evaluate it on the star-shaped tasks.
7. Add Parquet/Arrow plus spillable local execution for predicted-large plans.
8. Add the federation corpus before claiming multi-endpoint improvements.

## 9. Non-goals

- Do not turn KGF into an unrestricted SPARQL endpoint through incremental special cases.
- Do not silently change complete SPARQL into sampling or preferred-label semantics.
- Do not add quadratic families of statistics before dynamic counts and class-conditioned
  summaries have been exhausted.
- Do not make the engine responsible for guessing the intended meaning of disconnected
  query components.
- Do not judge a planner solely by total requests; bytes, client memory, completeness, and
  answer equivalence matter as well.

The intended result is a client that makes good query structure easy, diagnoses dangerous
structure before execution, exploits KGF's bounded operations, and refuses to hide semantic
changes behind the word “optimization.”
