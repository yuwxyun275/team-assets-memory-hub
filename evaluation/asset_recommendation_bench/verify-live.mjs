/** Independent immutable acceptance after real desktop work; never sends tests to the model. */
import {readFileSync,writeFileSync,mkdirSync,cpSync,existsSync,chmodSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {codebuddyApi as api} from '../cache_history_bench/codebuddy-live-api.mjs';
const root=resolve(import.meta.dirname,'../..'),directory=join(root,'output/asset-recommendation-live-20260908');
const state=JSON.parse(readFileSync(join(directory,'tasks.json'))),run=JSON.parse(readFileSync(join(directory,'run.json'))),manifest=JSON.parse(readFileSync(join(run.source,'manifest.json')));
const phase=process.argv[2];if(!['baseline','final'].includes(phase))throw Error('baseline | final [pilot-N]');
const hash=b=>createHash('sha256').update(b).digest('hex');
for(const task of state.tasks.filter(t=>!process.argv[3]||t.run_id===process.argv[3])){
  const out=join(directory,'acceptance',task.run_id,phase);if(existsSync(join(out,'result.json')))continue;
  mkdirSync(out,{recursive:true});
  const project=task.source_task.endsWith('flags')?'flags':'inventory',test=`acceptance/test_${project}.py`;
  const testBytes=readFileSync(join(root,'evaluation/asset_recommendation_bench',test));
  if(hash(testBytes)!==manifest.preparation_source_hashes[test])throw Error('acceptance tests changed since dataset freeze');
  const candidate=readFileSync(join(task.workspace,'service.py'));
  writeFileSync(join(out,'service.py'),candidate);writeFileSync(join(out,'test_acceptance.py'),testBytes);
  chmodSync(out,0o755);for(const f of ['service.py','test_acceptance.py'])chmodSync(join(out,f),0o644);
  const args=['run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user','65534:65534','--memory','128m','--cpus','0.5','--tmpfs','/tmp:rw,noexec,nosuid,size=16m','--mount',`type=bind,src=${out},dst=/evaluation,readonly`,'-w','/evaluation','-e','PYTHONDONTWRITEBYTECODE=1','--entrypoint','python3','tdai-local/memory-hub:quality-v2','-S','test_acceptance.py','-v'];
  const executed=spawnSync('docker',args,{encoding:'utf8',timeout:30000});
  const baseline=readFileSync(join(run.source,'client/tasks',task.source_task,'workspace/service.py'));
  const smokePreserved=hash(readFileSync(join(task.workspace,'smoke.py')))===hash(readFileSync(join(run.source,'client/tasks',task.source_task,'workspace/smoke.py')));
  const result={at:new Date().toISOString(),run_id:task.run_id,arm:task.arm,phase,exit_code:executed.status,signal:executed.signal,stdout:executed.stdout,stderr:executed.stderr,source_sha256:hash(candidate),tests_sha256:hash(testBytes),source_changed:hash(candidate)!==hash(baseline),original_smoke_preserved:smokePreserved,acceptance_passed:executed.status===0,complete:phase==='final'&&executed.status===0&&hash(candidate)!==hash(baseline)&&smokePreserved,isolation:'acceptance runtime is read-only/networkless container; desktop authoring remains host-accessible and requires tool-trajectory audit',causal_asset_contribution:false};
  writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2));
  if(phase==='final'){
    writeFileSync(join(out,'changes.diff'),execFileSync('git',['diff','--','service.py','smoke.py'],{cwd:task.workspace,encoding:'utf8'}));
    const current=await api('task/get',{task_id:task.task_id}),metadata=JSON.parse(current.metadata_json||'{}');
    metadata.benchmark_independent_acceptance={...result,stdout:undefined,stderr:undefined,evidence_path:out,evidence_author:'user-authorized independent benchmark runner; not CodeBuddy self-report'};
    await api('task/update',{task_id:task.task_id,status:result.complete?'completed':'running',metadata_json:JSON.stringify(metadata)});
  }
  console.log(JSON.stringify({run_id:task.run_id,phase,passed:result.acceptance_passed,complete:result.complete}));
}
