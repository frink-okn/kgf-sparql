# OKN Registry Queries Against the Local KGF Client

**Date:** 2026-08-27  
**Corpus:** `../okn-registry/docs/registry/queries/`  
**Client:** this repository at `7173d9c`, Comunica 5.3.0, with the current VoID actor  
**Server:** `http://127.0.0.1:8080`

## Executive summary

The registry contains 89 queries. Three Wikidata queries were deliberately excluded and
three NeST queries could not be run because `nestkg` was not present in the local KGF
catalog. Of the remaining 83 queries:

- 45 completed with non-empty results;
- 7 completed with no results;
- 16 reached the 30-second limit;
- 4 exhausted a 2 GB Node heap; and
- 11 failed for a concrete compatibility, query, or external-service reason.

This is not simply a collection of intrinsically expensive queries. Thirty-six non-empty
queries completed within both five seconds and 1,000 KGF requests. Several of the worst
cases have a small selective input that the current client fails to expose or preserve.
Validated rewrites reduced one query from 14,593 to 384 requests, and another from a
timeout to 701 requests. Other cases really are full-input jobs: `DISTINCT`, aggregation,
or ordering requires reading a broad relation before a small result can be returned.

The main conclusions are:

1. Rewrite finite equality and namespace filters as `VALUES`, and place known exact
   literals directly in triple patterns.
2. Produce a small set of IRIs first, then fetch labels and other enrichment in `VALUES`
   batches. Several expensive queries spend most of their requests on labels or other
   optional properties.
3. Reject or warn about disconnected mandatory graph patterns. At least one registry
   query denotes an accidental Cartesian product.
4. Treat broad `DISTINCT` and aggregate queries as scans. A KGF facet/distinct-values and
   grouped-count operation would materially help; cardinality statistics alone do not.
5. Fix two client/transport bugs before treating their queries as query-author errors:
   transitive property-path expansion can emit an invalid `??o` variable, and a bound
   typed literal can be serialized incorrectly in a fragment GET.
6. Hard-coded `SERVICE` clauses are not tests of local KGF federation. Dataset selection
   should be supplied to the client, or the external endpoint should be declared as a
   real dependency.

## Method

The test runner is [`test/registry-corpus.py`](../test/registry-corpus.py), which invokes
[`test/run-registry-query.mjs`](../test/run-registry-query.mjs). The machine-readable
results are in
[`test/registry-query-results-20260827.json`](../test/registry-query-results-20260827.json).

For each query, the runner:

- reads its `#+ tags` header;
- resolves each tag to the current local release and supplies the release's `/fragment`
  URL as a brTPF source;
- supplies the current VoID statistics to the client;
- allows 30 seconds and a 2 GB Node heap; and
- records rows, HTTP requests, elapsed time, HTTP status counts, memory, samples, and an
  order-independent result hash when the query completes.

The captured corpus run used two HTTP retries. The checked-in harness now uses eight so
that occasional `429` responses are less likely to be mistaken for query failures. This
does not rescue the structural timeouts; only three corpus entries saw any `429`s.

Older queries tagged only `federation` do not name their sources. Their sources were
inferred explicitly in the runner. `fio-kg` was treated as the current `fiokg` identifier.
The two generic federation queries were run across every locally advertised dataset.

The labels below are descriptive, not a conformance claim:

- **GOOD:** non-empty, at most five seconds and 1,000 requests;
- **HEAVY:** completes, but exceeds either threshold;
- **EMPTY:** completes correctly with no bindings; this may be stale content;
- **TIMEOUT/OOM/ERROR:** does not complete under the test conditions; and
- **SKIP:** Wikidata was excluded or the target dataset was unavailable.

Results are a single run against a live local service, so small timing differences should
not be over-interpreted. Request-count changes of one or two orders of magnitude are much
more informative.

## What already works well

The current client handles constant-bound lookups and modest connected graph patterns
well. Representative examples include:

| Query | Rows | Requests | Seconds |
|---|---:|---:|---:|
| BioBricks assays from invitrodb | 100 | 8 | 0.562 |
| FIO classification for a facility | 5 | 4 | 0.325 |
| Hydrology query 02 | 296 | 22 | 0.445 |
| NASA publications and datasets used | 25 | 3 | 0.510 |
| NCIPID labeled proteins | 2,588 | 69 | 0.655 |
| ProKN gene properties | 461 | 9 | 0.562 |
| ProKN protein properties | 2,983 | 34 | 0.522 |
| SecureChain FFmpeg dependencies | 100 | 14 | 0.376 |
| Ubergraph adrenal gland | 35 | 4 | 0.346 |

The RuralKG suite is particularly healthy: all seven queries returned non-empty results
in 0.3–3.4 seconds. Both SpatialKG-only queries and all three Ubergraph-only queries also
worked well.

Two queries exceed the mechanical request threshold but are reasonable for their output
volume: `nde/dataset-count-by-agent` returns 2,208 rows in 5.6 seconds, and
`prokn/protein_kinases` returns 3,545 rows in 3.9 seconds. They are not priority rewrite
targets.

## Completed but inefficient queries

| Query | Rows | Requests | Seconds | Assessment |
|---|---:|---:|---:|---|
| `federation/sawgraph-hydrology-spatial-04` | 64 | 17,386 | 20.530 | Cross-source enrichment dominates; stage waterbody IRIs before county lookup. |
| `spoke-okn/compounds-downregulating-alzheimers-genes` | 10 | 14,593 | 17.231 | Broad label scan; an exact literal rewrite is validated below. |
| `prokn/protein_disease` | 277 | 6,145 | 26.110 | Includes a remote OARD `SERVICE`; stage disease IRIs and query configured sources. |
| `nde/nde-resources-by-count` | 8 | 6,582 | 24.218 | Genuine grouped count over the dataset relation. |
| `spoke-genelab/human-ortholog-of-model-gene` | 3 | 3,421 | 13.953 | Known symbol is hidden in a case-folding filter; use an exact term or text candidates. |
| `oard-kg/diseases-associated-with-phenotype` | 100 | 6,600 | 7.530 | Selective input, but a large study/result expansion; hydrate labels last. |
| `oard-kg/phenotypes-associated-with-disease` | 100 | 3,655 | 4.216 | Same shape as above. |
| `nde/dataset-count-by-agent` | 2,208 | 1,254 | 5.619 | Large output; acceptable, though server-side grouping would help. |
| `prokn/protein_kinases` | 3,545 | 1,031 | 3.872 | Output-proportional and acceptable. |

## Empty results

Seven queries completed with no bindings. These are useful results: they distinguish a
stale or currently unsatisfied query from a client failure.

| Query | Requests | Seconds | Note |
|---|---:|---:|---|
| `dreamkg/services-available-weekend` | 3 | 0.307 | Clean empty result. |
| `dreamkg/services-in-more-than-one-language` | 4 | 0.304 | Clean empty result. |
| `ncipidkg/list-all-hdac1-neighbors` | 3 | 0.290 | Clean empty result. |
| `oard-kg/oard-ubergraph-concordance` | 16 | 0.384 | Header names only OARD although the intent mentions Ubergraph; source annotation should be reviewed. |
| `scales/distinct-judges` | 3 | 0.300 | Clean empty result. |
| `spoke-genelab/genes-expression-and-methylation-spaceflight-osd48` | 31 | 0.471 | Clean empty result. |
| `spoke-genelab/spaceflight-vs-ground-control-60day-deg` | 2,149 | 8.637 | Empty, but expensive enough to merit staged assay selection. |

## Validated rewrites

The candidate query files are under
[`test/registry-rewrites/`](../test/registry-rewrites/). Rewrites were run against the same
release endpoints. “Equivalent on this release” means the measured answers were preserved
for the current data; it is not a claim about every possible RDF dataset. “Corrected
intent” means the original query itself expressed a likely mistake.

| Original | Change | Original | Rewrite | Result |
|---|---|---:|---:|---|
| `ncipidkg/list-all-labeled-interactions` | Replace a namespace filter over variable `?relation` with the six matching predicates from KGF `/schema` in `VALUES`. | Timeout; 4,750 requests at 30 s | 67,267 rows; 701 requests; 6.031 s | Equivalent on the current release. |
| `spoke-okn/compounds-downregulating-alzheimers-genes` | Put the known literal `"Alzheimer's disease"` directly in the label triple. | 10 rows; 14,593 requests; 17.231 s | 10 rows; 384 requests; 0.868 s | Equivalent on the current release; identical multiset hash. |
| `oard-kg/rank-diseases-given-phenotypes` | Aggregate the selective study core first, move labels after it, and expand the short property path. | Timeout; 15,491 requests at 30 s | 100 rows; 5,966 requests; 6.881 s | Same intended ranking; candidate should get an answer-equivalence regression test. |
| `prokn/lincs_kinase_perturbations` | Make `?comp rdfs:seeAlso ?pubchemURI` mandatory so that the two mandatory components are connected. | Timeout; 13,400 requests at 30 s | 0 rows; 14 requests; 0.524 s | Corrected intent. Current data has no connected answer. |
| `prokn/list_diseases` | Replace the equality disjunction on `?diseaseType` with `VALUES`. | Timeout; 5,510 requests at 30 s | Earlier isolated run: 54,291 rows; 1,849 requests; 6.8 s | Algebraically equivalent. A later loaded-server run encountered `429`s, showing the need for larger native binding batches as well. |

The FIO/spatial candidate
[`fio-spatial-facilities-fixed-depth.rq`](../test/registry-rewrites/fio-spatial-facilities-fixed-depth.rq)
expands the known town → county → state hierarchy and the geometry sequence into ordinary
triples. It also removes a duplicate facility-label lookup. This avoids the observed
property-path serialization defect, but it still timed out after 60 seconds and 8,214
requests (8,213 `200` responses and one natively retried `429`). It is therefore a partial
fix, not a successful rewrite; the cross-source join still needs explicit staging. An
earlier apparent loss of the local service was subsequently identified as network
isolation in the test-command sandbox, not a KGF server failure.

### Why the exact-label rewrite matters

The Alzheimer query already knew the complete literal but expressed it as:

```sparql
?disease rdfs:label ?diseaseLabel .
FILTER(LCASE(STR(?diseaseLabel)) = "alzheimer's disease")
```

That makes every label a candidate. For the literal form stored in the current release,
the following produces the same answers and exposes an object-bound KGF lookup:

```sparql
?disease rdfs:label "Alzheimer's disease" .
```

The 38-fold request reduction is strong evidence that authoring guidance and a small
normalization pass can matter more than additional global cardinality counts.

### Why the LINCS rewrite is a correctness fix

The original LINCS query has a perturbagen component and a compound/protein component.
Their only shared value appears in an `OPTIONAL`. SPARQL therefore forms the Cartesian
product of the mandatory components first; the optional match cannot constrain it. If
the PubChem relation is the identity link, it must be mandatory. Returning no rows after
that correction is evidence that the documented query or current release is stale, not
a reason to restore the Cartesian product.

## Failure diagnosis and proposed treatment

### 1. Finite inputs hidden from the access path

Affected examples:

- `prokn/list_diseases`
- `prokn/alzheimers_associated_genes`
- `prokn/kinase_inhibition_phosphosites`
- `ncipidkg/list-all-labeled-interactions`
- `spoke-genelab/human-ortholog-of-model-gene`

Use direct constants or `VALUES` for finite types, predicates, symbols, and exact labels.
For case-insensitive or substring lookup where no exact literal is known, obtain candidate
IRIs from a KGF text/facet operation and retain the original filter as a residual check.

### 2. Labels and other enrichment planned too early

Affected examples:

- `fiokg/fio-facilities-by-NAICS-Subsector`
- `hydrologykg/sawgraph-hydrology-04`
- both OARD association queries
- `federation/sawgraph-hydrology-spatial-04`
- `spoke-okn/drugs-for-sdoh-associated-diseases`

The stable client plan is:

1. run the selective, connected relation core and retain entity IRIs;
2. apply numeric filters and any `LIMIT` that is semantically legal;
3. hydrate labels, geometry, and secondary properties in bounded `VALUES` batches; and
4. perform final sort or aggregation locally.

Textual triple order is not enough to force this. The client needs either multi-pattern
star statistics or an explicit staged-query facility.

### 3. Blocking operations over broad relations

Affected examples:

- `nasa-gesdisc-kg/frequent-sciencekeywords`
- `nde/nde-resources-by-count`
- `scales/scales-ontology-event-labels`
- `federation/list-things-and-their-labels`

`LIMIT` cannot normally stop evaluation below `DISTINCT`, `GROUP BY`, or `ORDER BY`.
`scales/scales-ontology-event-labels` must inspect roughly 1.68 million matching triples
to discover 75 distinct values through the present fragment interface. A VoID statement
that says “75 distinct objects” does not contain the 75 RDF terms.

These are the clearest cases for bounded KGF operations:

- pattern-scoped distinct terms/facets, with exactness and pagination metadata;
- grouped counts over one or a small number of predicates; and
- optionally, a native column scan so the client can aggregate locally without thousands
  of small fragment requests.

The all-dataset label query is also underspecified. A client should require the caller to
choose datasets, or make the all-dataset sampling semantics explicit, instead of opening
41 sources for an arbitrary 100 labels.

### 4. Redundant or disconnected graph patterns

`federation/sawgraph-hydrology-spatial_03` contains both `?sp_s2` and `?aq_s2` cells with
the same type and connection to the aquifer, but only `?aq_s2` connects back to the well.
Because the query is `DISTINCT`, the extra `?sp_s2` is only an existence witness already
provided by `?aq_s2`; it multiplies intermediate rows without changing projected answers.
Remove it, replace `FILTER(?aqtype = 'sand and gravel')` with the literal in the triple,
and remove the duplicate aquifer type assertion.

The LINCS Cartesian product is the stronger form of the same authoring problem. The
client should lint disconnected mandatory components and report which variables, if any,
connect them only through `OPTIONAL`.

### 5. Property-path transport defect

Both of these failed during dereferencing:

- `federation/fio-spatial-facilities-in-state`
- `federation/sawgraph-spatial-hydrology-01`

A direct trace showed the transitive path expansion requesting an object parameter named
`??o`. This is a client/QPF serialization defect, not evidence that the graph is too
large. For a known administrative hierarchy, an author can temporarily expand `+` to the
known one- or two-hop alternatives. The real client-suite fix is a regression test and a
correct native KGF property-path plan; a materialized transitive-closure relation would
also be a useful KGF capability if this pattern is common.

### 6. Bound typed-literal transport defect

`sockg/soc_stock` and its duplicate `sock_stock_for_treatmnent_id` bind an input date and
treatment ID. A trace showed the date being serialized into a fragment URL as
`"1998-04-20"^^http://www.w3.org/2001/XMLSchema#date`, without angle brackets around the
datatype IRI, and the KGF request was rejected. Replacing the `BIND`s with `VALUES` is good
authoring, but the native client must also serialize RDF terms correctly, preferably in
a request body rather than by constructing stock fragment query strings.

### 7. Non-standard functions and a malformed query

These use Ontotext's non-standard `ofn:asDays`, for which this Comunica configuration has
no evaluator:

- `sockg/average_change_soc_stock`
- `sockg/average_soc_stock_0_30cm`
- `sockg/greatest_soc_increase`

If calendar-month buckets are intended, a standard rewrite is:

```sparql
BIND((YEAR(?date) * 12 + MONTH(?date)) AS ?bucket)
```

That is not identical to rounding elapsed days into 30-day bins, so the query author must
confirm the intended calendar semantics. These several-hundred-line analytic queries
also repeat the same large sample join and are better expressed as staged extraction plus
local analytics.

`sockg/avg_soc_stock_by_state` has a dangling semicolon after
`?spv qudt:numericValue ?bulkDensity`. Remove it before performance testing.

### 8. Large SOCKG star joins

`avg_temp_increase`, `biomassCarbohydrate`, and `harvest_fraction` exhausted the 2 GB
heap. `soilBiologicalSample`, `soil_samples`, and `water_sample` timed out with 4,487 to
30,614 requests. These patterns join many properties around a typed sample, then sort or
deduplicate the complete result.

For “show five samples” intent, select five sample IRIs first and hydrate them. For full
exports, use a KGF class-scoped star/column operation or stream the required columns into
a spillable local operator. In particular, the `LIMIT 5` in `soilBiologicalSample` occurs
after `DISTINCT` and `ORDER BY`; it cannot provide an early bound. Also, `?label` is
projected and ordered there but never bound.

`sockg/avg_temp_increase` has an additional semantic issue: the baseline subquery does
not constrain its parameter label to the outer `"air_temp_degc"` value, because that
variable is not projected from the subquery. It can sample a baseline from an unrelated
measurement. A rewrite should use a fixed parameter IRI or literal in both stages.

### 9. Hard-coded external `SERVICE` clauses

Five queries contain dependencies not fully represented by their graph tags:

| Query | Hard-coded dependency |
|---|---|
| `evoweb/protein-group-associated-organisms` | UniProt SPARQL |
| `prokn/protein_disease` | OARD SPARQL |
| `prokn/protein_variant_disease` | OARD SPARQL |
| `prokn/protein_opioid_abuse` | BioHealth SPARQL |
| `prokn/protein_variant_sdoh` | SPOKE-OKN SPARQL |

Three failed directly because the external request failed; one timed out and one happened
to complete. A KGF fragment URL is not a SPARQL `SERVICE` endpoint. For local KGF tests,
remove the `SERVICE` block, configure both datasets as sources, and let the client perform
the join. If UniProt remains external, record it as an explicit network dependency and
test it separately from local KGF behavior.

## Prioritized client-suite work

1. Add preflight lint/explain output for disconnected components, constants hidden in
   filters, variable-predicate namespace filters, blocking `LIMIT`, unbound projections,
   vendor functions, and hard-coded `SERVICE` IRIs.
2. Implement a native KGF source that uses KGF request bodies and advertised binding
   limits. Add regression tests for property-path variables and typed literals.
3. Preserve selective anchors across multiway BGP and `OPTIONAL` planning, and support a
   deliberate IRI-first/late-enrichment execution strategy.
4. Add or propose a pattern-scoped distinct-values/facet service. The service must return
   actual RDF terms, not only distinct counts.
5. Add grouped-count or efficient column-scan support for NASA, NDE, and similar analytic
   queries.
6. Add class-conditioned star statistics if full SPARQL planning remains a goal; global
   predicate cardinalities do not describe SOCKG's typed sample stars.
7. Turn the validated rewrites into paired regression cases that assert both multiset
   equality and request-count ceilings.

## Complete result inventory

| Query | Status | Rows | Requests | Seconds |
|---|---|---:|---:|---:|
| `biobricks-ice/assays-from-invitrodb` | GOOD | 100 | 8 | 0.562 |
| `biobricks-ice/names-of-chemical-entities` | GOOD | 200 | 759 | 1.558 |
| `dreamkg/services-available-weekend` | EMPTY | 0 | 3 | 0.307 |
| `dreamkg/services-in-more-than-one-language` | EMPTY | 0 | 4 | 0.304 |
| `evoweb/protein-group-associated-organisms` | ERROR | — | 316 | 3.307 |
| `federation/articles-about-abdominal-cell-types` | SKIP | — | — | — |
| `federation/fio-spatial-facilities-in-state` | ERROR | — | — | — |
| `federation/list-things-and-their-labels` | TIMEOUT | — | 77 | 30.001 |
| `federation/nde-diseases-mondo-parents` | GOOD | 200 | 884 | 3.234 |
| `federation/nde-study-mondo-xrefs` | GOOD | 1 | 22 | 0.352 |
| `federation/one-hundred-triples` | GOOD | 100 | 41 | 0.704 |
| `federation/sawgraph-hydrology-spatial-04` | HEAVY | 64 | 17,386 | 20.530 |
| `federation/sawgraph-hydrology-spatial_03` | OOM | — | — | — |
| `federation/sawgraph-spatial-hydrology-01` | ERROR | — | — | — |
| `fiokg/fio-NAICS-classification-for-facility` | GOOD | 5 | 4 | 0.325 |
| `fiokg/fio-facilities-by-NAICS-Subsector` | TIMEOUT | — | 4,995 | 30.001 |
| `hydrologykg/sawgraph-hydrology-02` | GOOD | 296 | 22 | 0.445 |
| `hydrologykg/sawgraph-hydrology-04` | TIMEOUT | — | 6,386 | 30.001 |
| `nasa-gesdisc-kg/count-publications-use-each-dataset` | GOOD | 25 | 555 | 3.627 |
| `nasa-gesdisc-kg/datasets-science-keywords` | GOOD | 25 | 152 | 1.161 |
| `nasa-gesdisc-kg/frequent-sciencekeywords-wikidata` | SKIP | — | — | — |
| `nasa-gesdisc-kg/frequent-sciencekeywords` | TIMEOUT | — | 6,105 | 30.002 |
| `nasa-gesdisc-kg/publications-datasets-used` | GOOD | 25 | 3 | 0.510 |
| `nasa-gesdisc-kg/publications-using-dataset-wikidata` | SKIP | — | — | — |
| `nasa-gesdisc-kg/pubs-by-year-title` | GOOD | 100 | 23 | 0.461 |
| `ncipidkg/list-all-hdac1-neighbors` | EMPTY | 0 | 3 | 0.290 |
| `ncipidkg/list-all-labeled-interactions` | TIMEOUT | — | 4,750 | 30.002 |
| `ncipidkg/list-all-labeled-proteins` | GOOD | 2,588 | 69 | 0.655 |
| `nde/dataset-count-by-agent` | HEAVY | 2,208 | 1,254 | 5.619 |
| `nde/nde-influenza-studies` | GOOD | 423 | 664 | 3.217 |
| `nde/nde-resources-by-count` | HEAVY | 8 | 6,582 | 24.218 |
| `nestkg/enriched-systems` | SKIP | — | — | — |
| `nestkg/subsystems` | SKIP | — | — | — |
| `nestkg/systems-for-protein` | SKIP | — | — | — |
| `oard-kg/diseases-associated-with-phenotype` | HEAVY | 100 | 6,600 | 7.530 |
| `oard-kg/oard-ubergraph-concordance` | EMPTY | 0 | 16 | 0.384 |
| `oard-kg/phenotypes-associated-with-disease` | HEAVY | 100 | 3,655 | 4.216 |
| `oard-kg/rank-diseases-given-phenotypes` | TIMEOUT | — | 15,491 | 30.002 |
| `pankgraph/non-acinar-cell-adhesion-regulation` | GOOD | 80 | 808 | 2.257 |
| `prokn/alzheimers_associated_genes` | TIMEOUT | — | 15,380 | 30.010 |
| `prokn/gene_properties_relationships` | GOOD | 461 | 9 | 0.562 |
| `prokn/kinase_inhibition_phosphosites` | TIMEOUT | — | 4,536 | 30.001 |
| `prokn/lincs_kinase_perturbations` | TIMEOUT | — | 13,400 | 30.004 |
| `prokn/list_diseases` | TIMEOUT | — | 5,510 | 30.003 |
| `prokn/protein_disease` | HEAVY | 277 | 6,145 | 26.110 |
| `prokn/protein_kinases` | HEAVY | 3,545 | 1,031 | 3.872 |
| `prokn/protein_opioid_abuse` | ERROR | — | 140 | 1.600 |
| `prokn/protein_properties_relationships` | GOOD | 2,983 | 34 | 0.522 |
| `prokn/protein_variant_disease` | TIMEOUT | — | 6,959 | 30.001 |
| `prokn/protein_variant_sdoh` | ERROR | — | 11 | 1.756 |
| `ruralkg/find_nibrs_justice_topics_to_variables` | GOOD | 100 | 126 | 0.746 |
| `ruralkg/find_nsduh_variables_that_mention_substances` | GOOD | 100 | 73 | 0.652 |
| `ruralkg/list-providers` | GOOD | 100 | 590 | 3.429 |
| `ruralkg/list-substances` | GOOD | 23 | 4 | 0.303 |
| `ruralkg/mental_health_service_categories` | GOOD | 21 | 9 | 0.352 |
| `ruralkg/rural_counties_rucc_7_9` | GOOD | 100 | 244 | 1.351 |
| `ruralkg/telehealth_treatment_providers` | GOOD | 100 | 470 | 2.594 |
| `scales/distinct-judges` | EMPTY | 0 | 3 | 0.300 |
| `scales/scales-ontology-event-labels` | TIMEOUT | — | 5,998 | 30.003 |
| `securechainkg/ffmpeg-dependencies` | GOOD | 100 | 14 | 0.376 |
| `securechainkg/ffmpeg-vulnerabilities` | GOOD | 17 | 6 | 0.322 |
| `sockg/average_change_soc_stock` | ERROR | — | 19 | 0.437 |
| `sockg/average_soc_stock_0_30cm` | ERROR | — | 18 | 0.390 |
| `sockg/avg_soc_stock_by_state` | ERROR | — | — | — |
| `sockg/avg_temp_increase` | OOM | — | — | — |
| `sockg/biomassCarbohydrate` | OOM | — | — | — |
| `sockg/field_location` | GOOD | 18 | 43 | 0.425 |
| `sockg/fields_in_texas` | GOOD | 2 | 15 | 0.359 |
| `sockg/fields_on_sites` | GOOD | 49 | 111 | 0.678 |
| `sockg/greatest_soc_increase` | ERROR | — | 19 | 0.450 |
| `sockg/harvest_fraction` | OOM | — | — | — |
| `sockg/location` | GOOD | 10 | 52 | 2.002 |
| `sockg/soc_stock` | ERROR | — | — | — |
| `sockg/sock_stock_for_treatmnent_id` | ERROR | — | — | — |
| `sockg/soilBiologicalSample` | TIMEOUT | — | 30,614 | 30.288 |
| `sockg/soil_samples` | TIMEOUT | — | 25,160 | 30.404 |
| `sockg/water_sample` | TIMEOUT | — | 4,487 | 30.004 |
| `sockg/who_works_agcros` | GOOD | 66 | 19 | 0.723 |
| `spatialkg/sawgraph-spatial-02` | GOOD | 18 | 6 | 0.405 |
| `spatialkg/sawgraph-spatial-04` | GOOD | 33 | 8 | 0.507 |
| `spoke-genelab/genes-expression-and-methylation-spaceflight-osd48` | EMPTY | 0 | 31 | 0.471 |
| `spoke-genelab/human-ortholog-of-model-gene` | HEAVY | 3 | 3,421 | 13.953 |
| `spoke-genelab/spaceflight-vs-ground-control-60day-deg` | EMPTY | 0 | 2,149 | 8.637 |
| `spoke-okn/compounds-downregulating-alzheimers-genes` | HEAVY | 10 | 14,593 | 17.231 |
| `spoke-okn/compounds-treating-rheumatoid-arthritis` | GOOD | 4 | 176 | 0.581 |
| `spoke-okn/drugs-for-sdoh-associated-diseases` | TIMEOUT | — | 5,620 | 30.004 |
| `ubergraph/abdominal-cell-types` | GOOD | 402 | 323 | 1.486 |
| `ubergraph/adrenal-gland` | GOOD | 35 | 4 | 0.346 |
| `ubergraph/processes-that-output-glucose` | GOOD | 1 | 4 | 0.465 |

## The native source through the command line (2026-09-09)

The corpus was rerun against the public deployment (`https://apps.okn.us/kgf`, 41
graphs) through the `kgf-sparql` command line: native `kgf@` sources with count-first
planning and lazy VoID statistics, a budget of 5,000 requests, 256 MB received, and 30
seconds per query, eight status-code retries, and a receipt for every run. The runner is
[`test/registry-corpus-cli.py`](../test/registry-corpus-cli.py); the results are in
[`test/registry-query-results-cli.json`](../test/registry-query-results-cli.json), in the
shape of the August file so the two compare directly. The registry has grown to 97
queries since August (six `evoweb`, two `spatialkg`); three Wikidata queries are skipped,
so 94 ran.

**Every run ended with a receipt and a classification; none died.** 52 completed, 34
were aborted at a budget (26 at requests, 4 at bytes, 4 at the clock), and 8 failed: three
name external `SERVICE` endpoints the runner does not configure, three call an Ontotext
function, and two hit Comunica's unretried network error (`fetch failed`) after a burst
of parallel connections. Of the 20 August timeouts and heap deaths, two now complete
(`federation/list-things-and-their-labels`, `spoke-okn/drugs-for-sdoh-associated-diseases`),
17 are budget aborts with receipts, and one is the network error. The byte budget did what
it was added for: `fiokg/fio-facilities-by-NAICS-Subsector` and
`scales/scales-ontology-event-labels` each stopped at 268 MB after reading 1,841 and 887
fragment pages of a whole relation, where the earlier public evaluation had lost such runs
to an exhausted 8 GB heap.

**45 queries are non-empty, as in August, but only 34 are the same queries.** Of the 25
non-empty in both runs whose query denotes one bag (no `LIMIT` without `ORDER BY`), 21
return an identical multiset. Two of the four that differ read a different release
(`ncipidkg` 0.0.2 to v0.0.3, `ubergraph` 2026-05-31 to v0.0.2); `nde/dataset-count-by-agent`
concatenates with `GROUP_CONCAT`, whose order is unspecified; `sockg/who_works_agcros`
returns the same 66 rows from the same release number and the difference is unexplained.
Eleven August results are gone, all but two aborted at 5,000 requests, and eleven are new:
the eight added queries, three `nestkg` queries whose graph was unavailable locally, and
the two rescued timeouts.

**The native source spends more requests than brTPF on the same queries because Comunica
plans them differently.** Over the 41 queries complete in both runs the median is 1.9 times
the August request count, and the tail is long: `hydrologykg/sawgraph-hydrology-02` went
from 22 requests to 1,791 for the same 296 rows, `spatialkg/sawgraph-spatial-04` from 8 to
273, `ubergraph/adrenal-gland` from 4 to 79. The physical plans of the hydrology query over
both source types ([`test/explain-query.mjs`](../test/explain-query.mjs)) share their
top-level shape and differ in the inner join. Over brTPF Comunica chose
`multi-smallest-filter-bindings`, which fetched the 296 named flowlines once and pushed
them into the other three patterns in blocks: 15 of its 22 requests carried `values=`.
Over the native source it chose the per-row `bind` join, which asks the source for each of
the 296 × 3 bound patterns separately, and count-first planning answers every one with a
`GET /count` and a `GET /fragment`: 896 counts, 889 pages, no bindings request at all.

The choice is the cost model's, not the data's. Comunica's bind join charges a paged
source nothing per request: when a source reports a `pageSize`, its per-request cost is
taken as zero and each item costs `requestTime / pageSize`; the expected rows are then
multiplied by a 0.0001 selectivity modifier. With the native source's exact cardinalities
and VoID selectivities, 888 round trips are priced at 0.1 iterations and a few
milliseconds, while the filter-bindings actor is charged for materialising 296 rows, so
per-row bind wins by two orders of magnitude. Page size (100, 1,000, or 10,000) and VoID
on or off do not change the choice. The same model fed brTPF's coarser estimates happens
to land on the better plan. This is the round-trip-aware cost model for paged sources
that the client-stack plan already lists as an upstream item: until a bound probe is
charged a request, the native source's exactness works against it. Count-first then
doubles every probe, and where bindings pushdown is chosen each batch is still counted
before it is read (`biobricks-ice/names-of-chemical-entities`: 4,522 requests, half of
them counts, for 200 rows). This is why the eleven August results were lost:
`sockg/fields_on_sites` needed 111 requests on brTPF and exceeded 5,000 here.

Against the client-stack plan's phase A criterion (the same 45 non-empty results, every
former timeout a budget abort with a receipt), the receipt half holds and the result half
does not, for the reason above.

## Reproducing the run

With the KGF server running at `127.0.0.1:8080`:

```sh
python3 test/registry-corpus.py test/registry-query-results.json
```

To exercise one rewrite directly, pass the endpoint(s) after the statistics file:

```sh
node --max-old-space-size=2048 test/run-registry-query.mjs \
  30000 test/void-stats.json \
  http://127.0.0.1:8080/ncipidkg/v/CURRENT/fragment \
  < test/registry-rewrites/ncipid-labeled-interactions-values.rq
```

Replace `CURRENT` with the release advertised by the KGF root document.

The command-line run against the public deployment, with its comparison against the
August results:

```sh
python3 test/registry-corpus-cli.py test/registry-query-results-cli.json
```

Budgets, the server, and the output directory are environment variables documented at
the top of the script; `--compare-only <results.json>` reprints the comparison. One query
directly:

```sh
kgf-sparql -f query.rq --source kgf@https://apps.okn.us/kgf/ncipidkg/v/CURRENT/fragment \
  --out results.srj --receipt receipt.json --max-requests 5000 --max-bytes 256M --timeout 30
```
