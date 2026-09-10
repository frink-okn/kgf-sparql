// Print the physical plan Comunica chose for a query, with the requests it cost.
// usage: node test/explain-query.mjs [--stock] query.rq kind@url [kind@url ...]
// Each source spec is explained separately, so plans over different source types compare.
// --stock uses Comunica's own engine (@comunica/query-sparql) instead of this one, as a control.
import fs from 'node:fs';
import { QueryEngine as StockQueryEngine } from '@comunica/query-sparql';
import { QueryEngine, parseSource } from 'kgf-sparql';

const stock = process.argv[2] === '--stock';
const [ queryPath, ...specs ] = process.argv.slice(stock ? 3 : 2);
if (!queryPath || specs.length === 0) {
  console.error('usage: node test/explain-query.mjs query.rq kind@url [kind@url ...]');
  process.exit(2);
}
const query = fs.readFileSync(queryPath, 'utf8');

function lines(node, depth = 0, out = []) {
  if (!node || typeof node !== 'object') return out;
  const tag = [ node.logical, node.physical ].filter(Boolean).join('/');
  const bits = [];
  if (node.cardinalities) bits.push(`entries=${node.cardinalities.map(c => `${c.type.slice(0, 3)}:${Math.round(c.value)}`).join(',')}`);
  if (node.bindOperationCardinality) bits.push(`bind=${node.bindOperationCardinality.type.slice(0, 3)}:${Math.round(node.bindOperationCardinality.value)}`);
  if (node.joinCoefficients) bits.push(`cost=${Object.entries(node.joinCoefficients).map(([ k, v ]) => `${k.slice(0, 4)}:${Math.round(v * 10) / 10}`).join(',')}`);
  if (node.cardinality && typeof node.cardinality === 'object') bits.push(`card=${node.cardinality.type.slice(0, 3)}:${Math.round(node.cardinality.value)}`);
  if (node.cardinalityReal !== undefined) bits.push(`real=${node.cardinalityReal}`);
  if (node.pattern) bits.push(String(node.pattern).slice(0, 90));
  out.push(`${'  '.repeat(depth)}${tag || '?'} ${bits.join(' ')}`);
  for (const child of node.children ?? []) lines(child, depth + 1, out);
  for (const child of node.childrenCompact ?? []) lines(child.firstOccurrence ?? child, depth + 1, out);
  return out;
}

for (const spec of specs) {
  const { kind, url } = parseSource(spec);
  let requests = 0;
  let pushed = 0;
  const counting = async(input, init = {}) => {
    requests++;
    const target = typeof input === 'string' ? input : input.url;
    if (/[?&]values=/u.test(target) || (typeof init.body === 'string' && init.body.includes('"bindings"'))) pushed++;
    return fetch(input, init);
  };
  const started = Date.now();
  const engine = stock ? new StockQueryEngine() : new QueryEngine();
  const result = await engine.explain(query, { sources: [{ type: kind, value: url }], fetch: counting }, 'physical-json');
  console.log(`=== ${stock ? 'stock Comunica' : 'kgf-sparql'}, ${spec}: ${requests} requests, ${pushed} carrying bindings, ${((Date.now() - started) / 1000).toFixed(1)} s ===`);
  console.log(lines(result.data).join('\n'));
}
