// Run one SPARQL query against KGF endpoint(s) under one configuration "arm".
// usage: node run-arm.mjs [--source qpf|brtpf] [--stats path|none] [--config path|default]
//                         [--page-limit N] [--page-limit-mode all|ramp] [--accept mime] [--timeout ms]
//                         <endpoint...>   ; query on stdin
// Writes exactly one JSON object to stdout.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { QueryEngine, QueryEngineFactory, KEY_VOID_STATISTICS } from 'kgf-sparql';

const opts = { source: 'brtpf', stats: 'none', config: 'default', pageLimit: 0, pageLimitMode: 'all', accept: '', timeout: 60000 };
const endpoints = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--source') opts.source = argv[++i];
  else if (a === '--stats') opts.stats = argv[++i];
  else if (a === '--config') opts.config = argv[++i];
  else if (a === '--page-limit') opts.pageLimit = Number(argv[++i]);
  // 'all': every fragment request; 'ramp': only continuation (cursor=) and bindings
  // (values=) requests, so the first page of a pattern stays at the server default.
  else if (a === '--page-limit-mode') opts.pageLimitMode = argv[++i];
  else if (a === '--timeout') opts.timeout = Number(argv[++i]);
  // Override the Accept header on fragment requests (e.g. 'text/turtle'). Comunica's
  // default ranks JSON-LD above Turtle, and KGF serves neither N-Quads nor TriG.
  else if (a === '--accept') opts.accept = argv[++i];
  else endpoints.push(a);
}
const query = fs.readFileSync(0, 'utf8');

let requests = 0;
let requestsWithValues = 0;
const statuses = {};
const rawFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  let url = typeof input === 'string' ? input : input.url;
  // KGF-specific lever: ask for the largest page the server allows. A KGF-aware
  // source actor would do exactly this from the published caps; the server keeps
  // the limit on its hydra:next links, so injecting it on the first request is enough.
  const eligible = opts.pageLimitMode === 'ramp' ? /[?&](cursor|values)=/.test(url) : true;
  if (opts.pageLimit > 0 && eligible && /\/fragment(\?|$)/.test(url) && !/[?&]limit=/.test(url)) {
    url += (url.includes('?') ? '&' : '?') + `limit=${opts.pageLimit}`;
    input = typeof input === 'string' ? url : new Request(url, input);
  }
  if (opts.accept && /\/fragment(\?|$)/.test(url)) {
    const headers = new Headers(init?.headers ?? (typeof input === 'string' ? undefined : input.headers));
    headers.set('accept', opts.accept);
    init = { ...init, headers };
  }
  requests++;
  if (/[?&]values=/.test(url)) requestsWithValues++;
  const response = await rawFetch(input, init);
  statuses[response.status] = (statuses[response.status] ?? 0) + 1;
  return response;
};

const context = {
  sources: endpoints.map(value => ({ type: opts.source, value })),
  '@comunica/bus-http:http-retry-count': 8,
  // Comunica handles 429, 503, and 504 natively, including Retry-After.
  '@comunica/bus-http:http-retry-status-codes': [ 502 ],
  '@comunica/bus-http:http-retry-delay-fallback': 250,
};
if (opts.stats !== 'none') {
  context[KEY_VOID_STATISTICS.name] = JSON.parse(fs.readFileSync(opts.stats, 'utf8'));
}

let started = Date.now();
let engineMs = 0;
let emitted = false;
const emit = output => {
  if (emitted) return;
  emitted = true;
  process.stdout.write(JSON.stringify({
    ...output,
    requests,
    requestsWithValues,
    statuses,
    seconds: Number(((Date.now() - started) / 1000).toFixed(3)),
    engineMs,
    rssMb: Number((process.memoryUsage().rss / 1_048_576).toFixed(1)),
  }));
};
const timer = setTimeout(() => { emit({ ok: false, error: 'timeout' }); process.exit(0); }, opts.timeout);

const MASK_64 = (1n << 64n) - 1n;
let digestSum = 0n;
let digestXor = 0n;
let rows = 0;
const termString = term => {
  switch (term.termType) {
    case 'NamedNode': return `<${term.value}>`;
    case 'BlankNode': return `_:${term.value}`;
    case 'Literal': {
      const language = term.language ? `@${term.language}` : '';
      const datatype = !term.language && term.datatype?.value ? `^^<${term.datatype.value}>` : '';
      return `${JSON.stringify(term.value)}${language}${datatype}`;
    }
    case 'DefaultGraph': return '';
    default: return `${term.termType}:${term.value}`;
  }
};
const addRow = value => {
  rows++;
  const digest = crypto.createHash('sha256').update(value).digest();
  const n = digest.readBigUInt64BE(0);
  digestSum = (digestSum + n) & MASK_64;
  digestXor ^= n;
};

try {
  const engine = opts.config === 'default' ?
    new QueryEngine() :
    await new QueryEngineFactory().create({ configPath: opts.config });
  // Engine construction (Components.js config loading for custom configs, ~1.7 s)
  // is a process-startup cost, not query time; restart the clock after it.
  engineMs = Date.now() - started;
  started = Date.now();
  const result = await engine.query(query, context);
  switch (result.resultType) {
    case 'bindings': {
      const stream = await result.execute();
      stream.on('data', binding => addRow([ ...binding ]
        .map(([ v, t ]) => `${v.value}=${termString(t)}`).sort().join('|')));
      await new Promise((resolve, reject) => stream.on('end', resolve).on('error', reject));
      break;
    }
    case 'quads': {
      const stream = await result.execute();
      stream.on('data', q => addRow([ q.subject, q.predicate, q.object, q.graph ].map(termString).join(' ')));
      await new Promise((resolve, reject) => stream.on('end', resolve).on('error', reject));
      break;
    }
    case 'boolean': {
      addRow(String(await result.execute()));
      break;
    }
    default: throw new Error(`Unsupported result type: ${result.resultType}`);
  }
  clearTimeout(timer);
  emit({ ok: true, rows, hash: `${digestSum.toString(16).padStart(16, '0')}:${digestXor.toString(16).padStart(16, '0')}` });
} catch (error) {
  clearTimeout(timer);
  emit({ ok: false, error: String(error?.message ?? error).slice(0, 300) });
}
process.exit(0);
