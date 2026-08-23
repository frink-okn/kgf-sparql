# kgf-sparql

A [Comunica](https://comunica.dev/) SPARQL engine tuned for
**Knowledge Graph Fragments (KGF)** endpoints.

It is stock `@comunica/query-sparql` with one extra actor registered: a join-selectivity
actor that estimates join sizes from **published VoID statistics** instead of from the shape
of the query. Everything else — parsing, execution, serialisation, every other source type —
is unchanged upstream Comunica.

**The actor is not KGF-specific.** It works for any TPF, brTPF, or LDF endpoint whose dataset
publishes VoID. KGF is simply an endpoint that publishes good VoID.

## Why

Comunica's shipped selectivity actor is a purely syntactic heuristic (Stocker et al. 2008).
It estimates every join at roughly 0.39 × the cross product regardless of the data. Because
`join-inner(symmetric-hash)` is the only join operator whose cost contains no selectivity
term, it wins by default whenever those estimates are wrong — and it materialises both
sides, which on a paged remote source means enumerating everything.

Measured on one benchmark query against a live KGF server:

| | requests | of those, pushing bindings | wall clock | rows |
|---|---:|---:|---:|---:|
| stock Comunica | 14,928 | 0 | 69.8 s | 10 |
| `kgf-sparql` with VoID | **59** | **31** | **0.3 s** | 10 |

Same answers. The bindings column is the point: stock Comunica never uses brTPF bindings
pushdown on this query, because the bad estimates price the pushdown operator out.

### Across a 60-query corpus, it is a *tail* fix

Measured over all 60 single-KG tasks of the mcp-okn benchmark, both arms back to back:

| | |
|---|---|
| requests | 82,186 → 56,772 (1.45x) |
| per task | **37 unchanged, 5 better, 2 worse** |
| median per-task request ratio | **1.000** |
| wrong answers | **0** |

**99.6% of that saving is one query.** Excluding it, the corpus total is unchanged (1.00x).
The estimator does nothing for plans that were already fine, and rescues the ones that were
catastrophic — including one query that ran out of memory in stock Comunica and completes in
5.9 s with VoID. Two queries got modestly worse; the worst is an aggregate-over-everything
query that gains nothing from pushdown but is flipped to it anyway (see the caveats below).

If your workload is agent-driven, tail risk is usually what matters. If you need broad
throughput, this is not that.

## Install

```bash
npm install kgf-sparql
```

## Use as a library

```js
import { QueryEngine, KEY_VOID_STATISTICS } from 'kgf-sparql';

const EP = 'https://example.org/mykg/v/1.0.0/fragment';
const engine = new QueryEngine();

const bindings = await engine.queryBindings(query, {
  sources: [{ type: 'brtpf', value: EP }],
  // Statistics keyed by endpoint URL. Optional — without them the engine
  // behaves exactly like stock Comunica.
  [KEY_VOID_STATISTICS.name]: {
    [EP]: {
      triples: 27386547,
      distinctSubjects: 4509929,
      distinctObjects: 4845730,
      propertyPartitions: {
        'http://www.w3.org/2000/01/rdf-schema#label': { distinctSubjects: 4314237 },
      },
    },
  },
});
```

## Use as a CLI

```bash
npx kgf-sparql -q 'SELECT * WHERE { ?s ?p ?o } LIMIT 10' \
  brtpf@https://example.org/mykg/v/1.0.0/fragment
```

## How the actor decides

`ActorRdfJoinSelectivityVoid` registers at `accuracy: 0.8`, outbidding the shipped actor's
`0.5` on Comunica's accuracy-max mediator. It **declines** (`test()` fails) for any join
where no entry resolves to an endpoint with published VoID; the mediator's
`ignoreFailures` then lets the default actor answer. So it is safe in a mixed federation:
instrumented sources get data-driven estimates, everything else is untouched.

Sources are identified by `IQuerySource.referenceValue` — the endpoint URL. Comunica query
sources carry no type field, and the concrete class is a wrapper stack
(`QuerySourceSkolemized` → `QuerySourceHypermedia` → `QuerySourceQpf`), so URL identity is
the only sound discriminator.

The estimate is the containment formula. Because Comunica multiplies the input
cardinalities itself and asks this actor only for the ratio, the returned value is
`1 / max(d_v(A), d_v(B))` for each shared variable `v`.

Statistics fall through tiers: per-predicate distinct counts, then `rdf:type` reasoning
(a subject is typed at most once, so distinct == cardinality), then the dataset-wide
ceiling, then the pattern cardinality. Per-predicate counts are the tier that matters;
the measurement above was obtained with only the dataset-wide ceiling.

The actor makes **no HTTP requests of its own** — cardinality comes from
`hydra:totalItems`, already memoized by Comunica.

## Development

```bash
npm install --ignore-scripts   # link workspaces without running prepare
npm run build                  # tsc -> componentsjs-generator -> comunica-compile-config
```

`--ignore-scripts` matters on a *fresh clone*: `prepare` compiles the Components.js config,
which needs the workspace symlinks that the same install is still creating.

## Layout

```
packages/actor-rdf-join-selectivity-void/  the actor - generic, publishable on its own
packages/kgf-sparql/                       the engine: config + compiled engine + CLI
```

`packages/kgf-sparql/config/config-default.json` imports the stock Comunica config and
*adds* one actor. Nothing upstream is removed or forked.

## License

MIT

## What the estimate can and cannot know

This is **more information, not uniformly better decisions.** The containment estimate
assumes the smaller value set is contained in the larger, and that values are uniform.
Real data breaks both:

- **Disjoint value sets** make it over-estimate. Still far better than the syntactic
  heuristic, which over-estimates by orders of magnitude more.
- **Skew** makes it *under*-estimate, and that is the dangerous direction: an
  under-estimate biases the planner toward bind/pushdown plans that then issue many more
  requests than predicted. `safetyFactor` (default `1`) multiplies the estimate; raise it
  to buy insurance. The estimate is also floored at one row.
- **Untrustworthy VoID.** Statistics are taken on faith. For a third-party endpoint,
  consider a higher `safetyFactor` or simply not registering it.

**Calibration.** Comunica's join actors carry hand-tuned `selectivityModifier` constants
(`0.0001` for `multi-smallest-filter-bindings`) that exist to compensate for the syntactic
heuristic's over-estimation. Supplying accurate selectivity leaves those corrections
double-counted, biasing toward pushdown. That is usually what you want against a paged remote
source, but it is a calibration artifact, not a judgement — and it is the measured cause of
the corpus's worst regression, on a `GROUP BY`/`COUNT` query that must read everything and so
gains nothing from pushdown.

Setting `selectivityModifier` to `1` removes that regression exactly, but destroys two of the
wins. A sweep across `0.0001 / 0.01 / 0.1 / 1` moved the total by under 6%, against a baseline
3.2x worse than any of them. **The modifier is second-order; supplying VoID at all is the
first-order effect.** Prefer `safetyFactor` on this actor as the tuning lever, since it does
not perturb plans for sources without statistics.
