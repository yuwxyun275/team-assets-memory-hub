import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
const root=resolve(import.meta.dirname,'../..');
const bench=resolve(root,'evaluation/team_asset_bench');
const run=(...args)=>execFileSync('docker',args,{encoding:'utf8'});
// Read only the existing internal service token, never print it. Match the actual Proxy configuration.
const tokenOutput=run('exec','tdai-proxy','node','--import','tsx','--input-type=module','-e','import{buildConfig}from"./src/config.ts";console.log(JSON.stringify({token:buildConfig({configFile:"/data/config.yaml"}).injection.teamAssets.serviceToken}))');
const token=JSON.parse(tokenOutput.trim().split('\n').at(-1)).token;
if (!token) throw new Error('The configured orchestrator service token is empty; configure it before enabling remote service');
const privateDir=resolve(root,'output/quality-deployment/orchestrator');mkdirSync(privateDir,{recursive:true,mode:0o700});
const tokenPath=resolve(privateDir,'service.token');writeFileSync(tokenPath,token,{mode:0o600});
const existing=run('ps','-a','--filter','name=^/tdai-quality-orchestrator$','--format','{{.Names}}').trim();
if(existing && !process.argv.includes('--replace')) { run('start',existing); console.log('existing orchestrator started'); }
else {
  if(existing){run('stop',existing);run('rename',existing,`${existing}-previous-${Date.now()}`);}
  run('run','-d','--name','tdai-quality-orchestrator','--restart','unless-stopped','--network','tdai-memory-stack',
    '--cpus','1','--memory','512m','-p','127.0.0.1:8765:8765',
    '--mount',`type=bind,src=${bench},dst=/bench,readonly`,
    '--mount',`type=bind,src=${bench}/results,dst=/bench/results`,
    '-e','PYTHONDONTWRITEBYTECODE=1','-e','PYTHONUNBUFFERED=1',
    '--mount',`type=bind,src=${tokenPath},dst=/run/team-asset-token,readonly`,
    '-e','TEAM_ASSET_SERVER_TOKEN_FILE=/run/team-asset-token',
    '-e','TEAM_ASSET_HUB_ENV=/bench/runtime/hub-demo.env','-e','TEAM_ASSET_BINDINGS_FILE=/bench/runtime/hub-binding.json',
    '-e','TEAM_ASSET_CORE_URL=http://memory-core:8420',
    '--health-cmd',`python3 -c 'import urllib.request;urllib.request.urlopen("http://127.0.0.1:8765/health")'`,
    '--health-interval','20s','--health-start-period','10s',
    '-w','/bench','--entrypoint','python3','tdai-local/memory-hub:quality-v2',
    '-m','team_asset_bench','serve','--host','0.0.0.0','--port','8765');
  console.log('orchestrator container started on loopback port 8765');
}
