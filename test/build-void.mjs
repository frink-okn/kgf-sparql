// Build a VoID statistics registry from KGF /schema, for every KG the corpus uses.
// usage: KGF_ROOT=https://apps.okn.us/kgf VOID_OUT=void-stats-public.json node build-void.mjs kg1 kg2 ...
import fs from 'node:fs';
const ROOT = (process.env.KGF_ROOT ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const origin = new URL(ROOT).origin;
const kgs = process.argv.slice(2);
const root = await (await fetch(`${ROOT}/`)).json();
const byId = Object.fromEntries(root.datasets.map(d => [d.id, d]));
const out = {};
for (const kg of kgs) {
  const d = byId[kg];
  if (!d) { console.error(`no such dataset: ${kg}`); continue; }
  // Root links are server-relative paths; resolve them against the service origin.
  const link = name => new URL(d.links[name], origin).href;
  const schema = link('schema');
  const ds = await (await fetch(`${schema}?view=design`)).json();
  // Page to exhaustion: a capped registry silently leaves the planner on the
  // dataset-wide ceiling for every predicate past the first page.
  const items = [];
  for (let cursor = null, page = 0; page < 50; page++) {
    const q = new URLSearchParams({ children: 'properties', view: 'design', limit: '500' });
    if (cursor) q.set('cursor', cursor);
    const r = await (await fetch(`${schema}?${q}`)).json();
    items.push(...(r.items ?? []));
    cursor = r.next;
    if (!cursor) break;
  }
  const c = ds.node?.counts ?? {};
  const propertyPartitions = {};
  for (const item of items) {
    if (item.term?.type === 'iri') {
      propertyPartitions[item.term.value] = {
        triples: item.counts?.triples,
        distinctSubjects: item.counts?.distinct_subjects,
        distinctObjects: item.counts?.distinct_objects,
      };
    }
  }
  out[link('fragment')] = {
    triples: c.triples,
    distinctSubjects: c.distinct_subjects,
    distinctObjects: c.distinct_objects,
    propertyPartitions,
  };
  console.error(`${kg}@${d.current}: triples=${c.triples?.toLocaleString()} dS=${c.distinct_subjects?.toLocaleString()} dO=${c.distinct_objects?.toLocaleString()} predicates=${Object.keys(propertyPartitions).length} withDistinct=${Object.values(propertyPartitions).filter(p => p.distinctSubjects !== undefined).length}`);
}
fs.writeFileSync(process.env.VOID_OUT ?? 'void-stats.json', JSON.stringify(out, null, 1));
