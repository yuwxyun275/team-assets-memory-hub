import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteMetadataStore } from "../../metadata/store/sqlite-adapter.js";
import { MetadataService } from "../../metadata/service/metadata-service.js";
import { validateLearningResult, type LearningInput } from "../learning.js";
import { createLearningGenerator } from "../learning-generator.js";
import { parseSkillFile, validateSkillFile } from "../../core/skill/skill-format.js";
import { usageWindowHash, USAGE_EVIDENCE_CONTRACT } from "../usage-result.js";
const databases: SqliteMetadataStore[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.restoreAllMocks(); });
const caller = { userId: "owner", token: "test", isAdmin: false, isSystemAdmin: false };
const input: LearningInput = { mode: "history", repository: "synthetic/inventory", version: "v1", scope: "库存重复请求的检查",
  sources: [{ id: "doc", kind: "document", locator: "contract.md", revision: "v1", synthetic: true, visibility: "team",
    content: "检查重复请求是否只产生一次库存副作用。读取项目约定，执行重复请求测试，参数冲突时停止并检查业务规则。" }] };
function proposal(kind = "skill_candidate") {
  return { kind, title: "库存重复请求检查", claim: "依据当前项目约定检查重复请求的副作用", action: "读取约定后执行重复请求测试", applicability: "具有请求标识和可观察副作用的接口；生产并发未验证", risk: "medium",
    evidence: [{ source_id: "doc", quote: input.sources[0].content }],
    workflow: { purpose: "检查重复请求的业务行为", inputs: [{ name: "project_root", description: "待检查工作区", required: true }],
      preconditions: ["能够读取当前项目的业务约定"], steps: [{ id: "inspect", instruction: "读取项目约定并识别副作用", expected_result: "找到当前项目规则", on_failure: "没有规则时停止并补充信息", evidence_indices: [0] }],
      verification: [{ instruction: "按当前项目规则执行重复请求测试", success_criteria: "实际副作用次数符合项目约定", evidence_indices: [0] }],
      stop_conditions: ["业务约定缺失或相互冲突"], recovery: ["保留失败证据，提出适配修订"], non_goals: ["不推断生产并发和跨进程保证"],
      portability: { level: "cross_project", rationale: "检查方法可以迁移，具体业务规则依赖项目", requirements: ["明确请求标识和副作用约定"], parameter_names: ["project_root"] } } };
}
function fixture() {
  const db = new SqliteMetadataStore(":memory:"); db.init(); databases.push(db);
  const assets = new Map<string, any>(), tasks = new Map<string, any>();
  const store = { qualityRecords: db.qualityRecords, getTeamById: vi.fn(async () => ({ team_id: "team" })),
    getTeamMember: vi.fn(async () => ({ role: "admin", status: "active" })),
    getAssetById: vi.fn(async (id: string) => assets.get(id) ?? null), listAclByAsset: vi.fn(async () => ({ items: [], total: 0 })),
    listAssetsByTeam: vi.fn(async () => ({ items: [...assets.values()], total: assets.size })),
    createAsset: vi.fn(async (a: any) => { const row = { ...a, version: 1 }; assets.set(a.asset_id, row); return row; }),
    updateAsset: vi.fn(async (id: string, p: any) => { const a = { ...assets.get(id), ...p }; assets.set(id, a); return a; }),
    getTaskById: vi.fn(async (id: string) => tasks.get(id) ?? null) };
  return { service: new MetadataService(store as any), records: db.qualityRecords, assets, tasks, store };
}
async function submit(f: ReturnType<typeof fixture>, value = input) {
  const job = await f.service.qualityForCaller("learning-submit", { team_id: "team", input: value }, caller);
  await f.service.learning!.queue.tick();
  return (await f.records.get(job.key))!;
}

describe("evidence-bound procedure learning", () => {
  it.each(["skill_candidate", "workflow_candidate"])("generates %s with real SDK mock transport and requires publication review", async kind => {
    const f = fixture();
    const transport = vi.fn(async (_u, options) => {
      const request = JSON.parse(String(options?.body)); expect(request.tools).toBeUndefined();
      return new Response(JSON.stringify({ id: "mock", object: "chat.completion", created: 1, model: "fixture", choices: [{ index: 0, finish_reason: "stop",
        message: { role: "assistant", content: JSON.stringify({ candidates: [proposal(kind)], reason: "有来源的流程候选，待审核" }) } }],
        usage: { prompt_tokens: 120, completion_tokens: 50, total_tokens: 170 } }), { headers: { "content-type": "application/json" } });
    });
    f.service.setAssetLearningGenerator(createLearningGenerator({ baseUrl: "https://fixture.invalid/v1", apiKey: "fixture", model: "fixture" }, transport as any));
    const job = await submit(f), id = job.data.candidate_ids[0], asset = f.assets.get(id);
    expect(job.data.state).toBe("completed"); expect(asset.asset_type).toBe("skill");
    const candidate = (await f.records.get(`learning-candidate:${id}`))!.data;
    expect(() => validateSkillFile(parseSkillFile(candidate.snapshot.body))).not.toThrow();
    expect(candidate.snapshot.body).toContain("实际验证范围：尚无本候选完整流程的独立执行验证");
    expect(candidate.snapshot.workflow_scope).toMatchObject({ suggested: "cross_project", verification_status: "unverified_workflow" });
    expect(candidate.source_manifest[0].synthetic).toBe(true);
    expect((await f.service.checkAssetPermission({ user_id: "owner", asset_id: id, action: "use" })).allowed).toBe(false);
    f.service.setAssetQualityReviewer({ id: "fake-review", review: async (s, criteria) => ({ checks: criteria.map(c => ({ id: c.id, status: "pass", score: 4,
      reason: "本地协议测试，不是真实质量评估", evidence: [{ source_id: "asset", quote: s.body }, { source_id: "doc", quote: s.sources[0].content }] })) }) });
    await f.service.quality!.tick();
    const revision = (await f.service.quality!.details("team", id)).revisions[0];
    expect(revision.data.state).toBe("awaiting_approval");
    await f.service.qualityForCaller("decide", { team_id: "team", revision_id: revision.data.id, decision: "approve", note: "合成流程的审核协议验证" }, caller);
    expect((await f.service.checkAssetPermission({ user_id: "owner", asset_id: id, action: "use" })).allowed).toBe(true);
    expect((await f.service.quality!.publication("team", id))!.snapshot.workflow_scope!.verification_status).toBe("unverified_workflow");
  });
  it("rejects fabricated verification, missing migration parameters and ungrounded steps", () => {
    const valid = () => ({ candidates: [proposal()], reason: "检查" });
    const missing = valid(); missing.candidates[0].workflow.steps[0].evidence_indices = [99];
    expect(() => validateLearningResult(missing, input)).toThrow(/步骤引用/);
    const params = valid(); params.candidates[0].workflow.portability.parameter_names = ["invented"];
    expect(() => validateLearningResult(params, input)).toThrow(/迁移参数/);
    const verified: any = valid(); verified.candidates[0].workflow.verified_scopes = ["all"];
    expect(() => validateLearningResult(verified, input)).toThrow();
    const fake = valid(); fake.candidates[0].evidence[0].quote = "未提供的执行结果";
    expect(() => validateLearningResult(fake, input)).toThrow(/引用/);
  });
  it("compares readable candidates and deduplicates an identical workflow across changed evidence", async () => {
    const f = fixture(); let observed: LearningInput | undefined;
    f.service.setAssetLearningGenerator({ id: "fake", generate: async i => { observed = i; return { candidates: [proposal()], reason: "同一方法" }; } });
    const first = await submit(f), id = first.data.candidate_ids[0];
    const second = await submit(f, { ...input, scope: input.scope + "，补充一次观察" });
    expect(observed!.sources.some(s => s.asset_id === id)).toBe(true);
    expect(f.assets.size).toBe(1); expect(second.data.state).toBe("reused");
    expect(second.data.decisions[0].kind).toBe("duplicate_candidate");
    expect((await f.records.list("learning-resolution", "team"))).toHaveLength(1);
  });
  it("records a reuse suggestion without creating an asset or fabricating adoption", async () => {
    const f = fixture();
    f.service.setAssetLearningGenerator({ id: "fake", generate: async () => ({ candidates: [proposal()], reason: "新方法" }) });
    const first = await submit(f), id = first.data.candidate_ids[0];
    f.service.setAssetLearningGenerator({ id: "fake", generate: async i => {
      const old = i.sources.find(s => s.asset_id === id)!;
      return { candidates: [{ ...proposal(), workflow: undefined, kind: "reuse_existing", target_asset_id: id,
        evidence: [{ source_id: "doc", quote: input.sources[0].content }, { source_id: old.id, quote: old.content }] }], reason: "已有候选覆盖" };
    } });
    const second = await submit(f, { ...input, scope: "库存重复请求的再次检查" });
    expect(second.data.state).toBe("reused"); expect(f.assets.size).toBe(1);
    expect((await f.records.list("learning-resolution", "team"))[0].data.assurance).toBe("reuse_suggestion_not_observed_adoption");
    expect(await f.records.list("exposure", "team")).toEqual([]);
  });
  it("offers evidence-bound workflow revisions without editing the original", async () => {
    const f = fixture();
    f.service.setAssetLearningGenerator({ id: "fake", generate: async () => ({ candidates: [proposal()], reason: "初始流程" }) });
    const first = await submit(f), id = first.data.candidate_ids[0], original = structuredClone(f.assets.get(id));
    f.service.setAssetLearningGenerator({ id: "fake", generate: async i => {
      const old = i.sources.find(s => s.asset_id === id)!;
      return { candidates: [{ ...proposal("revision_suggestion"), target_asset_id: id, title: "库存重复请求检查补充",
        evidence: [{ source_id: "doc", quote: input.sources[0].content }, { source_id: old.id, quote: old.content }] }], reason: "范围需要补充" };
    } });
    const second = await submit(f, { ...input, scope: "库存重复请求检查补充" });
    expect(second.data.state).toBe("completed"); expect(f.assets.size).toBe(2);
    expect(f.assets.get(id)).toEqual(original); expect(f.store.updateAsset).not.toHaveBeenCalled();
  });
  it("does not send private comparison material to a different owner", async () => {
    const f = fixture();
    f.service.setAssetLearningGenerator({ id: "fake", generate: async () => ({ candidates: [proposal()], reason: "流程" }) });
    const first = await submit(f, { ...input, sources: input.sources.map(s => ({ ...s, visibility: "private" })) });
    f.assets.get(first.data.candidate_ids[0]).owner_user_id = "someone-else";
    let compared = 0;
    f.service.setAssetLearningGenerator({ id: "fake", generate: async i => { compared = i.sources.filter(s => s.asset_id).length; return { candidates: [], reason: "不生成" }; } });
    await submit(f, { ...input, scope: input.scope + "新的问题" });
    expect(compared).toBe(0);
  });
  it("keeps historical comparison evidence readable after a source changes, while enforcing revocations", async () => {
    const f = fixture();
    f.service.setAssetLearningGenerator({ id: "fake", generate: async () => ({ candidates: [proposal()], reason: "流程" }) });
    const first = await submit(f), id = first.data.candidate_ids[0];
    f.service.setAssetLearningGenerator({ id: "fake", generate: async () => ({ candidates: [], reason: "已有方法" }) });
    const second = await submit(f, { ...input, scope: "库存重复请求补充检查" });
    f.assets.get(id).status = "approved"; // Original draft is no longer the current comparison snapshot.
    const audit = await f.service.qualityForCaller("learning-details", { team_id: "team", job_id: second.key }, caller);
    expect(audit.data.prepared_input.sources.some((s: any) => s.asset_id === id)).toBe(true);
    f.assets.get(id).visibility = "private"; f.assets.get(id).owner_user_id = "someone-else";
    await expect(f.service.qualityForCaller("learning-details", { team_id: "team", job_id: second.key }, caller)).rejects.toMatchObject({ code: "permission_denied" });
  });
  it("coalesces stage results and late feedback with a per-task cooldown, and normalizes profile fields", async () => {
    const f = fixture();
    const task: any = { task_id: "task", team_id: "team", creator_user_id: "owner", title: "库存检查", status: "in_progress",
      metadata_json: JSON.stringify({ asset_evidence: { trace_id: "trace", task_profile: { repository: { value: "synthetic/inventory" }, version: { value: "v1" } },
        completion: { failed_tests: ["repeat_request"] } } }) };
    f.tasks.set("task", task);
    await f.service.learning!.recordTask(task); const first = (await f.records.list("learning-trigger", "team"))[0];
    await f.service.learning!.recordTask(task); expect((await f.records.get(first.key))!.rev).toBe(first.rev);
    expect(first.data.reason).toBe("stage_result"); expect(first.data.due).toBeGreaterThan(Date.now());
    await f.records.cas({ ...first, data: { ...first.data, due: 0 } }, first.rev);
    let actual: LearningInput | undefined;
    f.service.setAssetLearningGenerator({ id: "fake", generate: async i => { actual = i; return { candidates: [], reason: "没有确定方法" }; } });
    await f.service.learning!.queue.tick(); expect(actual!.repository).toBe("synthetic/inventory"); expect(actual!.version).toBe("v1");
    await f.records.cas({ key: "exposure:late", kind: "exposure", team: "team", rev: 0, updated: Date.now(), data: {
      actor: "owner", task_id: "task", state: "observing", expires: Date.now() + 100000, events: [{ id: "tool-result", content: "重复扣减" }],
      assessment: { outcome: "content_error", reason: "缺少幂等检查", evidence_contract: USAGE_EVIDENCE_CONTRACT,
        event_hash: usageWindowHash({ events: [{ id: "tool-result", content: "重复扣减" }] }) } } }, 0);
    await f.service.learning!.queue.tick(); const late = (await f.records.get(first.key))!;
    expect(late.data.state).toBe("queued"); expect(late.data.reason).toBe("correction_observed");
    expect(late.data.due).toBeGreaterThanOrEqual(first.data.due);
    await f.service.learning!.queue.tick(); expect((await f.records.get(first.key))!.rev).toBe(late.rev);
  });
});
