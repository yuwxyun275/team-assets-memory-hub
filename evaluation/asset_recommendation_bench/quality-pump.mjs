import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'../..');
const until=Date.now()+2*60*60*1000;
while(Date.now()<until){
  for(const command of ['queue','approve'])console.log(execFileSync(process.execPath,['evaluation/asset_recommendation_bench/live.mjs',command],{cwd:root,encoding:'utf8',timeout:180000}).trim());
  const run=JSON.parse(readFileSync(resolve(root,'output/asset-recommendation-live-20260908/run.json'),'utf8'));
  if(run.assets.length===400&&run.assets.every(a=>['published','rejected','needs_evidence','failed'].includes(a.state))){console.log('quality batch finished');process.exit(0);}
  await new Promise(r=>setTimeout(r,20000));
}
throw Error('Quality batch time budget exhausted; progress saved, no assumed passes.');
