/** Run inside the actual Proxy image. Exercises real Core + selector + durable observer; no fabricated test success. */
import fs from "node:fs";
import { buildConfig } from "/app/src/config.ts";
import { TeamAssetsOrchestratorInjector } from "/app/src/injection/injectors/team-assets-orchestrator-injector.ts";
import { observeTeamAssetAssistantResponse } from "/app/src/injection/injectors/team-assets-response-observer.ts";
import { startQualityOutbox } from "/app/src/injection/injectors/quality-outbox.ts";
import { InjectionPipeline } from "/app/src/injection/pipeline.ts";
import { HookRegistryImpl } from "/app/src/injection/registry.ts";
import { OpenAIAdapter } from "/app/src/injection/adapters/openai.ts";
const data=JSON.parse(fs.readFileSync('/tmp/quality-smoke-context.json','utf8'));
const config=buildConfig({configFile:'/data/config.yaml'});
const originalFetch=globalThis.fetch;
globalThis.fetch=async(...args)=>{
  const response=await originalFetch(...args);
  const url=String(args[0]);
  if(url.includes('turns/recommend')) {
    const value=await response.clone().json();
    console.log('selector diagnostic',JSON.stringify({status:response.status,error:value.error,selected:value.selected?.length,
      rejected:value.rejected?.map((v:any)=>({id:v.asset?.asset_id,reasons:v.reasons})),keys:Object.keys(value)}));
  }
  return response;
};
startQualityOutbox(config.coreSkill, false); // Real running Proxy owns delivery; this process only enqueues.
const injector=new TeamAssetsOrchestratorInjector(config.injection.teamAssets, config.coreSkill);
const ctx={messages:[{role:'system',blocks:[{type:'text',content:'固定系统前缀：质量闭环合成集成验收。'}]},
  {role:'user',blocks:[{type:'text',content:'请为 Redis 故障安全回退设计审查推荐适用资产。此为接口联调，不修改工作区，也不声称测试通过。'}]}],
  requestParams:{},metadata:{protocol:'openai',traceId:`quality-smoke-${Date.now()}`,keyId:'quality-smoke',modelId:'deepseek-v4-flash',stream:false,
    spaceId:'default',userId:data.owner,turnSeq:1,agentSource:'codebuddy',custom:{userKey:data.key,session:{session_id:data.session,team_id:data.team,
      task_id:data.task,agent_id:data.agent,user_id:data.owner},taskDetail:{id:data.task,name:'质量闭环验收：Redis 安全回退',description:'在隔离示例 feature_flags v1 中检查单次安全回退、租户隔离与故障恢复。'}}}};
const adapter=new OpenAIAdapter(), registry=new HookRegistryImpl(); registry.register(injector);
const pipeline=new InjectionPipeline(registry,new Map([['openai',adapter]]));
const raw=adapter.serialize(ctx as any), before=JSON.stringify(raw.messages);
let blocks:any[]=[];
const originalApplied=injector.onApplied.bind(injector);
injector.onApplied=async(context,applied)=>{blocks=applied;await originalApplied(context,applied);};
const result=await pipeline.process(raw,ctx.metadata as any);
if(!blocks.length) throw new Error('No approved assets were selected');
if(before!==JSON.stringify((result.messages as any[]).slice(0,(raw.messages as any[]).length))) throw new Error('Pipeline mutated the existing prefix');
if(!(result.messages as any[]).at(-1)?.content?.includes(blocks[0].content)) throw new Error('Applied asset text is absent from serialized upstream messages');
if(injector.point!=='context.tail') throw new Error('Dynamic content is not appended at the tail');
await observeTeamAssetAssistantResponse(config,{sessionId:data.session,turnSeq:1,actorId:data.agent,text:'【合成集成验收响应】已收到资产正文，尚未执行代码修改或测试，不能据此确认实际帮助。',toolCalls:[],
  qualityContext:{spaceId:'default',userKey:data.key,teamId:data.team,taskId:data.task}});
console.log(JSON.stringify({selected:blocks[0].metadata.assetIds,prefix_unchanged:true,placement:injector.point,
  serialized_upstream_content_verified:true,injected_revision_count:blocks[0].metadata.qualityAssets.length,assistant_response_observed:true,real_task_success_claim:false}));
