# Named graphs: the KGF contract and what the sources must do

Decided 2026-09-15 with the KGF design; the server side is not implemented yet, so a
KGF dataset declares no `graphs` capability today. This note is what the sources in
this repository must do once one does, and what they do now. The contract follows the
union-default convention of QLever, RDF4J/GraphDB, and Blazegraph.

## The contract, from the client's side

1. **A pattern outside any `GRAPH` reads the union** of every graph in the dataset,
   one solution per distinct triple. A KGF dataset's unscoped `/fragment` and `/count`
   are that union already, so this costs the client nothing.
2. **Two reserved graph IRIs, the same in every dataset:** `urn:x-kgf:union` names the
   union and `urn:x-kgf:unnamed` names the unnamed graph, the triples that carried no
   graph in the source. A dataset never has a named graph by either name.
3. **`GRAPH <G>` is `g=<G>`**, the two constants included. `g=<urn:x-kgf:union>` is the
   same as omitting `g`, and both constants are accepted whether or not the dataset
   declares `graphs`.
4. **`GRAPH ?g` is the quad view minus the unnamed graph.** `g=*` asks for one row per
   (triple, graph) membership with a `g` column; rows whose `g` is `urn:x-kgf:unnamed`
   are dropped, because SPARQL's `GRAPH ?g` ranges over named graphs only.
5. **`/count` takes the same `g`**, so every cardinality stays exact: the union count,
   a per-graph count, and the quad-view count (memberships, which can exceed the
   triple count when a triple is in several graphs).

Worked example. A source with five statements, `:a :b :c .`, `:a :b :c :g1`,
`:a :b :d .`, `:x :y :z :g1`, `:x :y :z :g2`, is three distinct triples with
memberships `:a :b :c` in {unnamed, g1}, `:a :b :d` in {unnamed}, `:x :y :z` in {g1, g2}.

| SPARQL | Request | Rows |
|---|---|---|
| `{ ?s ?p ?o }` | no `g` | 3 |
| `GRAPH <g1> { ?s ?p ?o }` | `g=<g1>` | 2 |
| `GRAPH <urn:x-kgf:unnamed> { ?s ?p ?o }` | `g=<urn:x-kgf:unnamed>` | 2 |
| `GRAPH ?g { ?s ?p ?o }` | `g=*`, drop unnamed rows | 3, with g1 twice and g2 once |

## The native source, `QuerySourceKgf`

Its selector shape already advertises a graph variable. What it does with the pattern's
graph term today, in `queryBindings`: a default-graph pattern is answered from the
unscoped operations, and **any other graph term returns empty metadata and no rows**.
That is correct for a dataset without graphs except for the two constants, and it is
the whole gap for a dataset with them.

Required mapping, keyed on the dataset's declared capabilities from `discover()`:

| Pattern graph | Dataset declares `graphs` | Dataset does not |
|---|---|---|
| default graph | no `g` | no `g` |
| `<urn:x-kgf:union>` | no `g` | no `g` |
| `<urn:x-kgf:unnamed>` | `g=<urn:x-kgf:unnamed>` | no `g` (every triple is unnamed) |
| other `NamedNode` G | `g=<G>` on the count and every page | empty, as today |
| `Variable` | `g=*` on the count and every page; skip rows whose `g` is `urn:x-kgf:unnamed`; bind the variable to the `g` term | empty, as today |

Details that follow:

- The `g` column arrives as one more term per row in the JSON, in the same term syntax
  as s, p, and o. Parse it with the existing term reader.
- Cardinality for a `Variable` graph comes from `/count` with `g=*`; after dropping
  unnamed rows it is an upper bound, so mark it `estimate` when the dataset reports a
  non-empty unnamed graph in `GET /graphs`, exact otherwise.
- Bindings pushdown is unchanged: `g` is a request parameter beside the binding body,
  never a column of the binding table, because Comunica's join never binds the graph
  variable of a pushed pattern from another source.
- Keep passing `false` for `unionDefaultGraph` into `quadsToBindings`, as the source
  does today, whatever the context key says: the contract gives the union for bare
  patterns by itself, and honouring the key would keep unnamed-graph rows in
  `GRAPH ?g`. On the brTPF path the key is likewise unnecessary and must stay off.

## The brTPF path through stock Comunica

Nothing to implement. A dataset with graphs publishes the four-mapping QPF form on its
TPF route and declares the union as its default graph in a shape `QuerySourceQpf`
reads, `sd:defaultDataset [ sd:defaultGraph <urn:x-kgf:union> ]`: for a bare pattern
it requests `graph=urn:x-kgf:union` and gets each triple once, tagged with that IRI;
for `GRAPH ?g` it requests with `graph` absent (`qpf`) or `graph=?g` (`brtpf`) and
discards the untagged quads the server sends for unnamed-graph memberships;
`GRAPH <G>` and an explicit `GRAPH <urn:x-kgf:union>` pass through. A brTPF source
needs no configuration change beyond pointing at a graphs-bearing dataset.

## Tests to add when the server lands

- The worked example above, through both the native source and the brTPF source, with
  the row counts in the table.
- `GRAPH <urn:x-kgf:union> { … }` equal to the bare pattern on every dataset, including
  one without graphs, through both the native and the brTPF source.
- A join between a `GRAPH <g1>` pattern and a bare pattern, to exercise `g=` on the
  bindings-restricted path.
