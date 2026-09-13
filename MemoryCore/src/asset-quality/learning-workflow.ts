import { z } from "zod";
import { formatSkillFile, parseSkillFile, validateSkillFile } from "../core/skill/skill-format.js";
import type { LearningInput, LearningProposal } from "./learning.js";

const sentence = z.string().trim().min(1).max(1600);
const list = z.array(sentence).min(1).max(12);
const evidence = z.array(z.number().int().nonnegative()).min(1).max(12);
export const workflowDefinitionSchema = z.object({
  purpose: sentence,
  inputs: z.array(z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), description: sentence, required: z.boolean() }).strict()).min(1).max(12),
  preconditions: list,
  steps: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), instruction: sentence,
    expected_result: sentence, on_failure: sentence, evidence_indices: evidence }).strict()).min(1).max(16),
  verification: z.array(z.object({ instruction: sentence, success_criteria: sentence, evidence_indices: evidence }).strict()).min(1).max(12),
  stop_conditions: list, recovery: list, non_goals: list,
  portability: z.object({ level: z.enum(["project", "team", "cross_project"]), rationale: sentence,
    requirements: list, parameter_names: z.array(z.string()).max(12) }).strict(),
}).strict();
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

/** The model suggests portability, never attests to execution or broadens ACLs. */
export const workflowScopeSchema = z.object({
  suggested: z.enum(["project", "team", "cross_project"]), requirements: list,
  origin: z.object({ repository: z.string().min(1).max(1000), version: z.string().min(1).max(200), task_id: z.string().max(200).optional() }).strict(),
  verification_status: z.literal("unverified_workflow"),
  evidence_source_ids: z.array(z.string()).max(24),
  admission: z.literal("check_preconditions_before_execution"),
}).strict();

export function workflowIssues(p: LearningProposal, input: LearningInput): string[] {
  const w = p.workflow; if (!w) return ["缺少结构化流程"];
  const issues: string[] = [];
  if (new Set(w.steps.map(s => s.id)).size !== w.steps.length) issues.push("步骤 ID 重复");
  if (new Set(w.inputs.map(s => s.name)).size !== w.inputs.length) issues.push("输入参数重复");
  if (w.portability.parameter_names.some(n => !w.inputs.some(i => i.name === n))) issues.push("迁移参数未定义");
  if (w.portability.level !== "project" && !w.portability.parameter_names.length) issues.push("跨项目流程必须声明需要适配的参数");
  for (const step of [...w.steps, ...w.verification]) {
    if (step.evidence_indices.some(i => !p.evidence[i])) issues.push("步骤引用不存在的证据");
  }
  if (!p.evidence.some(e => !input.sources.find(s => s.id === e.source_id)?.asset_id)) issues.push("没有原资产之外的新依据");
  return issues;
}

export function renderLearnedWorkflow(assetId: string, p: LearningProposal, input: LearningInput) {
  const w = p.workflow!;
  const bullets = (items: string[]) => items.map(s => `- ${s}`).join("\n");
  const refs = (indices: number[]) => indices.map(i => {
    const e = p.evidence[i], s = input.sources.find(s => s.id === e.source_id)!;
    return `${s.locator} @ ${s.revision}，字符 ${e.start}–${e.end}`;
  }).join("；");
  const scope = workflowScopeSchema.parse({ suggested: w.portability.level, requirements: w.portability.requirements,
    origin: { repository: input.repository, version: input.version, task_id: input.task_id },
    verification_status: "unverified_workflow", evidence_source_ids: [...new Set(p.evidence.map(e => e.source_id))],
    admission: "check_preconditions_before_execution" });
  const body = [
    `# ${p.title}`, w.purpose, `## 适用范围\n${p.applicability}`,
    `建议复用层级：${w.portability.level}。${w.portability.rationale}`,
    `材料来源范围：${input.repository} @ ${input.version}。${input.sources.some(s => s.synthetic) ? "包含合成资料。" : ""}`,
    "实际验证范围：尚无本候选完整流程的独立执行验证。来源中的任务结果仅支持原任务范围，不证明本流程或跨项目适用性。",
    `## 输入参数\n${bullets(w.inputs.map(i => `${i.name}（${i.required ? "必需" : "可选"}）：${i.description}`))}`,
    `## 执行前检查\n先读取当前项目约定、代码和环境，逐条核对下列条件并记录依据。缺失必需参数、条件不成立或无法判断时停止执行，补充信息或提出适配修订。\n${bullets([...w.preconditions, ...w.portability.requirements])}`,
    `## 操作流程\n${w.steps.map((s, i) => `${i + 1}. **${s.id}**：${s.instruction}\n   预期：${s.expected_result}\n   失败处理：${s.on_failure}\n   来源：${refs(s.evidence_indices)}`).join("\n\n")}`,
    `## 验证\n${w.verification.map(v => `- ${v.instruction}\n  成功条件：${v.success_criteria}\n  来源：${refs(v.evidence_indices)}`).join("\n")}`,
    `## 停止条件\n${bullets(w.stop_conditions)}`, `## 恢复与后续处理\n${bullets(w.recovery)}`,
    `## 不适用与未覆盖\n${bullets(w.non_goals)}`, `风险等级：${p.risk}`,
    "## 使用后记录\n保留前置检查、实际动作、测试结果及失败证据；遵循当前任务的资产回执协议。未经实际观察不得声明 adopted/validated 或扩大已验证范围。",
  ].join("\n\n");
  const raw = formatSkillFile({ frontmatter: { name: assetId.slice(0, 64), description: p.claim.slice(0, 1024), source: "auto", category: p.kind === "workflow_candidate" ? "workflow" : "engineering" }, body, raw: "" });
  validateSkillFile(parseSkillFile(raw));
  return { body: raw, scope };
}

/** Exact equality is a deterministic guard; semantic overlap is decided by the evidence-bound model. */
export function normalizedLearningText(text: string) { return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim(); }
