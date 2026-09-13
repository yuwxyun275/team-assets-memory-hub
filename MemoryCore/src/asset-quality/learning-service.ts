import { z } from "zod";
import type { AssetEntity, CreateAssetInput, TeamMemberEntity } from "../metadata/types.js";
import type { QualityLifecycle } from "./lifecycle.js";
import type { TaskEntity } from "../metadata/types.js";
import type { QualityRecords } from "./records.js";
import { AssetLearning, hashLearning, learningInputSchema, type LearningCandidate, type LearningInput } from "./learning.js";
import { QualityError } from "./lifecycle.js";
import { summarizeModelUsage } from "./model-usage.js";
import { currentUsageAssessment } from "./usage-result.js";

interface LearningMetadata {
  quality?: QualityLifecycle;
  getTeamMember(team: string, actor: string): Promise<TeamMemberEntity | null>;
  getTaskById(id: string): Promise<TaskEntity | null>;
  getAssetById(id: string): Promise<AssetEntity | null>;
  checkAssetPermission(input: { user_id: string; asset_id: string; action: "read" }): Promise<{ allowed: boolean }>;
  createAsset(input: CreateAssetInput): Promise<AssetEntity>;
  listAssetsByTeam(team: string, pagination: { offset: number; limit: number }): Promise<{ items: AssetEntity[]; total: number }>;
}
export class AssetLearningService {
  readonly queue: AssetLearning;
  private triggerCursor = "";
  private observationCursor = "";
  constructor(private meta: LearningMetadata, private records: QualityRecords) {
    this.queue = new AssetLearning(records, async (t, a, i) => { await this.authorize(t, a, i); }, c => this.materialize(c));
    this.queue.prepare = (t, a, i) => this.prepareComparisons(t, a, i);
    this.queue.beforeTick = async () => { await this.collectUsageSignals(); await this.consumeTaskTrigger(); };
  }
  async recordTask(task: TaskEntity, signal?: { id: string; reason: string }) {
    let receipt;
    try { receipt = JSON.parse(task.metadata_json || "{}").asset_evidence; } catch { return; }
    if (!receipt?.completion || !receipt.trace_id) return;
    if (task.status !== "completed" && !receipt.completion.task_completed && !receipt.completion.failed_tests?.length
      && !receipt.completion.checks?.automated_test_evidence_observed && !receipt.ci_runs?.length && !signal) return;
    const key = `learning-trigger:${hashLearning([task.team_id, task.task_id])}`;
    const old = await this.records.get(key);
    const fingerprint = hashLearning([receipt.trace_id, receipt.completion, receipt.ci_runs, signal]);
    if (old?.data.fingerprint === fingerprint) return;
    const firstSeen = old?.data.state === "queued" ? old.data.first_seen ?? Date.now() : Date.now();
    const row = { key, kind: "learning-trigger", team: task.team_id, updated: Date.now(), rev: old?.rev ?? 0,
      data: { fingerprint, task_id: task.task_id, actor: task.creator_user_id, state: "queued", attempts: 0,
        first_seen: firstSeen, submitted_at: old?.data.submitted_at,
        reason: signal?.reason ?? (receipt.completion.task_completed ? "task_completed" : "stage_result"),
        // Coalesce late tool results/feedback; a task can trigger at most one automatic job per minute.
        due: Math.max(Math.min(Date.now() + 15000, firstSeen + 120000), (old?.data.submitted_at ?? 0) + 60000) } };
    if (!await this.records.cas(row, row.rev)) throw new QualityError("quality_version_conflict", "任务回流触发记录已更新，请重试任务保存");
  }
  private async collectUsageSignals() {
    const rows = await this.records.list("exposure", undefined, this.observationCursor, 50);
    this.observationCursor = rows.length === 50 ? rows.at(-1)!.key : "";
    let processed = 0;
    for (const r of rows.filter(r => r.data.state === "observing" && r.data.task_id && r.data.expires > Date.now())) {
      const assessment = currentUsageAssessment(r.data);
      if (!assessment || !["helpful", "harmful", "content_error", "not_applicable"].includes(assessment.outcome)) continue;
      const fingerprint = hashLearning([r.data.events, assessment]);
      const key = `learning-observation:${hashLearning(r.key)}`, old = await this.records.get(key);
      if (old?.data.fingerprint === fingerprint) continue;
      const task = await this.meta.getTaskById(r.data.task_id);
      // Private trajectories only enter their owner's task; team administration does not grant conversation access.
      if (!task || task.team_id !== r.team || task.creator_user_id !== r.data.actor) continue;
      await this.recordTask(task, { id: fingerprint, reason: assessment.outcome === "helpful" ? "reuse_observed" : "correction_observed" });
      await this.records.cas({ key, kind: "learning-observation", team: r.team, rev: old?.rev ?? 0, updated: Date.now(),
        data: { fingerprint } }, old?.rev ?? 0);
      if (++processed >= 8) break;
    }
  }
  private async consumeTaskTrigger() {
    const rows = await this.records.list("learning-trigger", undefined, this.triggerCursor, 50);
    this.triggerCursor = rows.length === 50 ? rows.at(-1)!.key : "";
    const r = rows.find(r => r.data.state === "queued" && r.data.due <= Date.now());
    if (!r) return;
    try {
      const job = await this.fromTask(r.team, r.data.actor, r.data.task_id);
      await this.records.cas({ ...r, updated: Date.now(), data: { ...r.data, state: "submitted", job_id: job.key, submitted_at: Date.now() } }, r.rev);
    } catch (e) {
      const attempts = r.data.attempts + 1;
      await this.records.cas({ ...r, updated: Date.now(), data: { ...r.data, attempts,
        state: attempts >= 3 ? "failed" : "queued", due: Date.now() + 10000 * attempts,
        last_error: e instanceof QualityError ? e.code : "task_learning_input_unavailable" } }, r.rev);
    }
  }
  async authorize(team: string, actor: string, input?: LearningInput, checkCurrentVersion = true) {
    const member = await this.meta.getTeamMember(team, actor);
    if (member?.status !== "active") throw new QualityError("permission_denied", "需要有效团队成员身份");
    if (input?.task_id) {
      const task = await this.meta.getTaskById(input.task_id);
      if (!task || task.team_id !== team) throw new QualityError("permission_denied", "任务不属于当前团队");
      if (task.creator_user_id !== actor && member.role !== "admin") throw new QualityError("permission_denied", "仅任务创建者或管理员可提交任务学习");
    }
    for (const s of input?.sources ?? []) if (s.asset_id) {
      const asset = await this.meta.getAssetById(s.asset_id);
      const p = asset && await this.meta.checkAssetPermission({ user_id: actor, asset_id: s.asset_id, action: "read" });
      if (!asset || asset.team_id !== team || !p?.allowed) throw new QualityError("permission_denied", "无权使用来源资产");
      if (asset.visibility !== "team" && s.visibility !== "private") throw new QualityError("permission_denied", "候选不能扩大来源资产的可见范围");
      const snapshot = checkCurrentVersion ? await this.comparisonSnapshot(team, asset) : null;
      if (checkCurrentVersion && (!snapshot || s.content !== snapshot.body || s.revision !== snapshot.content_version)) {
        throw new QualityError("quality_version_conflict", "来源资产正文或版本与当前审核快照不一致");
      }
    }
    return member;
  }
  private async comparisonSnapshot(team: string, asset: AssetEntity) {
    const p = await this.meta.quality?.publication(team, asset.asset_id);
    if (p) return p.snapshot;
    if (asset.status !== "candidate" || asset.source_type !== "asset_learning") return null;
    const c = await this.records.get(`learning-candidate:${asset.asset_id}`);
    return c?.team === team ? c.data.snapshot as LearningCandidate["snapshot"] : null;
  }
  private async prepareComparisons(team: string, actor: string, original: LearningInput): Promise<LearningInput> {
    const input = structuredClone(original), known = new Set(input.sources.map(s => s.asset_id).filter(Boolean));
    const terms = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9_]{2,}|[\u4e00-\u9fff]{2}/g) ?? []);
    const query = terms([input.scope, ...input.sources.filter(s => !s.asset_id).map(s => s.content.slice(0, 6000))].join(" "));
    const candidates: Array<{ asset: AssetEntity; score: number }> = [];
    for (let offset = 0; offset < 2000; offset += 200) {
      const page = await this.meta.listAssetsByTeam(team, { offset, limit: 200 });
      for (const asset of page.items) {
        if (known.has(asset.asset_id) || !["candidate", "approved"].includes(asset.status)) continue;
        const words = terms(`${asset.name} ${asset.description ?? ""}`);
        const score = [...words].filter(w => query.has(w)).length / Math.max(1, Math.sqrt(words.size * query.size));
        if (score > 0) candidates.push({ asset, score });
      }
      if (offset + page.items.length >= page.total || !page.items.length) break;
    }
    let added = 0;
    for (const { asset } of candidates.sort((a, b) => b.score - a.score || a.asset.asset_id.localeCompare(b.asset.asset_id)).slice(0, 24)) {
      if (added >= 8 || input.sources.length >= 24) break;
      if (!(await this.meta.checkAssetPermission({ user_id: actor, asset_id: asset.asset_id, action: "read" })).allowed) continue;
      const snapshot = await this.comparisonSnapshot(team, asset); if (!snapshot) continue;
      const source: LearningInput["sources"][number] = { id: `existing-${hashLearning(asset.asset_id).slice(0, 20)}`,
        kind: asset.asset_type === "skill" ? "resource" : "document", asset_id: asset.asset_id,
        locator: `asset:${asset.asset_id}#${asset.status}`, revision: snapshot.content_version, content: snapshot.body,
        synthetic: snapshot.project_scope?.synthetic === true, visibility: asset.visibility === "team" ? "team" : "private" };
      if (input.sources.some(s => s.id === source.id)) continue;
      if (Buffer.byteLength(JSON.stringify({ ...input, sources: [...input.sources, source] }), "utf8") > 138000) continue;
      input.sources.push(source); added++;
    }
    return input;
  }
  private async materialize(c: LearningCandidate) {
    let asset = await this.meta.getAssetById(c.asset_id);
    if (!asset) asset = await this.meta.createAsset({ asset_id: c.asset_id, team_id: c.team,
      owner_user_id: c.owner, name: c.proposal.title, description: c.proposal.claim,
      asset_type: c.snapshot.asset_type, visibility: c.visibility, status: "candidate",
      source_type: "asset_learning", source_ref: c.origin_job, content_ref: `learning-candidate:${c.asset_id}`,
      metadata_json: JSON.stringify({ repository: c.repository, project_version: c.version,
        recommended_action: c.proposal.action, risks: [`declared_risk:${c.proposal.risk}`],
        semantic_asset_type: c.snapshot.asset_type === "skill" ? "validation_workflow" : c.proposal.kind === "failure_pattern" ? "failure_experience" : "project_constraint",
        learning: { kind: c.proposal.kind, origin_job: c.origin_job,
        task_id: c.task_id, repository: c.repository, version: c.version, source_manifest: c.source_manifest,
        target_asset_id: c.proposal.target_asset_id, evidence: c.proposal.evidence, verification: c.verification,
        synthetic: c.source_manifest.some(s => s.synthetic), review_required: true } }),
    });
    if (asset.team_id !== c.team || asset.owner_user_id !== c.owner || asset.source_ref !== c.origin_job) {
      throw new QualityError("quality_version_conflict", "候选 ID 已由其他内容使用");
    }
    // Publication changes only through the existing versioned quality decision.
    if (asset.status === "candidate") await this.meta.quality!.submit(c.team, c.owner, asset.version, c.snapshot);
  }
  async fromTask(team: string, actor: string, taskId: string) {
    await this.authorize(team, actor);
    const task = await this.meta.getTaskById(taskId);
    if (!task || task.team_id !== team) throw new QualityError("permission_denied", "任务不属于当前团队");
    const member = await this.meta.getTeamMember(team, actor);
    if (task.creator_user_id !== actor && member?.role !== "admin") throw new QualityError("permission_denied", "无权提交该任务的学习");
    const metadata = JSON.parse(task.metadata_json || "{}");
    const receipt = metadata.asset_evidence;
    if (!receipt?.completion || (!receipt.completion.task_completed && !receipt.completion.failed_tests?.length
      && !receipt.completion.checks?.automated_test_evidence_observed)) {
      throw new QualityError("quality_gate_blocked", "任务尚无执行或测试结果，请完成验证后提炼");
    }
    const source = (id: string, kind: LearningInput["sources"][number]["kind"], content: unknown, visibility: "team" | "private" = "team") => {
      const text = typeof content === "string" ? content : JSON.stringify(content);
      if (!text) throw new QualityError("quality_gate_blocked", "任务材料为空");
      const excerpt = text.slice(0, 18000);
      return { id, kind, locator: `task:${taskId}#${id}`, revision: hashLearning(text), content: excerpt, truncated: text.length > excerpt.length,
        synthetic: metadata.synthetic === true, visibility };
    };
    const field = (v: any): string | undefined => typeof v === "string" ? v : typeof v?.value === "string" ? v.value : undefined;
    const input: LearningInput = {
      mode: "task", task_id: taskId,
      repository: field(receipt.task_profile?.repository) || field(receipt.acceptance_contract?.repository) || field(metadata.repository) || task.source_url || `task:${taskId}`,
      version: field(receipt.task_profile?.version) || field(receipt.acceptance_contract?.version) || field(metadata.version) || "unspecified",
      scope: `${task.title}\n${task.description || ""}`.slice(0, 4000),
      sources: [source("task", "document", { title: task.title, description: task.description }),
        source("execution", "test_output", { completion: receipt.completion, ci_runs: receipt.ci_runs ?? [],
          assurance: "stored_task_receipt_not_new_test_execution", trace_id: receipt.trace_id })],
    };
    for (const item of (receipt.assets ?? []).slice(0, 10)) {
      const id = item.runtime_asset_id || item.asset_id;
      const asset = await this.meta.getAssetById(id);
      if (!asset || asset.team_id !== team || !(await this.meta.checkAssetPermission({ user_id: actor, asset_id: id, action: "read" })).allowed) continue;
        const p = await this.meta.quality!.publication(team, id); if (!p) continue;
      input.sources.push({ id: `asset-${input.sources.length}`, kind: "document", locator: `asset:${id}`,
        asset_id: id, revision: p.snapshot.content_version, content: p.snapshot.body,
        visibility: asset.visibility === "team" ? "team" : "private", synthetic: JSON.parse(asset.metadata_json || "{}").learning?.synthetic === true });
    }
    const exposures = await this.meta.quality!.usageRecords(team, taskId);
    for (const e of exposures.filter(e => e.data.actor === actor).slice(-8)) {
      if (!e.data.events?.length) continue;
      input.sources.push(source(`trajectory-${input.sources.length}`, "conversation", { events: e.data.events,
        usage_assessment: currentUsageAssessment(e.data), applicability: e.data.applicability ?? null,
        assurance: "observed_feedback_not_causal_validation" }, "private"));
    }
    // Preserve complete asset bodies; trim only the number of context sources.
    let size = Buffer.byteLength(JSON.stringify({ ...input, sources: [] }), "utf8");
    const kept = input.sources.filter(s => {
      const bytes = Buffer.byteLength(JSON.stringify(s), "utf8") + 1;
      if (size + bytes > 135000) return false; size += bytes; return true;
    });
    if (kept.length !== input.sources.length) input.scope = `${input.scope.slice(0, 3800)}\n部分来源因观察预算未纳入，不能据此声称覆盖全部轨迹。`;
    input.sources = kept;
    return this.queue.enqueue(team, actor, input);
  }
  async action(action: string, team: string, actor: string, data: Record<string, any>) {
    const member = await this.authorize(team, actor);
    if (action === "learning-submit") {
      const input = learningInputSchema.parse(data.input);
      // Task learning must load the server's recorded outcome instead of accepting a fabricated receipt.
      if (input.mode !== "history") throw new QualityError("invalid_param", "任务回流请使用 learning-from-task");
      return this.queue.enqueue(team, actor, input);
    }
    if (action === "learning-from-task") return this.fromTask(team, actor, z.string().min(1).max(200).parse(data.task_id));
    if (action === "learning-details") {
      const r = await this.records.get(z.string().min(1).max(200).parse(data.job_id));
      if (!r || r.team !== team || r.kind !== "learning" || r.data.actor !== actor) throw new QualityError("permission_denied", "无权读取该学习任务");
      // Historic snapshots stay auditable when the source advances; current ACLs still apply.
      await this.authorize(team, actor, r.data.prepared_input ?? r.data.input, false); return r;
    }
    if (action === "learning-candidate") {
      const asset = await this.meta.getAssetById(data.asset_id);
      if (!asset || asset.team_id !== team || !(await this.meta.checkAssetPermission({ user_id: actor, asset_id: asset.asset_id, action: "read" })).allowed) throw new QualityError("permission_denied", "无权读取候选");
      const r = await this.records.get(`learning-candidate:${asset.asset_id}`);
      if (!r || r.team !== team) throw new QualityError("quality_not_found", "候选不存在");
      return r;
    }
    if (action === "learning-list") {
      const rows = await this.records.list("learning", team, String(data.after ?? ""), 100);
      const items = [];
      for (const r of rows) if (r.data.actor === actor && (!data.task_id || r.data.input.task_id === data.task_id)) {
        try { await this.authorize(team, actor, r.data.prepared_input ?? r.data.input, false); } catch { continue; }
        items.push({ key: r.key, updated: r.updated, data: { state: r.data.state, mode: r.data.input.mode,
          task_id: r.data.input.task_id, repository: r.data.input.repository, candidate_ids: r.data.candidate_ids,
          last_error: r.data.last_error, validation_error: r.data.validation_error, reason: r.data.result?.reason, decisions: r.data.decisions ?? [], attempts: r.data.attempts } });
      }
      if (!data.after) {
        const triggers = await this.records.list("learning-trigger", team, "", 100);
        for (const r of triggers) if (r.data.actor === actor && r.data.state !== "submitted" && (!data.task_id || data.task_id === r.data.task_id)) {
          items.push({ key: r.key, updated: r.updated, data: { state: r.data.state, mode: "task", task_id: r.data.task_id,
            repository: r.data.task_id, candidate_ids: [], last_error: r.data.last_error, reason: "任务结果已记录，等待组织学习材料", attempts: r.data.attempts } });
        }
      }
      return { items, next_cursor: rows.length === 100 ? rows.at(-1)!.key : null };
    }
    if (action === "costs") {
      const prices = z.array(z.object({ model: z.string(), version: z.string().min(1), currency: z.string().min(1),
        input_per_million: z.number().nonnegative(), output_per_million: z.number().nonnegative(),
        cache_read_per_million: z.number().nonnegative().optional(), cache_write_per_million: z.number().nonnegative().optional() }).strict()).max(100).parse(data.prices ?? []);
      const items = []; let after = "";
      for (;;) {
        const rows = await this.records.list("model-usage", team, after, 200);
        for (const r of rows) {
          if (r.data.actor !== actor && member.role !== "admin") continue;
          if (data.task_id && r.data.task_id !== data.task_id) continue;
          if (r.data.asset_id && !(await this.meta.checkAssetPermission({ user_id: actor, asset_id: r.data.asset_id, action: "read" })).allowed) continue;
          items.push(r);
        }
        if (rows.length < 200) break; after = rows.at(-1)!.key;
      }
      const byPurpose: Record<string, ReturnType<typeof summarizeModelUsage>> = {};
      for (const p of new Set(items.map(r => r.data.purpose))) byPurpose[p] = summarizeModelUsage(items.filter(r => r.data.purpose === p), prices);
      return { items, summary: summarizeModelUsage(items, prices), by_purpose: byPurpose, price_source: "caller_supplied_estimate" };
    }
    throw new QualityError("invalid_param", "未知学习操作");
  }
}
