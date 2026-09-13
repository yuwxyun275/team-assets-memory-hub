import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteMetadataStore } from "../../metadata/store/sqlite-adapter.js";
import { QualityLifecycle } from "../lifecycle.js";
import { sceneSchema, sceneHash, SCENE_CONTRACT, sceneSimilarity, validateApplicability, type RecommendationScene } from "../scene.js";
import { usageWindowHash, validateUsageResult, USAGE_EVIDENCE_CONTRACT } from "../usage-result.js";
import { AssetDisclosure } from "../disclosure.js";

const stores: SqliteMetadataStore[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); vi.useRealTimers(); });
const asset = "Only for Redis cache outages. Catch CacheUnavailable and use one database fallback. Do not retry inside a request.";
const context = { repository: "flags", task_type: "bug_fix", environment: "v1" };
const before: RecommendationScene = { schema_version: "recommendation-scene/v1", request_id: "before-1", turn: 1,
  query: "Redis CacheUnavailable safe fallback timeout", task: "Fix flags", active_paths: ["service.py"], errors: [], truncated: false,
  events: [{ id: "before-event", role: "user", content: "Redis CacheUnavailable causes a timeout. Use one fallback and preserve tenant isolation." }] };
const fit = { verdict: "applicable", reason: "The observed Redis outage meets the stated precondition. Effect is still unknown.",
  asset_quote: "Only for Redis cache outages.", citations: [{ event_id: "before-event", quote: "Redis CacheUnavailable causes a timeout." }] };
const after = { id: "after-event", role: "user", content: "I used the one-fallback instruction to catch CacheUnavailable and the request now returns without retrying." };
const effect = { outcome: "helpful", reason: "Specific user feedback connects this instruction to a changed action. Not independently verified.",
  asset_quote: "Catch CacheUnavailable and use one database fallback.", citations: [{ event_id: after.id, quote: after.content }] };

function setup() {
  const store = new SqliteMetadataStore(":memory:"); store.init(); stores.push(store);
  const l = new QualityLifecycle(store.qualityRecords, async () => ({ team_id: "team", version: 1 }));
  vi.spyOn(l, "publication").mockResolvedValue({ revision_id: "r1", snapshot: { body: asset } } as any);
  return l;
}
const expose = (l: QualityLifecycle, extra = {}) => l.expose("team", "actor", {
  asset_id: "a", revision_id: "r1", task_id: "t1", session_id: "s1", turn: 1, context,
  request_id: "request-1", injected_text: asset, baseline_event_ids: ["before-event"], before, ...extra });

describe("prior-context and subsequent-effect learning", () => {
  it("freezes the scene at recommendation and does not overwrite it on later reads", async () => {
    const l = setup(), d = new AssetDisclosure(l, a => l.publication("team", a));
    const scope = { agent_id: "agent", task_id: "t1", session_id: "s1" }, refs = [{ asset_id: "a", revision_id: "r1" }];
    await d.remember("team", "actor", { ...scope, references: refs, before });
    const next = await d.remember("team", "actor", { ...scope, references: refs, before: { ...before, query: "Everything passed", request_id: "later" } });
    expect(next.references[0].before).toEqual(before);
    expect((await d.list("team", "other-actor", scope)).references).toEqual([]);
    expect(await l.usageRecords("team")).toHaveLength(0); // A card is not actual body exposure.
  });
  it("runs a prior-only fit request, then a separate effect request and joins both in the receipt", async () => {
    vi.useFakeTimers(); const l = setup(), r = await expose(l);
    const review = vi.fn(async (input: any) => input.mode === "applicability" ? fit : effect);
    l.usageReviewer = { id: "contract-fixture", review };
    await l.observe("team", "actor", { exposure_id: r.key, events: [after] });
    await vi.advanceTimersByTimeAsync(2001); await l.tick();
    expect(review.mock.calls[0][0]).toMatchObject({ mode: "applicability", before });
    expect(review.mock.calls[0][0]).not.toHaveProperty("events");
    let saved = (await l.records.get(r.key))!;
    expect(saved.data.effect_receipt.applicability.verdict).toBe("applicable");
    expect(saved.data.effect_receipt.assessment).toBeNull();
    await l.tick(); saved = (await l.records.get(r.key))!;
    expect(review.mock.calls[1][0]).toMatchObject({ mode: "effect", before, events: [after] });
    expect(saved.data.effect_receipt.assessment.outcome).toBe("helpful");
    expect(saved.data.effect_receipt.recommendation_scene.hash).toBe(sceneHash(before));
  });
  it("fit alone never raises U and no future event does not mean an asset is bad", async () => {
    const l = setup(), r = await expose(l);
    l.usageReviewer = { id: "fixture", review: async () => fit }; await l.tick();
    const saved = (await l.records.get(r.key))!;
    expect(saved.data.effect_receipt.applicability.verdict).toBe("applicable");
    expect(l.utility([saved], context, "r1", before)).toMatchObject({ score: null, applicability_adjustment: 0 });
  });
  it("merges a prior-only result when new future events arrive during model evaluation", async () => {
    const l = setup(), r = await expose(l); let resolve!: (v: unknown) => void;
    l.usageReviewer = { id: "slow-fit", review: () => new Promise(r => { resolve = r; }) };
    const pending = l.tick(); await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    await l.observe("team", "actor", { exposure_id: r.key, events: [after] });
    resolve(fit); await pending;
    const saved = (await l.records.get(r.key))!;
    expect(saved.data.events).toEqual([after]);
    expect(saved.data.effect_receipt.applicability.verdict).toBe("applicable");
    expect(saved.data.state).toBe("queued");
  });
  it("excludes pre-injection events in the service even if the sender forgets baseline IDs", async () => {
    const l = setup(), r = await expose(l, { baseline_event_ids: [] });
    const saved = await l.observe("team", "actor", { exposure_id: r.key, events: [...before.events, after] });
    expect(saved.data.events).toEqual([after]);
    expect(() => validateUsageResult({ ...effect, citations: fit.citations }, [after], asset)).toThrow("invalid_citation");
  });
  it("does not accept future events or assistant-only claims as proof of prior applicability", () => {
    expect(() => validateApplicability({ ...fit, citations: effect.citations }, before, asset)).toThrow("invalid_citation");
    expect(() => validateApplicability(fit, { ...before, events: [{ ...before.events[0], role: "assistant" }] }, asset)).toThrow("missing_evidence");
    expect(validateApplicability({ verdict: "unknown", reason: "No verified prerequisites", citations: [], asset_quote: "" }, before, asset).verdict).toBe("unknown");
  });
  it("repairs fit citations without inventing a positive result and preserves retry diagnostics", async () => {
    vi.useFakeTimers(); const l = setup(), r = await expose(l);
    const review = vi.fn().mockResolvedValueOnce({ ...fit, citations: effect.citations }).mockResolvedValueOnce({ verdict: "unknown", reason: "Cannot confirm prerequisites", citations: [] });
    l.usageReviewer = { id: "fixture", review }; await l.tick();
    await vi.advanceTimersByTimeAsync(6000); await l.tick();
    expect(review.mock.calls[1][0].correction.errors[0]).toContain("推荐前");
    expect((await l.records.get(r.key))!.data.effect_receipt.applicability.verdict).toBe("unknown");
  });
  it("invalidates effect credit if a scene is changed, while keeping compatibility for historical rows", () => {
    expect(usageWindowHash({ events: [after], before, context })).not.toBe(usageWindowHash({ events: [after], before: { ...before, query: "other" }, context }));
    expect(usageWindowHash({ events: [after] })).toBe(usageWindowHash({ events: [after], irrelevant: 1 }));
  });
  it("bounds and validates the snapshot payload", () => {
    expect(() => sceneSchema.parse({ ...before, events: Array(13).fill(before.events[0]) })).toThrow();
    expect(() => sceneSchema.parse({ ...before, events: Array.from({ length: 5 }, (_, i) => ({ ...before.events[0], id: `${i}`, content: "x".repeat(4000) })) })).toThrow();
  });
  it("matches issues rather than identical board descriptions", () => {
    expect(sceneSimilarity(before, before)).toBe(1);
    expect(sceneSimilarity(before, { ...before, query: "OAuth token refresh concurrency race" })).toBeLessThan(.6);
  });
  it("requires three independent same-scene tasks, caps adjustment and isolates versions and environments", async () => {
    const l = setup(), base = await expose(l);
    const make = (task: string) => ({ ...base, key: `exposure:${task}`, data: { ...base.data, task_id: task,
      applicability: { ...fit, verdict: "not_applicable", scene_hash: sceneHash(before), evidence_contract: SCENE_CONTRACT } } });
    const rows = [make("one"), make("two"), make("three")];
    expect(l.utility(rows.slice(0, 2), context, "r1", before).applicability_adjustment).toBe(0);
    const learned = l.utility(rows, context, "r1", before);
    expect(learned.score).toBeNull(); expect(learned.applicability_adjustment).toBeLessThan(0);
    expect(learned.applicability_adjustment).toBeGreaterThan(-.05);
    expect(learned.scene_learning?.fit_tasks).toBe(3);
    expect(l.utility([rows[0], { ...rows[0], key: "retry" }, rows[1]], context, "r1", before).applicability_adjustment).toBe(0);
    for (const ctx of [{ ...context, repository: "other" }, { ...context, environment: "v2" }, { ...context, task_type: "docs" }]) {
      expect(l.utility(rows, ctx, "r1", before).scene_learning?.matched_tasks).toBe(0);
    }
    expect(l.utility(rows, context, "r2", before).scene_learning?.matched_tasks).toBe(0);
    expect(l.utility(rows, context, "r1", { ...before, query: "OAuth token refresh concurrency race" }).scene_learning?.matched_tasks).toBe(0);
    const legacy = { ...rows[0], data: { ...rows[0].data, before: undefined, events: [after], assessment: { ...effect, evidence_contract: USAGE_EVIDENCE_CONTRACT, event_hash: usageWindowHash({ events: [after] }) } } };
    expect(l.utility([legacy], context, "r1", before).score).toBeNull();
    expect(l.utility([legacy], context, "r1").score).toBeGreaterThan(.5);
  });
});
