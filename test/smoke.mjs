import { QueryEngine, KEY_VOID_STATISTICS } from 'kgf-sparql';
import fs from 'node:fs';

const EP = 'http://127.0.0.1:8080/biobricks-ice/v/0.0.3/fragment';
const q = fs.readFileSync(new URL('./q_chem.rq', import.meta.url), 'utf8');
const mode = process.argv[2] ?? 'none';

let n = 0, vals = 0;
const rf = globalThis.fetch;
globalThis.fetch = (i, o) => { n++; const u = typeof i === 'string' ? i : i.url; if (/values=/.test(u)) vals++; return rf(i, o); };

// Exactly what KGF's /void publishes today: dataset-level distinct counts,
// property partitions carrying only void:triples.
const datasetLevel = {
  triples: 27386547,
  distinctSubjects: 4509929,
  distinctObjects: 4845730,
  propertyPartitions: {
    'http://www.w3.org/2000/01/rdf-schema#label': { triples: 4314237 },
    'http://edamontology.org/has_identifier': { triples: 413086 },
  },
};

const ctx = { sources: [{ type: 'brtpf', value: EP }] };
if (mode !== 'none') ctx[KEY_VOID_STATISTICS.name] = { [EP]: datasetLevel };

const engine = new QueryEngine();
const t0 = Date.now();
const bs = await engine.queryBindings(q, ctx);
let rows = 0; bs.on('data', () => rows++);
await new Promise((r, j) => bs.on('end', r).on('error', j));
console.log(JSON.stringify({ mode, rows, requests: n, withValues: vals, seconds: +((Date.now()-t0)/1000).toFixed(1) }));
process.exit(0);
