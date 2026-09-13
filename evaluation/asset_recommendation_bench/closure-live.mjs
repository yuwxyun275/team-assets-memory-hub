/** One new real desktop closure check; preserves the earlier six runs. */
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,cpSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {codebuddyApi as api,actor} from '../cache_history_bench/codebuddy-live-api.mjs';
const root=resolve(import.meta.dirname,'../..'),out=join(root,'output/closure-live-20260910');
mkdirSync(out,{recursive:true});
const statePath=join(out,'run.json'),old=JSON.parse(readFileSync(join(root,'output/asset-recommendation-live-20260908/run.json')));
let state=existsSync(statePath)?JSON.parse(readFileSync(statePath)):null;
const save=()=>writeFileSync(statePath,JSON.stringify(state,null,2));
const hash=b=>createHash('sha256').update(b).digest('hex');
const mode=process.argv[2];
if(mode==='prepare') {
  if(!state){
    const workspace=mkdtempSync('/Users/xiaomo/Projects/agent/asset-closure-');
    const source=join(old.source,'client/tasks/task-01-flags');
    cpSync(join(source,'workspace'),workspace,{recursive:true,errorOnExist:true});
    for(const args of [['init','--quiet'],['add','.'],['-c','user.name=Closure Check','-c','user.email=closure@example.invalid','commit','--quiet','-m','Independent closure baseline']])execFileSync('git',args,{cwd:workspace});
    const spec=JSON.parse(readFileSync(join(source,'task.json')));
    state={at:new Date().toISOString(),workspace,source,team_id:old.team.team_id,agent_id:old.agents[0].agent_id,actor,spec,baseline_commit:execFileSync('git',['rev-parse','HEAD'],{cwd:workspace,encoding:'utf8'}).trim()};save();
  }
  if(!state.task){
    state.task=await api('task/create',{team_id:state.team_id,creator_user_id:actor,title:'真实闭环验收 0910：Redis 故障安全回退',description:`${state.spec.description}\n仓库：${state.spec.repository}；版本：${state.spec.version}；目标文件：service.py。\n范围：${state.spec.scope}。\n仅修改当前工作区，自行重现并新增回归测试，不读取工作区外的评测材料，不提交或部署。`,source_type:'other',source_url:state.workspace,linked_agents:[{agent_id:state.agent_id,role_in_task:'implementer'}],metadata_json:JSON.stringify({closure_check:true,repository:state.spec.repository,version:state.spec.version,target_paths:['service.py']})});save();
  }
  const previous=JSON.parse(execFileSync('docker',['exec','tdai-proxy','cat','/data/asset-bench-manifest.json'],{encoding:'utf8'}));
  if(!existsSync(join(out,'manifest.before.json')))writeFileSync(join(out,'manifest.before.json'),JSON.stringify(previous,null,2));
  if(!previous.runs.some(r=>r.task_id===state.task.task_id))previous.runs.push({run_id:'closure-0910',arm:'history_append_cards',task_id:state.task.task_id,workspace:state.workspace,repository:state.spec.repository,version:state.spec.version,learn_utility:true});
  writeFileSync(join(out,'manifest.active.json'),JSON.stringify(previous,null,2));
  // The old manifest is a read-only bind mount and historical trial evidence.
  // Deployment mounts this new manifest; never overwrite the old one.
  console.log(JSON.stringify({workspace:state.workspace,task_id:state.task.task_id,team:state.team_id,title:state.task.title}));
} else if(mode==='capture') {
  const data=execFileSync('docker',['exec','tdai-proxy','cat','/data/asset-bench-audit/requests.jsonl'],{encoding:'utf8',maxBuffer:200*1024*1024});
  const req=data.trim().split('\n').filter(Boolean).map(JSON.parse).filter(r=>r.run_id==='closure-0910');
  const res=execFileSync('docker',['exec','tdai-proxy','cat','/data/asset-bench-audit/responses.jsonl'],{encoding:'utf8',maxBuffer:200*1024*1024}).trim().split('\n').filter(Boolean).map(JSON.parse).filter(r=>r.run_id==='closure-0910');
  writeFileSync(join(out,'requests.json'),JSON.stringify(req,null,2));writeFileSync(join(out,'responses.json'),JSON.stringify(res,null,2));
  state.session_id=req.at(-1)?.session_id;save();
  const receipt=await api('asset/quality/task-receipt',{team_id:state.team_id,task_id:state.task.task_id});
  writeFileSync(join(out,'effect-receipt.json'),JSON.stringify(receipt,null,2));
  const token=readFileSync(join(root,'output/quality-deployment/orchestrator/service.token'),'utf8').trim();
  if(state.session_id)for(const [name,path]of [['turns','/v2/turns'],['native-receipt','/v2/sessions/receipt']]){
    const response=await fetch(`http://127.0.0.1:8765${path}?session_id=${state.session_id}`,{headers:{authorization:`Bearer ${token}`}});
    writeFileSync(join(out,`${name}.json`),JSON.stringify(await response.json(),null,2));
  }
  const task=await api('task/get',{task_id:state.task.task_id});writeFileSync(join(out,'task-current.json'),JSON.stringify(task,null,2));
  console.log(JSON.stringify({requests:req.length,responses:res.length,session:state.session_id,receipt:receipt.summary,items:receipt.items.map(i=>({asset_id:i.asset_id,status:i.status,assessment:i.assessment,error:i.error_details}))}));
} else if(['baseline','final'].includes(mode)){
  const phase=join(out,mode);mkdirSync(phase,{recursive:true});
  if(existsSync(join(phase,'result.json')))throw Error('Do not overwrite recorded acceptance');
  cpSync(join(state.workspace,'service.py'),join(phase,'service.py'));
  cpSync(join(root,'evaluation/asset_recommendation_bench/acceptance/test_flags.py'),join(phase,'test_acceptance.py'));
  const p=spawnSync('docker',['run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','128m','--cpus','0.5','--mount',`type=bind,src=${phase},dst=/evaluation,readonly`,'-w','/evaluation','-e','PYTHONDONTWRITEBYTECODE=1','--entrypoint','python3','tdai-local/memory-hub:quality-v2','-S','test_acceptance.py','-v'],{encoding:'utf8',timeout:30000});
  const result={phase:mode,at:new Date().toISOString(),exit_code:p.status,stdout:p.stdout,stderr:p.stderr,source_sha256:hash(readFileSync(join(phase,'service.py'))),tests_sha256:hash(readFileSync(join(phase,'test_acceptance.py'))),causal_asset_contribution:false};
  writeFileSync(join(phase,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} else throw Error('prepare | capture | baseline | final');
