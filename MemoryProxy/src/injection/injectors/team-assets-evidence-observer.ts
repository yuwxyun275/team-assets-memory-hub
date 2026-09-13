import { createHash } from "node:crypto";
import type { ContextMessage } from "../types.js";

export interface AssetUseDeclaration {
  asset_id: string;
  decision: string;
  target: string;
}

export interface AcceptanceEvidenceDeclaration {
  criterion_id: string;
  mode: "automated" | "manual";
  test_ids: string[];
  targets: string[];
  note: string;
}

export interface CodeBuddyAcceptancePlan {
  criteria: Array<{
    text: string;
    category: string;
    rationale: string;
    source_asset_ids: string[];
    target_paths: string[];
    candidate_test_ids: string[];
  }>;
}

export interface AssetFeedbackDeclaration {
  asset_id: string;
  signal:
    | "useful"
    | "not_applicable"
    | "duplicate"
    | "ignored"
    | "stale"
    | "incorrect"
    | "unobserved"
    | "accepted"
    | "corrected";
  reason: string;
  target: string;
}

export interface SanitizedToolCall {
  id: string;
  name: string;
  kind: "edit" | "test" | "read" | "other";
  target: string;
  command: string;
  arguments: string;
  change_hash: string;
  changed_paths: string[];
  test_ids: string[];
}

export interface SanitizedToolResult {
  tool_call_id: string;
  success: boolean;
  summary: string;
  evidence_ref: string;
  test_ids: string[];
}

export interface TeamAssetObservations {
  declarations: AssetUseDeclaration[];
  feedback: AssetFeedbackDeclaration[];
  acceptance_declarations: AcceptanceEvidenceDeclaration[];
  codebuddy_acceptance_plan: CodeBuddyAcceptancePlan | null;
  tool_calls: SanitizedToolCall[];
  tool_results: SanitizedToolResult[];
}

const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /sk-mem-[A-Za-z0-9_-]+/gi, replacement: "[REDACTED]" },
  { pattern: /uky-[A-Za-z0-9_-]+/gi, replacement: "[REDACTED]" },
  { pattern: /(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s"']+/gi, replacement: "$1[REDACTED]" },
  { pattern: /("?(?:api[_-]?key|user[_-]?key)"?\s*[:=]\s*")[^"]+/gi, replacement: "$1[REDACTED]" },
];

export function stableEvidenceTrace(sessionId: string, taskId: string): string {
  const digest = createHash("sha256").update(`${sessionId}\0${taskId}`).digest("hex").slice(0, 20);
  return `trace-team-assets-${digest}`;
}

export function stableTurnEvidenceTrace(sessionId: string, turnSeq: number): string {
  const digest = createHash("sha256").update(`${sessionId}\0${Math.max(1, turnSeq)}`).digest("hex").slice(0, 20);
  return `trace-team-assets-turn-${digest}`;
}

export function extractTeamAssetObservations(messages: ContextMessage[]): TeamAssetObservations {
  const declarations: AssetUseDeclaration[] = [];
  const feedback: AssetFeedbackDeclaration[] = [];
  const acceptanceDeclarations: AcceptanceEvidenceDeclaration[] = [];
  let codebuddyAcceptancePlan: CodeBuddyAcceptancePlan | null = null;
  const toolCalls: SanitizedToolCall[] = [];
  const toolResults: SanitizedToolResult[] = [];

  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.blocks) {
        if (block.type === "text") {
          declarations.push(...extractDeclarations(block.content));
          feedback.push(...extractFeedbackDeclarations(block.content));
          acceptanceDeclarations.push(...extractAcceptanceDeclarations(block.content));
          codebuddyAcceptancePlan = extractCodeBuddyAcceptancePlan(block.content) ?? codebuddyAcceptancePlan;
        }
        if (block.type === "tool_use") {
          const call = sanitizeToolCall(block.content, String(block.metadata?.tool_id ?? ""));
          if (call) toolCalls.push(call);
        }
      }
    }
    if (message.role === "tool") {
      for (const block of message.blocks) {
        if (block.type !== "tool_result") continue;
        const toolCallId = String(block.metadata?.tool_use_id ?? "");
        if (!toolCallId) continue;
        const redacted = redact(block.content);
        toolResults.push({
          tool_call_id: toolCallId,
          success: isSuccessfulToolResult(redacted),
          summary: summarizeToolResult(redacted),
          evidence_ref: `sha256:${createHash("sha256").update(block.content).digest("hex")}`,
          test_ids: extractTestIds(block.content),
        });
      }
    }
  }
  return {
    declarations,
    feedback,
    acceptance_declarations: acceptanceDeclarations,
    codebuddy_acceptance_plan: codebuddyAcceptancePlan,
    tool_calls: toolCalls,
    tool_results: toolResults,
  };
}

function extractCodeBuddyAcceptancePlan(text: string): CodeBuddyAcceptancePlan | null {
  const matches = [...text.matchAll(/<acceptance_plan>\s*(\{[\s\S]*?\})\s*<\/acceptance_plan>/g)];
  const latest = matches.at(-1);
  if (!latest) return null;
  try {
    const value = JSON.parse(latest[1]) as Record<string, unknown>;
    if (!Array.isArray(value.criteria)) return null;
    const criteria = value.criteria
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      .slice(0, 8)
      .map((item) => ({
        text: redact(String(item.text ?? "")).trim().slice(0, 1200),
        category: redact(String(item.category ?? "business")).trim().slice(0, 80),
        rationale: redact(String(item.rationale ?? "")).trim().slice(0, 1200),
        source_asset_ids: sanitizedStringList(item.source_asset_ids, 160),
        target_paths: sanitizedStringList(item.target_paths, 600),
        candidate_test_ids: sanitizedStringList(item.candidate_test_ids, 300),
      }))
      .filter((item) => item.text.length > 0);
    return criteria.length > 0 ? { criteria } : null;
  } catch {
    return null;
  }
}

function extractFeedbackDeclarations(text: string): AssetFeedbackDeclaration[] {
  const results: AssetFeedbackDeclaration[] = [];
  const pattern = /<team_asset_feedback>\s*(\{[\s\S]*?\})\s*<\/team_asset_feedback>/g;
  for (const match of text.matchAll(pattern)) {
    try {
      const value = JSON.parse(match[1]) as Record<string, unknown>;
      const assetId = String(value.asset_id ?? "").trim();
      const rawSignal = String(value.signal ?? "").trim().toLowerCase();
      if (!assetId || ![
        "useful", "not_applicable", "duplicate", "ignored", "stale",
        "incorrect", "unobserved", "accepted", "corrected",
      ].includes(rawSignal)) continue;
      results.push({
        asset_id: assetId,
        signal: rawSignal as AssetFeedbackDeclaration["signal"],
        reason: redact(String(value.reason ?? "")).trim().slice(0, 1200),
        target: redact(String(value.target ?? "asset_recommendation")).trim().slice(0, 600),
      });
    } catch {
      // Feedback must be structured; prose is not enough to alter ranking.
    }
  }
  return results;
}

function extractDeclarations(text: string): AssetUseDeclaration[] {
  const results: AssetUseDeclaration[] = [];
  const pattern = /<team_asset_use>\s*(\{[\s\S]*?\})\s*<\/team_asset_use>/g;
  for (const match of text.matchAll(pattern)) {
    try {
      const value = JSON.parse(match[1]) as Record<string, unknown>;
      const assetId = String(value.asset_id ?? "").trim();
      const decision = redact(String(value.decision ?? "")).trim();
      const target = redact(String(value.target ?? "")).trim();
      if (assetId && decision && target) {
        results.push({ asset_id: assetId, decision: decision.slice(0, 1200), target: target.slice(0, 600) });
      }
    } catch {
      // Malformed declarations are ignored; they can never advance evidence.
    }
  }
  return results;
}

function extractAcceptanceDeclarations(text: string): AcceptanceEvidenceDeclaration[] {
  const results: AcceptanceEvidenceDeclaration[] = [];
  const pattern = /<acceptance_evidence>\s*(\{[\s\S]*?\})\s*<\/acceptance_evidence>/g;
  for (const match of text.matchAll(pattern)) {
    try {
      const value = JSON.parse(match[1]) as Record<string, unknown>;
      const criterionId = String(value.criterion_id ?? "").trim();
      const rawMode = String(value.mode ?? "automated").trim().toLowerCase();
      if (!/^criterion-\d+$/.test(criterionId)) continue;
      results.push({
        criterion_id: criterionId.slice(0, 80),
        mode: rawMode === "manual" ? "manual" : "automated",
        test_ids: sanitizedStringList(value.test_ids, 300),
        targets: sanitizedStringList(value.targets, 600),
        note: redact(String(value.note ?? "")).trim().slice(0, 1200),
      });
    } catch {
      // Invalid model output is never promoted to evidence.
    }
  }
  return results;
}

function sanitizedStringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .map((item) => redact(String(item)).trim().slice(0, limit))
      .filter(Boolean),
  )];
}

function sanitizeToolCall(content: string, toolId: string): SanitizedToolCall | null {
  try {
    const outer = JSON.parse(content) as { name?: unknown; arguments?: unknown };
    const name = String(outer.name ?? "unknown");
    const args = parseArguments(outer.arguments);
    const command = firstString(args, ["command", "cmd", "script"]);
    // Coding clients do not agree on a single file argument name. CodeBuddy
    // currently emits camelCase/URI variants for several edit tools, while
    // other clients use snake_case. Keep only path-like metadata here; source
    // contents are still represented by a hash below.
    const target = firstString(args, [
      "path", "file", "file_path", "filePath", "filepath", "filename",
      "target", "target_file", "targetFile", "uri",
    ]);
    const lowerName = name.toLowerCase();
    // A read of test_inventory.py, or a Python probe with "tests" in a
    // comment, is not a test execution. Match tool names / runner invocations.
    const testCommand = command.split(/&&|\|\||[;\n|]/).some(part =>
      /^\s*(?:(?:python[\d.]*|py)\s+-m\s+(?:pytest|unittest)|(?:\S*\/)?(?:pytest|tox|jest|vitest)\b|(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|vitest|jest)\b|go\s+test\b|cargo\s+test\b)/i.test(part));
    const kind: SanitizedToolCall["kind"] =
      /apply_patch|patch|edit|write|replace|create_file/.test(lowerName) ? "edit"
        : /read|open|search|grep|glob|list/.test(lowerName) ? "read"
          : /^(?:run[_-]?)?(?:tests?|pytest|unittest|tox)$/.test(lowerName) || testCommand ? "test"
            : "other";
    const safeArgs = redact(JSON.stringify(pickSafeArguments(args))).slice(0, 2000);
    const changedPaths = extractChangedPaths(args, target);
    return {
      id: toolId || createHash("sha256").update(content).digest("hex").slice(0, 20),
      name: name.slice(0, 200),
      kind,
      target: redact(target).slice(0, 600),
      command: redact(command).slice(0, 1200),
      arguments: safeArgs,
      change_hash: kind === "edit" ? `sha256:${createHash("sha256").update(content).digest("hex")}` : "",
      changed_paths: kind === "edit" ? changedPaths : [],
      test_ids: kind === "test" ? extractTestIds(`${command}\n${safeArgs}`) : [],
    };
  } catch {
    return null;
  }
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return { raw: value };
  }
}

function pickSafeArguments(value: Record<string, unknown>): Record<string, unknown> {
  // Patch/file contents are represented only by a hash + changed path list;
  // raw source code must not be copied into the evidence service.
  const allowed = new Set([
    "path", "file", "file_path", "filePath", "filepath", "filename",
    "target", "target_file", "targetFile", "uri", "command", "cmd", "script",
  ]);
  return Object.fromEntries(Object.entries(value).filter(([key]) => allowed.has(key)));
}

function extractChangedPaths(value: Record<string, unknown>, directTarget: string): string[] {
  const paths = new Set<string>();
  if (directTarget) paths.add(redact(directTarget).slice(0, 600));
  const patch = [value.patch, value.diff, value.content]
    .filter((item): item is string => typeof item === "string")
    .join("\n");
  const patterns = [
    /^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/gm,
    /^\+\+\+\s+(?:b\/)?([^\t\n]+)$/gm,
    /^---\s+(?:a\/)?([^\t\n]+)$/gm,
  ];
  for (const pattern of patterns) {
    for (const match of patch.matchAll(pattern)) {
      const path = redact(String(match[1] ?? "").trim());
      if (path && path !== "/dev/null") paths.add(path.slice(0, 600));
    }
  }
  return [...paths].sort();
}

function extractTestIds(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(/(?:[A-Za-z0-9_./-]+::)?(test_[A-Za-z0-9_]+)/g)) {
    ids.add(match[1]);
  }
  return [...ids].sort();
}

function firstString(value: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const item = value[key];
    if (typeof item === "string") return item;
  }
  return "";
}

function isSuccessfulToolResult(text: string): boolean {
  const lower = text.toLowerCase();
  if (/\b[1-9]\d* failed\b|traceback|process exited with code [1-9]\d*/.test(lower)) return false;
  return /\b[1-9]\d* passed\b|process exited with code 0|"exit_code"\s*:\s*0|\bexit code:? 0\b|"success"\s*:\s*true|\bsucceeded\b/.test(lower);
}

function summarizeToolResult(text: string): string {
  if (text.length <= 1200) return text;
  // Test runners put the useful failure near the beginning and the final
  // pass/fail count at the end. Preserve both instead of truncating away the
  // exact result that drives validation.
  return `${text.slice(0, 580)}\n…[truncated]…\n${text.slice(-580)}`;
}

function redact(text: string): string {
  let result = text;
  for (const item of SECRET_PATTERNS) result = result.replace(item.pattern, item.replacement);
  return result;
}
