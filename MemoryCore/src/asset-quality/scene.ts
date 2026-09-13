import { z } from "zod";
import { sha256 } from "./evaluator.js";
import { UsageReviewError, usageCitationSpans, usageEvidenceKind, type UsageEvent } from "./usage-result.js";

/** Frozen BEFORE retrieval. These are observations, never verified business facts. */
export const sceneSchema = z.object({
  schema_version: z.literal("recommendation-scene/v1"),
  request_id: z.string().min(1).max(200), turn: z.number().int().min(1),
  query: z.string().max(4000), task: z.string().max(4000),
  active_paths: z.array(z.string().max(1000)).max(12),
  errors: z.array(z.string().max(1000)).max(6),
  events: z.array(z.object({
    id: z.string().min(1).max(200), role: z.enum(["user", "assistant", "tool_result", "tool_call"]),
    content: z.string().min(1).max(4000), tool_call_id: z.string().max(200).optional(),
  }).strict()).max(12),
  truncated: z.boolean(),
}).strict().refine(s => s.events.reduce((n, e) => n + e.content.length, 0) <= 16000, "scene evidence exceeds 16000 characters");
export type RecommendationScene = z.infer<typeof sceneSchema>;
export const SCENE_CONTRACT = "prior-only-applicability/v1";
export const sceneHash = (scene: RecommendationScene) => sha256(JSON.stringify(sceneSchema.parse(scene)));

const applicabilitySchema = z.object({
  verdict: z.enum(["applicable", "adapt", "not_applicable", "unknown"]),
  reason: z.string().min(1).max(2000), asset_quote: z.string().min(1).max(1000).optional(),
  citations: z.array(z.object({ event_id: z.string().min(1).max(200), quote: z.string().min(1).max(1000) }).strict()).max(12),
}).strict();

export function validateApplicability(raw: unknown, scene: RecommendationScene, asset: string) {
  if (typeof raw === "string") {
    if (raw.length > 30000) throw new UsageReviewError("invalid_format", ["请精简适用性 JSON。"]);
    try { raw = JSON.parse(raw); } catch { throw new UsageReviewError("invalid_json", ["请返回适用性 JSON 对象。"]); }
  }
  if (raw && typeof raw === "object") {
    const value = { ...raw } as any;
    if (value.verdict === "unknown" && !value.asset_quote) delete value.asset_quote;
    const spans = usageCitationSpans(scene.events);
    if (Array.isArray(value.citations)) value.citations = value.citations.map((c: any) => {
      if (!c || !Object.hasOwn(c, "span_id")) return c;
      const span = Object.keys(c).length === 1 && spans.find(s => s.span_id === c.span_id);
      if (!span) throw new UsageReviewError("invalid_citation", ["适用性引用必须来自 before_citation_spans，不能引用未来事件。"]);
      return { event_id: span.event_id, quote: span.quote };
    });
    raw = value;
  }
  const parsed = applicabilitySchema.safeParse(raw);
  if (!parsed.success) throw new UsageReviewError("invalid_format", ["适用性只允许 verdict、reason、asset_quote、citations。verdict 为 applicable、adapt、not_applicable 或 unknown。"]);
  const result = parsed.data;
  const refs: UsageEvent[] = result.citations.map(c => {
    const event = scene.events.find(e => e.id === c.event_id && e.content.includes(c.quote));
    if (!event) throw new UsageReviewError("invalid_citation", ["适用性引用不是推荐前快照的连续原文。没有证据请返回 unknown。"]);
    return event;
  });
  if (result.asset_quote && !asset.includes(result.asset_quote)) throw new UsageReviewError("invalid_asset_citation", ["asset_quote 必须来自当前版本正文。"]);
  if (result.verdict !== "unknown" && (!result.asset_quote || !refs.some(e => e.role === "user"
      || (e.role === "tool_result" && usageEvidenceKind(e, scene.events) !== "generated_artifact")))) {
    throw new UsageReviewError("missing_evidence", ["非 unknown 适用性需要资产前提原文及推荐前用户条件或真实工具观察。助手自述不能单独证明匹配。"]);
  }
  return result;
}

export function currentApplicability(data: Record<string, any>) {
  const fit = data.applicability;
  return data.before && fit?.scene_hash === sceneHash(data.before) && fit.evidence_contract === SCENE_CONTRACT ? fit : null;
}

/** Explicit lexical scene matching, NOT an embedding or an LLM-generated label.
 * Hard environment/version checks belong to the caller and precede similarity.
 * Only the contemporaneous question is compared. Repeated board boilerplate must
 * not make every turn in a long task look like the same scene.
 */
export function sceneTerms(scene: RecommendationScene): Set<string> {
  const text = (scene.query || scene.task).normalize("NFKC").toLowerCase();
  const stop = new Set("please help fix check task code project the a an and or to of in is for with this that 请帮 帮我 我们 这个 当前 任务 问题 如何 检查 修复".split(" "));
  const terms = (text.match(/[a-z_][a-z0-9_.-]{2,}|[\u4e00-\u9fff]+/g) ?? []).flatMap(t =>
    /^[\u4e00-\u9fff]+$/.test(t) ? [...t].slice(1).map((_, i) => t.slice(i, i + 2)) : [t]);
  return new Set(terms.filter(t => !stop.has(t)).slice(0, 512));
}
export function sceneSimilarity(a: RecommendationScene, b: RecommendationScene) {
  const left = sceneTerms(a), right = sceneTerms(b);
  if (left.size < 3 || right.size < 3) return 0;
  const intersection = [...left].filter(t => right.has(t)).length;
  return intersection / new Set([...left, ...right]).size;
}
export function sameEnvironment(a: Record<string, string>, b: Record<string, string>) {
  return ["repository", "task_type", "environment"].every(k => typeof a?.[k] === "string" && a[k].length > 0 && a[k] === b?.[k]);
}
