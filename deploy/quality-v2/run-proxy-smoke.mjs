import {api} from './live-check.mjs';
import {readFileSync,writeFileSync,mkdirSync,unlinkSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'../..');
const r=JSON.parse(readFileSync(resolve(root,'output/quality-live/run.json')));
let agent=r.smoke_agent;
if(!agent){agent=await api('agent/create',{team_id:r.team.team_id,owner_user_id:r.team.owner_user_id,name:'质量闭环集成验收 Agent',visibility:'private'});r.smoke_agent=agent;writeFileSync(resolve(root,'output/quality-live/run.json'),JSON.stringify(r,null,2));}
const key=readFileSync(resolve(root,'evaluation/team_asset_bench/runtime/hub-demo.env'),'utf8').split('\n').find(x=>x.startsWith('TEAM_ASSET_DEMO_USER_KEY=')).split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g,'');
const directory=resolve(root,'output/quality-deployment/smoke');mkdirSync(directory,{recursive:true,mode:0o700});
const file=resolve(directory,'context.json');
const session=`quality-smoke-${Date.now()}`;
writeFileSync(file,JSON.stringify({owner:r.team.owner_user_id,key,team:r.team.team_id,task:r.task.task_id,agent:agent.agent_id,session}),{mode:0o600});
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',maxBuffer:4*1024*1024});
try{
  docker('cp',file,'tdai-proxy:/tmp/quality-smoke-context.json');
  docker('exec','--user','0','tdai-proxy','node','-e','require("node:fs").chownSync("/tmp/quality-smoke-context.json",10001,999)');
  docker('cp',resolve(root,'deploy/quality-v2/proxy-smoke.ts'),'tdai-proxy:/app/quality-smoke.ts');
  const result=docker('exec','tdai-proxy','node','--import','tsx','/app/quality-smoke.ts');
  writeFileSync(resolve(root,'output/quality-live/proxy-smoke.txt'),result);console.log(result);
}finally{
  unlinkSync(file);
  docker('exec','--user','0','tdai-proxy','node','-e','require("node:fs").unlinkSync("/tmp/quality-smoke-context.json")');
}
