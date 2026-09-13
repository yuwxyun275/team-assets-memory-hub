import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetHistoryCoordinator, compactionBoundary, messageFingerprint, prefixFingerprints } from "../history.js";
import { AssetHistoryStore, historyScope } from "../history-store.js";
import { renderAssetBody } from "../disclosure.js";
import { AssetDelivery } from "../delivery.js";
import { InjectionPipeline } from "../../injection/pipeline.js";
import { HookRegistryImpl } from "../../injection/registry.js";
import { OpenAIAdapter } from "../../injection/adapters/openai.js";
import { AnthropicAdapter } from "../../injection/adapters/anthropic.js";
import { TeamAssetsOrchestratorInjector } from "../../injection/injectors/team-assets-orchestrator-injector.js";

const mocks = vi.hoisted(() => ({ list: vi.fn(), quality: vi.fn(), deliver: vi.fn() }));
vi.mock("../../meta/client.js", () => ({ getMetadataClient: () => ({ listAccessibleAssets: mocks.list, quality: mocks.quality }) }));
vi.mock("../../injection/injectors/quality-outbox.js", () => ({ deliverQuality: mocks.deliver }));
const asset = (id: string, version = "r1") => ({ asset_id: id, name: `缓存资产 ${id}`, quality_publication: {
  revision_id: version, snapshot: { body: `验证缓存故障及恢复 ${id}。`.repeat(80), content_version: version, declared_scope: "Redis", asset_type: "skill" },
} });
const A = asset("A"), B = asset("B"), C = asset("C");
let directory: string, chosen: string[], permitted = [A, B, C];
beforeEach(async () => {
  vi.clearAllMocks(); directory = await mkdtemp(join(tmpdir(), "proxy-asset-history-test-")); chosen = ["A"]; permitted = [A, B, C];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.list.mockImplementation(async () => permitted);
  mocks.quality.mockImplementation(async (action, input) => action === "disclosure-remember" ? { references: input.references } : {});
  mocks.deliver.mockResolvedValue(undefined);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ trace_id: "trace", token_cost: 100,
    selected: chosen.map(id => ({ asset: { asset_id: id } })), markdown: "<team_assets>legacy full body</team_assets>" }), { status: 200 })));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const msg = (text: string, role: any = "user") => ({ role, blocks: [{ type: "text" as const, content: text }] });
const scope = (session = "session", user = "user") => historyScope({ space: "space", user, team: "team", agent: "agent", task: "task", session, source: "codebuddy" });

function setup(protocol: "openai" | "anthropic" = "openai", budget = 12000) {
  const store = new AssetHistoryStore(directory);
  const core = { endpoint: "http://core", serviceToken: "private-service", timeoutMs: 1000 };
  const registry = new HookRegistryImpl();
  registry.register(new TeamAssetsOrchestratorInjector({ endpoint: "http://ranker", externalUrl: "http://ranker", serviceToken: "",
    timeoutMs: 1000, tokenBudget: 10000, maxAssets: 10, repository: "repo", version: "v1", taskType: "bug_fix", targetPaths: [],
    progressiveDisclosure: true, bridgeBaseUrl: "http://proxy", inlineMaxChars: 600,
  }, core));
  const adapter = protocol === "openai" ? new OpenAIAdapter() : new AnthropicAdapter();
  const coordinator = new AssetHistoryCoordinator({ store, core, bridgeBaseUrl: "http://proxy", tokenBudget: budget });
  const pipeline = new InjectionPipeline(registry, new Map([[protocol, adapter]]), { assetHistory: coordinator });
  const metadata: any = { protocol, traceId: "trace", keyId: "key", modelId: "model", stream: false, userId: "user", spaceId: "space", agentSource: "codebuddy", turnSeq: 1,
    custom: { userKey: "private-business-key", session: { session_id: "session", user_id: "user", team_id: "team", agent_id: "agent", task_id: "task" },
      taskDetail: { description: "修复 Redis 缓存故障" } } };
  const input: any = protocol === "openai" ? { model: "model", messages: [{ role: "system", content: "stable system" }, { role: "user", content: "修复 Redis 缓存故障" }] }
    : { model: "model", max_tokens: 100, system: "stable system", messages: [{ role: "user", content: "修复 Redis 缓存故障" }] };
  const run = (body: any) => pipeline.process(body, structuredClone(metadata)) as Promise<any>;
  return { run, input, pipeline, metadata, store };
}

describe("message and prefix fingerprints", () => {
  it("includes roles, exact whitespace, tool identifiers, images and order", () => {
    expect(messageFingerprint(msg("a"))).not.toBe(messageFingerprint(msg("a", "assistant")));
    expect(messageFingerprint(msg("a"))).not.toBe(messageFingerprint(msg("a ")));
    const tool: any = { role: "tool", blocks: [{ type: "tool_result", content: "ok", metadata: { tool_use_id: "t1" } }] };
    expect(messageFingerprint(tool)).not.toBe(messageFingerprint({ ...tool, blocks: [{ ...tool.blocks[0], metadata: { tool_use_id: "t2" } }] }));
    expect(prefixFingerprints([msg("A"), msg("B")]).at(-1)).not.toBe(prefixFingerprints([msg("B"), msg("A")]).at(-1));
    expect(prefixFingerprints([msg("A"), msg("继续"), msg("继续")])[1]).not.toBe(prefixFingerprints([msg("A"), msg("继续"), msg("继续")])[2]);
    const image: any = { role: "user", blocks: [{ type: "image", content: "data:one" }] };
    expect(messageFingerprint(image)).not.toBe(messageFingerprint({ ...image, blocks: [{ type: "image", content: "data:two" }] }));
  });
  it("does not interpret a changed fingerprint or ordinary summary question as compaction", () => {
    expect(compactionBoundary([msg("请帮我写一个摘要")])).toBeUndefined();
    expect(compactionBoundary([msg("摘要：用户编辑了问题")])).toBeUndefined();
    expect(compactionBoundary([msg("<conversation_summary>缓存修复</conversation_summary>")])).toBe(0);
    expect(compactionBoundary([msg("<conversation_summary>截断")])).toBeUndefined();
  });
});

describe("durable augmentation through the real pipeline", () => {
  it('stages cards until upstream acceptance; failed or stripped requests leave no offered history', async () => {
    const {pipeline,input,metadata,store}=setup();
    const failed=new AssetDelivery(); await pipeline.process(input,{...metadata,assetDelivery:failed});
    expect((await store.read(scope())).entries).toHaveLength(0);
    await failed.accept(input,500); expect((await store.read(scope())).liveRefs).toHaveLength(0);
    const stripped=new AssetDelivery(); await pipeline.process(input,{...metadata,assetDelivery:stripped});
    await stripped.accept(input,200); expect((await store.read(scope())).entries).toHaveLength(0);
    const success=new AssetDelivery(), sent=await pipeline.process(input,{...metadata,assetDelivery:success});
    await success.accept(sent,200); expect((await store.read(scope())).entries).toHaveLength(1);
    expect((await store.read(scope())).liveRefs).toHaveLength(1);
  });
  it('does not commit a stale prepared branch over a later accepted one', async () => {
    const {pipeline,input,metadata,store}=setup();
    const first=new AssetDelivery(), a=await pipeline.process(input,{...metadata,assetDelivery:first});
    chosen=['B']; const second=new AssetDelivery(), b=await pipeline.process(input,{...metadata,assetDelivery:second});
    await second.accept(b,200); await first.accept(a,200);
    const state=await store.read(scope());
    expect(state.liveRefs).toHaveLength(1); expect(state.references[state.liveRefs[0]].asset_id).toBe('B');
  });
  it.each(["openai", "anthropic"] as const)("%s keeps old upstream prefix byte-for-byte and appends only new cards", async protocol => {
    const { run, input, store } = setup(protocol);
    const original = JSON.stringify(input), first = await run(input);
    chosen = ["B"];
    const secondInput = structuredClone(input);
    secondInput.messages.push({ role: "assistant", content: "检查完毕" }, { role: "user", content: "继续验证 Redis 恢复" });
    const second = await run(secondInput);
    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
    expect(JSON.stringify(second.messages.at(-1).content)).toContain("缓存资产 B");
    expect(JSON.stringify(second).match(/缓存资产 A/g)).toHaveLength(1);
    expect(JSON.stringify(input)).toBe(original);
    expect(second.system).toEqual(first.system);
    expect((await store.read(scope())).liveRefs).toHaveLength(2);
    expect(mocks.deliver.mock.calls.filter(c => c[3] === "expose")).toHaveLength(0);
  });
  it("replays old cards when no new asset is selected and on greeting turns", async () => {
    const { run, input } = setup(); const first = await run(input); chosen = [];
    input.messages.push({ role: "assistant", content: "完成" }, { role: "user", content: "你好" });
    const next = await run(input);
    expect(next.messages.slice(0, first.messages.length)).toEqual(first.messages);
    expect(next.messages.at(-1).content).toBe("你好");
  });
  it("does not duplicate an immutable card when only the display name changes", async () => {
    const { run, input, store } = setup(); const first = await run(input);
    permitted = [{ ...A, name: "Redis 新显示名称" }];
    input.messages.push({ role: "assistant", content: "已查看" }, { role: "user", content: "继续 Redis" });
    const next = await run(input);
    expect(next.messages.slice(0, first.messages.length)).toEqual(first.messages);
    expect(JSON.stringify(next).match(/<team_asset_card /g)).toHaveLength(1);
    expect((await store.read(scope())).entries).toHaveLength(1);
  });
  it("survives restart without recording client text or credentials", async () => {
    const { run, input, store } = setup(); const first = await run(input); chosen = [];
    input.messages.push({ role: "assistant", content: "CLIENT_SECRET_TEXT_123" }, { role: "user", content: "继续 Redis" });
    const next = await setup().run(input);
    expect(next.messages.slice(0, first.messages.length)).toEqual(first.messages);
    const file = join(directory, `${scope()}.json`), raw = await readFile(file, "utf8");
    expect(raw).not.toContain("CLIENT_SECRET_TEXT_123"); expect(raw).not.toContain("private-business-key");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await store.read(scope())).entries).toHaveLength(1);
  });
  it("deduplicates client echoes and retries, including concurrent same-request calls", async () => {
    const { run, input, store } = setup(); const first = await run(input);
    expect(await run(first)).toEqual(first);
    const results = await Promise.all([run(input), setup().run(input)]);
    expect(results[0]).toEqual(first); expect(results[1]).toEqual(first);
    expect((await store.read(scope())).entries).toHaveLength(1);
  });
  it("compacts all previously injected valid cards into one frozen index, even if ranker picks none", async () => {
    const { run, input, store } = setup(); await run(input);
    chosen = ["B"]; input.messages.push({ role: "assistant", content: "完成第一步" }, { role: "user", content: "继续 Redis" }); await run(input);
    chosen = [];
    const compacted = { ...input, messages: [input.messages[0], { role: "user", content: "<conversation_summary>已定位 Redis 问题</conversation_summary>" }, { role: "user", content: "检查恢复" }] };
    const out = await run(compacted);
    expect(out.messages[1]).toEqual(compacted.messages[1]);
    expect(out.messages[2].content).toContain("缓存资产 A"); expect(out.messages[2].content).toContain("缓存资产 B");
    expect(out.messages[3]).toEqual(compacted.messages[2]);
    expect(JSON.stringify(out)).not.toContain(A.quality_publication.snapshot.body);
    const state = await store.read(scope());
    expect(state.entries.filter(e => e.active)).toHaveLength(1);
    expect(state.entries.filter(e => e.retired_reason === "compacted")).toHaveLength(2);
    compacted.messages.push({ role: "assistant", content: "恢复正常" }, { role: "user", content: "继续测试" });
    expect((await run(compacted)).messages.slice(0, out.messages.length)).toEqual(out.messages);
  });
  it("plain edits/deletions do not carry old cards into a different history", async () => {
    const { run, input, store } = setup(); await run(input); chosen = [];
    input.messages[1].content = "改为检查另一项 Redis 配置";
    const out = await run(input);
    expect(JSON.stringify(out)).not.toContain("缓存资产 A");
    const state = await store.read(scope()); expect(state.liveRefs).toHaveLength(0);
    expect(state.entries[0].retired_reason).toBe("history_changed");
    input.messages[1].content = "<conversation_summary>另一项任务的摘要</conversation_summary>";
    expect(JSON.stringify(await run(input))).not.toContain("缓存资产 A");
  });
  it("does not carry a revoked or superseded reference; can append a newly approved version", async () => {
    const { run, input } = setup(); await run(input);
    permitted = [asset("A", "r2")]; chosen = ["A"];
    input.messages.push({ role: "assistant", content: "下一步" }, { role: "user", content: "继续 Redis" });
    const out = await run(input);
    expect(JSON.stringify(out)).not.toContain('版本：r1'); expect(JSON.stringify(out)).toContain('版本：r2');
    permitted = []; chosen = [];
    expect(JSON.stringify(await run(input))).not.toContain("缓存资产 A");
  });
  it("isolates users, teams, tasks, agents and sessions", async () => {
    const { run, input, pipeline, metadata } = setup(); await run(input); chosen = [];
    for (const field of ["session_id", "user_id", "team_id", "task_id", "agent_id"]) {
      const meta = structuredClone(metadata); meta.custom.session[field] = "different";
      if (field === "user_id") meta.userId = "different";
      expect(JSON.stringify(await pipeline.process(input, meta))).not.toContain("缓存资产 A");
    }
  });
  it("does not break tool call/result pairing and retains the old card before the assistant call", async () => {
    const { run, input } = setup(); const first = await run(input);
    const tool = { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "Bash", arguments: "{}" } }] };
    const pending = structuredClone(input); pending.messages.push(tool); chosen = ["B"];
    const waiting = await run(pending);
    expect(waiting.messages.at(-1)).toEqual(tool);
    const read = { role: "tool", tool_call_id: "t1", content: renderAssetBody("A", "r1", A.quality_publication.snapshot.body) };
    pending.messages.push(read);
    const out = await run(pending);
    expect(out.messages.slice(0, first.messages.length)).toEqual(first.messages);
    expect(out.messages[first.messages.length]).toEqual(tool); expect(out.messages[first.messages.length + 1]).toEqual(read);
    expect(mocks.deliver.mock.calls.filter(c => c[3] === "expose")).toHaveLength(1);
  });
  it("overflow keeps a readable directory and full live reference ledger, not a sliced card", async () => {
    chosen = ["A", "B", "C"]; const { run, input, store } = setup(); await run(input); chosen = [];
    const compacted = { ...input, messages: [input.messages[0], { role: "user", content: "<context_summary>Redis 任务摘要</context_summary>" }] };
    const out = await setup("openai", 1100).run(compacted);
    expect(JSON.stringify(out)).toContain("/asset-bridge/list");
    const state = await store.read(scope()); expect(state.liveRefs).toHaveLength(3);
    const active = state.entries.filter(e => e.active);
    expect(active).toHaveLength(1); expect(active[0].refs.length).toBeLessThan(3);
    expect((active[0].content.match(/<team_asset_card /g) || []).length).toBe((active[0].content.match(/<\/team_asset_card>/g) || []).length);
  });
  it("does not persist a read-only/fork request", async () => {
    const { input, pipeline, metadata } = setup(); metadata.readOnly = true;
    await pipeline.process(input, metadata);
    expect(await readdir(directory)).toEqual([]);
  });
  it("storage/ACL failures never allow stale replay", async () => {
    const { run, input } = setup(); await run(input);
    mocks.list.mockRejectedValueOnce(new Error("ACL unavailable"));
    await expect(run(input)).rejects.toThrow("ACL unavailable");
    // The outer HTTP handler's existing fail-open path forwards the original
    // client request when pipeline processing rejects.
  });
});
