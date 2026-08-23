# @kgf/actor-rdf-join-selectivity-kgf

A Comunica join-selectivity actor that estimates join sizes from statistics published by
[Knowledge Graph Fragments](https://github.com/frink-okn) endpoints, rather than from the
syntactic shape of the query.

Most users want [`kgf-sparql`](https://www.npmjs.com/package/kgf-sparql), which is Comunica
with this actor already registered. Install this package directly only if you are assembling
your own Comunica engine config.

Registers at `accuracy: 0.9` and declines cleanly when no entry resolves to an endpoint with
published statistics, so the shipped `variable-counting` actor remains the fallback.

See the `kgf-sparql` README for the measured effect and the design rationale.

## License

MIT
