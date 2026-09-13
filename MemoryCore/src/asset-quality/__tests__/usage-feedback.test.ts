import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QualityLifecycle } from "../lifecycle.js";
import { usageWindowHash, validateUsageResult, USAGE_EVIDENCE_CONTRACT } from "../usage-result.js";
import { SqliteMetadataStore } from "../../metadata/store/sqlite-adapter.js";

const stores: SqliteMetadataStore[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); vi.useRealTimers(); });
const event = { id: "test-output-1", role: "tool_result", content: "Added tenant-isolation regression: 9 passed", tool_call_id: "call-1" };
const helpful = { outcome: "helpful", asset_quote: "Preserve tenant isolation", reason: "The observed regression addresses the tenant boundary in the asset; observational evidence only.", citations: [{ event_id: event.id, quote: "tenant-isolation regression: 9 passed" }] };
function setup(file = ":memory:") {
  const store = new SqliteMetadataStore(file); store.init(); stores.push(store);
  const l = new QualityLifecycle(store.qualityRecords, async () => ({ team_id: "team", version: 1 }));
  return { store, l };
}
async function seed(l: QualityLifecycle, overrides: Record<string, any> = {}, key = "exposure:one") {
  await l.records.cas({ key, kind: "exposure", team: "team", rev: 0, updated: Date.now(), data: {
    asset_id: "asset", revision_id: "revision-1", task_id: "task", session_id: "session", actor: "user", request_id: "req",
    turn: 1, context: { repository: "repo", task_type: "bug_fix", environment: "v1" },
    injected_text: "Preserve tenant isolation; add regression coverage.", events: [event],
    state: "queued", attempts: 0, due: 0, lease_until: 0, created: Date.now(), expires: Date.now() + 86400000, ...overrides,
  } }, 0);
  return key;
}
const row = async (l: QualityLifecycle, key = "exposure:one") => (await l.records.get(key))!;

describe("usage evaluation recovery and effect receipts", () => {
  it('keeps a closed bounded observation window without poisoning transport retries',async()=>{
    const {l}=setup(); await seed(l,{events:Array.from({length:160},(_,i)=>({id:`e-${i}`,role:'tool_result',content:`event ${i}`}))});
    const input={exposure_id:'exposure:one',events:[{id:'overflow',role:'tool_result',content:'new evidence beyond the window'}]};
    const closed=await l.observe('team','user',input);
    expect(closed.data.events).toHaveLength(160); expect(closed.data.window_closed).toBe(true);
    expect(closed.data.effect_receipt.observation_window).toMatchObject({closed:true,omitted_events:1,reason:'bounded_observation_limit'});
    const retry=await l.observe('team','user',input); expect(retry.rev).toBe(closed.rev);
  });
  it('uses exposure chronology for both receipt and utility, not worker completion time',async()=>{
    const {l}=setup(),assessment={...helpful,evidence_contract:USAGE_EVIDENCE_CONTRACT,event_hash:usageWindowHash({events:[event]})};
    await seed(l,{turn:8,created:200,assessment:{outcome:'unobserved',reason:'no effect evidence',citations:[],event_hash:assessment.event_hash,evidence_contract:USAGE_EVIDENCE_CONTRACT}},'exposure:new');
    await seed(l,{turn:3,created:100,assessment},'exposure:old-retried-late');
    const records=await l.usageRecords('team','task');
    expect(l.taskReceipt(records).items[0].receipt_id).toBe('exposure:new');
    expect(l.utility(records).samples).toBe(0);
  });
  it.each(["not JSON", { outcome: "helpful" }])("feeds a concrete format error back, then atomically saves a corrected receipt: %j", async bad => {
    vi.useFakeTimers(); const { l } = setup(); await seed(l);
    const review = vi.fn().mockResolvedValueOnce(bad).mockResolvedValueOnce(helpful); l.usageReviewer = { id: "contract-oracle", review };
    await l.tick();
    const failed = await row(l);
    expect(failed.data.state).toBe("queued"); expect(failed.data.error_details.repairable).toBe(true);
    expect(failed.data.repair_feedback.errors.length).toBeGreaterThan(0);
    expect(failed.data.effect_receipt.assessment).toBeNull();
    await vi.advanceTimersByTimeAsync(6000); await l.tick();
    expect(review.mock.calls[1][0].correction.previous_response).toBeTruthy();
    const done = await row(l);
    expect(done.data.effect_receipt).toMatchObject({ status: "assessed", assessment: { outcome: "helpful" }, asset_id: "asset", revision_id: "revision-1", native_states_unchanged: true });
    expect(done.data.effect_receipt.citations[0]).toMatchObject({ role: "tool_result", tool_call_id: "call-1" });
    expect(done.data.last_error).toBeNull(); expect(done.data.error_history).toHaveLength(1);
    expect(l.utility([done]).samples).toBe(1);
  });
  it.each([
    { outcome: "helpful", reason: "missing citation", citations: [] },
    { ...helpful, citations: [{ event_id: "invented", quote: "9 passed" }] },
    { ...helpful, citations: [{ event_id: event.id, quote: "100 passed" }] },
  ])("repairs evidence errors without manufacturing a positive result", async bad => {
    vi.useFakeTimers(); const { l } = setup(); await seed(l);
    const review = vi.fn().mockResolvedValueOnce(bad).mockResolvedValueOnce({ outcome: "unobserved", reason: "Evidence is insufficient to attribute an effect.", citations: [] });
    l.usageReviewer = { id: "contract-oracle", review }; await l.tick();
    expect((await row(l)).data.repair_feedback.instruction).toContain("不要编造");
    await vi.advanceTimersByTimeAsync(6000); await l.tick();
    expect((await row(l)).data.effect_receipt.status).toBe("needs_evidence");
    expect(l.utility([await row(l)]).score).toBeNull();
  });
  it("times out the background evaluator, aborts it and retries within the finite budget", async () => {
    vi.useFakeTimers(); const { l } = setup(); await seed(l); let signal: AbortSignal | undefined;
    l.usageReviewer = { id: "slow", review: (_input, s) => { signal = s; return new Promise(() => {}); } };
    const pending = l.tick(); await vi.advanceTimersByTimeAsync(60001); await pending;
    expect(signal?.aborted).toBe(true);
    expect((await row(l)).data).toMatchObject({ state: "queued", last_error: "upstream_timeout", repair_feedback: null });
  });
  it("holds exhausted jobs for humans, survives restart, and does not restart on each new event", async () => {
    vi.useFakeTimers(); const file = join(mkdtempSync(join(tmpdir(), "usage-recovery-")), "db.sqlite");
    const { l } = setup(file); await seed(l);
    const review = vi.fn(async () => "not JSON"); l.usageReviewer = { id: "bad", review };
    for (let i = 0; i < 3; i++) { await l.tick(); await vi.advanceTimersByTimeAsync(15000); }
    expect(review).toHaveBeenCalledTimes(3);
    expect((await row(l)).data.effect_receipt).toMatchObject({ status: "manual_review", can_retry: true });
    await l.observe("team", "user", { exposure_id: "exposure:one", events: [{ id: "next", role: "user", content: "additional evidence" }] });
    await vi.advanceTimersByTimeAsync(5000); await l.tick(); expect(review).toHaveBeenCalledTimes(3);
    const { l: restarted } = setup(file);
    expect((await row(restarted)).data.state).toBe("failed");
    restarted.usageReviewer = { id: "good", review: async () => helpful };
    await restarted.retryUsage("team", "user", "exposure:one", "服务已恢复，重试本次观察"); await restarted.tick();
    expect((await row(restarted)).data.effect_receipt.status).toBe("assessed");
    expect((await row(restarted)).data.retry_requests).toHaveLength(1);
  });
  it("keeps credentials out of diagnostics and sends auth failures to manual review", async () => {
    const { l } = setup(); await seed(l);
    l.usageReviewer = { id: "auth", review: async () => { throw Object.assign(new Error("secret-request-body"), { statusCode: 401 }); } };
    await l.tick(); const saved = await row(l);
    expect(saved.data.last_error).toBe("upstream_auth_error"); expect(saved.data.state).toBe("failed");
    expect(JSON.stringify(saved)).not.toContain("secret-request-body");
  });
  it("does not let a late worker overwrite a newer event window", async () => {
    const { l } = setup(); await seed(l); let resolve!: (value: unknown) => void;
    l.usageReviewer = { id: "slow", review: () => new Promise(r => { resolve = r; }) };
    const pending = l.tick(); await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    await l.observe("team", "user", { exposure_id: "exposure:one", events: [{ id: "new", role: "user", content: "The earlier result is incomplete" }] });
    resolve(helpful); await pending;
    expect((await row(l)).data.effect_receipt.assessment).toBeNull(); expect((await row(l)).data.events).toHaveLength(2);
  });
  it("removes old effect credit while evaluating new events and preserves prior history", async () => {
    const { l } = setup(); await seed(l); l.usageReviewer = { id: "good", review: async () => helpful }; await l.tick();
    expect(l.utility([await row(l)]).samples).toBe(1);
    await l.observe("team", "user", { exposure_id: "exposure:one", events: [{ id: "new", role: "user", content: "A later regression occurred" }] });
    expect((await row(l)).data.assessment.outcome).toBe("helpful");
    expect((await row(l)).data.effect_receipt.assessment).toBeNull(); expect(l.utility([await row(l)]).samples).toBe(0);
  });
  it("deduplicates receipt rows but isolates versions and sessions, without changing native counters", async () => {
    const { l } = setup(); const assessment = { ...helpful, evidence_contract:USAGE_EVIDENCE_CONTRACT, event_hash: usageWindowHash({ events: [event] }) };
    await seed(l, { assessment }, "exposure:a"); await seed(l, { assessment }, "exposure:b");
    await seed(l, { revision_id: "revision-2", assessment }, "exposure:c");
    await seed(l, { session_id: "another-session", assessment }, "exposure:d");
    const receipt = l.taskReceipt(await l.usageRecords("team", "task"));
    expect(receipt.summary).toMatchObject({ observations: 3, assets: 2, helpful: 3 });
    expect(receipt).not.toHaveProperty("summary.contributed"); expect(receipt).not.toHaveProperty("summary.validated");
    expect(l.taskReceipt(await l.usageRecords("team", "other-task")).items).toHaveLength(0);
  });
  it("manual feedback resolves failed review and writes a version-bound human receipt", async () => {
    const { l } = setup(); await seed(l, { state: "failed", attempts: 3 });
    const saved = await l.feedback("team", "reviewer", "exposure:one", "unobserved", "人工核对后，暂时缺少资产影响的可靠证据");
    expect(saved.data.effect_receipt).toMatchObject({ status: "human_reviewed", assessment: { source: "human", outcome: "unobserved" }, manual_review_required: false });
    expect(l.utility([saved]).score).toBeNull();
  });
  it("enforces retention and lifetime retry cap", async () => {
    const { l } = setup(); await seed(l, { state: "failed", total_attempts: 20 });
    await expect(l.retryUsage("team", "user", "exposure:one", "retry")).rejects.toMatchObject({ code: "quality_gate_blocked" });
    await seed(l, { state: "failed", expires: Date.now() - 1 }, "exposure:expired");
    await expect(l.feedback("team", "user", "exposure:expired", "helpful", "old evidence")).rejects.toMatchObject({ code: "quality_gate_blocked" });
    expect(await l.usageRecords("team")).toHaveLength(1);
  });
  it("does not treat assistant self-report as independently observed help", () => {
    expect(validateUsageResult({ ...helpful, citations: [{ event_id: "a", quote: "I used it" }] }, [{ id: "a", role: "assistant", content: "I used it" }]).outcome).toBe("unobserved");
  });
  it("invalidates old model credit and rechecks once without erasing its audit history", async () => {
    const {l}=setup(); const assessment={...helpful,reviewer:'usage-review/4:model',event_hash:usageWindowHash({events:[event]})};
    await seed(l,{state:'observing',assessment,attempts:3,total_attempts:3});
    expect(l.utility([await row(l)]).samples).toBe(0);
    expect(l.taskReceipt([await row(l)]).items[0].status).toBe('needs_recheck');
    const review=vi.fn(async()=>helpful);l.usageReviewer={id:'usage-review/5:model',review};
    await l.tick();await l.tick();
    expect(review).toHaveBeenCalledTimes(1);
    expect((await row(l)).data.assessment_history[0]).toEqual(assessment);
    expect((await row(l)).data.assessment.evidence_contract).toBe(USAGE_EVIDENCE_CONTRACT);
    expect(l.utility([await row(l)]).samples).toBe(1);
  });
  it("does not replace human resolutions or exceed the migration retry budget", async()=>{
    const {l}=setup(),assessment={...helpful,reviewer:'usage-review/4:model',event_hash:usageWindowHash({events:[event]})};
    await seed(l,{state:'observing',assessment,total_attempts:20});
    await seed(l,{state:'observing',assessment,human_feedback:{outcome:'unobserved',event_hash:assessment.event_hash}},'exposure:human');
    const review=vi.fn(async()=>helpful);l.usageReviewer={id:'new-model',review};await l.tick();await l.tick();
    expect(review).not.toHaveBeenCalled();expect((await row(l)).data.state).toBe('failed');
    expect((await row(l,'exposure:human')).data.human_feedback.outcome).toBe('unobserved');
  });
});
