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
  (`example.org:8080`) or `hostname`.

```js
import { KEY_HTTP_HOST_LIMITS, QueryEngine } from 'kgf-sparql';

await new QueryEngine().queryBindings(query, {
  sources,
  [KEY_HTTP_HOST_LIMITS.name]: { 'qlever.dev': { inFlight: 1, perSecond: 1 } },
});
```

## Refusals

A 429 or 503, or a 405 with `Retry-After` as DBpedia sends, is a refusal.

- With `Retry-After`, the host starts nothing until then, and nothing else changes: the
  server said when to come back, as KGF's admission gate does with `Retry-After: 1`.
- Without it, the host's interval between starts doubles, from 250 ms up to 10 s, and every
  answer that is not a refusal takes a tenth off it, so the host settles near the rate it
  accepts. Only requests started since the last change count: the requests of one burst are
  refused together, and each doubling the interval again took QLever to 10 s within seconds.
- A timeout or a network failure changes nothing.

A refused request is retried through its host's queue, ahead of requests not yet sent, up
to `httpRetryCount` times, or the actor's `retries` (5) when the context sets no count.
Comunica's retry actor is told to stand aside, since its retries would bypass the pacing or
multiply this actor's, and this actor keeps its other duties: with `httpRetryCount` set, a
504 or a status in `httpRetryStatusCodes` is retried after `httpRetryDelayFallback`. When
retries run out the last response is returned as it is, not a bare "Request failed", so the
caller reports its status. A request whose body is a stream is sent once.

`KEY_HTTP_ATTEMPT_LISTENER` in a request's context is told when each attempt leaves its
host's queue (`sent`) and when its response headers arrive or it fails (`settled`), so a
caller can time a request by the server alone: `kgf-sparql`'s bounded SPARQL source times
its COUNT queries this way.

## Configuration

`kgf-sparql` installs the actor with an override of Comunica's
`urn:comunica:default:http/actors#limit-rate`, ahead of `#retry` and `#proxy`. Queues and
learned intervals belong to the actor, so one engine shares them across its queries, as a
page that keeps one engine does.

Most users want [`kgf-sparql`](https://www.npmjs.com/package/kgf-sparql), where the command
line's `--max-in-flight` and `--max-rate` set these keys.

## License

MIT
