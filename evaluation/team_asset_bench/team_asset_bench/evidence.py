from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Sequence

from .ledger import EvidenceLedger, InvalidAssetTransition
from .models import AssetState, ContextPackage


@dataclass
class TestEvidence:
    name: str
    passed: bool
    command: str
    output_ref: str


@dataclass
class RunEvidence:
    trace_id: str
    task_id: str
    changed_paths: List[str]
    decisions: Dict[str, str]
    asset_targets: Dict[str, str]
    tests: List[TestEvidence]
    tool_calls: List[str] = field(default_factory=list)
    attempts: int = 1
    duration_ms: int = 0

    @property
    def passed(self) -> bool:
        return bool(self.tests) and all(test.passed for test in self.tests)


class EvidenceValidator:
    """Converts declared use into validated evidence only when independent checks agree."""

    def __init__(self, ledger: EvidenceLedger) -> None:
        self.ledger = ledger

    def confirm_injected(
        self,
        package: ContextPackage,
        *,
        actor_id: str,
        evidence_ref: str,
        detail: Dict[str, object] | None = None,
    ) -> List[str]:
        """Confirm that selected blocks reached an actual agent context boundary.

        Selection alone is never treated as injection. Live runs call the
        MemoryProxy acknowledgement endpoint; the offline harness calls this
        method immediately after it has assembled the agent prompt.
        """
        confirmed: List[str] = []
        for selection in package.selected:
            asset_id = selection.asset.asset_id
            if self.ledger.latest_state(package.trace_id, package.task.task_id, asset_id) is not AssetState.SELECTED:
                continue
            self.ledger.append(
                trace_id=package.trace_id,
                task_id=package.task.task_id,
                asset_id=asset_id,
                state=AssetState.INJECTED,
                actor_type="proxy" if actor_id == "memory-proxy" else "harness",
                actor_id=actor_id,
                evidence_ref=evidence_ref,
                detail={"token_cost": selection.asset.token_cost, **(detail or {})},
            )
            confirmed.append(asset_id)
        return confirmed

    def record_declared_use(self, package: ContextPackage, evidence: RunEvidence) -> List[str]:
        accepted: List[str] = []
        injected_ids = {item.asset.asset_id for item in package.selected}
        for asset_id, decision in evidence.decisions.items():
            if asset_id not in injected_ids:
                continue
            target = evidence.asset_targets.get(asset_id)
            code_target = bool(target) and any(
                target == path or target.startswith(path + ":") for path in evidence.changed_paths
            )
            test_target = bool(target and target.startswith("test:")) and any(
                call.startswith("pytest") for call in evidence.tool_calls
            )
            if not target or not (code_target or test_target):
                continue
            self.ledger.append(
                trace_id=evidence.trace_id,
                task_id=evidence.task_id,
                asset_id=asset_id,
                state=AssetState.USED,
                actor_type="agent",
                actor_id=package.task.agent_id,
                target=target,
                decision=decision,
                detail={"tool_calls": evidence.tool_calls},
            )
            accepted.append(asset_id)
        return accepted

    def validate(self, package: ContextPackage, evidence: RunEvidence) -> List[str]:
        validated: List[str] = []
        passed_tests = [test for test in evidence.tests if test.passed]
        if not passed_tests:
            return validated
        for asset_id in self.record_declared_use(package, evidence):
            selection = next(item for item in package.selected if item.asset.asset_id == asset_id)
            required = set(selection.asset.tests)
            matched = [test for test in passed_tests if not required or test.name in required]
            if not matched:
                continue
            self.ledger.append(
                trace_id=evidence.trace_id,
                task_id=evidence.task_id,
                asset_id=asset_id,
                state=AssetState.VALIDATED,
                actor_type="validator",
                actor_id="pytest-validator",
                evidence_ref=matched[0].output_ref,
                detail={"tests": [test.name for test in matched]},
            )
            validated.append(asset_id)
        return validated

    def mark_contributed(
        self,
        package: ContextPackage,
        asset_ids: Iterable[str],
        comparison_ref: str,
        delta: Dict[str, object],
    ) -> List[str]:
        contributed: List[str] = []
        for asset_id in asset_ids:
            try:
                self.ledger.append(
                    trace_id=package.trace_id,
                    task_id=package.task.task_id,
                    asset_id=asset_id,
                    state=AssetState.CONTRIBUTED,
                    actor_type="evaluator",
                    actor_id="counterfactual-evaluator",
                    evidence_ref=comparison_ref,
                    detail=delta,
                )
                contributed.append(asset_id)
            except InvalidAssetTransition:
                # A non-used or non-validated asset must never be promoted by a
                # task-level win. The receipt keeps its actual lower state.
                continue
        return contributed


def test_pass_rate(tests: Sequence[TestEvidence]) -> float:
    if not tests:
        return 0.0
    return round(sum(1 for test in tests if test.passed) / len(tests), 4)
