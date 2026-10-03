# @kgf/actor-rdf-join-selectivity-bound

A [Comunica](https://comunica.dev/) join-selectivity actor that caps any other estimate
with an upper bound on the join's size.

An entry whose variables all occur in the other entries cannot make the join larger than
the join of those others: each of their rows fixes every variable of the entry, and a set
of solutions matches a fixed assignment at most once. `?cell rdfs:subClassOf cell:`
(31,721 rows) joined with `?cell part_of: abdomen:` (838 rows) therefore has at most 838
rows. The shipped `variable-counting` heuristic, which looks only at pattern shapes, puts
it at about 7.4 million. In a federated query that estimate made a 307,784-row subquery
look like the smaller side, and the plan bound the large side into the small one.

- Registers at `accuracy: 0.9`, above the VoID actor's `0.8` and the heuristic's `0.5`.
- Asks the selectivity bus again with itself excluded, through a context key that makes
  its own test fail, and returns the smaller of that answer and the bound. Whatever
  estimator would otherwise answer keeps answering; this actor only stops it from
  exceeding what the join can produce.
- Removes filter entries greedily, largest first, while each one's variables stay covered
  by the entries that remain. A union of `k` branches multiplies the bound by `k`;
  operations whose multiplicity it cannot tell (VALUES, extensions, subqueries) are never
  removed.

## Limits

The bus asks for a ratio of the product of the input cardinalities. When an input's
cardinality is unknown (infinite), no ratio expresses a finite bound, and the delegate's
answer is returned unchanged. Variables that may be unbound disable the bound. The bound
assumes each source answers a triple pattern with a set.

Only exact sizes bound the join. An estimate may be a lower bound, as a SPARQL count that
reached its cap is (`kgf-sparql` counts to 1,000,001 and reports more as an estimate of
that), and so is an incomplete KGF count: two such patterns on `?x` would otherwise bound
a join of tens of millions at a million. Entries with estimates are removed first, and
when one has to remain there is no bound.

An exact size is one a source counted: the entry's operation is a source's, or a union of
sources' operations, and no join computed it. Comunica labels a join's result exact whenever
its inputs are, though its size is their product times an estimated selectivity, which may
be far below the truth; bounding by it could cap a join of 40,000 rows at 50. Such an entry
counts as estimated.

When no other selectivity actor answers, the bound is taken against the product of the
input sizes. One that fails while answering fails the estimate, as it would without this
actor.

Most users want [`kgf-sparql`](https://www.npmjs.com/package/kgf-sparql), which is Comunica
with this actor already registered.

## License

MIT
