/** Surgical deployment of quality queue limits; preserve old container and snapshot. */
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,chmodSync} from 'node:fs';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'../..');
const docker=(...args)=>execFileSync('docker',args,{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024});
const component=process.argv[2]||'core';if(!['core','proxy'].includes(component))throw Error('core | proxy');
const name=component==='core'?'tdai-memory-core':'tdai-proxy', info=JSON.parse(docker('inspect',name))[0];
const stamp=new Date().toISOString().replace(/[:.]/g,'-').toLowerCase();
const backup=join(root,'output/quality-deployment',`bench-${component}-${stamp}`);mkdirSync(backup,{recursive:true,mode:0o700});
writeFileSync(join(backup,'private-container.json'),JSON.stringify(info),{mode:0o600});
const image=`tdai-local/memory-${component}:bench-${stamp}`,build=`bench-${component}-build-${Date.now()}`,previous=`${name}-before-bench-${stamp}`;
docker('create','--name',build,info.Image);
try{
  const files=component==='core'?['asset-quality/lifecycle.ts','asset-quality/rules.ts']:['assets/benchmark.ts','assets/history.ts','assets/asset-bridge.ts','injection/pipeline.ts','injection/injectors/team-assets-orchestrator-injector.ts','handler.ts','skill/skill-bridge.ts','memory/memory-bridge.ts'];
  for(const file of files)docker('cp',`${component==='core'?'MemoryCore':'MemoryProxy'}/src/${file}`,`${build}:/app/src/${file}`);docker('commit',build,image);
}finally{docker('rm',build);}
let renamed=false,created=false;
try{
  docker('stop','--time','20',name);
  for(const m of info.Mounts.filter(m=>m.Type==='volume'&&m.RW)){
    docker('run','--rm','--user','0','--network','none','--entrypoint','tar','--mount',`type=volume,src=${m.Name},dst=/source,readonly`,'--mount',`type=bind,src=${backup},dst=/backup`,info.Image,'-czf',`/backup/${m.Name}.tgz`,'-C','/source','.');chmodSync(join(backup,`${m.Name}.tgz`),0o600);
  }
  docker('rename',name,previous);renamed=true;
  const env=info.Config.Env.filter(e=>!/^ASSET_BENCH_(MANIFEST|AUDIT_DIR)=/.test(e));
  if(component==='proxy')env.push('ASSET_BENCH_MANIFEST=/data/asset-bench-manifest.json','ASSET_BENCH_AUDIT_DIR=/data/asset-bench-audit');
  const envPath=join(backup,'private.env');writeFileSync(envPath,env.join('\n')+'\n',{mode:0o600});
  const args=['create','--name',name,'--restart','unless-stopped','--env-file',envPath];
  const nets=Object.entries(info.NetworkSettings.Networks);
  args.push('--network',nets[0][0]);
  for(const alias of nets[0][1].Aliases||[])if(alias!==info.Id&&alias!==info.Id.slice(0,12))args.push('--network-alias',alias);
  for(const [port,bindings]of Object.entries(info.HostConfig.PortBindings||{}))for(const b of bindings||[])args.push('-p',`${b.HostIp?b.HostIp+':':''}${b.HostPort}:${port}`);
  for(const m of info.Mounts)args.push('--mount',`type=${m.Type},src=${m.Type==='volume'?m.Name:m.Source.replace(/^\/host_mnt/,'')},dst=${m.Destination}${m.RW?'':',readonly'}`);
  if(component==='proxy'){
    if(!info.Mounts.some(m=>m.Destination==='/data/asset-bench-manifest.json'))args.push('--mount',`type=bind,src=${join(root,'output/asset-recommendation-live-20260908/proxy-manifest.json')},dst=/data/asset-bench-manifest.json,readonly`);
    if(!info.Mounts.some(m=>m.Destination==='/data/asset-bench-audit'))args.push('--mount','type=volume,src=tdai-asset-bench-audit-20260908,dst=/data/asset-bench-audit');
  }
  for(const host of info.HostConfig.ExtraHosts||[])args.push('--add-host',host);
  args.push(image,...(info.Config.Cmd||[]));docker(...args);created=true;
  for(const [net,details]of nets.slice(1)){const aliases=[];for(const alias of details.Aliases||[])if(alias!==info.Id&&alias!==info.Id.slice(0,12))aliases.push('--alias',alias);docker('network','connect',...aliases,net,name);}
  docker('start',name);
  if(component==='proxy')docker('exec','--user','0',name,'node','-e','const fs=require("fs");fs.chownSync("/data/asset-bench-audit",10001,999);fs.chmodSync("/data/asset-bench-audit",0o700)');
  for(let i=0;i<50;i++){const s=JSON.parse(docker('inspect',name))[0].State;if(s.Running&&(!s.Health||s.Health.Status==='healthy'))break;if(i===49)throw Error('health timeout');await new Promise(r=>setTimeout(r,1000));}
  writeFileSync(join(backup,'result.json'),JSON.stringify({name,previous,image,backup,status:'healthy'},null,2));console.log(JSON.stringify({name,previous,backup,status:'healthy'}));
}catch(e){if(created){docker('stop','--time','10',name);docker('rename',name,`${name}-failed-${stamp}`);}if(renamed)docker('rename',previous,name);docker('start',name);throw e;}
