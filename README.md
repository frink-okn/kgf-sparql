# kgf-sparql

A [Comunica](https://comunica.dev/) SPARQL engine with a native
[Knowledge Graph Fragments (KGF)](https://apps.okn.us/kgf/) triple source, join actors for
federated queries over KGF and SPARQL endpoints, per-host request pacing, and a command line
that runs a query under budgets and accounts for every request it made. It runs in Node and
in a browser.

```js
import { QueryEngine } from '@frink-okn/kgf-sparql';

const bindings = await new QueryEngine().queryBindings(`
  SELECT ?s ?label WHERE {
    VALUES ?s { <http://identifiers.org/cas/100-00-5> }
    ?s <http://www.w3.org/2000/01/rdf-schema#label> ?label
  }
`, {
  sources: [{ type: 'kgf', value: 'https://apps.okn.us/kgf/biobricks-tox21' }],
});
```

```bash
kgf-sparql -f query.rq \
  --source kgf@https://apps.okn.us/kgf/phaseskg/v/v0.0.1/fragment \
  --out results.srj --receipt receipt.json \
  --max-requests 5000 --max-bytes 256M --timeout 120
```

The engine's documentation, for the library, the command line, its budgets and receipt,
and the context keys, is in [packages/kgf-sparql](packages/kgf-sparql/README.md).

## Packages

| package | |
|---|---|
| [`@frink-okn/kgf-sparql`](packages/kgf-sparql/) | the engine: configuration, library, browser entry, and command line |
| [`@frink-okn/actor-query-source-identify-kgf`](packages/actor-query-source-identify-kgf/) | the native KGF JSON source: counts before pages, bindings over HTTP `QUERY`, opaque cursors, lazy VoID |
| [`@frink-okn/actor-rdf-join-selectivity-void`](packages/actor-rdf-join-selectivity-void/) | join selectivity from VoID statistics, for any source that publishes them |
| [`@frink-okn/actor-rdf-join-selectivity-bound`](packages/actor-rdf-join-selectivity-bound/) | an upper bound on any join-size estimate |
| [`@frink-okn/actor-rdf-join-multi-bind-block`](packages/actor-rdf-join-multi-bind-block/) | block bind joins, as FedX's bound joins do: inner, through every entry that takes bindings, and `OPTIONAL` |
| [`@frink-okn/actor-rdf-join-multi-bind-round-trip`](packages/actor-rdf-join-multi-bind-round-trip/) | Comunica's inner and `OPTIONAL` bind joins, charging a request per probe and leaving to the block joins what they bind whole |
| [`@frink-okn/actor-http-throttle`](packages/actor-http-throttle/) | per-host pacing, and retries of refused requests |
| [`@frink-okn/actor-query-source-identify-hypermedia-sparql-bounded`](packages/actor-query-source-identify-hypermedia-sparql-bounded/) | Comunica's SPARQL endpoint source with bounded, server-timed COUNTs |

Each actor replaces or joins Comunica's own through the engine's Components.js
configuration, and none of them needs a fork of Comunica. Most users want the engine;
the actors are published separately for other configurations.

## Named graphs

A bare pattern reads a KGF dataset's union, and `GRAPH` reaches its named graphs and
its unnamed graph through two reserved IRIs. This holds for the native `kgf` source
and for a stock `brtpf` source pointed at a dataset's TPF route, with no engine
configuration: do not set Comunica's `unionDefaultGraph` context key for either. The
contract the native source must implement, and what it does today, is in
[docs/graph-semantics.md](docs/graph-semantics.md).

## Development

```bash
npm install --ignore-scripts
npm test
npm run test:live
```

`--ignore-scripts` allows npm to link the workspaces before compiling their
Components.js configurations. `npm test` builds all packages and runs deterministic
protocol, SPARQL regression, and command-line tests against a mock KGF server, the
latter through both the in-process entry point and the executable. `test:live` is an
opt-in, bounded run against the public KGF server; it checks count-first QUERY bindings
and pagination, then runs the command line on a small graph and asserts a complete
receipt with request ids and a budget abort. Set `KGF_ROOT` and `KGF_DATASET` to test
another deployment. `npm run clean` removes everything the build generates.

## License

MIT
