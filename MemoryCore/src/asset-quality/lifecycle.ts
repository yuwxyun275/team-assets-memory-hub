import { DECISION_POLICY, usagePosterior } from "./decision-policy.js";
import { withModelUsage } from "./model-usage.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { evaluateQuality, sha256 } from "./evaluator.js";
import { containsCredential } from "./rules.js";
import { snapshotSchema, POLICY_VERSION, type QualitySnapshot, type ModelReviewer, type QualityReport } from "./types.js";
import type { QualityRecord, QualityRecords } from "./records.js";
import { usageResultSchema, validateUsageResult, usageFailure, UsageReviewError, usageWindowHash, currentUsageAssessment, usageReceipt, deduplicateUsage, USAGE_EVIDENCE_CONTRACT } from "./usage-result.js";
import { sceneSchema, sceneHash, currentApplicability, validateApplicability, SCENE_CONTRACT, sceneSimilarity, sameEnvironment, type RecommendationScene } from "./scene.js";
export { usageResultSchema } from "./usage-result.js";

export class QualityError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
const fail = (code: string, message: string): never => { throw new QualityError(code, message); };
const id = z.string().min(1).max(200);
export const usageEventSchema = z.object({
  id, role: z.enum(["user", "assistant", "tool_result", "tool_call"]),
  content: z.string().min(1).max(30_000), tool_call_id: z.string().max(200).optional(),
}).strict();
export const exposureSchema = z.object({
  asset_id: id, revision_id: id, task_id: id, session_id: id, turn: z.number().int().min(1),
  context: z.object({ repository: z.string().max(1000), task_type: z.string().max(100), environment: z.string().max(1000) }).strict(),
  injected_text: z.string().min(1).max(60_000), request_id: id,
  baseline_event_ids: z.array(id).max(4000).default([]),
  before: sceneSchema.optional(),
}).strict();
export const observationSchema = z.object({
  exposure_id: id, events: z.array(usageEventSchema).min(1).max(30),
}).strict();
export const policySchema = z.object({
  expected_revision: z.number().int().min(0).optional(),
  minimum_quality: z.number().min(0).max(100),
  retention_days: z.number().int().min(1).max(365),
  review_daily_limit: z.number().int().min(1).max(1000).optional(),
  review_queue_limit: z.number().int().min(1).max(100).optional(),
  review_parallelism: z.number().int().min(1).max(4).optional(),
  note: z.string().min(8).max(2000),
}).strict();
export type UsageReviewer = { id: string; review(input: unknown, signal: AbortSignal): Promise<unknown> };
type Status = "queued" | "running" | "needs_evidence" | "rejected" | "awaiting_approval" | "published" | "suspended" | "failed";
interface Revision {
  id: string; asset_id: string; expected_version: number; snapshot: QualitySnapshot; hash: string;
  policy_revision: number; policy: { minimum_quality: number; retention_days: number };
  state: Status; attempts: number; due: number; lease_until: number; lease_owner?: string;
  requested_by: string; report?: QualityReport; last_error?: string; approved_by?: string; approved_at?: number;
}
export interface Publication {
  revision_id: string; snapshot: QualitySnapshot; report: QualityReport; expected_version: number;
  approved_by: string; approved_at: number;
}
/** Owns authoritative immutable publications. Mutable native containers are NOT published by implication. */
export class QualityLifecycle {
  private busy = false;
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  private cursor = "";
  private exposureCursor = "";
  private recheckCursor = "";
  private disclosureCursors: Record<string, string> = {};
  reviewer?: ModelReviewer;
  usageReviewer?: UsageReviewer;
  constructor(readonly records: QualityRecords, private getAsset: (id: string) => Promise<{ team_id: string; version: number; metadata_json?: string } | null>) {}
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(() => { /* retry next tick; no content logging */ }); }, 2000);
    this.timer.unref();
  }
  stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); }
  private async save(key: string, kind: string, team: string, data: Record<string, any>, previous?: QualityRecord | null) {
    const record = { key, kind, team, data, rev: previous?.rev ?? 0, updated: Date.now() };
    if (kind === "exposure") record.data = { ...data, effect_receipt: usageReceipt(record) };
    if (!await this.records.cas(record, record.rev)) fail("quality_version_conflict", "状态已改变，请刷新后重试");
    return { ...record, rev: record.rev + 1 };
  }
  private async scoped(key: string, team: string) {
    const record = await this.records.get(key);
    if (!record || record.team !== team) fail("quality_not_found", "找不到当前团队内的记录");
    return record!;
  }
  async policy(team: string) {
    const record = await this.records.get(`policy:${team}`);
    return { revision: record?.rev ?? 0, minimum_quality: DECISION_POLICY.quality.defaultMinimum, retention_days: 30, review_daily_limit: 200, review_queue_limit: 50, review_parallelism: 1, ...record?.data,
      scoring_policy: POLICY_VERSION, calibration: "explicit_policy_with_contract_validation", automatic_publication: false };
  }
  async setPolicy(team: string, actor: string, input: unknown) {
    const { expected_revision, ...data } = policySchema.parse(input);
    const previous = await this.records.get(`policy:${team}`);
    if (expected_revision !== undefined && expected_revision !== (previous?.rev ?? 0)) fail("quality_version_conflict", "团队策略已被其他审核者修改，请重新载入后再保存");
    await this.save(`policy:${team}`, "policy", team, { ...previous?.data, ...data, changed_by: actor }, previous);
    await this.audit(team, actor, "policy_changed", team, data.note);
    return this.policy(team);
  }
  async submit(team: string, actor: string, version: number, input: unknown) {
    const snapshot = snapshotSchema.parse(input);
    const asset = await this.getAsset(snapshot.asset_id);
    if (!asset || asset.team_id !== team || asset.version !== version) fail("quality_version_conflict", "资产版本或团队不一致");
    // Never persist or send credentials to an evaluator. Names/paths/conversations are retained unchanged.
    if (containsCredential(JSON.stringify(snapshot))) fail("invalid_quality_snapshot", "评估材料包含账号凭据，请移除凭据后提交");
    const policy = await this.policy(team);
    const canonical = JSON.stringify({ ...snapshot, sources: [...snapshot.sources].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) });
    const hash = sha256(canonical);
    const revisionId = sha256(JSON.stringify([team, snapshot.asset_id, version, hash, policy.revision, POLICY_VERSION, this.reviewer?.id ?? "none"]));
    const key = `revision:${revisionId}`;
    const existing = await this.records.get(key);
    if (existing) return existing;
    let after = "", active = 0, today = 0;
    for (;;) {
      const page = await this.records.list("revision", team, after, 200);
      active += page.filter(r => ["queued", "running"].includes(r.data.state)).length;
      today += page.filter(r => (r.data.created ?? r.updated) > Date.now() - 86400000).length;
      if (active >= policy.review_queue_limit || today >= policy.review_daily_limit) fail("quality_review_busy", "团队评估队列或每日额度已满，请稍后重试");
      if (page.length < 200) break;
      after = page[page.length - 1].key;
    }
    let originTask: string | undefined;
    try { originTask = JSON.parse(asset!.metadata_json || "{}").learning?.task_id; } catch { /* Legacy metadata without a learning origin. */ }
    const data: Revision = { id: revisionId, asset_id: snapshot.asset_id, expected_version: version,
      snapshot, hash, policy_revision: policy.revision, policy, state: "queued", attempts: 0, due: Date.now(), lease_until: 0, requested_by: actor };
    // Payload and durable queue state committed together. No fire-and-forget enqueue gap.
    try { return await this.save(key, "revision", team, { ...data, task_id: originTask, created: Date.now() }); }
    catch (e) { if (e instanceof QualityError && e.code === "quality_version_conflict") return this.records.get(key); throw e; }
  }
  async details(team: string, assetId: string) {
    const revisions: QualityRecord[] = [], exposures: QualityRecord[] = [];
    for (const kind of ["revision", "exposure"]) {
      let after = "";
      for (;;) {
        const page = await this.records.list(kind, team, after, 200);
        for (const r of page) if (r.data.asset_id === assetId) (kind === "revision" ? revisions : exposures).push(r);
        if (page.length < 200) break;
        after = page[page.length - 1].key;
      }
    }
    return { policy: await this.policy(team), publication: await this.publication(team, assetId),
      revisions: revisions.sort((a, b) => b.updated - a.updated),
      exposures: exposures.sort((a, b) => b.updated - a.updated).map(r => ({ ...r, data: { ...r.data, effect_receipt: usageReceipt(r) } })), utility: this.utility(exposures) };
  }
  async decide(team: string, actor: string, revisionId: string, decision: "approve" | "reject" | "suspend", note: string) {
    const record = await this.scoped(`revision:${revisionId}`, team);
    const data = record.data as Revision;
    const asset = await this.getAsset(data.asset_id);
    if (!asset || asset.team_id !== team || asset.version !== data.expected_version) fail("quality_version_conflict", "源资产已更新，必须重评当前版本");
    if (decision === "approve") {
      const policy = await this.policy(team);
      if (policy.revision !== data.policy_revision) fail("quality_version_conflict", "发布策略已变化，请重新提交评估");
      if (!["awaiting_approval", "published"].includes(data.state) || data.report?.decision !== "pass"
        || data.report.scorecard?.quality == null || data.report.scorecard.quality < policy.minimum_quality
        || data.report.scorecard.evidence_coverage !== 100) fail("quality_gate_blocked", "评估未满足发布门槛，不能批准");
    }
    const state = decision === "approve" ? "published" : decision === "suspend" ? "suspended" : "rejected";
    // Decision history is committed with the state, even if the audit projection/head write is interrupted.
    const updated = await this.save(record.key, record.kind, team, { ...data, state, approved_by: actor, approved_at: Date.now(), decision_note: note,
      decisions: [...(record.data.decisions ?? []), { actor, state, at: Date.now(), note }].slice(-100) }, record);
    if (decision === "approve") {
      const head = await this.records.get(`publication:${data.asset_id}`);
      await this.save(`publication:${data.asset_id}`, "publication", team, { revision_id: revisionId, approved_by: actor, approved_at: Date.now() }, head);
    }
    await this.audit(team, actor, state, revisionId, note);
    return updated;
  }
  async publication(team: string, assetId: string): Promise<Publication | null> {
    const asset = await this.getAsset(assetId);
    if (!asset || asset.team_id !== team) return null;
    const head = await this.records.get(`publication:${assetId}`);
    if (!head || head.team !== team) return null;
    const latest = await this.records.get(`revision:${head.data.revision_id}`);
    if (!latest || latest.team !== team || latest.data.asset_id !== assetId || latest.data.expected_version !== asset.version || latest.data.state !== "published") return null;
    const d = latest.data as Revision;
    return { revision_id: d.id, expected_version: d.expected_version, snapshot: d.snapshot, report: d.report!, approved_by: d.approved_by!, approved_at: d.approved_at! };
  }
  async retry(team: string, actor: string, revisionId: string) {
    const r = await this.scoped(`revision:${revisionId}`, team);
    if (!["failed", "needs_evidence"].includes(r.data.state)) fail("quality_gate_blocked", "该状态不可重试");
    await this.audit(team, actor, "retry", revisionId, "explicit retry");
    return this.save(r.key, r.kind, team, { ...r.data, state: "queued", attempts: 0, due: Date.now(), lease_until: 0 }, r);
  }
  async expose(team: string, actor: string, input: unknown) {
    const data = exposureSchema.parse(input);
    if (containsCredential(JSON.stringify(data))) fail("invalid_quality_snapshot", "观察材料包含凭据，未保存");
    const p = await this.publication(team, data.asset_id);
    if (!p || p.revision_id !== data.revision_id) fail("quality_gate_blocked", "注入版本未发布或已经失效");
    if (!p!.snapshot.body.includes(data.injected_text)) fail("invalid_quality_snapshot", "注入片段不属于审核版本");
    const key = `exposure:${sha256(JSON.stringify([team, actor, data.session_id, data.task_id, data.revision_id, data.request_id]))}`;
    const previous = await this.records.get(key);
    if (previous) return previous;
    const policy = await this.policy(team);
    return this.save(key, "exposure", team, { ...data, actor, events: [], attempts: 0, due: 0, lease_until: 0,
      state: data.before ? "queued" : "observing", created: Date.now(), expires: Date.now() + policy.retention_days * 86400000,
      observation_scope: "authorized_task_only", attribution: "observational_not_causal" });
  }
  async observe(team: string, actor: string, input: unknown) {
    const data = observationSchema.parse(input);
    if (containsCredential(JSON.stringify(data))) fail("invalid_quality_snapshot", "观察材料包含凭据，未保存");
    const r = await this.scoped(data.exposure_id, team);
    if (r.data.actor !== actor || r.kind !== "exposure") fail("permission_denied", "只能追加本人发起的观察");
    if (Date.now() > r.data.expires) fail("quality_gate_blocked", "观察保留期已结束");
    const events = [...r.data.events] as z.infer<typeof usageEventSchema>[];
    let closed = !!r.data.window_closed;
    const omitted = new Set<string>(r.data.omitted_event_ids ?? []);
    for (const event of data.events) {
      if ((r.data.baseline_event_ids ?? []).includes(event.id) || r.data.before?.events.some((e: any) => e.id === event.id)) continue;
      const old = events.find(e => e.id === event.id);
      if (old && JSON.stringify(old) !== JSON.stringify(event)) fail("quality_version_conflict", "同一事件不能覆盖成另一内容");
      if (!old) {
        if (closed || events.length >= 160 || Buffer.byteLength(JSON.stringify([...events,event])) > 200_000) {
          closed = true; if (omitted.size < 160) omitted.add(event.id);
        } else events.push(event);
      }
    }
    if (events.length === r.data.events.length && closed === !!r.data.window_closed && omitted.size === (r.data.omitted_event_ids?.length ?? 0)) return r;
    // Coalesce tool-loop messages, then judge asynchronously. Never run the judge on a model request's critical path.
    // New events invalidate old assessments, but must not restart an exhausted job forever.
    const held = r.data.state === "failed" || (r.data.total_attempts ?? 0) >= 20;
    return this.save(r.key, r.kind, team, { ...r.data, events, window_closed: closed,
      window_close_reason: closed ? 'bounded_observation_limit' : null, omitted_event_ids: [...omitted],
      state: held ? "failed" : "queued", attempts: held ? r.data.attempts : 0,
      repair_feedback: null, lease_until: 0, due: Date.now() + 2000 }, r);
  }
  async feedback(team: string, actor: string, exposureId: string, outcome: string, note: string) {
    const r = await this.scoped(exposureId, team);
    if (r.kind !== "exposure") fail("quality_not_found", "不是使用记录");
    if (r.data.expires <= Date.now()) fail("quality_gate_blocked", "观察保留期已结束");
    if (typeof note !== "string" || !note.trim() || containsCredential(note)) fail("invalid_quality_snapshot", "反馈说明必填，且不能包含凭据");
    const result = usageResultSchema.parse({ outcome, reason: note, citations: [] });
    const updated = await this.save(r.key, r.kind, team, { ...r.data, state: "observing", lease_until: 0,
      human_feedback_history: [...(r.data.human_feedback_history ?? []), ...(r.data.human_feedback ? [r.data.human_feedback] : [])].slice(-20),
      human_feedback: { ...result, actor, at: Date.now(), event_hash: usageWindowHash(r.data) } }, r);
    await this.audit(team, actor, "human_feedback", exposureId, note);
    if (outcome === "content_error") await this.recheck(r, actor);
    return updated;
  }
  async retryUsage(team: string, actor: string, exposureId: string, note: string) {
    const r = await this.scoped(exposureId, team);
    if (r.kind !== "exposure" || r.data.state !== "failed" || r.data.expires <= Date.now()) fail("quality_gate_blocked", "仅可重试保留期内的失败观察");
    if ((r.data.total_attempts ?? 0) >= 20) fail("quality_gate_blocked", "已达累计调用上限，请人工评阅，不能继续自动调用");
    if (typeof note !== "string" || !note.trim() || note.length > 2000 || containsCredential(note)) fail("invalid_quality_snapshot", "请填写不含凭据的重试原因");
    const updated = await this.save(r.key, r.kind, team, { ...r.data, state: "queued", attempts: 0, lease_until: 0, due: Date.now(),
      retry_requests: [...(r.data.retry_requests ?? []), { actor, note, at: Date.now() }].slice(-20) }, r);
    await this.audit(team, actor, "usage_retry", exposureId, note);
    return updated;
  }
  async usageRecords(team: string, taskId?: string) {
    const records: QualityRecord[] = []; let after = "";
    for (;;) {
      const page = await this.records.list("exposure", team, after, 200);
      records.push(...page.filter(r => r.data.expires > Date.now() && (!taskId || r.data.task_id === taskId)));
      if (page.length < 200) return records;
      after = page[page.length - 1].key;
    }
  }
  taskReceipt(records: QualityRecord[]) {
    const items = deduplicateUsage(records).map(r => usageReceipt(r)).sort((a, b) => b.updated_at - a.updated_at);
    return { schema_version: "task-asset-usage-receipt/v1", items,
      summary: { assets: new Set(items.map(r => JSON.stringify([r.asset_id, r.revision_id]))).size, observations: items.length,
        assessed: items.filter(r => r.assessment).length, helpful: items.filter(r => r.assessment?.outcome === "helpful").length,
        manual_review: items.filter(r => r.manual_review_required).length }, native_states_unchanged: true };
  }
  utility(exposures: QualityRecord[], context?: z.infer<typeof exposureSchema>["context"], revisionId?: string, before?: RecommendationScene) {
    let positive = 0, negative = 0, count = 0, inapplicable = 0;
    // Repeated injection on ten turns of the same task is ONE correlated sample, not ten votes.
    let samples = deduplicateUsage(exposures.filter(r => (!revisionId || r.data.revision_id === revisionId)
      && (!context || sameEnvironment(r.data.context, context))
      && (!before || (context && revisionId && r.data.before && sceneSimilarity(before, r.data.before) >= DECISION_POLICY.usage.sceneSimilarity))));
    // Scene learning counts independent tasks, not actors/sessions/repeated injections.
    {
      const tasks = new Map<string, QualityRecord>();
      for (const r of samples.sort((a, b) => b.updated - a.updated)) if (!tasks.has(r.data.task_id)) tasks.set(r.data.task_id, r);
      samples = [...tasks.values()];
    }
    let fits = 0, fitWeight = 0, fitBalance = 0;
    for (const r of samples) {
      const fit = currentApplicability(r.data);
      if (before && fit && ["applicable", "not_applicable"].includes(fit.verdict)) {
        const w = DECISION_POLICY.usage.actorWeight;
        fits++; fitWeight += w; fitBalance += fit.verdict === "applicable" ? w : -w;
      }
      const result = currentUsageAssessment(r.data);
      if (!result) continue;
      const weight = DECISION_POLICY.usage.actorWeight;
      if (result.outcome === "not_applicable") { if (!before || !fit) inapplicable += weight; continue; }
      if (!["helpful", "harmful"].includes(result.outcome)) continue;
      if (result.outcome === "helpful") positive += weight; else negative += weight;
      count++;
    }
    const effective = positive + negative;
    const prior = DECISION_POLICY.usage.priorPositive + DECISION_POLICY.usage.priorNegative;
    const posterior = usagePosterior(positive, negative);
    return { score: count ? posterior.mean : null,
      samples: count, effective_samples: effective,
      uncertainty: count ? posterior.standardDeviation : null,
      uncertainty_kind: "posterior_standard_deviation_not_accuracy",
      credible_interval95: count ? posterior.interval95 : null,
      prior: { positive: DECISION_POLICY.usage.priorPositive, negative: DECISION_POLICY.usage.priorNegative },
      applicability_penalty: DECISION_POLICY.usage.maxAdjustment * inapplicable / (prior + inapplicable + effective),
      inapplicable_evidence: inapplicable,
      applicability_adjustment: before && fits >= DECISION_POLICY.usage.minimumFitTasks
        ? DECISION_POLICY.usage.maxAdjustment * fitBalance / (prior + fitWeight) : 0,
      scene_learning: before ? { method: "exact_normalized_terms/v1", similarity_threshold: DECISION_POLICY.usage.sceneSimilarity, matched_tasks: samples.length,
        fit_tasks: fits, minimum_fit_tasks: DECISION_POLICY.usage.minimumFitTasks, max_adjustment: DECISION_POLICY.usage.maxAdjustment, calibrated: false,
        scope: "same_repository_environment_task_type_revision_and_normalized_query", legacy_without_scene_excluded: true } : null,
      decision_policy: DECISION_POLICY.version,
      method: "task_deduplicated_beta/v3", causal_claim: false };
  }

  contextualUtilities(exposures: QualityRecord[]) {
    const groups = new Map<string, QualityRecord>();
    for (const r of exposures) groups.set(JSON.stringify([r.data.revision_id, r.data.context]), r);
    return [...groups.values()].map(r => ({ revision_id: r.data.revision_id, context: r.data.context,
      ...this.utility(exposures, r.data.context, r.data.revision_id) }));
  }
  private async recheck(exposure: QualityRecord, actor: string) {
    const r = await this.scoped(`revision:${exposure.data.revision_id}`, exposure.team);
    // Store a separate re-review request; a model allegation never edits content or silently unpublishes it.
    const key = `recheck:${sha256(exposure.key)}`;
    if (!await this.records.get(key)) await this.save(key, "recheck", r.team, { revision_id: r.data.id,
      asset_id: r.data.asset_id, requested_by: actor, exposure_id: exposure.key, state: "pending", note: "内容错误反馈：请复评并决定是否暂停版本" });
  }
  private async audit(team: string, actor: string, action: string, target: string, note: string) {
    await this.save(`audit:${Date.now()}:${randomUUID()}`, "audit", team, { actor, action, target, note });
  }
  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const revisions = await this.records.list("revision", undefined, this.cursor, 50);
      this.cursor = revisions.length === 50 ? revisions[49].key : "";
      const now = Date.now();
      for (const kind of ["disclosure", "disclosure-read"]) {
        const page = await this.records.list(kind, undefined, this.disclosureCursors[kind] || "", 50);
        this.disclosureCursors[kind] = page.length === 50 ? page[49].key : "";
        for (const row of page) if (row.data.expires <= now) await this.records.delete(row.key, row.rev);
      }
      const eligible = revisions.filter(x => ["queued", "running"].includes(x.data.state) && x.data.due <= now && x.data.lease_until <= now);
      const r = eligible[0];
      if (r) {
        // Opt-in, bounded batch for one team. Every revision still claims its own CAS lease.
        const concurrency = Math.max(1, Math.min(4, Number(r.data.policy.review_parallelism) || 1));
        await Promise.all(eligible.filter(x => x.team === r.team).slice(0, concurrency).map(x => this.evaluate(x)));
      }
      const exposures = await this.records.list("exposure", undefined, this.exposureCursor, 50);
      this.exposureCursor = exposures.length === 50 ? exposures[49].key : "";
      for (const e of exposures) if (e.data.expires <= now) await this.records.delete(e.key, e.rev);
      const e = exposures.find(x => x.data.expires > now && ["queued", "running"].includes(x.data.state) && x.data.due <= now && x.data.lease_until <= now);
      if (e) await this.evaluateUse(e);
      // One bounded migration per tick. Preserve the old result for audit, but
      // never let obsolete evidence rules continue contributing utility votes.
      // Human resolutions and failed/manual-review jobs must not be overridden.
      if (!e && this.usageReviewer) {
        const old = exposures.find(x => x.data.expires > now && x.data.state === "observing" && x.data.events?.length
          && x.data.assessment && x.data.assessment.evidence_contract !== USAGE_EVIDENCE_CONTRACT
          && x.data.recheck_contract !== USAGE_EVIDENCE_CONTRACT && !currentUsageAssessment(x.data));
        if (old) {
          try {
            const queued = await this.save(old.key, old.kind, old.team, { ...old.data,
              recheck_contract: USAGE_EVIDENCE_CONTRACT, attempts: 0, lease_until: 0, due: now,
              state: (old.data.total_attempts ?? 0) >= 20 ? "failed" : "queued",
              last_error: (old.data.total_attempts ?? 0) >= 20 ? "retry_budget_exhausted" : null,
              repair_feedback: null }, old);
            if (queued.data.state === "queued") await this.evaluateUse(queued);
          } catch (error) { if (!(error instanceof QualityError && error.code === "quality_version_conflict")) throw error; }
        }
      }
      const rechecks = await this.records.list("recheck", undefined, this.recheckCursor, 50);
      this.recheckCursor = rechecks.length === 50 ? rechecks[49].key : "";
      const check = rechecks.find(r => r.data.state === "pending");
      if (check) {
        const original = await this.records.get(`revision:${check.data.revision_id}`);
        const exposure = await this.records.get(check.data.exposure_id);
        const current = original ? await this.getAsset(original.data.asset_id) : null;
        if (original && current && exposure && current.team_id === check.team && current.version === original.data.expected_version) {
          const sources = [...original.data.snapshot.sources];
          const result = exposure.data.human_feedback ?? exposure.data.assessment;
          // Only cited excerpts enter the re-review snapshot, not an unbounded copy of the conversation.
          if (sources.length < 24) sources.push({ id: `feedback-${sha256(check.key).slice(0, 12)}`, kind: "conversation", locator: check.data.exposure_id,
            content: JSON.stringify({ feedback: result, excerpts: result?.citations ?? [], retention_expires: exposure.data.expires }) });
          try {
            const revision = await this.submit(check.team, check.data.requested_by, current.version, { ...original.data.snapshot, sources });
            await this.save(check.key, check.kind, check.team, { ...check.data, state: "submitted", review_revision_id: revision!.data.id,
              note: "已自动提交带反馈证据的复评；原版本保持原状态，等待负责人决定修订或暂停。" }, check);
          } catch (error) {
            if (error instanceof QualityError && error.code === "quality_version_conflict") throw error;
            await this.save(check.key, check.kind, check.team, { ...check.data, state: "needs_evidence", note: "无法构造完整复评材料，请负责人补充当前版本证据" }, check);
          }
        } else await this.save(check.key, check.kind, check.team, { ...check.data, state: "unavailable", note: "原内容或观察已不存在，需人工补证据" }, check);
      }
    } finally { this.busy = false; }
  }
  private async claim(r: QualityRecord) {
    if (r.data.attempts >= 3 || (r.data.total_attempts ?? 0) >= 20) { await this.save(r.key, r.kind, r.team, { ...r.data, state: "failed", last_error: "retry_budget_exhausted" }, r); return null; }
    try { return await this.save(r.key, r.kind, r.team, { ...r.data, state: "running", lease_owner: randomUUID(), attempts: r.data.attempts + 1, total_attempts: (r.data.total_attempts ?? 0) + 1, lease_until: Date.now() + 125000 }, r); }
    catch (e) { if (e instanceof QualityError) return null; throw e; }
  }
  private async evaluate(r: QualityRecord) {
    const claimed = await this.claim(r); if (!claimed) return;
    try {
      const report = await withModelUsage({ records: this.records, team: r.team, actor: claimed.data.requested_by, purpose: "quality_review", task_id: claimed.data.task_id, asset_id: claimed.data.asset_id, job_id: r.key }, () => evaluateQuality(claimed.data.snapshot, { reviewer: this.reviewer }));
      const temporary = ["unavailable", "timeout", "invalid_response"].includes(report.reviewer.status);
      const state: Status = temporary ? (claimed.data.attempts < 3 ? "queued" : "failed") : report.decision === "reject" ? "rejected"
        : report.decision === "pass" && report.scorecard?.quality != null && report.scorecard.quality >= claimed.data.policy.minimum_quality
          && report.scorecard.evidence_coverage === 100 ? "awaiting_approval" : "needs_evidence";
      const history = [...(claimed.data.report_history ?? []), ...(claimed.data.report ? [{ report: claimed.data.report, state: claimed.data.state, archived_at: Date.now() }] : [])].slice(-20);
      await this.save(r.key, r.kind, r.team, { ...claimed.data, report_history: history, report, state, due: Date.now() + 5000 * claimed.data.attempts, lease_until: 0 }, claimed);
    } catch (e) {
      if (e instanceof QualityError && e.code === "quality_version_conflict") return;
      await this.save(r.key, r.kind, r.team, { ...claimed.data, state: claimed.data.attempts < 3 ? "queued" : "failed", last_error: "evaluation_failed", due: Date.now() + 10000, lease_until: 0 }, claimed);
    }
  }
  private async evaluateUse(r: QualityRecord) {
    const claimed = await this.claim(r); if (!claimed) return;
    let raw: unknown;
    try {
      if (!this.usageReviewer) throw new UsageReviewError("reviewer_not_configured", ["尚未配置使用效果评价模型，请配置后重试。"]);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const controller = new AbortController();
      const fitPhase = !!claimed.data.before && !currentApplicability(claimed.data);
      // Two isolated model requests. The fit reviewer NEVER sees future events.
      const reviewInput = fitPhase
        ? { mode: "applicability", asset: claimed.data.injected_text, before: claimed.data.before, context: claimed.data.context }
        : { mode: "effect", asset: claimed.data.injected_text, events: claimed.data.events, context: claimed.data.context,
            ...(claimed.data.before ? { before: claimed.data.before } : {}) };
      raw = await Promise.race([
        withModelUsage({ records: this.records, team: r.team, actor: claimed.data.actor, purpose: fitPhase ? "applicability_review" : "effect_review", task_id: claimed.data.task_id, asset_id: claimed.data.asset_id, job_id: r.key }, () => this.usageReviewer!.review({ ...reviewInput,
          ...(claimed.data.repair_feedback ? { correction: claimed.data.repair_feedback } : {}) }, controller.signal)),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => {
          reject(new UsageReviewError("upstream_timeout", ["后台评价模型调用超过 60 秒，已终止本次请求。"])); controller.abort();
        }, 60000); }),
      ]).finally(() => { if (timeout) clearTimeout(timeout); });
      if (containsCredential(typeof raw === "string" ? raw : JSON.stringify(raw) ?? "")) throw new UsageReviewError("unsafe_result", ["评价结果包含疑似凭据，未保存原文。"]);
      if (fitPhase) {
        const fit = validateApplicability(raw, claimed.data.before, claimed.data.injected_text);
        // New future events do not invalidate a prior-only judgment. Merge only
        // that independent result into the latest CAS row, never overwrite events.
        for (let attempt = 0; attempt < 3; attempt++) {
          const latest = await this.records.get(r.key);
          if (!latest || latest.team !== r.team || latest.data.expires <= Date.now() || !latest.data.before
              || sceneHash(latest.data.before) !== sceneHash(claimed.data.before) || currentApplicability(latest.data)) return;
          const held = latest.data.state === "failed" || (latest.data.total_attempts ?? 0) >= 20;
          try {
            await this.save(r.key, r.kind, r.team, { ...latest.data,
              applicability: { ...fit, scene_hash: sceneHash(claimed.data.before), evidence_contract: SCENE_CONTRACT,
                reviewer: this.usageReviewer.id, evaluated_at: Date.now(), assurance: "observational_not_causal" },
              state: held ? "failed" : currentUsageAssessment(latest.data)?.source === "human" ? "observing"
                : latest.data.events.length ? "queued" : "observing", due: Date.now(), lease_until: 0,
              attempts: held ? latest.data.attempts : 0, last_error: held ? latest.data.last_error : null,
              error_details: held ? latest.data.error_details : null, repair_feedback: null }, latest);
            break;
          } catch (error) { if (!(error instanceof QualityError && error.code === "quality_version_conflict")) throw error; }
        }
        return;
      }
      const result = validateUsageResult(raw, claimed.data.events, claimed.data.injected_text);
      const saved = await this.save(r.key, r.kind, r.team, { ...claimed.data, state: "observing", lease_until: 0,
        last_error: null, error_details: null, repair_feedback: null,
        assessment_history: [...(claimed.data.assessment_history ?? []), ...(claimed.data.assessment ? [claimed.data.assessment] : [])].slice(-20), assessment: {
        ...result, reviewer: this.usageReviewer.id, evidence_contract: USAGE_EVIDENCE_CONTRACT,
        evaluated_at: Date.now(), event_hash: usageWindowHash(claimed.data), assurance: "observational_not_causal" } }, claimed);
      if (result.outcome === "content_error") await this.recheck(saved, "usage-reviewer");
    } catch (e) {
      if (e instanceof QualityError && e.code === "quality_version_conflict") return; // new events superseded the leased snapshot
      const error = usageFailure(e);
      const terminal = claimed.data.attempts >= 3 || (claimed.data.total_attempts ?? 0) >= 20
        || ["reviewer_not_configured", "upstream_auth_error", "unsafe_result"].includes(error.code);
      const response = typeof raw === "string" ? raw : JSON.stringify(raw) ?? "";
      const previousResponse = containsCredential(response) ? undefined : response.slice(0, 12000);
      const diagnostic = { ...error, at: Date.now(), attempt: claimed.data.attempts, event_hash: usageWindowHash(claimed.data) };
      try {
        await this.save(r.key, r.kind, r.team, { ...claimed.data, state: terminal ? "failed" : "queued", last_error: error.code,
          error_details: diagnostic, error_history: [...(claimed.data.error_history ?? []), diagnostic].slice(-20),
          repair_feedback: error.repairable ? { errors: error.issues, previous_response: previousResponse,
            instruction: "根据原始资产和事件纠正结果；上一回答不是证据。不要编造引用，没有足够证据请返回 unobserved。" } : null,
          due: Date.now() + Math.min(60000, 5000 * 2 ** (claimed.data.attempts - 1)), lease_until: 0 }, claimed);
      } catch (saveError) {
        if (!(saveError instanceof QualityError && saveError.code === "quality_version_conflict")) throw saveError;
      }
    }
  }
}
