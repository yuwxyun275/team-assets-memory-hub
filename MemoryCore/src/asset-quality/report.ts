import type { QualityReport } from "./types.js";

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[\\`*_{}[\]()!#|]/g, "\\$&");
const status = { pass: "通过", fail: "发现缺陷", unknown: "待补证据" };
export function reportToMarkdown(r: QualityReport): string {
  const decision = { pass: "声明范围内通过内容审阅", reject: "发现缺陷，建议修订后重评", needs_evidence: "证据不足，暂不能判断通过" };
  return [
    "# 资产内在质量评估报告", "", `结论：${decision[r.decision]}。此结论不改变发布状态，发布前仍需负责人复核。`, "",
    `资产：${escape(r.asset_id)} / ${escape(r.unit_id)}（${r.asset_type}）`, "",
    `内容版本：${escape(r.content_version)}；评估时间：${r.evaluated_at}`, "",
    `声明用途：${escape(r.declared_scope) || "未提供"}`, "",
    `策略版本：${r.policy_version}；审阅器：${escape(r.reviewer.id)}；状态：${r.reviewer.status}`, "",
    `快照 SHA-256：${r.snapshot_sha256}`, "",
    ...(r.scorecard ? [`内容质量 Q：${r.scorecard.quality ?? "待核实"}；证据覆盖 E：${r.scorecard.evidence_coverage}%（不代表正确概率）；权重尚待校准。`, ""] : []),
    ...r.checks.flatMap((c) => [
      `## ${escape(c.label)}：${status[c.status]}`, "",
      `检查方式：${c.method === "rule" ? "确定性规则" : "模型辅助审阅"}；检查项：${c.id}`, "",
      escape(c.reason), "",
      ...(c.remediation ? [`待办：${escape(c.remediation)}`, ""] : []),
      ...c.evidence.flatMap((e) => [`证据 ${escape(e.source_id)}，字符区间 [${e.start}, ${e.end})：`, "", `> ${escape(e.quote).replace(/\n/g, "\n> ")}`, ""]),
    ]),
    "## 结论边界", "", ...r.limitations.map((s) => `- ${escape(s)}`), "",
  ].join("\n");
}
