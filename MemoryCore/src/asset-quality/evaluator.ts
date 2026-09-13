import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { criteriaFor } from "./rubrics.js";
import { scoreChecks } from "./scorecard.js";
import { containsCredential, runRules, sourceTexts } from "./rules.js";
import { POLICY_VERSION, snapshotSchema, type EvidenceRef, type ModelReviewer, type QualityCheck, type QualityReport, type ReviewCriterion } from "./types.js";

const modelResponseSchema = z.object({ checks: z.array(z.object({
  id: z.string().max(100), status: z.enum(["pass", "fail", "unknown"]),
  reason: z.string().trim().min(1).max(2000),
  evidence: z.array(z.object({ source_id: z.string().max(200), quote: z.string().min(1).max(1500), start: z.number().int().min(0).optional() }).strict()).max(12),
  remediation: z.string().max(2000).nullable().optional().transform(value => value ?? undefined),
  score: z.number().int().min(0).max(4).nullable().optional(),
}).strict()).max(16) }).strict();

export function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
const limitations = [
  "仅评估提交的内容单元和声明用途；不评价当前任务相关性或推荐效果。",
  "来源、版本和测试输出由提交者提供；哈希只固定快照，不验证来源真实性。",
  "未读取原生资产存储或外部仓库，未执行配套代码或测试，不能据此宣称运行验证通过。",
  "模型审阅可能误判；发布前应由负责人复核。通过报告不是自动发布许可。",
];

export async function evaluateQuality(input: unknown, options: { reviewer?: ModelReviewer; timeoutMs?: number } = {}): Promise<QualityReport> {
  const s = snapshotSchema.parse(input);
  const canonical = JSON.stringify({ ...s, sources: [...s.sources].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) });
  const rules = runRules(s);
  const criteria = criteriaFor(s.asset_type);
  const texts = sourceTexts(s);
  let reviewerStatus: QualityReport["reviewer"]["status"] = "not_run";
  let semantic: QualityCheck[] = criteria.map((c) => unknown(c, "尚未完成内容审阅。"));
  const reviewer = options.reviewer;
  if (!rules.blockModel && reviewer) {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { abort.abort(); reject(new Error("quality_review_timeout")); }, Math.max(1, Math.min(options.timeoutMs ?? 60_000, 120_000)));
      });
      const raw = await Promise.race([Promise.resolve().then(() => reviewer.review(s, criteria, abort.signal)), timeout]);
      try {
        if (typeof raw === "string" && raw.length > 60_000) throw new Error("oversized response");
        const result = modelResponseSchema.parse(typeof raw === "string" ? JSON.parse(raw) : raw);
        if (containsCredential(JSON.stringify(result))) throw new Error("unsafe response");
        const expectedIds = new Set(criteria.map((c) => c.id));
        if (result.checks.length !== criteria.length || new Set(result.checks.map((c) => c.id)).size !== criteria.length || result.checks.some((c) => !expectedIds.has(c.id))) {
          throw new Error("incomplete rubric");
        }
        reviewerStatus = "completed";
        semantic = criteria.map((criterion) => {
          const c = result.checks.find((v) => v.id === criterion.id)!;
          if ((c.status === "unknown" && c.score != null) || (c.status === "fail" && c.score != null && c.score > 1)
            || (c.status === "pass" && c.score != null && c.score < 2)) return unknown(criterion, "等级和结论冲突，需重新评估。");
          const evidence: EvidenceRef[] = [];
          for (const ref of c.evidence) {
            const content = texts.get(ref.source_id);
            const start = ref.start ?? content?.indexOf(ref.quote) ?? -1;
            if (content === undefined || start < 0 || content.slice(start, start + ref.quote.length) !== ref.quote
              || (ref.start === undefined && content.indexOf(ref.quote, start + 1) !== -1)) {
              reviewerStatus = "invalid_response";
              return unknown(criterion, "模型引用不存在或不唯一；该项结论未被接受。请提供精确证据后重评。");
            }
            evidence.push({ source_id: ref.source_id, start, end: start + ref.quote.length, quote: ref.quote });
          }
          if (c.status !== "unknown" && !evidence.some((e) => e.source_id === "asset")) {
            reviewerStatus = "invalid_response";
            return unknown(criterion, "模型未引用被评估正文，不能接受通过或失败结论。");
          }
          if (c.status !== "unknown" && criterion.supportKinds && !evidence.some((e) => {
            const src = s.sources.find((v) => v.id === e.source_id);
            // Exact duplicates cannot corroborate themselves. A legitimate source quotation may
            // also appear verbatim in the asset; overlap alone is NOT evidence of a bad source.
            return src && criterion.supportKinds!.includes(src.kind) && src.content.trim() !== s.body.trim()
              && src.content.trim().length > 0;
          })) return unknown(criterion, "没有引用相应类型、非正文复述的支持材料；只能标为待补证据。");
          return { ...c, label: criterion.label, evidence, method: "model" as const };
        });
      } catch {
        reviewerStatus = "invalid_response";
        semantic = criteria.map((c) => unknown(c, "模型返回未通过严格结构、覆盖项或安全校验；没有采用其结论。"));
      }
    } catch {
      reviewerStatus = abort.signal.aborted ? "timeout" : "unavailable";
      semantic = criteria.map((c) => unknown(c, reviewerStatus === "timeout" ? "内容审阅超时，需重试或人工补充证据。" : "内容审阅服务不可用，不能据此判断质量通过。"));
    } finally {
      if (timer) clearTimeout(timer);
      abort.abort();
    }
  } else {
    reviewerStatus = rules.blockModel ? "not_run" : "unavailable";
    semantic = criteria.map((c) => unknown(c, rules.blockModel ? "基础检查未通过或缺少正文，未发送至模型审阅。" : "未配置内容审阅模型；规则检查不能替代内容正确性评估。"));
  }
  const checks = [...rules.checks, ...semantic];
  // No weighted average: a real defect cannot be offset by unrelated passes.
  const decision = checks.some((c) => c.status === "fail") ? "reject" : checks.some((c) => c.status === "unknown") ? "needs_evidence" : "pass";
  const safe = (value: string) => containsCredential(value) ? "[疑似凭据已隐藏]" : value;
  return {
    report_id: randomUUID(), evaluated_at: new Date().toISOString(), policy_version: POLICY_VERSION,
    snapshot_sha256: sha256(canonical), asset_id: safe(s.asset_id), unit_id: safe(s.unit_id), asset_type: s.asset_type,
    content_version: safe(s.content_version), declared_scope: safe(s.declared_scope),
    sources: s.sources.map((v) => ({ id: safe(v.id), sha256: sha256(v.content) })),
    reviewer: { id: safe(reviewer?.id ?? "none"), status: reviewerStatus }, decision, checks,
    assurance: "submitted_snapshot_review", human_review_required: true, publication_changed: false,
    limitations: [...limitations],
    scorecard: scoreChecks(checks),
  };
}

function unknown(c: ReviewCriterion, reason: string): QualityCheck {
  return { id: c.id, label: c.label, method: "model", status: "unknown", reason, evidence: [], remediation: "补齐可核对材料后重新评估；必要时人工审阅。" };
}
