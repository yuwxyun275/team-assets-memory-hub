/** Server-owned opt-in pilot bindings. No client prompt/metadata can choose an arm. */
import {readFileSync,appendFileSync,mkdirSync,existsSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {createHash} from "node:crypto";
import type {AgentContext,ContextMessage} from "../injection/types.js";
export type BenchRun={run_id:string;arm:"front_dynamic_cards"|"history_append_cards"|"no_team_assets";task_id:string;workspace:string;repository?:string;version?:string;learn_utility?:boolean};
export type BenchManifest={team_id:string;agent_id:string;user_id:string;run_id:string;runs:BenchRun[];max_calls_per_run:number};
function configured():BenchManifest|undefined {
  const path=process.env.ASSET_BENCH_MANIFEST;
  return path?JSON.parse(readFileSync(path,"utf8")):undefined;
}
export function benchmarkBinding(session:any,user?:string,manifest=configured()):BenchRun|undefined {
  if(!manifest||!session||user!==manifest.user_id||session.user_id!==user||session.team_id!==manifest.team_id||session.agent_id!==manifest.agent_id)return;
  return manifest.runs.find(r=>r.task_id===session.task_id);
}
export const BENCH_NO_NATIVE_ASSETS={skill:false,chat_memory:false,llm_wiki:false,code_graph:false};
export function moveBenchmarkAugmentsToFront(ctx:AgentContext) {
  const owned=ctx.messages.filter(m=>m.metadata?.proxyAssetAugment===true);
  ctx.messages=ctx.messages.filter(m=>m.metadata?.proxyAssetAugment!==true);
  const index=ctx.messages.findIndex(m=>m.role!=="system");
  ctx.messages.splice(index<0?ctx.messages.length:index,0,...owned);
}
const digest=(v:unknown)=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
export function auditBenchmarkRequest(ctx:AgentContext,run:BenchRun) {
  validateBenchmarkRequest(ctx,run);
  const directory=process.env.ASSET_BENCH_AUDIT_DIR;
  if(!directory)throw Error("benchmark_audit_required");
  mkdirSync(directory,{recursive:true,mode:0o700});
  const manifest=configured()!,counter=join(directory,`${run.run_id}.count`);
  const count=existsSync(counter)?Number(readFileSync(counter,"utf8")):0;
  if(count>=manifest.max_calls_per_run)throw Error("benchmark_request_budget_exhausted");
  // Synchronous reservation prevents overlapping requests from evading the local budget.
  writeFileSync(counter,String(count+1),{mode:0o600});
  const messages:ContextMessage[]=ctx.messages;
  appendFileSync(join(directory,"requests.jsonl"),JSON.stringify({phase:"prepared",at:new Date().toISOString(),...run,request_id:ctx.metadata.traceId,session_id:(ctx.metadata.custom?.session as any)?.session_id,
    model:ctx.metadata.modelId,sequence:count+1,messages_sha256:digest(messages),messages,tools:ctx.tools,
    card_count:messages.reduce((n,m)=>n+m.blocks.reduce((v,b)=>v+(b.content.match(/<team_asset_card /g)||[]).length,0),0)})+"\n",{mode:0o600});
  ctx.requestParams.user_id=`${manifest.run_id}-${run.run_id}`;
  ctx.metadata.assetDelivery?.defer(async () => {
    appendFileSync(join(directory,"deliveries.jsonl"),JSON.stringify({at:new Date().toISOString(),run_id:run.run_id,request_id:ctx.metadata.traceId,phase:"upstream_accepted"})+"\n",{mode:0o600});
  });
}
export function validateBenchmarkRequest(ctx:AgentContext,run:BenchRun) {
  if(!ctx.metadata.custom?.workspaceFolder)throw Error('workspace_confirmation_required');
  if(ctx.metadata.custom?.workspaceFolder!==run.workspace)throw Error("benchmark_workspace_mismatch");
}
export function auditBenchmarkResponse(session:any,user:string|undefined,requestId:string,usage:unknown,output:unknown) {
  const run=benchmarkBinding(session,user),directory=process.env.ASSET_BENCH_AUDIT_DIR;
  if(!run||!directory)return;
  appendFileSync(join(directory,"responses.jsonl"),JSON.stringify({at:new Date().toISOString(),...run,request_id:requestId,session_id:session.session_id,usage,output})+"\n",{mode:0o600});
}
