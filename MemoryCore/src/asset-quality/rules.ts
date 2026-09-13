import { z } from "zod";
import { posix } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseSkillFile, validateSkillFile } from "../core/skill/skill-format.js";
import type { EvidenceRef, QualityCheck, QualitySnapshot } from "./types.js";

export function sourceTexts(s: QualitySnapshot): Map<string, string> {
  return new Map([["asset", s.body], ["scope", s.declared_scope], ...s.sources.map((v): [string, string] => [v.id, v.content])]);
}
export function cite(source_id: string, content: string, start = 0, end = Math.min(content.length, start + 160)): EvidenceRef[] {
  return end > start ? [{ source_id, start, end, quote: content.slice(start, end) }] : [];
}
function check(id: string, label: string, status: QualityCheck["status"], reason: string, evidence: EvidenceRef[] = []): QualityCheck {
  return { id, label, status, reason, evidence, method: "rule" };
}

// Deliberately conservative detection. Absence is NOT evidence of comprehensive safety.
export function containsCredential(text: string): boolean {
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b|(?:api[_-]?key|password|access[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9/+_=.-]{16,}/i.test(text);
}
export function safeResourcePath(path: string): boolean {
  return path.length > 0 && !path.includes("\\") && !path.includes("\0") && !posix.isAbsolute(path)
    && !path.split("/").some((p) => p === ".." || p === "." || p === "") && !/^[a-z]+:/i.test(path);
}

const graphSchema = z.object({
  repository: z.string().min(1),
  revision: z.string().min(1),
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  coverage: z.string().max(4000).optional(),
  nodes: z.array(z.object({
    id: z.string().min(1), source_id: z.string().min(1), path: z.string().min(1),
    symbol: z.string().min(1), start_line: z.number().int().positive(), end_line: z.number().int().positive(),
  }).strict()).min(1).max(500),
  edges: z.array(z.union([
    z.object({ from: z.string().min(1), to: z.string().min(1), kind: z.string().min(1) }).strict(),
    z.object({ source: z.string().min(1), target: z.string().min(1), type: z.string().min(1), source_id: z.string().min(1), line: z.number().int().positive(), resolution: z.literal("same_file_syntactic") }).strict()
      .transform(e=>({from:e.source,to:e.target,kind:e.type})),
  ])).max(2000),
}).strict();

export function runRules(s: QualitySnapshot): { checks: QualityCheck[]; blockModel: boolean } {
  const checks: QualityCheck[] = [];
  const secrets = containsCredential(JSON.stringify(s));
  // Do not echo suspected secrets into the report, prompt or telemetry.
  checks.push(check("input.credential_scan", "明显凭据检查", secrets ? "fail" : "pass",
    secrets ? "快照含疑似凭据；请脱敏后重新提交，未发送至模型。" : "未匹配到有限规则覆盖的明显凭据；不代表完成全面安全审计。"));
  checks.push(check("input.body", "实际正文", s.body.trim() ? "pass" : "unknown", s.body.trim() ? "已提供待评估内容单元的正文。" : "没有正文，不能凭名称和元数据评估。"));
  checks.push(check("input.scope", "声明用途", s.declared_scope.trim() ? "pass" : "unknown", s.declared_scope.trim() ? "已提供声明用途；其合理性另行核对。" : "请声明适用场景和范围，不以某次任务的相似分替代。"));
  checks.push(check("input.sources", "可核对的配套材料", s.sources.some((v) => v.content.trim()) ? "pass" : "unknown",
    "仅检查是否提交材料；来源名称、哈希和引用命中均不证明来源真实或内容正确。"));
  if (secrets || !s.body.trim()) return { checks, blockModel: true };

  if (s.asset_type === "skill") {
    try {
      const skill = parseSkillFile(s.body);
      validateSkillFile(skill);
      // The legacy parser silently skips malformed resources; a reviewer must not.
      const rawFrontmatter = s.body.replace(/\r\n?/g, "\n").match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1];
      const frontmatter = z.object({
        resources: z.array(z.object({ path: z.string().min(1).max(1000), type: z.enum(["text", "executable", "binary"]) })).max(100).optional(),
      }).passthrough().parse(parseYaml(rawFrontmatter ?? ""));
      checks.push(check("skill.format", "Skill 格式", skill.body.trim() ? "pass" : "fail", skill.body.trim() ? "SKILL.md 可解析且含正文；格式合格不等于步骤正确。" : "只有 frontmatter，没有实际技能内容。"));
      const resources = frontmatter.resources ?? [];
      const unsafe = resources.some((r) => !safeResourcePath(r.path));
      const missing = resources.filter((r) => !s.sources.some((v) => v.locator === r.path && v.content.trim()));
      checks.push(check("skill.resources", "声明的配套文件", unsafe ? "fail" : missing.length ? "unknown" : "pass",
        unsafe ? "资源路径越界或不是规范相对路径；未读取、未执行。" : missing.length ? `缺少 ${missing.length} 个声明资源的内容：${missing.slice(0, 10).map((r) => r.path).join("、")}。不能确认可用性。` : "声明资源均随快照提供（或未声明）；未执行其中任何指令。"));
    } catch {
      checks.push(check("skill.format", "Skill 格式", "fail", "SKILL.md 解析或格式校验失败；需要合法 frontmatter、名称、描述和正文。"));
    }
  }
  if (s.asset_type === "chat_memory") {
    checks.push(check("memory.original", "原始对话材料", s.sources.some((v) => v.kind === "conversation" && v.content.trim()) ? "pass" : "unknown", "记忆结论需要与原始对话核对；摘要本身不是对话证据。"));
  }
  if (s.asset_type === "code_graph") {
    let parsed: z.infer<typeof graphSchema> | undefined;
    try { parsed = graphSchema.parse(JSON.parse(s.body)); } catch { /* diagnostic below */ }
    if (!parsed) {
      checks.push(check("graph.format", "图快照格式", "unknown", "需要文档所定义的节点/边评估快照；不支持的原生图格式不直接判为坏资产。"));
    } else {
      const graph = parsed;
      const ids = new Set(graph.nodes.map((n) => n.id));
      const structuralProblems: string[] = [];
      const seen = new Set<string>();
      for (const n of graph.nodes) {
        if (seen.has(n.id)) structuralProblems.push(`节点 ID 重复：${n.id}`);
        seen.add(n.id);
        if (n.end_line < n.start_line) structuralProblems.push(`节点 ${n.id} 的结束行小于起始行`);
        if (!safeResourcePath(n.path)) structuralProblems.push(`节点 ${n.id} 的路径不合法：${n.path}`);
      }
      for (const e of graph.edges) {
        if (!ids.has(e.from)) structuralProblems.push(`边 ${e.from} → ${e.to} 的起点节点不存在`);
        if (!ids.has(e.to)) structuralProblems.push(`边 ${e.from} → ${e.to} 的终点节点不存在`);
      }
      checks.push(check("graph.structure", "节点与边的结构完整性", structuralProblems.length ? "fail" : "pass",
        structuralProblems.length ? structuralProblems.slice(0, 10).join("；") : "节点唯一，边端点存在，行范围及路径格式合法。"));
      let missing = 0, mismatches = 0;
      const refs: EvidenceRef[] = [];
      for (const n of graph.nodes) {
        const src = s.sources.find((v) => v.id === n.source_id && v.kind === "code");
        if (!src || !src.revision || !src.repository) { missing++; continue; }
        const lines = src.content.split("\n");
        if (src.repository !== graph.repository || src.locator !== n.path || src.revision !== graph.revision || n.end_line > lines.length || n.end_line < n.start_line) { mismatches++; continue; }
        const fragment = lines.slice(n.start_line - 1, n.end_line).join("\n");
        // AST exporters may supply qualified names (Class.method), while source declarations
        // contain only `def method`. This is a lexical anchor check, not a proof of ownership.
        const terminal=n.symbol.split(".").at(-1)!;
        const escaped=terminal.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
        const pythonDeclaration=/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(n.symbol)
          && new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?(?:def|class)\\s+${escaped}\\b`).test(fragment);
        if (!fragment.includes(n.symbol) && !pythonDeclaration) { mismatches++; continue; }
        const offset = lines.slice(0, n.start_line - 1).reduce((len, line) => len + line.length + 1, 0);
        refs.push(...cite(src.id, src.content, offset, Math.min(src.content.length, offset + fragment.length, offset + 160)));
      }
      checks.push(check("graph.source_anchors", "路径、版本与源码锚点", mismatches ? "fail" : missing ? "unknown" : "pass",
        mismatches ? `${mismatches} 个节点与提交的路径、版本、行范围或符号不一致。` : missing ? `${missing} 个节点缺少带版本的代码材料。` : "锚点与提交代码文本一致；限定名仅核对末级声明，归属和调用语义另由内容审阅核对；未独立读取仓库。", refs.slice(0, 12)));
    }
  }
  return { checks, blockModel: checks.some((c) => c.status === "fail") };
}
