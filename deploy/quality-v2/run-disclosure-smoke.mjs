import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'../..');
const run=JSON.parse(readFileSync(resolve(root,'output/quality-live/run.json'),'utf8'));
if(!run.smoke_agent) throw new Error('Existing authorized demo Agent is required');
const env=Object.fromEntries(readFileSync(resolve(root,'evaluation/team_asset_bench/runtime/hub-demo.env'),'utf8').split('\n').filter(x=>/^[A-Z_]+=/.test(x)).map(l=>{const i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1).trim().replace(/^['"]|['"]$/g,'')];}));
const dir=resolve(root,'output/quality-deployment/disclosure-smoke');mkdirSync(dir,{recursive:true,mode:0o700});
const file=resolve(dir,'context.json');
writeFileSync(file,JSON.stringify({owner:run.team.owner_user_id,key:env.TEAM_ASSET_DEMO_USER_KEY,team:run.team.team_id,
  task:run.task.task_id,agent:run.smoke_agent.agent_id,session:`disclosure-smoke-${Date.now()}`}),{mode:0o600});
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',maxBuffer:4*1024*1024});
try {
  docker('cp',file,'tdai-proxy:/tmp/disclosure-smoke-context.json');
  docker('exec','--user','0','tdai-proxy','node','-e','require("node:fs").chownSync("/tmp/disclosure-smoke-context.json",10001,999)');
  docker('cp',resolve(root,'deploy/quality-v2/disclosure-smoke.ts'),'tdai-proxy:/app/disclosure-smoke.ts');
  const result=docker('exec','tdai-proxy','node','--import','tsx','/app/disclosure-smoke.ts');
  writeFileSync(resolve(root,'output/quality-live/disclosure-smoke.txt'),result);console.log(result);
} finally {
  unlinkSync(file);
  docker('exec','--user','0','tdai-proxy','node','-e','require("node:fs").unlinkSync("/tmp/disclosure-smoke-context.json")');
}
