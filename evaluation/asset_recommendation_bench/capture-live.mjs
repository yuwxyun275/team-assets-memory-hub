/** Read-only capture of real Proxy traffic; never replays or invokes a model. */
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
const directory=resolve('output/asset-recommendation-live-20260908'),out=join(directory,'proxy-audit');mkdirSync(out,{recursive:true});
execFileSync('docker',['cp','tdai-proxy:/data/asset-bench-audit/.',out],{stdio:'pipe'});
const rows=name=>existsSync(join(out,name))?readFileSync(join(out,name),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const requests=rows('requests.jsonl'),responses=rows('responses.jsonl');
const tasks=JSON.parse(readFileSync(join(directory,'tasks.json')));
const summaries=[];
const token=readFileSync(resolve('output/quality-deployment/orchestrator/service.token'),'utf8').trim();
for(const task of tasks.tasks){
  const req=requests.filter(r=>r.run_id===task.run_id),res=responses.filter(r=>r.run_id===task.run_id);
  const byId=new Map(res.map(r=>[r.request_id,r]));
  if(byId.size!==res.length)throw Error('Duplicate full request IDs');
  const usages=res.filter(r=>r.usage&&typeof r.usage.prompt_tokens==='number');
  const sum=key=>usages.every(r=>typeof r.usage[key]==='number')?usages.reduce((n,r)=>n+r.usage[key],0):null;
  const prompt=sum('prompt_tokens'),hit=sum('prompt_cache_hit_tokens');
  const summary={run_id:task.run_id,arm:task.arm,source_task:task.source_task,session_ids:[...new Set(req.map(r=>r.session_id))],
    requests:req.length,responses:res.length,usage_records:usages.length,requests_without_response:req.filter(r=>!byId.has(r.request_id)).length,
    prompt_tokens:prompt,completion_tokens:sum('completion_tokens'),cache_hit_tokens:hit,cache_miss_tokens:sum('prompt_cache_miss_tokens'),
    weighted_cache_hit_rate:prompt&&hit!==null?hit/prompt:null,card_counts:req.map(r=>r.card_count)};
  summaries.push(summary);
  for(const session of summary.session_ids){
    for(const [name,path] of [['turns','/v2/turns'],['receipt','/v2/sessions/receipt']]){
      const r=await fetch(`http://127.0.0.1:8765${path}?session_id=${encodeURIComponent(session)}`,{headers:{authorization:`Bearer ${token}`}});
      writeFileSync(join(out,`${task.run_id}-${name}.json`),JSON.stringify({status:r.status,body:await r.json()},null,2));
    }
  }
}
writeFileSync(join(directory,'live-summary.json'),JSON.stringify({at:new Date().toISOString(),method:'Real CodeBuddy desktop -> Proxy -> configured DeepSeek. No replay. Main upstream usage only; background evaluations excluded.',summaries},null,2));
console.log(JSON.stringify(summaries));
