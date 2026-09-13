/** Reproducible local regressions. No model calls or business-data mutation. */
import {spawnSync,execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'../..'),output=resolve(process.argv[2]||'');
if(!process.argv[2]||existsSync(output))throw Error('provide a new evidence filename');
const core=JSON.parse(execFileSync('docker',['inspect','tdai-memory-core'],{encoding:'utf8'}))[0].Config.Image;
const checks=[
  {id:'proxy-typecheck',cwd:'MemoryProxy',cmd:'npm',args:['run','typecheck']},
  {id:'proxy-tests',cwd:'MemoryProxy',cmd:'npm',args:['test']},
  {id:'core-quality-tests',cwd:'.',cmd:'docker',args:['run','--rm','--network','none','--entrypoint','node','--mount',`type=bind,src=${root}/MemoryCore/src,dst=/app/src,readonly`,core,'/app/node_modules/vitest/vitest.mjs','run','src/asset-quality/__tests__','--maxWorkers','2']},
  {id:'ci-publication-tests',cwd:'evaluation/team_asset_bench',cmd:'python3',args:['-m','pytest','tests/test_hub_publication_failure.py','tests/test_unittest_discovery.py','tests/test_v7_contextual_acceptance_ci.py','tests/test_turn_runtime_v3.py','-q']},
  {id:'panel-build',cwd:'MemoryPanel/web',cmd:'npm',args:['run','build']},
];
const results=[];
for(const c of checks){
  const start=Date.now(),r=spawnSync(c.cmd,c.args,{cwd:join(root,c.cwd),encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
  results.push({id:c.id,exit_code:r.status,error:r.error?.message,duration_ms:Date.now()-start,stdout:r.stdout,stderr:r.stderr});
  console.log(JSON.stringify({id:c.id,exit_code:r.status,duration_ms:Date.now()-start}));
}
const run=JSON.parse(readFileSync(join(root,'output/closure-live-20260910/run.json'),'utf8'));
const hashes=Object.fromEntries(['service.py','test_regression.py','RESULT.md'].map(f=>[f,createHash('sha256').update(readFileSync(join(run.workspace,f))).digest('hex')]));
mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify({at:new Date().toISOString(),core_image:core,results,workspace_hashes:hashes,passed:results.every(r=>r.exit_code===0)},null,2),{mode:0o600});
if(results.some(r=>r.exit_code!==0))process.exitCode=1;
