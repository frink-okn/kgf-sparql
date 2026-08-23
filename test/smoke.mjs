import { QueryEngine, KEY_KGF_STATISTICS } from 'kgf-sparql';
import fs from 'node:fs';

const EP = 'http://127.0.0.1:8080/biobricks-ice/v/0.0.3/fragment';
const q = fs.readFileSync(new URL('./q_chem.rq', import.meta.url), 'utf8');
const withStats = process.argv[2] === 'stats';

let n = 0, vals = 0;
const rf = globalThis.fetch;
globalThis.fetch = (i, o) => { n++; const u = typeof i === 'string' ? i : i.url; if (/values=/.test(u)) vals++; return rf(i, o); };

const ctx = { sources: [{ type: 'brtpf', value: EP }] };
if (withStats) {
  ctx[KEY_KGF_STATISTICS.name] = { [EP]: { distinctSubjects: 4509929, distinctObjects: 4845730 } };
}

const engine = new QueryEngine();
const t0 = Date.now();
const bs = await engine.queryBindings(q, ctx);
let rows = 0; bs.on('data', () => rows++);
await new Promise((r, j) => bs.on('end', r).on('error', j));
console.log(JSON.stringify({ statistics: withStats, rows, requests: n, withValues: vals, seconds: +((Date.now()-t0)/1000).toFixed(1) }));
process.exit(0);
