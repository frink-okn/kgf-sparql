import { QueryEngineFactory, KEY_VOID_STATISTICS } from 'kgf-sparql';
import fs from 'node:fs';
const [cfg, ep, statsPath] = process.argv.slice(2);
const q = fs.readFileSync(0, 'utf8');
let n=0, vals=0; const rf=globalThis.fetch;
globalThis.fetch=(i,o)=>{n++; const u=typeof i==='string'?i:i.url; if(/values=/.test(u))vals++; return rf(i,o);};
const ctx={sources:[{type:'brtpf',value:ep}],
  '@comunica/bus-http:http-retry-count':8,
  '@comunica/bus-http:http-retry-status-codes':[429,502,503,504],
  '@comunica/bus-http:http-retry-delay-fallback':250};
if (statsPath && statsPath!=='none') ctx[KEY_VOID_STATISTICS.name]=JSON.parse(fs.readFileSync(statsPath,'utf8'));
const engine = await new QueryEngineFactory().create({ configPath: cfg });
const t0=Date.now();
const bs=await engine.queryBindings(q,ctx);
let rows=0; bs.on('data',()=>rows++);
await new Promise((r,j)=>bs.on('end',r).on('error',j));
console.log(JSON.stringify({rows,requests:n,withValues:vals,secs:+((Date.now()-t0)/1000).toFixed(1)}));
process.exit(0);
