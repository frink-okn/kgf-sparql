# @kgf/actor-http-throttle

A [Comunica](https://comunica.dev/) HTTP actor that paces the requests to each host, and
retries the requests a host refuses as too many. It runs the same in Node and in a browser.

A Comunica plan can put hundreds of requests in flight at once, and over HTTP/2 nothing
below it caps them: one connection carries any number. The public KGF server refused about
650 of one run's requests at once with 429, and QLever's Wikidata endpoint refuses clients
that ask too often, with 429 and no `Retry-After`. Comunica's own pacing does not help. Its
retry actor waits a fixed delay unless the server sends `Retry-After`, so retries arrive as
fast as the refusals; its rate limiter slows a whole host after any failure, a timeout
included. Two SPARQL endpoints on the KGF server's host timed out on their service
descriptions, every KGF request on that host then waited 1 to 3 seconds, and three registry
queries made 12 to 19 requests in 30 seconds. With this actor they make 5,000.

## Pacing

Each host has a queue. A request starts when the host has fewer requests in flight than its
limit, and no sooner after the previous start than the host's interval allows. It holds its
place until its response headers arrive; the body is read outside the queue.

- `KEY_HTTP_IN_FLIGHT` in the query context caps requests in flight for every host
  (the actor's `inFlight`, 32 in `kgf-sparql`, when it is not set).
- `KEY_HTTP_HOST_LIMITS` gives hosts their own `{ inFlight, perSecond }`, keyed by `host`
  (`example.org:8080`) or else `hostname`. A key of `*.` and a domain is a queue the hosts
  in that domain share: `*.wikidata.org` caps `query.wikidata.org` and
  `query-scholarly.wikidata.org` together. A request waits in its host's queue and starts
  only when its host and each such group can all start it then, so a host's own limits hold
  within its group's: a rate for `query.wikidata.org` does not take it out of a cap on
  `*.wikidata.org`, and a cap on the group that holds the host's requests back does not let
  them all start at once when it has room, past the host's rate. A group starts its hosts'
  requests in the order they arrived: one host with requests always waiting does not keep
  the group's places from another host's request that has waited longer.
- Queries whose contexts give a host other limits each have a queue of their own, so each
  query's limits hold for its requests. A rate spaces the requests given it, counted from the
  last of them, so another query's faster rate does not hold them back; a rate also outlives
  the queue, for the next query given it. The host's queues start their requests in the order
  they arrived, as a group's hosts do.
- The actor's `hosts` are limits of the same form that hold unless the context overrides
  them, field by field. `kgf-sparql` starts at most one request a second to QLever's hosts
  (`qlever.dev`, `qlever.cs.uni-freiburg.de`), about the rate its Wikidata endpoint was
  seen to accept from one client. QLever publishes no limit, and the refusals that would
  teach the actor the rate cost the first requests of every run.

```js
import { KEY_HTTP_HOST_LIMITS, QueryEngine } from 'kgf-sparql';

await new QueryEngine().queryBindings(query, {
  sources,
  [KEY_HTTP_HOST_LIMITS.name]: { 'qlever.dev': { inFlight: 1, perSecond: 1 } },
});
```

## Refusals

A 429 or 503, or a 405 with `Retry-After` as DBpedia sends, is a refusal. It teaches the
host and each group it is in.

- With `Retry-After`, in seconds (a fraction allowed) or as an HTTP date, the host starts
  nothing until then, and nothing else changes: the server said when to come back, as
  KGF's admission gate does with `Retry-After: 1`. The pause lasts no longer than the
  context's `httpRetryDelayLimit`: a request asked to wait past it gives up, and the host's
  others wait no longer either.
- Without it, the host's interval between starts doubles, from 250 ms up to 10 s, and every
  answer that is not a refusal takes a tenth off it, so the host settles near the rate it
  accepts. Only requests started since the last change count: the requests of one burst are
  refused together, and each doubling the interval again took QLever to 10 s within seconds.
  A refusal teaches before the refused request gives up its place, so the request started
  in its place goes at the new pace.
- A timeout or a network failure changes nothing.
- Invalidating the HTTP cache (`engine.invalidateHttpCache()`, for a URL or for all)
  forgets the pause and the interval, as it clears Comunica's retry actor's delays.

A refused request is retried through its host's queue, ahead of requests that arrived after
it, up to `httpRetryCount` times, or the actor's `retries` (5) when the context sets no count.
Comunica's retry actor is told to stand aside, since its retries would bypass the pacing or
multiply this actor's, and this actor keeps its other duties: with `httpRetryCount` set, a
504 or a status in `httpRetryStatusCodes` is retried after `httpRetryDelayFallback`. When
retries run out the last response is returned as it is, not a bare "Request failed", so the
caller reports its status. A request whose body is a stream is sent once; a `Request` whose
own body is sent is sent a copy of it each attempt. A `Request`'s own signal aborts it while it
waits, as the init's does.

## User agent

Under Node, a request without a `User-Agent` header is sent with the actor's `userAgent`
in place of Comunica's generic one. Wikidata's query service asks clients to name
themselves and a contact, and UniProt turns Comunica's default away. `kgf-sparql` sends
`kgf-sparql/<version> (+https://github.com/frink-okn/kgf-sparql)`. A request that names its
own keeps it, and a browser sends its own, so the actor sets none there.

## Attempts

`KEY_HTTP_ATTEMPT_LISTENER` in a request's context is told when each attempt leaves its
host's queue (`sent`), when its response headers arrive or it fails (`settled`), and when
its response is let go for another attempt (`retrying`), so a caller can time a request by
the server alone: `kgf-sparql`'s bounded SPARQL source times its COUNT queries this way.

## Configuration

`kgf-sparql` installs the actor with an override of Comunica's
`urn:comunica:default:http/actors#limit-rate`, ahead of `#retry` and `#proxy`, with the
`hosts` and `userAgent` above. Queues and learned intervals belong to the actor, so one
engine shares them across its queries, as a page that keeps one engine does. Queries that
give a host the same limits share its queue; a query that gives it others waits in a queue
of its own, so that each query's limits hold for its requests, and a queue no request holds
is let go. What refusals taught, and when the host last started a request, is shared either
way, as the server sees all of them.

Most users want [`kgf-sparql`](https://www.npmjs.com/package/kgf-sparql), where the command
line's `--max-in-flight` and `--max-rate` set these keys.

## License

MIT
