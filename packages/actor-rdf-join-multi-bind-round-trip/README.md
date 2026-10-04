# @frink-okn/actor-rdf-join-multi-bind-round-trip

[Comunica](https://comunica.dev/)'s inner and `OPTIONAL` bind joins, with each bound probe
charged the requests it sends.

The stock `ActorRdfJoinMultiBind` prices a probe against a remaining join entry as that
entry's initial request cost plus a per-item cost. Comunica takes a paged source's initial
cost as zero: by the time an entry's metadata is known, its first page has been fetched.
That holds for the entry as planned. It does not hold for the bound probes the join will
send, each of which is a new request. Against a source that reports exact cardinalities
and large pages, the stock formula priced 888 probes on one query at a few
milliseconds, and per-row binding beat pushing the bindings in blocks by two orders of
magnitude: 1,791 requests instead of 22 for the same 296 rows.

This actor extends the stock one and adds the missing term to `requestTime`: for every
remaining entry that reports a `pageSize`, one `requestTime` per probe. A non-paged entry
is already charged that way by the stock formula and is left alone. Every other
coefficient, default, and refusal is the stock actor's; the class overrides one method.

`ActorRdfJoinOptionalBindRoundTrip` does the same for `ActorRdfJoinOptionalBind`, whose
formula has the same shape and the same zero: on one query its two `OPTIONAL` patterns
cost 19,537 per-row probes, a count and a page each.

Both formulas also price at zero a probe into an entry the engine computes, such as the
result of a join or a nested `OPTIONAL` group, which reports neither a page size nor a
request time. Each such probe re-plans and re-runs every pattern in the entry. With
Comunica's cap on `OPTIONAL` size estimates (comunica#1846), one query joined such a group
per row at a cost of nothing, and read the same four predicates whole 780 times each before
it ran out of time. Both actors charge such a probe one request per triple pattern or
property path in the entry, at the time per pattern that the join's other entries report.
When no entry reports a request time they use `patternRequestTime` (100 ms by default).

Both replace the stock actors in place through Components.js `Override`s in the engine's
config, keeping the actors' identifiers so the other join actors' ordering still refers to
them. Nothing here is specific to KGF; any paged source with honest `requestTime` metadata
benefits.

Most users want [`@frink-okn/kgf-sparql`](https://www.npmjs.com/package/@frink-okn/kgf-sparql), which is Comunica
with these actors already registered.

## License

MIT
