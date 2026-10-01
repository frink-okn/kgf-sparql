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

Most users want [`kgf-sparql`](https://www.npmjs.com/package/kgf-sparql), which is Comunica
with this actor already registered.

## License

MIT
