# @kgf/actor-rdf-join-selectivity-void

A [Comunica](https://comunica.dev/) join-selectivity actor that estimates join cardinality
from published **VoID** statistics rather than from the syntactic shape of the query.

Works with any TPF, brTPF, or LDF endpoint whose dataset publishes VoID. Nothing in it is
specific to any one publisher.

Comunica already parses VoID and ships an estimator, but wires it only to SPARQL sources.
This actor connects those statistics to the join-selectivity bus, where they change plans.

- Registers at `accuracy: 0.8`, outbidding the shipped `variable-counting` heuristic's `0.5`.
- **Declines** when no join entry resolves to an endpoint with known statistics, so the
  default actor answers and behaviour is unchanged everywhere else.
- Uses VoID only for the *divisor* — the distinct counts. Pattern cardinality keeps coming
  from `hydra:totalItems`, which on an LDF endpoint is exact.
- Makes no HTTP requests of its own.

Most users want [`kgf-sparql`](https://www.npmjs.com/package/kgf-sparql), which is Comunica
with this actor already registered.

## Caveats

The containment estimate assumes containment and uniformity. Skewed data makes it
under-estimate, which biases the planner toward pushdown plans that issue more requests than
predicted; `safetyFactor` (default `1`) is the knob. The estimate is floored at one row.

## License

MIT
