# @kgf/actor-rdf-join-inner-multi-bind-block

A [Comunica](https://comunica.dev/) bind join that sends the smallest entry's rows in
blocks through every other entry that can take bindings, one after another, as FedX's
bound joins do.

Comunica binds in blocks only when every entry but the smallest lives on one source that
accepts `joinBindings` (`multi-bind-source`), or when a join has a pattern on a source that
accepts `filterBindings` (`multi-smallest-filter-bindings`). A federated join rarely meets
either condition. The fallback binds one row at a time, and against a SPARQL endpoint each
row also costs a COUNT. On one query over Ubergraph (KGF) and QLever's Wikidata endpoint
that plan produced no results in four minutes; with this actor and
`@kgf/actor-rdf-join-selectivity-bound` the same query returns all 3,332 rows in 56
requests.

## The plan

Starting from the smallest entry of known size, the actor repeatedly picks, among the
entries it can probe, the one sharing the most variables with what is bound so far, then
the smallest. An entry whose size is unknown, as a COUNT that failed or timed out leaves it,
can still be probed; the actor used to refuse when such an entry sorted first, and a
per-row bind join took the join over. The entries it can probe are:

- an operation on one source that accepts `filterBindings` (KGF, brTPF) or `joinBindings`
  (a SPARQL endpoint, through `VALUES`);
- a union whose branches are each such an operation, as source assignment produces for a
  pattern more than one source can answer; every branch is probed;
- a join no source was given, whose inputs are each of the above, as Comunica's
  `group-sources` leaves behind. Each input is probed and joined in turn, never to each
  other.

Each block of the smallest entry then runs through those entries in that order. Every
probe carries the values of the variables it shares with the rows joined so far, projected
and deduplicated, so either kind of source returns the entry's own rows that match some
row; those are joined locally, and a block that empties stops. Entries that cannot be
probed, or are smaller than the bound entry, go to the join mediator with the result.

Binding every entry in one pass needs no estimate of an intermediate result. An earlier
version bound one entry at a time and handed the rest back to the planner, whose
compounded estimate for one registry query's intermediate (10^21 rows, for a few dozen)
made it read a label pattern whole: 455 pages and 106 MB in 19 s. In one pass the query
takes 32 requests and 1.3 s, where Comunica's per-row bind join takes 1,615 and 5.2 s.

## Execution

- `blockSize` (default 256) rows per block and values per probe request.
- Rows move through the steps in chunks of 1,024 as they are joined. A probe's results are
  streamed past an index of the rows that sent them rather than collected first, and the
  event loop gets a turn between chunks. An earlier version held each probe's results and
  each step's joined rows whole and joined them in one synchronous pass; a probe of a few
  experiments with millions of statements each then held the event loop for minutes, past
  the run's timeout and its SIGTERM handler, at 9.4 GB. Streamed, the same query stops at
  its request budget on time.
- Each step collects the rows reaching it until they carry `blockSize` distinct values, or
  4,096 rows, before sending, so its requests stay full however finely the step before it
  hands rows on; up to four such batches per step and block are out at once. Sending each
  arriving piece on its own took one registry query from 287 requests to 1,545, the same
  bytes in requests a seventh the size.
- `blocksInFlight` (default 4; `kgf-sparql` sets 16) blocks are probed at once, and joined
  rows leave as soon as they exist. Once `blocksInFlight` times `blockSize` joined rows
  wait unread, the blocks wait too, so a slow reader holds the probes back. Releasing blocks in order let one slow block hold the
  rest back; probing only the block at the head of the queue held another query to about
  two requests in flight. Destroying the stream, as a `LIMIT` above it does, starts no
  further block.
- `requestsInFlight` (default 8; `kgf-sparql` sets 16) probe requests are sent at once
  across the join. A step whose rows fan out to many values needs many requests, and
  sending them all together put hundreds in flight against a server that runs 8 bindings
  requests at a time and answered the overflow with 429.
- A value an earlier block already sent is answered from a per-join cache, or from the
  request still carrying it, rather than sent again; the cache keeps up to
  `probeCacheRows` result rows (default 100,000). Without it a value recurring across
  blocks was fetched once per block. An answer is kept only while its request returns no
  more than 64 rows per value it could carry; a block waiting on a larger one sends for it
  itself.

## Cost

The coefficients are the stock bind join's formula over the probed entries, so the two
compare on equal terms, except that a probe request is charged once per block instead of
once per row, and one block of rows is held. Nothing counts as blocking: Comunica's join
mediator penalises blocking joins under a `LIMIT`, and this one only waits for a block. The
actor is registered ahead of the stock join actors, because the mediator keeps the first
candidate when its cost is `NaN`, which happens whenever a COUNT has timed out.

## Limits

- A SPARQL endpoint answers each probe request with a COUNT first, and a native KGF source
  counts before its first page, because both fetch metadata eagerly.
- Comunica's SPARQL source reports no `requestTime`, so when every cost is finite the stock
  bind join prices its per-row requests at nothing and can win. `kgf-sparql`'s
  [bounded SPARQL source](../actor-query-source-identify-hypermedia-sparql-bounded/) reports
  the time its requests take.
- Entries with possibly unbound variables are left to other actors.

Most users want [`kgf-sparql`](https://www.npmjs.com/package/kgf-sparql), which is Comunica
with this actor already registered.

## License

MIT
