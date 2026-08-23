# kgf-sparql

A [Comunica](https://comunica.dev/) SPARQL engine tuned for
**Knowledge Graph Fragments (KGF)** endpoints.

It is stock `@comunica/query-sparql` with one extra actor registered: a join-selectivity
actor that estimates join sizes from statistics KGF publishes, instead of from the shape of
the query. Everything else — parsing, execution, serialisation, every other source type —
is unchanged upstream Comunica.

## Why

Comunica's shipped selectivity actor is a purely syntactic heuristic (Stocker et al. 2008).
It estimates every join at roughly 0.39 × the cross product regardless of the data. Because
`join-inner(symmetric-hash)` is the only join operator whose cost contains no selectivity
term, it wins by default whenever those estimates are wrong — and it materialises both
sides, which on a paged remote source means enumerating everything.

Measured on one benchmark query against a live KGF server:

| | requests | of those, pushing bindings | wall clock | rows |
|---|---:|---:|---:|---:|
| stock Comunica | 14,928 | 0 | 71.9 s | 10 |
| `kgf-sparql` with statistics | **56** | **28** | **0.3 s** | 10 |

Same answers. The bindings column is the point: stock Comunica never uses brTPF bindings
pushdown on this query, because the bad estimates price the pushdown operator out.

## Install

```bash
npm install kgf-sparql
```

## Use as a library

```js
import { QueryEngine, KEY_KGF_STATISTICS } from 'kgf-sparql';

const EP = 'https://example.org/mykg/v/1.0.0/fragment';
const engine = new QueryEngine();

const bindings = await engine.queryBindings(query, {
  sources: [{ type: 'brtpf', value: EP }],
  // Statistics keyed by endpoint URL. Optional — without them the engine
  // behaves exactly like stock Comunica.
  [KEY_KGF_STATISTICS.name]: {
    [EP]: {
      distinctSubjects: 4509929,
      distinctObjects: 4845730,
      predicates: {
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

`ActorRdfJoinSelectivityKgf` registers at `accuracy: 0.9`, outbidding the shipped actor's
`0.5` on Comunica's accuracy-max mediator. It **declines** (`test()` fails) for any join
where no entry resolves to an endpoint with published statistics; the mediator's
`ignoreFailures` then lets the default actor answer. So it is safe in a mixed federation:
KGF sources get data-driven estimates, everything else is untouched.

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
packages/actor-rdf-join-selectivity-kgf/   the actor (publishable on its own)
packages/kgf-sparql/                       the engine: config + compiled engine + CLI
```

`packages/kgf-sparql/config/config-default.json` imports the stock Comunica config and
*adds* one actor. Nothing upstream is removed or forked.

## License

MIT
