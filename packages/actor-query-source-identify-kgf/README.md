# @kgf/actor-query-source-identify-kgf

A native KGF JSON triple source for Comunica 5. Most users should use the
[`kgf-sparql`](https://www.npmjs.com/package/kgf-sparql) engine, which registers
this actor alongside Comunica's standard source types.

Configure sources as `{ type: 'kgf', value: datasetOrVersionedFragmentUrl }`.
Dataset `/latest/fragment` aliases are also accepted and pinned to the current
release through the dataset descriptor, without fetching a fragment page.
The actor identifies sources without network access. Query planning then discovers
service limits and requests `/count`; fragment pages remain lazy. Filter bindings
use QUERY, with POST fallback on HTTP 405/501, and follow opaque cursors.

Pages default to 1,000 rows. Bindings default to the advertised `max_bindings`
(200 if absent), subject to the request-byte limit; Comunica may supply smaller
batches. Exported context keys `KEY_KGF_PAGE_SIZE`, `KEY_KGF_BINDINGS_SIZE`, and
`KEY_KGF_HTTP_METHOD` override these choices. `KEY_KGF_VOID_STATISTICS` disables
the lazy VoID provider when set to false. The provider reads only relevant schema
partitions during join planning and memoizes them per query.

The source implements Comunica's `filterBindings` semantics, removing repeated
matches from overlapping input rows while leaving SPARQL join multiplicities to
Comunica. KGF's union is exposed as the default graph; named graphs are empty.
Graph-scoped operations and quoted triple terms are not implemented.

To register the actor in another Components.js configuration, provide
`mediatorHttp` and `mediatorMergeBindingsContext`, and put it before the generic
hypermedia identification actor via `beforeActors`. See the engine's
`config/config-default.json` for a complete configuration.

MIT
