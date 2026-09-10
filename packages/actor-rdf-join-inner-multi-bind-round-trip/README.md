# @kgf/actor-rdf-join-inner-multi-bind-round-trip

[Comunica](https://comunica.dev/)'s bind join, with each bound probe against a paged
source charged one request.

The stock `ActorRdfJoinMultiBind` prices a probe against a remaining join entry as that
entry's initial request cost plus a per-item cost. Comunica takes a paged source's initial
cost as zero: by the time an entry's metadata is known, its first page has been fetched.
That holds for the entry as planned. It does not hold for the bound probes the join will
send, each of which is a new request. Against a source that reports exact cardinalities
and large pages, the stock formula priced 888 probes on one registry query at a few
milliseconds, and per-row binding beat pushing the bindings in blocks by two orders of
magnitude: 1,791 requests instead of 22 for the same 296 rows.

This actor extends the stock one and adds the missing term to `requestTime`: for every
remaining entry that reports a `pageSize`, one `requestTime` per probe. A non-paged entry
is already charged that way by the stock formula and is left alone. Every other
coefficient, default, and refusal is the stock actor's; the class overrides one method.

It replaces the stock actor in place through a Components.js `Override` in the engine's
config, keeping the actor's identifier so the other join actors' ordering still refers to
it. Nothing here is specific to KGF; any paged source with honest `requestTime` metadata
benefits.
