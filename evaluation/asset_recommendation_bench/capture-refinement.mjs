/** Read-only evidence snapshot for the real desktop continuation; preserves prior closure artifacts. */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {codebuddyApi as api} from '../cache_history_bench/codebuddy-live-api.mjs';
const root=resolve(import.meta.dirname,'../..'),out=join(root,'output/refinement-live-20260910');
const run=JSON.parse(readFileSync(join(root,'output/closure-live-20260910/run.json'),'utf8'));
mkdirSync(out,{recursive:true});
const save=(name,value)=>writeFileSync(join(out,name+'.json'),JSON.stringify(value,null,2),{mode:0o600});
const audit=name=>JSON.parse(execFileSync('docker',['exec','tdai-proxy','node','-e',
  String.raw`const fs=require('fs'),p='/data/asset-bench-audit/${name}.jsonl';console.log(JSON.stringify(fs.existsSync(p)?fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(r=>r.run_id==='closure-0910'):[]))`],{encoding:'utf8',maxBuffer:100*1024*1024}));
const allRequests=audit('requests'),requests=allRequests.filter(r=>r.phase==='prepared'),ids=new Set(requests.map(r=>r.request_id));
const responses=audit('responses').filter(r=>ids.has(r.request_id)),deliveries=audit('deliveries').filter(r=>ids.has(r.request_id));
save('requests',requests);save('responses',responses);save('deliveries',deliveries);
const prefixComparisons=requests.slice(1).map((current,i)=>{
  const previous=requests[i];let unchanged=0;
  while(unchanged<previous.messages.length && JSON.stringify(previous.messages[unchanged])===JSON.stringify(current.messages[unchanged]))unchanged++;
  return {previous_request:previous.request_id,current_request:current.request_id,previous_messages:previous.messages.length,
    current_messages:current.messages.length,unchanged_leading_messages:unchanged,entire_previous_input_preserved:unchanged===previous.messages.length};
});save('prefix-comparisons',prefixComparisons);
const effect=await api('asset/quality/task-receipt',{team_id:run.team_id,task_id:run.task.task_id});save('effect-receipt',effect);
const task=await api('task/get',{task_id:run.task.task_id});save('task-current',task);
const token=readFileSync(join(root,'output/quality-deployment/orchestrator/service.token'),'utf8').trim();
for(const [name,path]of [['turns','/v2/turns'],['native-receipt','/v2/sessions/receipt']]){
  const response=await fetch(`http://127.0.0.1:8765${path}?session_id=${run.session_id}`,{headers:{authorization:`Bearer ${token}`}});
  if(!response.ok)throw new Error(`snapshot ${name} failed ${response.status}`);save(name,await response.json());
}
const utilities=[];for(const item of effect.items) utilities.push({asset_id:item.asset_id,revision_id:item.revision_id,context:item.context,
  result:await api('asset/quality/utility',{team_id:run.team_id,asset_id:item.asset_id,revision_id:item.revision_id,context:item.context})});
save('utility',utilities);
const containers=JSON.parse(execFileSync('docker',['inspect','tdai-proxy','tdai-memory-core','tdai-memory-hub','tdai-quality-orchestrator'],{encoding:'utf8'}))
  .map(c=>({name:c.Name,image:c.Config.Image,running:c.State.Running,health:c.State.Health?.Status}));save('deployment',containers);
const summary={at:new Date().toISOString(),task:run.task.task_id,session:run.session_id,workspace:run.workspace,
  prepared:requests.length,accepted:deliveries.length,responses:responses.length,task_status:task.status,effects:effect.summary,
  prior_requests_unchanged:allRequests.filter(r=>r.phase!=='prepared').length,containers};save('summary',summary);console.log(JSON.stringify(summary));
