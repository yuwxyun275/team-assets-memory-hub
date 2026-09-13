import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { syntheticFixture } from './synthetic-fixture.mjs';
const root=resolve(import.meta.dirname,'../..');
const live=process.argv.includes('--live');
const run=`cache-${new Date().toISOString().replace(/[:.]/g,'-')}`;
const output=resolve(root,'output/cache-injection-bench',run); mkdirSync(output,{recursive:true,mode:0o700});
const fixture=syntheticFixture(process.argv.includes('--long-prefix'));
writeFileSync(join(output,'fixture.json'),JSON.stringify(fixture,null,2));
const stage=`/tmp/${run}`;
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',maxBuffer:4*1024*1024});
docker('exec','--user','0','tdai-proxy','node','-e','require("node:fs").mkdirSync(process.argv[1],{recursive:true,mode:0o700})',stage);
for(const name of ['bench.ts','fixture.ts','package.json']) docker('cp',join(import.meta.dirname,name),`tdai-proxy:${stage}/${name}`);
docker('cp',join(output,'fixture.json'),`tdai-proxy:${stage}/fixture.json`);
const args=['exec','--user','0','-e',`CACHE_BENCH_RUN=${run}`,'tdai-proxy','node','--import','tsx',`${stage}/bench.ts`,...(live?['--live']:[])];
console.log(JSON.stringify({run,live,output,data_provenance:fixture.provenance,workload:fixture.workload,normal_proxy_config_changed:false,max_comparison_requests:72,max_output_tokens_per_request:16}));
const child=spawn('docker',args,{stdio:['ignore','pipe','pipe']});
let log=''; child.stdout.on('data',d=>{process.stdout.write(d);log+=d;}); child.stderr.on('data',d=>{process.stderr.write(d);log+=d;});
const code=await new Promise(resolveExit=>child.on('close',resolveExit));
writeFileSync(join(output,'run.log'),log);
try {docker('cp',`tdai-proxy:${stage}/result`,output);} catch(error) {
  if(code===0) throw error;
} finally {
  // Remove only this exact, generated temporary benchmark directory. Original services/data are untouched.
  docker('exec','--user','0','tdai-proxy','node','-e',
    'const p=process.argv[1];if(!p.startsWith("/tmp/cache-")||!/^cache-[0-9TZ:-]+$/.test(p.slice(5)))throw Error("Unexpected cleanup target");require("node:fs").rmSync(p,{recursive:true,force:true});',stage);
}
console.log(JSON.stringify({exit_code:code,output})); process.exitCode=Number(code)||0;
