/** Real Core + ranker + HTTP bridge, synthetic model-message sequence. No model success claim. */
import fs from 'node:fs';
import { buildConfig } from '/app/src/config.ts';
import { ensureBindingRepoPersistent } from '/app/src/injection/index.ts';
import { getSessionStore } from '/app/src/session/store.ts';
import { getMetadataClient } from '/app/src/meta/client.ts';
import { TeamAssetsOrchestratorInjector } from '/app/src/injection/injectors/team-assets-orchestrator-injector.ts';
import { HookRegistryImpl } from '/app/src/injection/registry.ts';
import { InjectionPipeline } from '/app/src/injection/pipeline.ts';
import { OpenAIAdapter } from '/app/src/injection/adapters/openai.ts';
import { renderAssetBody, visibleTexts } from '/app/src/assets/disclosure.ts';
import { startQualityOutbox } from '/app/src/injection/injectors/quality-outbox.ts';
const d=JSON.parse(fs.readFileSync('/tmp/disclosure-smoke-context.json','utf8'));
const config=buildConfig({configFile:'/data/config.yaml'});
if(!config.injection.teamAssets.progressiveDisclosure) throw new Error('Progressive disclosure is disabled');
ensureBindingRepoPersistent(config); startQualityOutbox(config.coreSkill,false);
const store=getSessionStore();
store.bind(`codebuddy:${d.session}`,{userId:d.owner,spaceId:'default',agentSource:'codebuddy',sessionId:d.session});
await store.set(`codebuddy:${d.session}`,{status:'initialized',keyId:`codebuddy:${d.session}`,startedAt:Date.now(),attemptCount:0,
  sessionInfo:{session_id:d.session,space_id:'default',user_id:d.owner,user_key:d.key,team_id:d.team,agent_id:d.agent,task_id:d.task} as any});
const client=getMetadataClient(config.coreSkill,'default',d.key);
const scope={team_id:d.team,agent_id:d.agent,task_id:d.task,session_id:d.session};
const injector=new TeamAssetsOrchestratorInjector({...config.injection.teamAssets,bridgeBaseUrl:'http://127.0.0.1:8096'},config.coreSkill);
const adapter=new OpenAIAdapter(),registry=new HookRegistryImpl();registry.register(injector);
const pipeline=new InjectionPipeline(registry,new Map([['openai',adapter]]));
const metadata:any={protocol:'openai',traceId:d.session,keyId:'disclosure-smoke',modelId:'synthetic-protocol-check',stream:false,spaceId:'default',userId:d.owner,turnSeq:1,agentSource:'codebuddy',
  custom:{userKey:d.key,session:{session_id:d.session,team_id:d.team,agent_id:d.agent,task_id:d.task,user_id:d.owner},
    taskDetail:{id:d.task,name:'渐进式披露接口验收',description:'在隔离示例 feature_flags v1 中审查 Redis 读取安全回退、禁止请求内重试、租户隔离及故障恢复。'}}};
const raw:any={model:'synthetic-protocol-check',messages:[{role:'system',content:'固定前缀。合成接口验收，不执行业务代码，不声称模型采用了资产。'},
  {role:'user',content:'请推荐 Redis 缓存故障与恢复设计审查需要的团队资产。'}]};
let applied:any[]=[];const onApplied=injector.onApplied.bind(injector);
injector.onApplied=async(ctx,blocks)=>{applied=blocks;await onApplied(ctx,blocks);};
const assert=(condition:unknown,message:string)=>{if(!condition)throw new Error(message);};
try {
  const first:any=await pipeline.process(raw,metadata);
  assert(JSON.stringify(first.messages.slice(0,raw.messages.length))===JSON.stringify(raw.messages),'prefix changed');
  const cardIds=applied[0]?.metadata?.cardAssetIds||[];
  assert(cardIds.length>0,'no versioned cards selected');
  const assets:any[]=await client.listAccessibleAssets({user_id:d.owner,team_id:d.team,agent_id:d.agent,action:'use'});
  const asset=assets.find(a=>a.asset_id===cardIds[0]); const p=asset?.quality_publication;
  assert(p,'no published body for card');
  assert(!visibleTexts(adapter.parse(first,metadata).messages).some(t=>t.includes(p.snapshot.body)),'first card included long body');
  const before:any=await client.quality('open-exposures',scope);
  assert(before.items.length===0,'card falsely recorded as body exposure');
  const headers={'content-type':'application/json','x-tdai-service-id':'default','x-conversation-id':d.session};
  const response=await fetch('http://127.0.0.1:8096/asset-bridge/read',{method:'POST',headers,body:JSON.stringify({asset_id:asset.asset_id,revision_id:p.revision_id})});
  const fetched=await response.text();
  assert(response.ok,`live asset read failed: ${response.status} ${fetched}`);
  assert(fetched===renderAssetBody(asset.asset_id,p.revision_id,p.snapshot.body),'versioned body mismatch');
  const afterFetch:any=await client.quality('open-exposures',scope);
  assert(afterFetch.items.length===0,'HTTP fetch falsely recorded as model exposure');
  const withRead=structuredClone(raw);
  withRead.messages.push({role:'assistant',content:null,tool_calls:[{id:'read-asset',type:'function',function:{name:'Bash',arguments:'{}'}}]},
    {role:'tool',tool_call_id:'read-asset',content:fetched});
  const untouchedRead=JSON.stringify(withRead);
  const canonicalRead=adapter.serialize(adapter.parse(withRead,metadata));
  const second:any=await pipeline.process(withRead,metadata);
  const copies=visibleTexts(adapter.parse(second,metadata).messages).filter(t=>t.includes(fetched)).length;
  assert(copies===1,'duplicate body after tool result');
  assert(JSON.stringify(second.messages.slice(0,withRead.messages.length))===JSON.stringify(canonicalRead.messages),'tool history rewritten');
  assert(JSON.stringify(withRead)===untouchedRead,'caller history mutated');
  const compressed=structuredClone(raw);compressed.messages.push({role:'user',content:'继续 Redis 故障恢复审查；对话已压缩，之前读过相关资产。'});
  const third:any=await pipeline.process(compressed,{...metadata,turnSeq:2,traceId:`${d.session}-compressed`});
  assert(JSON.stringify(third).includes('team_asset_card'),'missing card after compression');
  assert(!visibleTexts(adapter.parse(third,metadata).messages).some(t=>t.includes(p.snapshot.body)),'compression eagerly reinserted full body');
  const refs:any=await client.quality('disclosure-list',scope);assert(refs.references.length>0,'missing durable manifest');
  const invalid=await fetch('http://127.0.0.1:8096/asset-bridge/read',{method:'POST',headers,body:JSON.stringify({asset_id:asset.asset_id,revision_id:'nonexistent-revision'})});
  assert(!invalid.ok,'invalid revision accepted');
  console.log(JSON.stringify({progressive_disclosure:true,card_count:cardIds.length,first_request_body_absent:true,card_not_counted_as_exposure:true,
    live_http_read_complete:true,fetch_not_counted_as_exposure:true,body_copies_after_read:copies,history_prefix_unchanged:true,
    compressed_history_restores_card:true,durable_reference_count:refs.references.length,invalid_revision_rejected:true,
    real_model_task_success_claim:false}));
} finally {await store.getBindingRepo()?.deleteBinding('default',d.session);}
