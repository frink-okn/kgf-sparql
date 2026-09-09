// Dump full result rows as JSON, for comparing two arms field by field.
// usage: node dump-rows.mjs <endpoint> <timeoutMs> <statsPath|none> ; query on stdin
import { QueryEngine, KEY_VOID_STATISTICS } from 'kgf-sparql';
import fs from 'node:fs';

const [ ep, timeoutMs, statsPath ] = process.argv.slice(2);
const query = await new Promise((resolve) => {
  let b = '';
  process.stdin.on('data', c => b += c);
  process.stdin.on('end', () => resolve(b));
});

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

setTimeout(() => process.exit(3), Number(timeoutMs));

const bs = await new QueryEngine().queryBindings(query, ctx);
const rows = [];
bs.on('data', b => rows.push(Object.fromEntries([ ...b ].map(([ k, v ]) => [ k.value, v.value ]))));
await new Promise((resolve, reject) => bs.on('end', resolve).on('error', reject));
process.stdout.write(JSON.stringify(rows));
process.exit(0);
