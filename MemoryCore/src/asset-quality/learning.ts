import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { QualityRecord, QualityRecords } from "./records.js";
import { snapshotSchema, type QualitySnapshot } from "./types.js";
import { containsCredential } from "./rules.js";
import { QualityError } from "./lifecycle.js";
import { withModelUsage } from "./model-usage.js";
import { workflowDefinitionSchema, workflowIssues, renderLearnedWorkflow, normalizedLearningText } from "./learning-workflow.js";
import { learningExcerpts } from "./learning-evidence.js";

const id = z.string().min(1).max(200);
export const LEARNING_POLICY_VERSION = "procedure-learning/v5";
export const learningSourceSchema = z.object({
  id: id.refine(s => s !== "asset" && s !== "scope", "reserved source id"), kind: z.enum(["document", "conversation", "code", "test_output", "resource"]),
  locator: z.string().min(1).max(1000), revision: id, content: z.string().min(1).max(60_000),
  synthetic: z.boolean(), visibility: z.enum(["private", "team"]), asset_id: id.optional(),
  truncated: z.boolean().optional(),
}).strict();
export const learningInputSchema = z.object({
  mode: z.enum(["history", "task"]), repository: z.string().min(1).max(1000), version: id,
  scope: z.string().min(1).max(4000), task_id: id.optional(),
  sources: z.array(learningSourceSchema).min(1).max(24),
}).strict().superRefine((v, c) => {
  if (new Set(v.sources.map(s => s.id)).size !== v.sources.length) c.addIssue({ code: "custom", message: "来源 ID 不得重复" });
  if (Buffer.byteLength(JSON.stringify(v), "utf8") > 140_000) c.addIssue({ code: "custom", message: "材料超过 140000 UTF-8 字节，请分批提交，为生成内容和审核快照保留空间" });
  if (v.mode === "task" && !v.task_id) c.addIssue({ code: "custom", message: "任务回流需要 task_id" });
});
export type LearningInput = z.infer<typeof learningInputSchema>;
const citationSchema = z.object({ source_id: id, start: z.number().int().min(0).optional(), end: z.number().int().min(1).optional(), quote: z.string().min(1).max(8000) }).strict();
const proposalSchema = z.object({
  kind: z.enum(["project_experience", "failure_pattern", "revision_suggestion", "skill_candidate", "workflow_candidate", "reuse_existing"]),
  title: z.string().min(1).max(200), claim: z.string().min(1).max(8000),
  action: z.string().min(1).max(8000), applicability: z.string().min(1).max(4000),
  risk: z.enum(["low", "medium", "high"]), target_asset_id: id.optional(),
  evidence: z.array(citationSchema).min(1).max(12),
  workflow: workflowDefinitionSchema.optional(),
}).strict();
export const learningResultSchema = z.object({
  candidates: z.array(proposalSchema).max(6), reason: z.string().min(1).max(4000),
}).strict();
const wireResultSchema = learningResultSchema.extend({ candidates: z.array(proposalSchema.extend({
  evidence: z.array(z.union([citationSchema, z.object({ source_id: id, excerpt_id: id }).strict()])).min(1).max(12),
})).max(6) });
export type LearningProposal = z.infer<typeof proposalSchema>;
export const hashLearning = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface LearningGenerator { id: string; generate(input: LearningInput, signal: AbortSignal, validationError?: string): Promise<unknown> }
export type LearningCandidate = {
  asset_id: string; proposal: LearningProposal; snapshot: QualitySnapshot;
  origin_job: string; task_id?: string; repository: string; version: string;
  visibility: "private" | "team"; owner: string; team: string;
  source_manifest: Array<Omit<LearningInput["sources"][number], "content"> & { sha256: string }>;
  verification: { status: "requires_review"; test_source_ids: string[]; automatic_validation: false };
};

export function validateLearningResult(raw: unknown, input: LearningInput) {
  const wire = wireResultSchema.parse(typeof raw === "string" ? JSON.parse(raw) : raw);
  const result = learningResultSchema.parse({ ...wire, candidates: wire.candidates.map(p => ({ ...p, evidence: p.evidence.map(e => {
    if (!('excerpt_id' in e)) return e;
    const source = input.sources.find(s => s.id === e.source_id);
    const span = source && learningExcerpts(source).find(s => s.excerpt_id === e.excerpt_id);
    if (!span) throw new QualityError('invalid_quality_snapshot', '引用片段编号不属于对应的原始资料');
    return { source_id: e.source_id, start: span.start, end: span.end, quote: span.quote };
  }) })) });
  if (containsCredential(JSON.stringify(result))) throw new QualityError("invalid_quality_snapshot", "生成内容包含凭据，未保存候选");
  for (const p of result.candidates) {
    if (["revision_suggestion", "reuse_existing"].includes(p.kind) && (!p.target_asset_id || !input.sources.some(s => s.asset_id === p.target_asset_id))) {
      throw new QualityError("invalid_quality_snapshot", "修订建议缺少可追溯的原资产");
    }
    if (!["revision_suggestion", "reuse_existing"].includes(p.kind) && p.target_asset_id) throw new QualityError("invalid_quality_snapshot", "仅修订或复用可以指定原资产");
    for (const e of p.evidence) {
      const s = input.sources.find(s => s.id === e.source_id);
      if (s && e.start === undefined && e.end === undefined) {
        const start = s.content.indexOf(e.quote);
        if (start >= 0 && s.content.indexOf(e.quote, start + 1) < 0) { e.start = start; e.end = start + e.quote.length; }
      }
      if (!s || e.start === undefined || e.end === undefined || e.end <= e.start || s.content.slice(e.start, e.end) !== e.quote) {
        throw new QualityError("invalid_quality_snapshot", "候选引用与原始资料不一致");
      }
    }
    if (["revision_suggestion", "reuse_existing"].includes(p.kind) && !p.evidence.some(e => input.sources.find(s => s.id === e.source_id)?.asset_id === p.target_asset_id)) {
      const sourceIds = input.sources.filter(s => s.asset_id === p.target_asset_id).map(s => s.id);
      throw new QualityError("invalid_quality_snapshot", `第 ${result.candidates.indexOf(p) + 1} 项：修订或复用必须引用目标资产原文。target_asset_id=${p.target_asset_id} 对应 source_id=${sourceIds.join(",")}；须在本项 evidence 中增加该来源的片段。执行轨迹中提到资产不替代原资产引用。`);
    }
    if (["revision_suggestion", "reuse_existing"].includes(p.kind) && !p.evidence.some(e => !input.sources.find(s => s.id === e.source_id)?.asset_id)) {
      throw new QualityError("invalid_quality_snapshot", "修订建议还需要引用原资产以外的纠错依据");
    }
    if (["skill_candidate", "workflow_candidate"].includes(p.kind) && !p.workflow) throw new QualityError("invalid_quality_snapshot", "新流程缺少结构化步骤");
    if (p.workflow && !["skill_candidate", "workflow_candidate", "revision_suggestion"].includes(p.kind)) throw new QualityError("invalid_quality_snapshot", "当前分流不应包含流程");
    if (p.workflow) { const issues = workflowIssues(p, input); if (issues.length) throw new QualityError("invalid_quality_snapshot", issues.join("；")); }
  }
  return result;
}

/** Durable queue shared by raw-source ingestion and task-result learning.
 * Generation and publication are separate operations; no native asset patch tool is exposed. */
export class AssetLearning {
  generator?: LearningGenerator;
  beforeTick?: () => Promise<void>;
  prepare?: (team: string, actor: string, input: LearningInput) => Promise<LearningInput>;
  private busy = false;
  private timer?: ReturnType<typeof setInterval>;
  private cursor = "";
  constructor(readonly records: QualityRecords,
    private authorize: (team: string, actor: string, input: LearningInput) => Promise<void>,
    private materialize: (candidate: LearningCandidate) => Promise<void>) {}
  start() { if (!this.timer) { this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 2500); this.timer.unref(); } }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  private async save(r: QualityRecord) {
    if (!await this.records.cas({ ...r, updated: Date.now() }, r.rev)) throw new QualityError("quality_version_conflict", "候选任务已被其他执行器更新");
    return { ...r, rev: r.rev + 1 };
  }
  async enqueue(team: string, actor: string, raw: unknown) {
    const input = learningInputSchema.parse(raw);
    if (containsCredential(JSON.stringify(input))) throw new QualityError("invalid_quality_snapshot", "原始资料包含凭据，请清理后提交");
    await this.authorize(team, actor, input);
    const key = `learning:${hashLearning([LEARNING_POLICY_VERSION, team, actor, input])}`;
    const old = await this.records.get(key); if (old) return old;
    let after = "", active = 0, daily = 0;
    for (;;) {
      const page = await this.records.list("learning", team, after, 200);
      active += page.filter(r => ["queued", "running"].includes(r.data.state)).length;
      daily += page.filter(r => r.data.created_at > Date.now() - 86400000).length;
      if (active >= 50 || daily >= 200) throw new QualityError("quality_review_busy", "候选生成队列或每日限额已满");
      if (page.length < 200) break; after = page.at(-1)!.key;
    }
    return this.save({ key, kind: "learning", team, rev: 0, updated: Date.now(), data: {
      actor, input, policy_version: LEARNING_POLICY_VERSION, state: "queued", attempts: 0, due: Date.now(), lease_until: 0,
      created_at: Date.now(), candidate_ids: [], review_required: true,
      source_assurance: "submitted_material_not_independent_attestation",
    } });
  }
  async tick() {
    if (this.busy || !this.generator) return;
    this.busy = true;
    try {
      await this.beforeTick?.();
      const page = await this.records.list("learning", undefined, this.cursor, 50);
      this.cursor = page.length === 50 ? page.at(-1)!.key : "";
      const row = page.find(r => ["queued", "running"].includes(r.data.state) && r.data.due <= Date.now() && r.data.lease_until <= Date.now());
      if (!row) return;
      let claimed: QualityRecord;
      try { claimed = await this.save({ ...row, data: { ...row.data, state: "running", attempts: row.data.attempts + 1, lease_owner: randomUUID(), lease_until: Date.now() + 125000 } }); }
      catch (e) { if (e instanceof QualityError) return; throw e; }
      try {
        let input = learningInputSchema.parse(claimed.data.prepared_input ?? claimed.data.input);
        await this.authorize(row.team, row.data.actor, input);
        // Reuse persisted output after a crash between materialization and job completion.
        let result = claimed.data.result;
        if (!result) {
          if (!claimed.data.prepared_input && this.prepare) {
            input = learningInputSchema.parse(await this.prepare(row.team, row.data.actor, input));
            await this.authorize(row.team, row.data.actor, input);
            claimed = await this.save({ ...claimed, data: { ...claimed.data, prepared_input: input } });
          }
          const raw = await withModelUsage({ records: this.records, team: row.team, actor: row.data.actor,
            purpose: input.mode === "history" ? "history_extraction" : "task_learning", task_id: input.task_id, job_id: row.key },
          () => this.generator!.generate(input, AbortSignal.timeout(110000), claimed.data.validation_error));
          result = validateLearningResult(raw, input);
          claimed = await this.save({ ...claimed, data: { ...claimed.data, result, generator: this.generator.id } });
        }
        result = validateLearningResult(result, input);
        await this.authorize(row.team, row.data.actor, input);
        const ids: string[] = [];
        const decisions: Array<{ kind: string; asset_id?: string; reason: string }> = [];
        for (const proposal of result.candidates) {
          if (proposal.kind === "reuse_existing") {
            const key = `learning-resolution:${hashLearning([row.key, proposal.target_asset_id])}`;
            if (!await this.records.get(key)) await this.save({ key, kind: "learning-resolution", team: row.team, rev: 0, updated: Date.now(),
              data: { actor: row.data.actor, job_id: row.key, task_id: input.task_id, proposal, assurance: "reuse_suggestion_not_observed_adoption" } });
            decisions.push({ kind: "reuse_existing", asset_id: proposal.target_asset_id, reason: proposal.action });
            continue;
          }
          const fingerprint = hashLearning([row.key, row.team, row.data.actor, input.repository, input.version, proposal.kind,
            proposal.title, proposal.claim, proposal.action, proposal.applicability, proposal.target_asset_id ?? null,
            proposal.workflow ?? null, proposal.risk, proposal.evidence,
            input.sources.map(s => [s.id, s.revision, hashLearning(s.content)])]);
          // Repeated evidence for the same exact procedure produces one candidate per owner/scope.
          const identity = proposal.workflow ? hashLearning([row.team, row.data.actor, input.repository, input.version,
            input.sources.some(s => s.visibility === "private"),
            proposal.kind, proposal.target_asset_id, normalizedLearningText(proposal.title), normalizedLearningText(proposal.claim),
            normalizedLearningText(proposal.action), proposal.workflow]) : fingerprint;
          const assetId = `learned-${identity.slice(0, 32)}`;
          const workflow = proposal.workflow ? renderLearnedWorkflow(assetId, proposal, input) : null;
          const candidate: LearningCandidate = {
            asset_id: assetId, proposal, owner: row.data.actor, team: row.team, origin_job: row.key,
            task_id: input.task_id, repository: input.repository, version: input.version,
            // All supplied context can influence generation, including uncited sources.
            visibility: input.sources.some(s => s.visibility === "private") ? "private" : "team",
            source_manifest: input.sources.map(({ content, ...s }) => ({ ...s, sha256: createHash("sha256").update(content).digest("hex") })),
            verification: { status: "requires_review", test_source_ids: input.sources.filter(s => s.kind === "test_output").map(s => s.id), automatic_validation: false },
            snapshot: {
              asset_id: assetId, unit_id: assetId,
              asset_type: workflow ? "skill" : proposal.kind === "failure_pattern" && input.sources.some(s => s.kind === "conversation") ? "chat_memory" : "llm_wiki",
              content_version: fingerprint, declared_scope: proposal.applicability,
              project_scope: { repository: input.repository, version: input.version, synthetic: input.sources.some(s => s.synthetic) },
              ...(workflow ? { workflow_scope: workflow.scope } : {}),
              body: workflow?.body ?? `${proposal.title}\n\n${proposal.claim}\n\n建议：${proposal.action}\n\n适用条件：${proposal.applicability}\n风险：${proposal.risk}`,
              sources: input.sources.map(s => ({ id: s.id, kind: s.kind, locator: s.locator, revision: s.revision, content: s.content })),
            },
          };
          // Validate before writing either candidate or asset; an oversized snapshot must not leave a partial asset.
          candidate.snapshot = snapshotSchema.parse(candidate.snapshot);
          const duplicate = input.sources.find(s => s.asset_id && normalizedLearningText(s.content) === normalizedLearningText(candidate.snapshot.body));
          if (duplicate && !proposal.workflow) {
            const resolution = `learning-resolution:${hashLearning([row.key, duplicate.asset_id])}`;
            if (!await this.records.get(resolution)) await this.save({ key: resolution, kind: "learning-resolution", team: row.team, rev: 0, updated: Date.now(),
              data: { actor: row.data.actor, job_id: row.key, task_id: input.task_id, proposal, target_asset_id: duplicate.asset_id, assurance: "duplicate_content_not_observed_adoption" } });
            decisions.push({ kind: "reuse_existing", asset_id: duplicate.asset_id, reason: "正文与已有资产相同，未重复创建" }); continue;
          }
          const key = `learning-candidate:${assetId}`;
          let existing = await this.records.get(key);
          if (!existing) {
            try { await this.save({ key, kind: "learning-candidate", team: row.team, rev: 0, updated: Date.now(), data: candidate }); }
            catch (e) { if (!(e instanceof QualityError)) throw e; existing = await this.records.get(key); if (!existing) throw e; }
          }
          if (existing && existing.data.origin_job !== row.key) {
            const origin = await this.records.get(existing.data.origin_job);
            if (!origin || origin.team !== row.team) throw new QualityError("permission_denied", "无法核对重复候选的来源");
            await this.authorize(row.team, row.data.actor, origin.data.prepared_input ?? origin.data.input);
            await this.materialize(existing.data as LearningCandidate);
            const resolution = `learning-resolution:${hashLearning([row.key, assetId])}`;
            if (!await this.records.get(resolution)) await this.save({ key: resolution, kind: "learning-resolution", team: row.team, rev: 0, updated: Date.now(),
              data: { actor: row.data.actor, job_id: row.key, task_id: input.task_id, proposal, target_asset_id: assetId, assurance: "duplicate_procedure_not_observed_adoption" } });
            decisions.push({ kind: "duplicate_candidate", asset_id: assetId, reason: "已有相同流程候选，保留新来源并继续使用原审核入口" });
            continue;
          }
          await this.materialize(existing ? existing.data as LearningCandidate : candidate);
          ids.push(assetId);
          decisions.push({ kind: proposal.kind, asset_id: assetId, reason: proposal.action });
        }
        await this.save({ ...claimed, data: { ...claimed.data, state: ids.length ? "completed" : decisions.length ? "reused" : "no_candidates", decisions, candidate_ids: [...new Set(ids)], lease_until: 0 } });
      } catch (e) {
        const current = await this.records.get(claimed.key);
        if (!current || current.rev !== claimed.rev) return; // A different worker owns this revision.
        const staleSource = e instanceof QualityError && ["quality_version_conflict", "permission_denied"].includes(e.code);
        await this.save({ ...claimed, data: { ...claimed.data, state: staleSource || claimed.data.attempts >= 3 ? "failed" : "queued",
          due: Date.now() + 10000 * claimed.data.attempts, lease_until: 0,
          last_error: e instanceof QualityError ? e.code : "generation_failed_or_invalid_evidence",
          // Only validator-authored diagnostics are retained, never provider bodies or rejected content.
          validation_error: e instanceof QualityError && e.code === "invalid_quality_snapshot" ? e.message
            : e instanceof z.ZodError ? "生成 JSON 不符合字段约束，请核对必填字段、枚举、长度与结构。" : undefined } });
      }
    } finally { this.busy = false; }
  }
}
