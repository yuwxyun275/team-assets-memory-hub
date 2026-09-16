"""Versioned decision settings. Evidence: evaluation/parameter_calibration/.

Capacity and influence limits are policy decisions, not fitted probabilities.
The legacy mode exists only to reproduce comparisons with earlier reports.
"""
from dataclasses import asdict, dataclass
import hashlib
import json


@dataclass(frozen=True)
class DecisionPolicy:
    version: str = "team-asset-decision/v3"
    retrieval: str = "rrf"
    rrf_k: int = 10
    minimum_relative_score: float = 0.2
    candidate_limit: int = 24
    feedback_max_adjustment: float = 0.05

    def __post_init__(self):
        if self.retrieval not in {"legacy", "rrf", "bm25"}:
            raise ValueError("unsupported retrieval policy")
        if self.rrf_k < 1 or self.candidate_limit < 1:
            raise ValueError("rank constant and candidate limit must be positive")
        if not 0 <= self.minimum_relative_score <= 1 or not 0 <= self.feedback_max_adjustment <= .05:
            raise ValueError("policy exceeds relevance/influence limits")

    def to_dict(self):
        return asdict(self)

    @property
    def fingerprint(self):
        return hashlib.sha256(json.dumps(asdict(self), sort_keys=True).encode()).hexdigest()


DEFAULT_POLICY = DecisionPolicy()
LEGACY_POLICY = DecisionPolicy(version="legacy-heuristic/v1", retrieval="legacy", rrf_k=60, minimum_relative_score=.4)
