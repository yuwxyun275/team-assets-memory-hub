from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional


class SourceType(str, Enum):
    WIKI = "wiki"
    CHAT_MEMORY = "chat_memory"
    CODE_GRAPH = "code_graph"
    SKILL = "skill"


class AssetType(str, Enum):
    PROJECT_CONSTRAINT = "project_constraint"
    FAILURE_EXPERIENCE = "failure_experience"
    CODE_KNOWLEDGE = "code_knowledge"
    VALIDATION_WORKFLOW = "validation_workflow"
    PRODUCT_KNOWLEDGE = "product_knowledge"


class EvidenceState(str, Enum):
    CANDIDATE = "candidate"
    SOURCE_VERIFIED = "source_verified"
    REVIEWED = "reviewed"
    TEST_VALIDATED = "test_validated"
    AUTHORITATIVE = "authoritative"
    CORRECTED = "corrected"


class AssetState(str, Enum):
    RECALLED = "recalled"
    SELECTED = "selected"
    INJECTED = "injected"
    USED = "used"
    VALIDATED = "validated"
    CONTRIBUTED = "contributed"
    CORRECTED = "corrected"


TRUST_BY_EVIDENCE = {
    EvidenceState.CANDIDATE: 0.25,
    EvidenceState.SOURCE_VERIFIED: 0.62,
    EvidenceState.REVIEWED: 0.78,
    EvidenceState.TEST_VALIDATED: 0.92,
    EvidenceState.AUTHORITATIVE: 1.0,
    EvidenceState.CORRECTED: 0.15,
}


@dataclass(frozen=True)
class Asset:
    asset_id: str
    team_id: str
    title: str
    source_type: SourceType
    asset_type: AssetType
    contributor: str
    source_ref: str
    claim: str
    action: str
    evidence_state: EvidenceState
    version: str
    updated_at: str
    token_cost: int
    keywords: List[str]
    task_types: List[str]
    paths: List[str] = field(default_factory=list)
    tests: List[str] = field(default_factory=list)
    risks: List[str] = field(default_factory=list)
    allowed_agents: List[str] = field(default_factory=lambda: ["*"])
    historical_effect: float = 0.5
    deprecated: bool = False
    superseded_by: Optional[str] = None
    content_hash: str = ""
    # Memory Hub runtime identity is deliberately kept separate from the
    # portable/logical id used by the benchmark fixtures.  Native Hub assets
    # simply use the same value for both fields.
    runtime_asset_id: Optional[str] = None
    native_asset_type: str = ""
    visibility: str = "team"
    status: str = "approved"
    content_ref: str = ""
    injection_mode: str = "direct_context"
    retrieval_handle: Dict[str, Any] = field(default_factory=dict)
    native_signals: Dict[str, float] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, value: Dict[str, Any]) -> "Asset":
        data = dict(value)
        data["source_type"] = SourceType(data["source_type"])
        data["asset_type"] = AssetType(data["asset_type"])
        data["evidence_state"] = EvidenceState(data["evidence_state"])
        return cls(**data)

    def to_dict(self) -> Dict[str, Any]:
        value = asdict(self)
        value["source_type"] = self.source_type.value
        value["asset_type"] = self.asset_type.value
        value["evidence_state"] = self.evidence_state.value
        return value


@dataclass(frozen=True)
class Task:
    task_id: str
    team_id: str
    agent_id: str
    title: str
    description: str
    repository: str
    version: str
    task_type: str
    token_budget: int = 900
    max_assets: int = 4
    target_paths: List[str] = field(default_factory=list)
    required_capabilities: List[AssetType] = field(default_factory=list)

    @classmethod
    def from_dict(cls, value: Dict[str, Any]) -> "Task":
        data = dict(value)
        data["required_capabilities"] = [AssetType(item) for item in data.get("required_capabilities", [])]
        return cls(**data)

    def to_dict(self) -> Dict[str, Any]:
        value = asdict(self)
        value["required_capabilities"] = [item.value for item in self.required_capabilities]
        return value


@dataclass
class SelectionFeatures:
    lexical_relevance: float
    task_type_match: float
    path_match: float
    trust: float
    freshness: float
    version_compatibility: float
    historical_effect: float
    capability_match: float
    token_efficiency: float
    bm25_relevance: float = 0.0
    vector_relevance: float = 0.0
    graph_relevance: float = 0.0
    rrf_score: float = 0.0

    def to_dict(self) -> Dict[str, float]:
        return asdict(self)


@dataclass
class Selection:
    asset: Asset
    score: float
    features: SelectionFeatures
    selected: bool
    reasons: List[str]
    rank: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "asset": self.asset.to_dict(),
            "score": self.score,
            "features": self.features.to_dict(),
            "selected": self.selected,
            "reasons": self.reasons,
            "rank": self.rank,
        }


@dataclass
class AssetEvent:
    event_id: str
    trace_id: str
    task_id: str
    asset_id: str
    state: AssetState
    actor_type: str
    actor_id: str
    timestamp: str
    target: Optional[str] = None
    decision: Optional[str] = None
    evidence_ref: Optional[str] = None
    detail: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, value: Dict[str, Any]) -> "AssetEvent":
        data = dict(value)
        data["state"] = AssetState(data["state"])
        return cls(**data)

    def to_dict(self) -> Dict[str, Any]:
        value = asdict(self)
        value["state"] = self.state.value
        return value


@dataclass
class ContextPackage:
    trace_id: str
    task: Task
    recalled: List[Selection]
    selected: List[Selection]
    rejected: List[Selection]
    token_cost: int
    markdown: str

    def to_dict(self) -> Dict[str, Any]:
        return {
            "trace_id": self.trace_id,
            "task": self.task.to_dict(),
            "recalled": [item.to_dict() for item in self.recalled],
            "selected": [item.to_dict() for item in self.selected],
            "rejected": [item.to_dict() for item in self.rejected],
            "token_cost": self.token_cost,
            "markdown": self.markdown,
        }
