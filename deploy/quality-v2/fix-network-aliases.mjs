import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const state=JSON.parse(readFileSync(process.argv[2],'utf8'));
const run=(...a)=>execFileSync('docker',a,{encoding:'utf8'});
for(const {name,info} of state){
  for(const [network,settings] of Object.entries(info.NetworkSettings.Networks)){
    run('network','disconnect',network,name);
    run('network','connect',...(settings.Aliases??[]).flatMap(a=>['--alias',a]),network,name);
  }
  console.log(`restored aliases: ${name}`);
}
