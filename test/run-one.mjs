// Run one SPARQL query against one KGF endpoint, with or without VoID statistics.
// usage: node run-one.mjs <endpoint> <timeoutMs> <statsPath|none>   ; query on stdin
import { QueryEngine, KEY_VOID_STATISTICS } from 'kgf-sparql';
import fs from 'node:fs';
import crypto from 'node:crypto';

const [ ep, timeoutMs, statsPath ] = process.argv.slice(2);
const query = await new Promise((resolve) => {
  let b = '';
  process.stdin.on('data', c => b += c);
  process.stdin.on('end', () => resolve(b));
});

let requests = 0;
let withValues = 0;
const rawFetch = globalThis.fetch;
globalThis.fetch = (i, o) => {
  requests++;
  const u = typeof i === 'string' ? i : i.url;
  if (/values=/.test(u)) {
    withValues++;
  }
  return rawFetch(i, o);
};

const ctx = {
  sources: [{ type: 'brtpf', value: ep }],
  '@comunica/bus-http:http-retry-count': 8,
  // Leave 429, 503, and 504 to Comunica's native Retry-After-aware paths.
  '@comunica/bus-http:http-retry-status-codes': [ 502 ],
  '@comunica/bus-http:http-retry-delay-fallback': 250,
};
if (statsPath && statsPath !== 'none') {
  ctx[KEY_VOID_STATISTICS.name] = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
}

const t0 = Date.now();
function emit(o) {
  const secs = Number(((Date.now() - t0) / 1000).toFixed(2));
  process.stdout.write(JSON.stringify({ ...o, requests, withValues, secs }));
}

const timer = setTimeout(() => {
  emit({ ok: false, err: 'timeout' });
  process.exit(0);
}, Number(timeoutMs));

try {
  const bs = await new QueryEngine().queryBindings(query, ctx);
  const rows = [];
  let n = 0;
  bs.on('data', (b) => {
    n++;
    if (n <= 200000) {
      rows.push([ ...b ].map(([ k, v ]) => k.value + '=' + v.value).sort().join(''));
    }
  });
  await new Promise((resolve, reject) => bs.on('end', resolve).on('error', reject));
  clearTimeout(timer);
  rows.sort();
  const h = crypto.createHash('sha1');
  for (const r of rows) {
    h.update(r);
    h.update('');
  }
  emit({ ok: true, n, hash: h.digest('hex').slice(0, 16) });
} catch (e) {
  clearTimeout(timer);
  emit({ ok: false, err: String((e && e.message) || e).slice(0, 200) });
}
process.exit(0);
