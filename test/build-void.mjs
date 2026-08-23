// Build a VoID statistics registry from KGF /schema, for every KG the corpus uses.
import fs from 'node:fs';
const ROOT = 'http://127.0.0.1:8080';
const kgs = process.argv.slice(2);
const root = await (await fetch(`${ROOT}/`)).json();
const ver = Object.fromEntries(root.datasets.map(d => [d.id, d.current]));
const out = {};
for (const kg of kgs) {
  if (!ver[kg]) { console.error(`no such dataset: ${kg}`); continue; }
  const base = `${ROOT}/${kg}/v/${ver[kg]}`;
  const ds = await (await fetch(`${base}/schema?view=design`)).json();
  const props = await (await fetch(`${base}/schema?children=properties&view=design`)).json();
  const c = ds.node?.counts ?? {};
  const propertyPartitions = {};
  for (const item of props.items ?? []) {
    if (item.term?.type === 'iri') {
      propertyPartitions[item.term.value] = { triples: item.counts?.triples };
    }
  }
  out[`${base}/fragment`] = {
    triples: c.triples,
    distinctSubjects: c.distinct_subjects,
    distinctObjects: c.distinct_objects,
    propertyPartitions,
  };
  console.error(`${kg}: triples=${c.triples?.toLocaleString()} dS=${c.distinct_subjects?.toLocaleString()} dO=${c.distinct_objects?.toLocaleString()} predicates=${Object.keys(propertyPartitions).length}`);
}
fs.writeFileSync(process.env.VOID_OUT ?? 'void-stats.json', JSON.stringify(out, null, 1));
