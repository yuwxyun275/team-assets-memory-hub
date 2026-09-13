import type { QualityCheck } from "./types.js";

export const QUALITY_WEIGHTS = { correctness: .40, completeness: .25, boundaries: .20, usability: .15 } as const;
export type Dimension = keyof typeof QUALITY_WEIGHTS;
export interface Scorecard {
  quality: number | null;
  evidence_coverage: number;
  dimensions: Record<Dimension, number | null>;
  weights: typeof QUALITY_WEIGHTS;
  calibration: "provisional_not_calibrated";
  blockers: string[];
}
/** Evidence coverage includes negative evidence; it is NOT probability of truth. */
export function scoreChecks(checks: QualityCheck[]): Scorecard {
  const semantic = checks.filter(c => c.method === "model");
  const groups: Record<Dimension, QualityCheck[]> = {
    correctness: semantic.filter(c => /grounding|meaning|correctness/.test(c.id)),
    completeness: semantic.filter(c => /coherence|coverage/.test(c.id)),
    boundaries: semantic.filter(c => c.id === "scope"),
    usability: semantic.filter(c => /usability|reuse|verifiability|graph.coverage/.test(c.id)),
  };
  const dimensions = {} as Record<Dimension, number | null>;
  for (const key of Object.keys(groups) as Dimension[]) {
    const items = groups[key];
    dimensions[key] = !items.length || items.some(c => c.status === "unknown" || c.score == null || !c.evidence.length)
      ? null : Math.round(25 * items.reduce((sum, c) => sum + c.score!, 0) / items.length);
  }
  return {
    quality: Object.values(dimensions).some(v => v === null) ? null
      : Math.round((Object.keys(dimensions) as Dimension[]).reduce((sum, k) => sum + dimensions[k]! * QUALITY_WEIGHTS[k], 0)),
    evidence_coverage: semantic.length ? Math.round(100 * semantic.filter(c => c.status !== "unknown" && c.evidence.length).length / semantic.length) : 0,
    dimensions, weights: QUALITY_WEIGHTS, calibration: "provisional_not_calibrated",
    blockers: checks.filter(c => c.status !== "pass").map(c => c.id),
  };
}
