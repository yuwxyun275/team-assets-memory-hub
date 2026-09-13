/** Local demo deployment: overlay only disclosure files, retain old containers.
 * No asset content/publication migration. Private backup includes runtime secrets.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = join(root, 'output/quality-deployment', `disclosure-${stamp}`);
mkdirSync(backup, {recursive:true, mode:0o700});
const docker = (...args) => execFileSync('docker',args,{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024});
const plans = [
  {name:'tdai-memory-core', part:'core', files:[
    ['MemoryCore/src/asset-quality/.','/app/src/asset-quality/'],
    ['MemoryCore/src/metadata/service/metadata-service.ts','/app/src/metadata/service/metadata-service.ts'],
    ['MemoryCore/src/metadata/router/v3-meta-router.ts','/app/src/metadata/router/v3-meta-router.ts'],
  ]},
  {name:'tdai-proxy', part:'proxy', files:[
    ['MemoryProxy/src/assets/.','/app/src/assets'],
    ...['server.ts','types.ts','config.ts','injection/index.ts','injection/injectors/team-assets-orchestrator-injector.ts'].map(p=>[`MemoryProxy/src/${p}`,`/app/src/${p}`]),
  ]},
];
for(const plan of plans) {
  plan.info=JSON.parse(docker('inspect',plan.name))[0];
  plan.image=`tdai-local/memory-${plan.part}:disclosure-${stamp.toLowerCase()}`;
  plan.previous=`${plan.name}-before-disclosure-${stamp}`;
}
writeFileSync(join(backup,'containers.json'),JSON.stringify(plans,null,2),{mode:0o600});
// Build without altering live containers or relying on the local BuildKit cache.
for(const plan of plans) {
  const build=`disclosure-build-${plan.part}-${Date.now()}`;
  docker('create','--name',build,plan.info.Image);
  try {
    for(const [source,target] of plan.files) docker('cp',source,`${build}:${target}`);
    docker('commit',build,plan.image);
  } finally { docker('rm',build); }
}
const changed=[];
try {
  for(const plan of plans) docker('stop','--time','20',plan.name);
  for(const plan of plans) for(const mount of plan.info.Mounts) {
    if(mount.Type!=='volume' || !mount.RW) continue;
    const filename=`${plan.part}-${mount.Name}.tgz`;
    docker('run','--rm','--network','none','--entrypoint','tar',
      '--mount',`type=volume,src=${mount.Name},dst=/source,readonly`,
      '--mount',`type=bind,src=${backup},dst=/backup`,plan.info.Image,'-czf',`/backup/${filename}`,'-C','/source','.');
    chmodSync(join(backup,filename),0o600);
  }
  for(const plan of plans) {
    const info=plan.info;
    docker('rename',plan.name,plan.previous); changed.push(plan);
    const envFile=join(backup,`${plan.part}.env`);
    const environment=[...(info.Config.Env||[])];
    if(plan.part==='proxy' && !environment.some(e=>e.startsWith('PROXY_DATA_DIR='))) environment.push('PROXY_DATA_DIR=/data/quality-outbox/session-bindings');
    writeFileSync(envFile,environment.join('\n')+'\n',{mode:0o600});
    const args=['create','--name',plan.name,'--restart',info.HostConfig.RestartPolicy?.Name||'unless-stopped','--env-file',envFile];
    const networks=Object.entries(info.NetworkSettings.Networks||{});
    if(networks[0]) {
      args.push('--network',networks[0][0]);
      for(const alias of networks[0][1].Aliases||[]) if(alias!==info.Id && alias!==info.Id.slice(0,12)) args.push('--network-alias',alias);
    }
    for(const [port,bindings] of Object.entries(info.HostConfig.PortBindings||{})) for(const b of bindings||[]) args.push('-p',`${b.HostIp?b.HostIp+':':''}${b.HostPort}:${port}`);
    for(const m of info.Mounts) args.push('--mount',`type=${m.Type},src=${m.Type==='volume'?m.Name:m.Source.replace(/^\/host_mnt/,'')},dst=${m.Destination}${m.RW?'':',readonly'}`);
    for(const host of info.HostConfig.ExtraHosts||[]) args.push('--add-host',host);
    if(info.HostConfig.Memory) args.push('--memory',String(info.HostConfig.Memory));
    if(info.HostConfig.NanoCpus) args.push('--cpus',String(info.HostConfig.NanoCpus/1e9));
    args.push(plan.image,...(info.Config.Cmd||[])); docker(...args);
    for(const [network,detail] of networks.slice(1)) {
      const options=[]; for(const alias of detail.Aliases||[]) if(alias!==info.Id && alias!==info.Id.slice(0,12)) options.push('--alias',alias);
      docker('network','connect',...options,network,plan.name);
    }
    docker('start',plan.name);
  }
  // The ranker source is a read-only bind mount: restarting loads the tested changes.
  docker('restart','--time','15','tdai-quality-orchestrator');
  for(let attempt=0;attempt<60;attempt++) {
    const states=plans.map(p=>JSON.parse(docker('inspect',p.name))[0].State);
    if(states.every(s=>s.Running && (!s.Health || s.Health.Status==='healthy'))) break;
    if(attempt===59) throw new Error('replacement health checks failed');
    await new Promise(r=>setTimeout(r,1000));
  }
  writeFileSync(join(backup,'manifest.json'),JSON.stringify({backup,containers:plans.map(({name,previous,image})=>({name,previous,image})),status:'deployed'},null,2),{mode:0o600});
  console.log(JSON.stringify({backup,containers:plans.map(p=>({name:p.name,previous:p.previous})),status:'healthy'}));
} catch(error) {
  for(const plan of changed.reverse()) {
    try {docker('stop','--time','10',plan.name);docker('rename',plan.name,`${plan.name}-failed-disclosure-${stamp}`);} catch {}
    try {docker('rename',plan.previous,plan.name);docker('start',plan.name);} catch {}
  }
  for(const plan of plans) {try {docker('start',plan.name);} catch {}}
  throw error;
}
