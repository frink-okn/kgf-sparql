// Execute one registry SPARQL query against one or more KGF brTPF sources.
// Usage: node run-registry-query.mjs <timeoutMs> <statsPath|none> <endpoint...>
// Query text is read from stdin. Exactly one JSON result is written to stdout.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { QueryEngine, KEY_VOID_STATISTICS } from 'kgf-sparql';

const [ timeoutArg = '30000', statsPath = 'none', ...endpoints ] = process.argv.slice(2);
const timeoutMs = Number(timeoutArg);
const query = fs.readFileSync(0, 'utf8');

let requests = 0;
let requestsWithValues = 0;
let responseBytes = 0;
const statuses = {};
const rawFetch = globalThis.fetch;
globalThis.fetch = async(input, init) => {
  requests++;
  const url = typeof input === 'string' ? input : input.url;
  if (/[?&]values=/.test(url)) {
    requestsWithValues++;
  }
  const response = await rawFetch(input, init);
  statuses[response.status] = (statuses[response.status] ?? 0) + 1;
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length)) {
    responseBytes += length;
  }
  return response;
};

const context = {
  sources: endpoints.map(value => ({ type: 'brtpf', value })),
  '@comunica/bus-http:http-retry-count': 8,
  // Comunica handles 429, 503, and 504 natively, including Retry-After.
  // Only force retry for 502, which has no built-in retry path.
  '@comunica/bus-http:http-retry-status-codes': [ 502 ],
  '@comunica/bus-http:http-retry-delay-fallback': 250,
};
if (statsPath !== 'none') {
  context[KEY_VOID_STATISTICS.name] = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
}

const started = Date.now();
let emitted = false;
const emit = output => {
  if (emitted) {
    return;
  }
  emitted = true;
  process.stdout.write(JSON.stringify({
    ...output,
    requests,
    requestsWithValues,
    responseBytes,
    statuses,
    seconds: Number(((Date.now() - started) / 1000).toFixed(3)),
    rssMb: Number((process.memoryUsage().rss / 1_048_576).toFixed(1)),
  }));
};

const timer = setTimeout(() => {
  emit({ ok: false, error: 'timeout' });
  process.exit(0);
}, timeoutMs);

const MASK_64 = (1n << 64n) - 1n;
let digestSum = 0n;
let digestXor = 0n;
let rows = 0;
const samples = [];

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
  if (samples.length < 3) {
    samples.push(value.slice(0, 500));
  }
  const digest = crypto.createHash('sha256').update(value).digest();
  const n = digest.readBigUInt64BE(0);
  digestSum = (digestSum + n) & MASK_64;
  digestXor ^= n;
};

try {
  if (endpoints.length === 0) {
    throw new Error('No KGF endpoints were supplied');
  }
  const result = await new QueryEngine().query(query, context);
  switch (result.resultType) {
    case 'bindings': {
      const stream = await result.execute();
      stream.on('data', binding => {
        const row = [ ...binding ]
          .map(([ variable, term ]) => `${variable.value}=${termString(term)}`)
          .sort()
          .join('\u0001');
        addRow(row);
      });
      await new Promise((resolve, reject) => stream.on('end', resolve).on('error', reject));
      break;
    }
    case 'quads': {
      const stream = await result.execute();
      stream.on('data', quad => addRow([
        termString(quad.subject),
        termString(quad.predicate),
        termString(quad.object),
        termString(quad.graph),
      ].join(' ')));
      await new Promise((resolve, reject) => stream.on('end', resolve).on('error', reject));
      break;
    }
    case 'boolean': {
      const value = await result.execute();
      addRow(String(value));
      rows = value ? 1 : 0;
      break;
    }
    case 'void': {
      await result.execute();
      break;
    }
    default:
      throw new Error(`Unsupported result type: ${result.resultType}`);
  }
  clearTimeout(timer);
  emit({
    ok: true,
    resultType: result.resultType,
    rows,
    multisetHash: `${digestSum.toString(16).padStart(16, '0')}:${digestXor.toString(16).padStart(16, '0')}`,
    samples,
  });
} catch (error) {
  clearTimeout(timer);
  emit({ ok: false, error: String(error?.message ?? error).slice(0, 500) });
}
process.exit(0);
