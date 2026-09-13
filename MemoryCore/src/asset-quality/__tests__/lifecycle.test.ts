import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMetadataStore } from "../../metadata/store/sqlite-adapter.js";
import { QualityLifecycle } from "../lifecycle.js";
import { scoreChecks } from "../scorecard.js";
import { evaluateQuality } from "../evaluator.js";
import { snapshot } from "./fixtures.js";
import { usageWindowHash, USAGE_EVIDENCE_CONTRACT } from "../usage-result.js";
import type { ModelReviewer, QualitySnapshot } from "../types.js";

const stores: SqliteMetadataStore[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); vi.useRealTimers(); });
/** Contract oracle ONLY, not a claim of real-model accuracy. */
const reviewer: ModelReviewer = { id: "synthetic-oracle/v2", review: async (s, criteria) => ({ checks: criteria.map(c => ({
  id: c.id, status: "pass", score: 4, reason: "合成测试判定器：验证评分、证据与发布契约，不代表真实评估准确率。",
  evidence: [{ source_id: "asset", quote: s.body }, ...(c.supportKinds ? [{ source_id: s.sources[0].id, quote: s.sources[0].content }] : [])],
})) }) };
function setup(file = ":memory:") {
  const store = new SqliteMetadataStore(file); store.init(); stores.push(store);
  let version = 1;
  const lifecycle = new QualityLifecycle(store.qualityRecords, async id => id === "asset-1" ? { version, team_id: "team-1" } : null);
  lifecycle.reviewer = reviewer;
  return { store, lifecycle, setVersion: (v: number) => { version = v; } };
}
async function publish(l: QualityLifecycle, type: QualitySnapshot["asset_type"] = "llm_wiki") {
  const submitted = await l.submit("team-1", "owner", 1, snapshot(type));
  await l.tick();
  const ready = await l.records.get(submitted!.key);
  expect(ready!.data.state).toBe("awaiting_approval");
  await l.decide("team-1", "reviewer", ready!.data.id, "approve", "人工核对测试材料");
  return (await l.publication("team-1", "asset-1"))!;
}
async function expose(l: QualityLifecycle) {
  const p = await publish(l);
  return l.expose("team-1", "user", { asset_id: "asset-1", revision_id: p.revision_id, task_id: "task", session_id: "session", turn: 1,
    context: { repository: "repo", task_type: "bug_fix", environment: "v1" }, injected_text: p.snapshot.body, request_id: "request", baseline_event_ids: ["old"] });
}

describe("durable quality lifecycle", () => {
  it("evaluates an opt-in bounded batch with one independent report per revision", async () => {
    const { lifecycle:l }=setup(); const review=vi.fn(reviewer.review);l.reviewer={...reviewer,review};
    await l.setPolicy("team-1","admin",{minimum_quality:80,retention_days:30,review_parallelism:2,note:"两条并发评估保持独立报告"});
    const jobs=[];
    for(let i=0;i<3;i++)jobs.push(await l.submit("team-1","owner",1,{...snapshot(),unit_id:`unit-${i}`}));
    await l.tick();expect(review).toHaveBeenCalledTimes(2);
    const states=await Promise.all(jobs.map(j=>l.records.get(j!.key)));
    expect(states.filter(r=>r!.data.state==="awaiting_approval")).toHaveLength(2);
    expect(states.filter(r=>r!.data.state==="queued")).toHaveLength(1);
  });
  it("keeps bounded per-team review quotas without lowering quality gates", async () => {
    const { lifecycle: l } = setup();
    expect(await l.policy("team-1")).toMatchObject({review_daily_limit: 200, review_queue_limit: 50, minimum_quality: 80});
    await l.setPolicy("team-1", "admin", {minimum_quality: 80, retention_days: 30, review_daily_limit: 500, review_queue_limit: 1, note: "隔离批量验收提高每日额度"});
    await l.submit("team-1", "owner", 1, snapshot());
    await expect(l.submit("team-1", "owner", 1, {...snapshot(), unit_id: "second"})).rejects.toMatchObject({code: "quality_review_busy"});
    await l.tick();
    await expect(l.submit("team-1", "owner", 1, {...snapshot(), unit_id: "second"})).resolves.toBeTruthy();
    await l.setPolicy("team-1", "admin", {minimum_quality: 80, retention_days: 30, note: "保留已设置的队列额度"});
    expect(await l.policy("team-1")).toMatchObject({review_daily_limit: 500, review_queue_limit: 1});
    expect(await l.policy("other-team")).toMatchObject({review_daily_limit: 200, review_queue_limit: 50});
    await expect(l.setPolicy("team-1", "admin", {minimum_quality: 80, retention_days: 30, review_daily_limit: 1001, note: "不能无限增加评估预算"})).rejects.toThrow();
  });
  it("counts a repeated task once and isolates contextual inapplicability from Q", () => {
    const {lifecycle:l}=setup(); const now=Date.now();
    const assessment={outcome:'helpful',event_hash:usageWindowHash({events:[]}),evidence_contract:USAGE_EVIDENCE_CONTRACT};
    const record:any={key:'a',team:'team',kind:'exposure',rev:1,updated:now,data:{actor:'user',session_id:'s',task_id:'t',revision_id:'r',context:{repository:'repo'},created:now,events:[],assessment}};
    expect(l.utility([record,{...record,key:'b',updated:now+1}]).samples).toBe(1);
    const incompatible={...record,key:'c',data:{...record.data,assessment:{...assessment,outcome:'not_applicable'}}};
    expect(l.utility([incompatible]).score).toBeNull();
    expect(l.utility([incompatible]).applicability_penalty).toBeGreaterThan(0);
    expect(l.utility([incompatible],{repository:'other',task_type:'bug_fix',environment:'v1'}).applicability_penalty).toBe(0);
  });
  it.each(["llm_wiki", "chat_memory", "code_graph", "skill"] as const)("publishes a specific %s version only after evidence and human approval", async type => {
    const { lifecycle: l } = setup(); const p = await publish(l, type);
    expect(p.snapshot.asset_type).toBe(type); expect(p.report.scorecard?.quality).toBe(100);
    expect(p.approved_by).toBe("reviewer"); expect(p.report.scorecard?.calibration).toBe("provisional_not_calibrated");
  });
  it("does not allow publication without evaluation", async () => {
    const { lifecycle: l } = setup(); const r = await l.submit("team-1", "owner", 1, snapshot());
    await expect(l.decide("team-1", "reviewer", r!.data.id, "approve", "approve")).rejects.toMatchObject({ code: "quality_gate_blocked" });
    expect(await l.publication("team-1", "asset-1")).toBeNull();
  });
  it("coalesces duplicate submissions and does not call the model during retrieval", async () => {
    const { lifecycle: l } = setup(); const fn = vi.fn(reviewer.review); l.reviewer = { ...reviewer, review: fn };
    const a = await l.submit("team-1", "owner", 1, snapshot());
    const b = await l.submit("team-1", "owner", 1, snapshot()); expect(a!.key).toBe(b!.key);
    expect(fn).not.toHaveBeenCalled(); await l.tick(); expect(fn).toHaveBeenCalledOnce();
    await l.publication("team-1", "asset-1"); expect(fn).toHaveBeenCalledOnce();
  });
  it("binds to current asset version and prevents stale approval", async () => {
    const { lifecycle: l, setVersion } = setup(); const p = await publish(l); setVersion(2);
    expect(await l.publication("team-1", "asset-1")).toBeNull();
    await expect(l.decide("team-1", "reviewer", p.revision_id, "approve", "stale")).rejects.toMatchObject({ code: "quality_version_conflict" });
  });
  it("suspends without silently rolling back to a previously approved version", async () => {
    const { lifecycle: l } = setup(); const p = await publish(l);
    await l.decide("team-1", "reviewer", p.revision_id, "suspend", "需要核实内容");
    expect(await l.publication("team-1", "asset-1")).toBeNull();
  });
  it("requires re-evaluation when approval policy changes", async () => {
    const { lifecycle: l } = setup(); const r = await l.submit("team-1", "owner", 1, snapshot()); await l.tick();
    await l.setPolicy("team-1", "admin", { minimum_quality: 85, retention_days: 30, note: "根据样本调整试验阈值" });
    await expect(l.decide("team-1", "admin", r!.data.id, "approve", "stale policy")).rejects.toMatchObject({ code: "quality_version_conflict" });
  });
  it("rejects stale policy edits instead of overwriting another reviewer's changes", async () => {
    const { lifecycle: l } = setup();
    await l.setPolicy('team-1', 'admin', { expected_revision: 0, minimum_quality: 85, retention_days: 60, note: '根据独立样本调整发布阈值' });
    await expect(l.setPolicy('team-1', 'other', { expected_revision: 0, minimum_quality: 80, retention_days: 10, note: '旧页面修改过期保留策略' })).rejects.toMatchObject({ code: 'quality_version_conflict' });
    expect(await l.policy('team-1')).toMatchObject({ minimum_quality: 85, retention_days: 60, revision: 1 });
  });
  it("preserves unknown instead of giving it a zero or approving it", async () => {
    const { lifecycle: l } = setup(); l.reviewer = undefined;
    const r = await l.submit("team-1", "owner", 1, snapshot()); await l.tick();
    const done = await l.records.get(r!.key);
    expect(done!.data.report.scorecard.quality).toBeNull(); expect(done!.data.state).not.toBe("awaiting_approval");
  });
  it("does not permit a high average to override a defect", async () => {
    const { lifecycle: l } = setup(); l.reviewer = { ...reviewer, review: async (s, cs) => {
      const v = await reviewer.review(s, cs, new AbortController().signal) as any;
      v.checks.find((c: any) => c.id === "safety").status = "fail";
      v.checks.find((c: any) => c.id === "safety").score = 0; return v;
    } };
    const r = await l.submit("team-1", "owner", 1, snapshot()); await l.tick();
    const done = await l.records.get(r!.key); expect(done!.data.report.scorecard.quality).toBe(100); expect(done!.data.state).toBe("rejected");
  });
  it("recovers a queued job after closing and reopening SQLite", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "quality-recovery-")), "metadata.db");
    const a = setup(file); const job = await a.lifecycle.submit("team-1", "owner", 1, snapshot()); a.store.close();
    const b = setup(file); await b.lifecycle.tick(); expect((await b.lifecycle.records.get(job!.key))!.data.state).toBe("awaiting_approval");
  });
  it("CAS leases prevent two workers from evaluating one revision", async () => {
    const { lifecycle: l, store } = setup(); const second = new QualityLifecycle(store.qualityRecords, async () => ({ team_id: "team-1", version: 1 }));
    const fn = vi.fn(reviewer.review); l.reviewer = second.reviewer = { ...reviewer, review: fn };
    await l.submit("team-1", "owner", 1, snapshot()); await Promise.all([l.tick(), second.tick()]); expect(fn).toHaveBeenCalledOnce();
  });
  it("rejects cross-team access and credentials before persistence", async () => {
    const { lifecycle: l } = setup();
    await expect(l.submit("other-team", "owner", 1, snapshot())).rejects.toMatchObject({ code: "quality_version_conflict" });
    await expect(l.submit("team-1", "owner", 1, { ...snapshot(), body: "secret sk-abcdefghijklmnopqrstuvwxyz123456" })).rejects.toMatchObject({ code: "invalid_quality_snapshot" });
    expect(await l.records.list("revision")).toHaveLength(0);
  });
  it("deduplicates exposure and observations; excludes pre-injection events", async () => {
    const { lifecycle: l } = setup(); const e = await expose(l);
    const events = [{ id: "old", role: "assistant", content: "old result" }, { id: "new", role: "tool_result", content: "new result" }];
    await l.observe("team-1", "user", { exposure_id: e.key, events });
    await l.observe("team-1", "user", { exposure_id: e.key, events });
    expect((await l.records.get(e.key))!.data.events).toHaveLength(1);
    await expect(l.observe("team-1", "other-user", { exposure_id: e.key, events })).rejects.toMatchObject({ code: "permission_denied" });
  });
  it("does not infer helpfulness from assistant self-report alone", async () => {
    const { lifecycle: l } = setup(); const e = await expose(l);
    await l.observe("team-1", "user", { exposure_id: e.key, events: [{ id: "new", role: "assistant", content: "我已经成功采用这个资产" }] });
    l.usageReviewer = { id: "oracle", review: async () => ({ outcome: "helpful", reason: "self report", citations: [{ event_id: "new", quote: "我已经成功采用这个资产" }] }) };
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 4000); await l.tick();
    const row = (await l.records.get(e.key))!; expect(row.data.assessment.outcome).toBe("unobserved"); expect(l.utility([row]).score).toBeNull();
  });
  it("updates only contextual utility with a cited effect and never Q", async () => {
    const { lifecycle: l } = setup(); const e = await expose(l); const original = await l.publication("team-1", "asset-1");
    await l.observe("team-1", "user", { exposure_id: e.key, events: [{ id: "new", role: "user", content: "这个规范提醒了我补上租户隔离测试，确实有帮助。" }] });
    l.usageReviewer = { id: "oracle", review: async () => ({ outcome: "helpful", asset_quote: e.data.injected_text.slice(0,1000), reason: "explicit confirmation", citations: [{ event_id: "new", quote: "确实有帮助" }] }) };
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 4000); await l.tick();
    const row = (await l.records.get(e.key))!;
    expect(l.utility([row], e.data.context, e.data.revision_id).score).toBeGreaterThan(.5);
    expect(l.utility([row], { ...e.data.context, repository: "another" }, e.data.revision_id).score).toBeNull();
    expect(l.contextualUtilities([row])[0]).toMatchObject({ revision_id: e.data.revision_id, context: e.data.context, samples: 1 });
    expect((await l.publication("team-1", "asset-1"))!.report.scorecard).toEqual(original!.report.scorecard);
  });
  it("routes content errors to re-review, without model-controlled unpublication", async () => {
    const { lifecycle: l } = setup(); const e = await expose(l);
    await l.feedback("team-1", "user", e.key, "content_error", "来源中的前提与正文不一致，需要核实");
    expect(await l.records.list("recheck", "team-1")).toHaveLength(1);
    expect(await l.publication("team-1", "asset-1")).not.toBeNull();
  });
  it("expires raw observations and their utility contribution", async () => {
    const { lifecycle: l } = setup(); const e = await expose(l);
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 31 * 86400000); await l.tick();
    expect(await l.records.get(e.key)).toBeNull();
  });
  it("rejects non-snapshot content as injection evidence", async () => {
    const { lifecycle: l } = setup(); const e = await expose(l);
    await expect(l.expose("team-1", "user", { ...e.data, injected_text: "not in asset", events: undefined })).rejects.toBeDefined();
  });
  it("keeps unknown numeric ratings null", async () => {
    const r = await evaluateQuality(snapshot()); expect(r.scorecard!.quality).toBeNull();
    expect(scoreChecks([]).evidence_coverage).toBe(0);
  });
});
