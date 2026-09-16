/** Governance choices are explicit constraints, not fitted accuracy estimates.
 * See docs/PARAMETER_EVIDENCE_CN.md and evaluation/parameter_calibration/.
 */
export const DECISION_POLICY = {
  version: "asset-decision/v3",
  quality: {
    weights: { correctness: .25, completeness: .25, boundaries: .25, usability: .25 },
    defaultMinimum: 80,
    rationale: "equal_dimension_convention_not_empirically_optimal",
  },
  usage: {
    priorPositive: 5, priorNegative: 5,
    actorWeight: 1,
    decay: "none_within_retention_and_revision",
    sceneSimilarity: 1,
    minimumFitTasks: 3,
    maxAdjustment: .05,
    rationale: "one_vote_per_task; single_vote_moves_mean_at_most_1/22; exact_normalized_scene",
  },
} as const;

/** Beta(a,b) posterior under a declared exchangeable-vote model.
 * The interval describes this model, NOT task-success probability or causal gain.
 */
export function usagePosterior(positive: number, negative: number) {
  const a = DECISION_POLICY.usage.priorPositive + positive;
  const b = DECISION_POLICY.usage.priorNegative + negative;
  const mean = a / (a + b);
  const standardDeviation = Math.sqrt(a * b / ((a + b) ** 2 * (a + b + 1)));
  // Integer Beta CDF = binomial tail. Log-sum avoids overflow on larger histories.
  function cdf(x: number) {
    const n = a + b - 1;
    let term = n * Math.log1p(-x), total = 0;
    for (let j = 0; j <= n; j++) {
      if (j >= a) total += Math.exp(term);
      term += Math.log(n - j) - Math.log(j + 1) + Math.log(x) - Math.log1p(-x);
    }
    return Math.min(1, total);
  }
  function quantile(p: number) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 48; i++) { const mid = (lo + hi) / 2; if (cdf(mid) < p) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  }
  return { mean, standardDeviation, interval95: [quantile(.025), quantile(.975)] as [number, number], a, b };
}
