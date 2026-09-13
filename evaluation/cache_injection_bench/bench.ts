import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { ARMS, SCENARIOS, assetPayload, rawReplay, parseUsage, aggregate, hash, type Arm, type Scenario, type Fixture } from './fixture.js';

const sourceRoot = process.env.CACHE_BENCH_PROXY_SOURCE || '/app/src';
const moduleAt = (file: string) => import(pathToFileURL(resolve(sourceRoot,file)).href);
const { InjectionPipeline } = await moduleAt('injection/pipeline.ts');
const { HookRegistryImpl } = await moduleAt('injection/registry.ts');
const { OpenAIAdapter } = await moduleAt('injection/adapters/openai.ts');
const fixture: Fixture = JSON.parse(readFileSync(resolve(import.meta.dirname,'fixture.json'),'utf8'));
const live = process.argv.includes('--live');
if(live) assert.equal((fixture as any).provenance,'entirely_synthetic_no_repository_content','Live cache test must not send repository code or existing assets');
const output = resolve(import.meta.dirname,'result'); mkdirSync(output,{recursive:true,mode:0o700});
const run = process.env.CACHE_BENCH_RUN || `cache-${Date.now()}`;
const model = 'deepseek-v4-flash';
const replicas = 2, turns = 6, inputLimit = 1_000_000, outputLimit = 16;
const sourceHashes = Object.fromEntries(['injection/pipeline.ts','injection/adapters/openai.ts','assets/disclosure.ts'].map(p=>[p,hash(readFileSync(resolve(sourceRoot,p),'utf8'))]));
const settings = {run,model,replicas,turns,scenarios:SCENARIOS,arms:ARMS,input_limit:inputLimit,
  workload:fixture.workload||'short_fixed_prefix',fixed_system_characters:rawReplay(fixture,run,1,'stable',1).messages[0].content.length,
  max_output_per_request:outputLimit,thinking:'disabled',temperature:0,stream:false,
  isolation:'unique user_id for each replica/scenario/arm; shared input text across arms',
  injection:'actual production InjectionPipeline + OpenAIAdapter, isolated single hook registry',
  content:'entirely synthetic code and four invented assets, no existing repository content; same asset bundle in both arms; not a progressive-disclosure savings comparison',
  client_history:'fixed replay, previous proxy-only asset suffix not persisted by simulated client',
  control:'system.suffix after fixed system text, before conversation history; reconstructed baseline, not old binary replay',
  source_hashes:sourceHashes,fixture_hash:hash(JSON.stringify(fixture)),
  source_files:fixture.assets.map(x=>({source:x.source,sha256:hash(x.body)})),
  docs:['https://api-docs.deepseek.com/zh-cn/guides/kv_cache/','https://api-docs.deepseek.com/api/create-chat-completion/','https://api-docs.deepseek.com/quick_start/rate_limit/']};
writeFileSync(resolve(output,'settings.json'),JSON.stringify(settings,null,2));
const adapter = new OpenAIAdapter();
async function makePayload(rep: number, scenario: Scenario, turn: number, arm: Arm) {
  const raw = {...rawReplay(fixture,run,rep,scenario,turn),model,thinking:{type:'disabled'},max_tokens:outputLimit,temperature:0,stream:false,
    user_id:`${run}-${rep}-${scenario}-${arm}`};
  const before = JSON.stringify(raw);
  const metadata={protocol:'openai',traceId:`${raw.user_id}-${turn}`,keyId:'isolated-cache-benchmark',modelId:model,stream:false,agentSource:'codebuddy'};
  const registry=new HookRegistryImpl();
  const text=assetPayload(fixture,scenario,turn);
  registry.register({id:'isolated-asset-position-benchmark',description:'Only move identical fixture asset text',
    point:arm==='system_suffix'?'system.suffix':'context.tail',priority:100,execute:async()=>[{type:'text',content:text}]});
  const pipeline=new InjectionPipeline(registry,new Map([['openai',adapter]]));
  // Avoid logging full content or filling benchmark progress with hook previews.
  const log=console.log; let body:any;
  try { console.log=()=>{}; body=await pipeline.process(raw,metadata); } finally { console.log=log; }
  assert.equal(JSON.stringify(raw),before,'Input history was mutated');
  const base=adapter.serialize(adapter.parse(raw,metadata));
  if(arm==='context_tail') assert.deepEqual(body.messages.slice(0,-1),base.messages,'Tail changed existing prefix');
  else assert.deepEqual(body.messages.slice(1),base.messages.slice(1),'Prefix injection changed conversation history');
  const serialized=JSON.stringify(body.messages);
  for(const a of fixture.assets) assert.equal(serialized.split(JSON.stringify(a.body).slice(1,-1)).length-1,1,'Body missing or repeated');
  return {body,asset_sha256:hash(text),history_sha256:hash(JSON.stringify(raw.messages)),bytes:Buffer.byteLength(JSON.stringify(body))};
}

// Construct and inspect every paired request before making any paid calls.
const plans:any[]=[];
for(let rep=1;rep<=replicas;rep++) for(const scenario of SCENARIOS) for(let turn=1;turn<=turns;turn++) {
  const pair=[];
  for(const arm of ARMS) pair.push({rep,scenario,turn,arm,...await makePayload(rep,scenario,turn,arm)});
  assert.equal(pair[0].asset_sha256,pair[1].asset_sha256);
  assert.equal(pair[0].history_sha256,pair[1].history_sha256);
  assert.equal(pair[0].body.model,pair[1].body.model);
  plans.push(...((rep+turn)%2?pair:pair.toReversed())); // counterbalance order within each pair
}
writeFileSync(resolve(output,'requests.json'),JSON.stringify(plans,null,2));
if (!live) { console.log(JSON.stringify({dry_run:true,requests:plans.length,all_paired_content_equal:true,output})); process.exit(0); }

const { buildConfig }=await moduleAt('config.ts');
const config=buildConfig({configFile:process.env.CACHE_BENCH_CONFIG||'/data/config.yaml'});
const entry=config.upstream.agents?.codebuddy || config.upstream;
const apiKey=entry.apiKey||config.upstream.apiKey;
const url=new URL(entry.url);
assert.equal(url.hostname,'api.deepseek.com','Only the configured, authorized DeepSeek upstream is allowed');
assert.equal(url.protocol,'https:'); assert.ok(apiKey,'Missing configured key');
if(!url.pathname.endsWith('/chat/completions')) url.pathname=url.pathname.replace(/\/$/,'')+'/chat/completions';
url.search=''; url.hash='';
writeFileSync(resolve(output,'upstream.json'),JSON.stringify({endpoint:url.origin+url.pathname,model,credential_source:'existing Proxy config; never persisted in results'},null,2));
let totalInput=0, totalCalls=0;
const rows:any[]=[], calibration:any[]=[], lastFinished=new Map<string,number>();
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function request(plan:any, phase:string) {
  // Always bounded. No silent paid retries: an error preserves partial data and ends this run.
  if(totalInput + plan.bytes + 2000 > inputLimit || totalCalls>=76) throw new Error('Predefined request/token budget reached');
  const previous=lastFinished.get(plan.body.user_id)||0;
  const pause=Math.max(0,6000-(Date.now()-previous)); if(pause) await wait(pause);
  const started=performance.now(), startedAt=new Date().toISOString(); totalCalls++;
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${apiKey}`},
    body:JSON.stringify(plan.body),signal:AbortSignal.timeout(60000),redirect:'error'});
  const result:any=await response.json();
  if(!response.ok) throw new Error(`Upstream HTTP ${response.status}; no automatic retry; error_type=${String(result.error?.type||'unknown').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,100)}`);
  const tokens=parseUsage(result.usage); totalInput+=tokens.input;
  lastFinished.set(plan.body.user_id,Date.now());
  const row={phase,rep:plan.rep,scenario:plan.scenario,turn:plan.turn,arm:plan.arm,started_at:startedAt,
    response_id:result.id,reported_model:result.model,system_fingerprint:result.system_fingerprint,
    duration_ms:Math.round(performance.now()-started),tokens,usage:result.usage,
    finish_reason:result.choices?.[0]?.finish_reason,response_text:result.choices?.[0]?.message?.content,
    asset_sha256:plan.asset_sha256,history_sha256:plan.history_sha256,request_sha256:hash(JSON.stringify(plan.body)),request_bytes:plan.bytes};
  appendFileSync(resolve(output,'responses.jsonl'),JSON.stringify(row)+'\n');
  console.log(JSON.stringify({phase,rep:plan.rep,scenario:plan.scenario,turn:plan.turn,arm:plan.arm,
    input:tokens.input,hit:tokens.hit,miss:tokens.miss,output:tokens.output,hit_rate:Number((tokens.hit/tokens.input).toFixed(4)),duration_ms:row.duration_ms}));
  return row;
}
function summary() {
  const groups=SCENARIOS.flatMap(scenario=>ARMS.map(arm=>({scenario,arm,
    all:aggregate(rows.filter(r=>r.scenario===scenario&&r.arm===arm)),
    later_turns:aggregate(rows.filter(r=>r.scenario===scenario&&r.arm===arm&&r.turn>=3)),
    per_replica:Array.from({length:replicas},(_,i)=>({rep:i+1,...aggregate(rows.filter(r=>r.scenario===scenario&&r.arm===arm&&r.rep===i+1))}))})));
  return {complete:rows.length===plans.length,actual_model_calls:totalCalls,total:aggregate([...calibration,...rows]),
    calibration,groups,cache_metric:'sum(prompt_cache_hit_tokens) / sum(prompt_tokens)',
    limitations:['Controlled fixture replay, not actual CodeBuddy UI traffic or task-quality measurement.',
      'Non-thinking, 16-token output cap; latency is full request duration, not TTFT.',
      'Two independent six-turn replicas per scenario; no production-wide hit-rate guarantee.',
      'Both arms inject the same full asset bundle; card/reading savings and extra tool round-trips are deliberately excluded.',
      'Other injection hooks disabled only in the isolated benchmark registry; normal production config unchanged.',
      'No server cache reset; fresh user_id isolation and cold-start observations, not guaranteed cold cache.']};
}
try {
  const control=await makePayload(0,'stable',1,'context_tail'); control.body.user_id=`${run}-calibration`;
  for(let i=1;i<=2;i++) calibration.push(await request({...control,rep:0,scenario:'identical_repeat',turn:i,arm:'control'},'calibration'));
  if(calibration[1].tokens.hit===0) {
    calibration.push(await request({...control,rep:0,scenario:'identical_repeat',turn:3,arm:'control'},'calibration'));
  }
  for(const plan of plans) { rows.push(await request(plan,'comparison')); writeFileSync(resolve(output,'summary.json'),JSON.stringify(summary(),null,2)); }
} catch(error:any) {
  writeFileSync(resolve(output,'summary.json'),JSON.stringify({...summary(),error:String(error.message)},null,2)); throw error;
}
writeFileSync(resolve(output,'summary.json'),JSON.stringify(summary(),null,2));
console.log(JSON.stringify({complete:true,output,actual_model_calls:totalCalls,total_input:totalInput}));
