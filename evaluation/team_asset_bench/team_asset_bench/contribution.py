from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from .ledger import EvidenceLedger
from .models import AssetState, ContextPackage


class TrustedEvaluationRegistry:
    """Promote contribution only from a matching, reproducible evaluation."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def finalize(
        self,
        package: ContextPackage,
        ledger: EvidenceLedger,
        completion: Dict[str, Any],
    ) -> Dict[str, Any]:
        if completion.get("task_completed") is not True:
            return {"status": "blocked", "reason": "engineering_verification_not_complete"}
        record = self._record(package)
        if record is None:
            return {"status": "unverified", "reason": "no_matching_trusted_evaluation"}
        appended: List[str] = []
        for selection in package.selected:
            asset_id = selection.asset.asset_id
            effect = record["effects"].get(asset_id)
            if not effect or effect.get("positive") is not True:
                continue
            latest = ledger.latest_state(package.trace_id, package.task.task_id, asset_id)
            if latest is AssetState.CONTRIBUTED:
                appended.append(asset_id)
                continue
            if latest is not AssetState.VALIDATED:
                continue
            ledger.append(
                trace_id=package.trace_id,
                task_id=package.task.task_id,
                asset_id=asset_id,
                state=AssetState.CONTRIBUTED,
                actor_type="evaluator",
                actor_id="trusted-counterfactual-registry",
                evidence_ref=record["evidence_ref"],
                detail={
                    "benchmark": record["benchmark"],
                    "evaluation_mode": record["mode"],
                    "effect": effect,
                    "contract": {
                        "repository": package.task.repository,
                        "version": package.task.version,
                        "task_type": package.task.task_type,
                    },
                },
            )
            appended.append(asset_id)
        return {
            "status": "contributed" if appended else "validated_without_positive_ablation",
            "asset_ids": appended,
            "evidence_ref": record["evidence_ref"],
            "benchmark": record["benchmark"],
            "mode": record["mode"],
        }

    def _record(self, package: ContextPackage) -> Optional[Dict[str, Any]]:
        if not self.path.is_file():
            return None
        raw = self.path.read_bytes()
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
        if value.get("schema_version") != "team-asset-benchmark-result/v1":
            return None
        if value.get("mode") not in {"deterministic-reference-policy", "real-model-repeated"}:
            return None
        benchmark = str(value.get("benchmark") or "")
        if benchmark != "python-feature-flag-team-assets":
            return None
        # This registry entry is deliberately narrow. A different repository,
        # version or task type must run its own counterfactual evaluation.
        if package.task.repository != "team/feature-flag-service":
            return None
        if package.task.version != "1.4" or package.task.task_type != "bug_fix":
            return None
        ablations = (value.get("comparisons") or {}).get("asset_ablations") or {}
        effects: Dict[str, Dict[str, Any]] = {}
        for effect in ablations.values():
            if isinstance(effect, dict) and effect.get("asset_id"):
                effects[str(effect["asset_id"])] = effect
        selected_ids = {item.asset.asset_id for item in package.selected}
        if not selected_ids.issubset(effects):
            return None
        digest = hashlib.sha256(raw).hexdigest()
        return {
            "benchmark": benchmark,
            "mode": str(value.get("mode")),
            "effects": effects,
            "evidence_ref": f"sha256:{digest}#comparisons.asset_ablations",
        }
