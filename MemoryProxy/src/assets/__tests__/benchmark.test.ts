import {describe,it,expect,afterEach,vi} from "vitest";
import {benchmarkBinding,moveBenchmarkAugmentsToFront,type BenchManifest} from "../benchmark.js";
import {InjectionPipeline} from "../../injection/pipeline.js";
import {HookRegistryImpl} from "../../injection/registry.js";
import {OpenAIAdapter} from "../../injection/adapters/openai.js";
import {mkdtempSync,writeFileSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
const manifest:BenchManifest={team_id:"team",agent_id:"agent",user_id:"user",run_id:"pilot",max_calls_per_run:2,runs:[{run_id:"c",arm:"no_team_assets",task_id:"task",workspace:"/workspace"}]};
const session={user_id:"user",team_id:"team",agent_id:"agent",task_id:"task",session_id:"s"};
afterEach(()=>vi.unstubAllEnvs());
describe("server-owned benchmark routing",()=>{
  it("requires all authenticated binding fields, not a client arm string",()=>{
    expect(benchmarkBinding(session,"user",manifest)?.arm).toBe("no_team_assets");
    for(const field of ["user_id","team_id","agent_id","task_id"])expect(benchmarkBinding({...session,[field]:"other"},"user",manifest)).toBeUndefined();
    expect(benchmarkBinding(session,"other",manifest)).toBeUndefined();
  });
  it("moves only proxy-owned messages and preserves client tool and system content",()=>{
    const client=[{role:"system",blocks:[{type:"text",content:"system"}]},{role:"user",blocks:[{type:"text",content:"quoted <team_asset_card> is client text"}]},{role:"tool",blocks:[{type:"tool_result",content:"result"}]}];
    const augment={role:"user",blocks:[{type:"text",content:"card"}],metadata:{proxyAssetAugment:true}};
    const ctx:any={messages:[...client,augment]};moveBenchmarkAugmentsToFront(ctx);
    expect(ctx.messages).toEqual([client[0],augment,...client.slice(1)]);
  });
  it("C skips every injector and history, preserves client data, reserves bounded requests",async()=>{
    const dir=mkdtempSync(join(tmpdir(),"asset-bench-")),file=join(dir,"manifest.json");writeFileSync(file,JSON.stringify(manifest));
    vi.stubEnv("ASSET_BENCH_MANIFEST",file);vi.stubEnv("ASSET_BENCH_AUDIT_DIR",dir);
    const execute=vi.fn(),processHistory=vi.fn();const registry=new HookRegistryImpl();registry.register({id:"team-assets-orchestrator-injector",point:"context.tail",priority:1,description:"test",execute});
    const pipeline=new InjectionPipeline(registry,new Map([["openai",new OpenAIAdapter()]]),{assetHistory:{prepare:vi.fn(),process:processHistory} as any});
    const body={messages:[{role:"system",content:"system"},{role:"user",content:"task"}]};const meta:any={protocol:"openai",userId:"user",traceId:"req",modelId:"model",custom:{session,workspaceFolder:"/workspace"}};
    const result=await pipeline.process(body,meta);expect(result.messages).toEqual(body.messages);expect(result.user_id).toBe("pilot-c");
    expect(execute).not.toHaveBeenCalled();expect(processHistory).not.toHaveBeenCalled();
    await pipeline.process(body,meta);await expect(pipeline.process(body,meta)).rejects.toThrow("budget_exhausted");
    expect(readFileSync(join(dir,"requests.jsonl"),"utf8").trim().split("\n")).toHaveLength(2);
  });
});
