import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamAssetsOrchestratorInjector,sanitizeAccessibleAsset } from "../../injection/injectors/team-assets-orchestrator-injector.js";
import { HookRegistryImpl } from "../../injection/registry.js";
import { InjectionPipeline } from "../../injection/pipeline.js";
import { OpenAIAdapter } from "../../injection/adapters/openai.js";
import { AnthropicAdapter } from "../../injection/adapters/anthropic.js";
import { renderAssetBody } from "../disclosure.js";
import { AssetDelivery } from "../delivery.js";

const mocked = vi.hoisted(() => ({ list: vi.fn(), quality: vi.fn(), deliver: vi.fn() }));
vi.mock("../../meta/client.js", () => ({ getMetadataClient: () => ({ listAccessibleAssets: mocked.list, quality: mocked.quality }) }));
vi.mock("../../injection/injectors/quality-outbox.js", () => ({ deliverQuality: mocked.deliver }));
const body = "缓存故障后需要验证恢复。".repeat(100);
const asset = { asset_id: "asset", name: "缓存恢复测试", quality_publication: { revision_id: "rev1", snapshot: {
  asset_id: "asset", asset_type: "skill", content_version: "v1", body, declared_scope: "Redis 缓存故障与恢复验证",
} } };
beforeEach(() => {
  vi.clearAllMocks(); vi.spyOn(console, "log").mockImplementation(() => {});
  mocked.list.mockResolvedValue([asset]); mocked.deliver.mockResolvedValue(undefined);
  let scene: unknown;
  mocked.quality.mockImplementation(async (action, input) => {
    if (action === "disclosure-remember") scene ??= input.before;
    if (["disclosure-remember", "disclosure-list"].includes(action)) return {
      references: scene ? [{ asset_id: "asset", revision_id: "rev1", before: scene }] : [] };
    return {};
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ trace_id: "trace", token_cost: 500,
    selected: [{ asset: { asset_id: "asset" } }], markdown: `<team_assets>LEGACY FULL BODY ${body}</team_assets>` }), { status: 200 })));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup(protocol: "openai" | "anthropic") {
  const injector = new TeamAssetsOrchestratorInjector({ endpoint: "http://ranker", externalUrl: "http://ranker", serviceToken: "",
    timeoutMs: 1000, tokenBudget: 2800, maxAssets: 4, repository: "repo", version: "v1", taskType: "bug_fix", targetPaths: [],
    progressiveDisclosure: true, bridgeBaseUrl: "http://127.0.0.1:8096", inlineMaxChars: 600,
  }, { endpoint: "http://core", serviceToken: "secret", timeoutMs: 1000 });
  const adapter = protocol === "openai" ? new OpenAIAdapter() : new AnthropicAdapter();
  const registry = new HookRegistryImpl(); registry.register(injector);
  const metadata: any = { protocol, traceId: "trace", keyId: "k", modelId: "m", stream: false, userId: "owner", spaceId: "space", agentSource: "codebuddy", turnSeq: 1,
    custom: { userKey: "secret-key", session: { session_id: "session", user_id: "owner", team_id: "team", agent_id: "agent", task_id: "task" },
      taskDetail: { description: "修复 Redis 缓存故障，测试故障与恢复。" } } };
  const input: any = protocol === "openai" ? { model: "m", messages: [{ role: "system", content: "stable system" }, { role: "user", content: "修复 Redis 缓存故障" }] }
    : { model: "m", max_tokens: 100, system: "stable system", messages: [{ role: "user", content: "修复 Redis 缓存故障" }] };
  return { input, metadata, pipeline: new InjectionPipeline(registry, new Map([[protocol, adapter]])), adapter };
}
describe("progressive assets through the real injection pipeline", () => {
  it('does not credit a prepared body when the final transport rejects or removes it',async()=>{
    const {input,metadata,pipeline}=setup('openai');
    const original=structuredClone(input);
    input.messages.push({role:'tool',tool_call_id:'read1',content:renderAssetBody('asset','rev1',body)});
    for(const status of [500,200]) {
      const delivery=new AssetDelivery();await pipeline.process(input,{...metadata,assetDelivery:delivery});
      await delivery.accept(original,status);
    }
    expect(mocked.deliver.mock.calls.filter(c=>c[3]==='expose')).toHaveLength(0);
    expect(vi.mocked(fetch).mock.calls.filter(([url])=>String(url).endsWith('/v1/evidence/injected'))).toHaveLength(0);
    const delivery=new AssetDelivery(), sent=await pipeline.process(input,{...metadata,assetDelivery:delivery});
    expect(mocked.deliver.mock.calls.filter(c=>c[3]==='expose')).toHaveLength(0);
    await delivery.accept(sent,200);
    expect(mocked.deliver.mock.calls.filter(c=>c[3]==='expose')).toHaveLength(1);
  });
  it("keeps reviewed content and gate outcomes but omits redundant review evidence from ranker payload",()=>{
    const value:any={...asset,quality_publication:{...asset.quality_publication,approved_by:"reviewer",snapshot:{...asset.quality_publication.snapshot,sources:[{content:"source evidence"}]},report:{decision:"pass",snapshot_sha256:"hash",checks:[{quote:"long repeated source evidence"}],scorecard:{quality:90,evidence_coverage:100}}}};
    value.source_type = 'asset_learning';
    value.quality_publication.snapshot.project_scope = { repository: 'synthetic/inventory', version: 'v1', synthetic: true };
    value.quality_publication.snapshot.workflow_scope = { suggested: 'cross_project', requirements: ['核对项目约定'], verification_status: 'unverified_workflow', admission: 'check_preconditions_before_execution' };
    const sanitized:any=sanitizeAccessibleAsset(value);
    expect(sanitized.source_type).toBe('asset_learning');
    expect(sanitized.quality_publication.snapshot.project_scope).toEqual(value.quality_publication.snapshot.project_scope);
    expect(sanitized.quality_publication.snapshot.workflow_scope).toEqual(value.quality_publication.snapshot.workflow_scope);
    expect(sanitized.quality_publication.snapshot.body).toBe(body);
    expect(sanitized.quality_publication.report.scorecard.quality).toBe(90);
    expect(JSON.stringify(sanitized)).not.toContain("source evidence");
    expect(value.quality_publication.snapshot.sources).toHaveLength(1);
  });
  it.each(["openai", "anthropic"] as const)("%s sends cards first, then reuses read bodies; preserves prefix and counts only bodies", async protocol => {
    const { input, metadata, pipeline, adapter } = setup(protocol);
    const original = JSON.stringify(input), canonical = adapter.serialize(adapter.parse(input, metadata));
    const first: any = await pipeline.process(input, metadata);
    expect(first.messages.slice(0, (canonical.messages as unknown[]).length)).toEqual(canonical.messages);
    expect(first.system).toEqual(canonical.system); expect(JSON.stringify(input)).toBe(original);
    expect(JSON.stringify(first)).toContain("team_asset_card"); expect(JSON.stringify(first)).not.toContain(body);
    expect(mocked.quality).toHaveBeenCalledWith("disclosure-remember", expect.objectContaining({ session_id: "session", agent_id: "agent", task_id: "task" }));
    expect(mocked.deliver.mock.calls.filter(c => c[3] === "expose")).toHaveLength(0);
    const frozen = mocked.quality.mock.calls.find(c => c[0] === "disclosure-remember")![1].before;
    expect(frozen.query).toContain("Redis");
    expect(mocked.quality).toHaveBeenCalledWith("utility", expect.objectContaining({ before: frozen }));

    const full = renderAssetBody("asset", "rev1", body);
    const read: any = structuredClone(input);
    if (protocol === "openai") read.messages.push({ role: "assistant", content: null, tool_calls: [{ id: "tool1", type: "function", function: { name: "Bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "tool1", content: full });
    else read.messages.push({ role: "assistant", content: [{ type: "tool_use", id: "tool1", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tool1", content: full }] });
    const readCanonical = adapter.serialize(adapter.parse(read, metadata));
    const second = await pipeline.process(read, metadata);
    expect(second.messages).toEqual(readCanonical.messages); // no extra body/card/message
    expect(mocked.deliver.mock.calls.filter(c => c[3] === "expose")).toHaveLength(1);
    const delivered = mocked.deliver.mock.calls.find(c => c[3] === "expose")![4].exposure;
    expect(delivered.before).toEqual(frozen);
    expect(JSON.stringify(delivered.before)).not.toContain(body);
    expect(delivered.baseline_event_ids.length).toBeGreaterThan(frozen.events.length - 2);

    // Compression removes the tool body and leaves only a summary.
    mocked.deliver.mockClear();
    const compressed = structuredClone(input); compressed.messages.push({ role: "user", content: "继续 Redis 测试；之前读过 asset rev1。" });
    const third = await pipeline.process(compressed, metadata);
    expect(JSON.stringify(third)).toContain("team_asset_card"); expect(JSON.stringify(third)).not.toContain(body);
    expect(mocked.deliver.mock.calls.filter(c => c[3] === "expose")).toHaveLength(0);
  });
  it("does not advertise unusable pointers when durable registration fails", async () => {
    const { input, metadata, pipeline, adapter } = setup("openai");
    mocked.quality.mockImplementation(async action => { if (action === "disclosure-remember") throw new Error("store unavailable"); return { references: [] }; });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await pipeline.process(input, metadata)).toEqual(adapter.serialize(adapter.parse(input, metadata)));
  });
  it("acknowledges a read body even when its card is already in replayed history", async () => {
    const { input, metadata, pipeline } = setup("openai");
    const { referenceKey } = await import("../disclosure.js");
    metadata.custom.assetHistoryVisibleCardKeys = [referenceKey("asset", "rev1")];
    input.messages.push({ role: "assistant", content: null, tool_calls: [{ id: "read1", type: "function", function: { name: "Bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "read1", content: JSON.stringify({ result: { stdout: renderAssetBody("asset", "rev1", body).replace("\n</team_asset_content>", "\n\n</team_asset_content\n").replace(/\n/g, "\r\n") } }) });
    await pipeline.process(input, metadata);
    expect(mocked.deliver.mock.calls.filter(c => c[3] === "expose")).toHaveLength(1);
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url).endsWith("/v1/evidence/injected") && JSON.parse(String(init?.body)).asset_ids.includes("asset"))).toBe(true);
  });
});
