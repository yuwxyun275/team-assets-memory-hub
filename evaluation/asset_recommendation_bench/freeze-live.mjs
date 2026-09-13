/** Freeze the actual reviewed pool before any desktop task starts. Oracle stays evaluator-only. */
import {readFileSync,writeFileSync,existsSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const directory=resolve('output/asset-recommendation-live-20260908');
const target=join(directory,'frozen-pool.json');
if(existsSync(target))throw Error('Pool already frozen; do not replace an experimental baseline');
const run=JSON.parse(readFileSync(join(directory,'run.json')));
if(run.assets.length!==400||run.assets.some(a=>!['published','rejected','needs_evidence'].includes(a.state)))throw Error('Quality batch not terminal');
const digest=v=>createHash('sha256').update(v).digest('hex');
const labels=JSON.parse(readFileSync(join(run.source,'evaluator-only/asset-annotations.json')));
const by_type={},challenges={total:0,published:0,rejected:0,needs_evidence:0};
for(const a of run.assets){
  by_type[a.asset_type]??={};by_type[a.asset_type][a.state]=(by_type[a.asset_type][a.state]??0)+1;
  if(labels[a.source_asset_id].expected_quality==='reject'){challenges.total++;challenges[a.state]++;}
}
const reports=Object.fromEntries(readdirSync(join(directory,'quality')).sort().map(f=>[f,digest(readFileSync(join(directory,'quality',f)))]));
const frozen={at:new Date().toISOString(),team_id:run.team.team_id,dataset_sha256:run.dataset_sha256,assets:run.assets,reports,by_type,challenges,
  provenance:'Synthetic author-defined challenge labels; no independent expert certification. Eligible-for-review does not mean guaranteed high quality.',
  policy:run.policy,quality_provider_usage:'Not captured by this runner; not included in dialogue token totals.',
  ranking:'Published corpus fixed; historical utility neutralized for all pilot requests; asynchronous feedback retained separately.'};
frozen.sha256=digest(JSON.stringify(frozen));writeFileSync(target,JSON.stringify(frozen,null,2));
console.log(JSON.stringify({sha256:frozen.sha256,by_type,challenges}));
