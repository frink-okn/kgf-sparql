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
- Uses VoID only for the *divisor* — the distinct counts. Pattern cardinality comes
  from source metadata: `hydra:totalItems` for LDF, or `/count` for native KGF.
- Accepts explicit registries through `KEY_VOID_STATISTICS` and static configuration.
  These take precedence over a source's lazy statistics provider.
- Can invoke `metadata[VOID_STATISTICS_PROVIDER]()` while testing a pairwise join
  with shared variables. Native KGF uses this to load relevant `/schema` partitions
  on demand; no full VoID download or config preparation is required. Sources should
  memoize providers. Missing statistics or provider failures leave the default
  estimator available. The actor itself contains no HTTP transport.

Most users want [`kgf-sparql`](https://www.npmjs.com/package/kgf-sparql), which is Comunica
with this actor already registered.

## Caveats

The containment estimate assumes containment and uniformity. Skewed data makes it
under-estimate, which biases the planner toward pushdown plans that issue more requests than
predicted; `safetyFactor` (default `1`) is the knob. The estimate is floored at one row.

## License

MIT
