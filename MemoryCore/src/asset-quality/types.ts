import { z } from "zod";
import { workflowScopeSchema } from "./learning-workflow.js";

export const POLICY_VERSION = "intrinsic-quality/v2";
const id = z.string().trim().min(1).max(200);
const text = z.string().max(60_000);

// Evidence is supplied data, NEVER a command, URL to fetch, or trusted test attestation.
export const snapshotSchema = z.object({
  asset_id: id,
  unit_id: id, // A document / memory record / graph slice / SKILL.md, not a container.
  asset_type: z.enum(["llm_wiki", "chat_memory", "code_graph", "skill"]),
  content_version: id,
  declared_scope: z.string().trim().max(4000),
  // Versioned alongside the reviewed body; retrieval must not widen this through mutable metadata.
  project_scope: z.object({ repository: z.string().min(1).max(1000), version: id, synthetic: z.boolean() }).strict().optional(),
  workflow_scope: workflowScopeSchema.optional(),
  body: text,
  sources: z.array(z.object({
    id: id.refine((s) => s !== "asset" && s !== "scope", "reserved source id"),
    kind: z.enum(["document", "conversation", "code", "test_output", "resource"]),
    locator: z.string().min(1).max(1000),
    revision: z.string().max(200).optional(),
    repository: z.string().max(1000).optional(),
    content: text,
  }).strict()).max(24).default([]),
}).strict().superRefine((s, ctx) => {
  if (s.workflow_scope && (s.asset_type !== "skill" || !s.project_scope
    || s.workflow_scope.origin.repository !== s.project_scope.repository || s.workflow_scope.origin.version !== s.project_scope.version)) {
    ctx.addIssue({ code: "custom", message: "workflow scope must belong to a Skill and match its source project/version" });
  }
  if (new Set(s.sources.map((v) => v.id)).size !== s.sources.length) {
    ctx.addIssue({ code: "custom", message: "duplicate source ids" });
  }
  if (Buffer.byteLength(JSON.stringify(s), "utf8") > 240_000) {
    ctx.addIssue({ code: "custom", message: "snapshot exceeds 240000 UTF-8 bytes; split into content units" });
  }
});
export type QualitySnapshot = z.infer<typeof snapshotSchema>;
export type CheckStatus = "pass" | "fail" | "unknown";
export type EvidenceRef = { source_id: string; start: number; end: number; quote: string };
export type QualityCheck = {
  id: string;
  label: string;
  status: CheckStatus;
  method: "rule" | "model";
  reason: string;
  evidence: EvidenceRef[];
  remediation?: string;
  /** Anchored rubric rating. Missing evidence is null, never an invented zero. */
  score?: number | null;
};
export type ReviewCriterion = { id: string; label: string; instructions: string; supportKinds?: QualitySnapshot["sources"][number]["kind"][] };
export type ModelReviewer = {
  id: string;
  review(snapshot: QualitySnapshot, criteria: ReviewCriterion[], signal: AbortSignal): Promise<unknown>;
};
export type QualityReport = {
  report_id: string;
  evaluated_at: string;
  policy_version: typeof POLICY_VERSION;
  snapshot_sha256: string;
  asset_id: string;
  unit_id: string;
  asset_type: QualitySnapshot["asset_type"];
  content_version: string;
  declared_scope: string;
  sources: { id: string; sha256: string }[];
  reviewer: { id: string; status: "completed" | "unavailable" | "invalid_response" | "timeout" | "not_run" };
  decision: "pass" | "needs_evidence" | "reject";
  checks: QualityCheck[];
  // A pass is a bounded content review, NOT native-storage verification or publication.
  assurance: "submitted_snapshot_review";
  human_review_required: true;
  publication_changed: false;
  limitations: string[];
  scorecard?: import("./scorecard.js").Scorecard;
};
