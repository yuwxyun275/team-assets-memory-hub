import { z } from "zod";
import { sha256 } from "./evaluator.js";
import type { QualityRecord } from "./records.js";
import { currentApplicability, sceneHash } from "./scene.js";

export const USAGE_EVIDENCE_CONTRACT = "asset-and-event/v2";

export const usageResultSchema = z.object({
  outcome: z.enum(["helpful", "harmful", "not_applicable", "content_error", "unobserved"]),
  reason: z.string().min(1).max(2000),
  asset_quote: z.string().min(1).max(1000).optional(),
  citations: z.array(z.object({ event_id: z.string().min(1).max(200), quote: z.string().min(1).max(1000) }).strict()).max(12),
}).strict();
export type UsageEvent = { id: string; role: string; content: string; tool_call_id?: string };
/** A generated report/tool UI echo is not independent execution evidence. Keep
 * the original events intact for audit; classification never changes event IDs. */
export function usageEvidenceKind(event: UsageEvent, events: UsageEvent[]) {
  if (event.role !== "tool_result") return event.role;
  const call = event.tool_call_id && events.find(e => e.role === "tool_call" && e.tool_call_id === event.tool_call_id);
  if (!call) return "tool_result_unknown";
  // Large tool-call JSON can be chunked. The leading name remains trustworthy
  // only as transport metadata, never as evidence that the tool succeeded.
  let name = "";
  try { name = String(JSON.parse(call.content).name ?? ""); }
  catch { name = /^\s*\{\s*"name"\s*:\s*"([\w.-]+)"/.exec(call.content)?.[1] ?? ""; }
  return /(?:^|__)(?:write_to_file|write_file|edit_file|replace_in_file|apply_patch|open_result_view|create_file)$/.test(name)
    ? "generated_artifact" : "tool_result";
}
/** Deterministic exact-text citation handles: the model selects, never rewrites evidence. */
export function usageCitationSpans(events: UsageEvent[]) {
  const candidates = events.filter(e => ["tool_result", "user"].includes(e.role) && usageEvidenceKind(e, events) !== "generated_artifact");
  const spans: { span_id: string; event_id: string; quote: string }[] = [];
  for (const e of candidates.slice(-40)) {
    const lines = e.content.split(/\\r\\n|\\n|\r?\n/).map(s => s.trim()).filter(Boolean);
    const preferred = lines.filter(s => /test_|passed|failed|error|lookup|CacheUnavailable|修复|修改|断言/i.test(s));
    for (const quote of [...new Set([...preferred, ...lines].map(s => s.slice(0, 350)))].slice(0, 3)) {
      spans.push({ span_id: `span-${sha256(JSON.stringify([e.id, quote])).slice(0, 20)}`, event_id: e.id, quote });
    }
  }
  return spans;
}
export class UsageReviewError extends Error {
  constructor(readonly code: string, readonly issues: string[] = []) { super(code); }
}

/** Only program-generated errors are fed back. Never echo provider credentials/HTTP bodies. */
export function usageFailure(error: unknown) {
  if (error instanceof UsageReviewError) return { code: error.code, issues: error.issues, repairable: ["invalid_json", "invalid_format", "invalid_citation", "invalid_asset_citation", "missing_evidence"].includes(error.code) };
  const status = Number((error as { statusCode?: number })?.statusCode);
  return { code: status === 401 || status === 403 ? "upstream_auth_error" : status === 429 ? "upstream_rate_limited" : "upstream_request_failed",
    issues: ["评价模型请求未完成；检查服务可用性、鉴权或限流。"], repairable: false };
}

export function validateUsageResult(raw: unknown, events: UsageEvent[], assetText?: string) {
  if (typeof raw === "string") {
    if (raw.length > 30000) throw new UsageReviewError("invalid_format", ["输出超过 30000 字符，请精简 JSON。"]);
    try { raw = JSON.parse(raw); } catch { throw new UsageReviewError("invalid_json", ["必须返回一个 JSON 对象，不要 Markdown 代码围栏或额外解释。"]); }
  }
  // Some JSON-mode providers emit an empty placeholder for optional fields.
  // Omit it only for the no-evidence outcome; never supply a missing positive
  // citation or change the model's verdict to make validation succeed.
  if (raw && typeof raw === "object" && (raw as any).outcome === "unobserved"
    && [(null), ""].includes((raw as any).asset_quote)) {
    const { asset_quote: _empty, ...rest } = raw as Record<string, unknown>; raw = rest;
  }
  if (raw && typeof raw === "object" && Array.isArray((raw as any).citations)) {
    const spans = usageCitationSpans(events);
    raw = { ...raw, citations: (raw as any).citations.map((c: any, index: number) => {
      if (!c || typeof c !== "object" || !Object.hasOwn(c, "span_id")) return c;
      const span = Object.keys(c).length === 1 && spans.find(s => s.span_id === c.span_id);
      if (!span) throw new UsageReviewError("invalid_citation", [`citations.${index}.span_id 必须从提供的 citation_spans 中选择，不能编造或追加其他字段。`]);
      return { event_id: span.event_id, quote: span.quote };
    }) };
  }
  const parsed = usageResultSchema.safeParse(raw);
  if (!parsed.success) throw new UsageReviewError("invalid_format", parsed.error.issues.slice(0, 12).map(i =>
    `${i.path.join(".") || "result"}: ${i.code}${i.code === "unrecognized_keys" ? `; unexpected=${JSON.stringify(i.keys).slice(0, 300)}; 顶层仅允许 outcome, reason, asset_quote, citations；引用仅允许 event_id, quote。` : `; ${i.message}`}`));
  const result = parsed.data;
  const refs = result.citations.map((c, index) => {
    const e = events.find(e => e.id === c.event_id);
    if (!e) throw new UsageReviewError("invalid_citation", [`citations.${index}.event_id 不在提供的事件中。请使用真实事件 ID；不得编造证据。`]);
    if (!e.content.includes(c.quote)) throw new UsageReviewError("invalid_citation", [`citations.${index}.quote 不是对应事件的连续原文。请重新核对；没有证据则返回 unobserved。`]);
    return e;
  });
  if (result.outcome !== "unobserved" && !refs.length) throw new UsageReviewError("missing_evidence", ["非 unobserved 结论必须引用真实事件；没有足够证据应返回 unobserved。"]);
  if (["helpful", "harmful"].includes(result.outcome) && !refs.some(e => ["tool_result", "user"].includes(e.role))) {
    result.outcome = "unobserved"; result.reason = "仅有模型自述，没有工具结果或用户反馈支持实际效果。";
  }
  if (result.outcome !== "unobserved" && !refs.some(e => e.role === "user" || (e.role === "tool_result" && usageEvidenceKind(e, events) !== "generated_artifact"))) {
    throw new UsageReviewError("missing_evidence", ["报告写入、编辑或展示成功不是行为验证。请引用实际检查结果或具体用户反馈；没有则返回 unobserved。"]);
  }
  if (assetText !== undefined && ((result.outcome !== "unobserved" && !result.asset_quote) || (result.asset_quote && !assetText.includes(result.asset_quote)))) {
    throw new UsageReviewError("invalid_asset_citation", ["asset_quote 必须逐字引用当前 asset 字段中的具体建议，不能引用 events 中其他资产的内容。没有对应建议应返回 unobserved。"]);
  }
  return result;
}

export const usageWindowHash = (data: Record<string, any>) => sha256(JSON.stringify(data.before
  ? { before: sceneHash(data.before), context: [data.context?.repository, data.context?.task_type, data.context?.environment], events: data.events ?? [] } : data.events ?? []));
export function currentUsageAssessment(data: Record<string, any>) {
  const hash = usageWindowHash(data);
  const human = data.human_feedback;
  if (human && human.event_hash === hash) return { ...human, source: "human" };
  const model = data.assessment;
  if (model?.event_hash === hash && model.evidence_contract === USAGE_EVIDENCE_CONTRACT) return { ...model, source: "model" };
  return null;
}

/** Committed with the exposure; task reads join it without overwriting native CI counters. */
export function usageReceipt(record: Pick<QualityRecord, "key" | "team" | "data" | "updated">) {
  const d = record.data, assessment = currentUsageAssessment(d);
  const events: UsageEvent[] = d.events ?? [];
  return {
    schema_version: "asset-usage-effect/v1", receipt_id: record.key, team_id: record.team,
    asset_id: d.asset_id, revision_id: d.revision_id, task_id: d.task_id, session_id: d.session_id,
    actor: d.actor, context: d.context, request_id: d.request_id, event_hash: usageWindowHash(d),
    recommendation_scene: d.before ? { ...d.before, hash: sceneHash(d.before) } : null,
    applicability: currentApplicability(d),
    status: assessment?.source === "human" ? "human_reviewed" : d.state === "failed" ? "manual_review"
      : assessment ? (assessment.outcome === "unobserved" ? "needs_evidence" : "assessed")
        : d.state === "observing" && d.assessment?.evidence_contract !== USAGE_EVIDENCE_CONTRACT ? "needs_recheck" : d.state,
    assessment, citations: (assessment?.citations ?? []).map((c: { event_id: string; quote: string }) => {
      const e = events.find(e => e.id === c.event_id);
      return { ...c, role: e?.role, tool_call_id: e?.tool_call_id };
    }),
    attempts: d.attempts, total_attempts: d.total_attempts ?? 0, last_error: d.last_error ?? null,
    error_details: d.error_details ?? null, manual_review_required: d.state === "failed" && assessment?.source !== "human",
    can_retry: d.state === "failed" && (d.total_attempts ?? 0) < 20,
    updated_at: record.updated, expires_at: d.expires,
    observation_window: { closed: !!d.window_closed, reason: d.window_close_reason ?? null, events: events.length,
      omitted_events: d.omitted_event_ids?.length ?? 0 },
    assurance: "observational_not_causal", native_states_unchanged: true,
  };
}

/** One row/vote per task/session/actor/asset revision/context, not per injection. */
export function deduplicateUsage(records: QualityRecord[]) {
  const grouped = new Map<string, QualityRecord>();
  for (const r of records) {
    if (r.data.expires <= Date.now()) continue;
    const key = JSON.stringify([r.team, r.data.actor, r.data.task_id, r.data.session_id, r.data.asset_id, r.data.revision_id, r.data.context]);
    const old = grouped.get(key);
    // Retry completion time is NOT observation chronology. An old slow worker
    // must never replace a newer exposure window in either the UI or utility.
    if (!old || Number(r.data.turn ?? 0) > Number(old.data.turn ?? 0)
      || (Number(r.data.turn ?? 0) === Number(old.data.turn ?? 0) && (Number(r.data.created ?? 0) > Number(old.data.created ?? 0)
      || (Number(r.data.created ?? 0) === Number(old.data.created ?? 0) && r.key > old.key)))) grouped.set(key, r);
  }
  return [...grouped.values()];
}
