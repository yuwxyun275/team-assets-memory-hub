from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Dict, Iterable

from .evidence import RunEvidence
from .models import ContextPackage


def generate_candidate_asset(
    package: ContextPackage,
    evidence: RunEvidence,
    validated_asset_ids: Iterable[str],
    output_dir: Path,
) -> Dict[str, Any]:
    """Create a review-only asset candidate from a validated task outcome.

    The candidate is intentionally excluded from the normalized catalog. A
    reviewer must approve it before any future retrieval run can treat it as a
    team authority.
    """
    passed_tests = [test for test in evidence.tests if test.passed]
    payload: Dict[str, Any] = {
        "schema_version": "team-asset-candidate/v1",
        "candidate_id": "candidate-cache-outage-regression-v1",
        "team_id": package.task.team_id,
        "title": "Feature Flag 缓存故障与恢复回归组合",
        "asset_type": "validation_workflow",
        "source_type": "task_feedback",
        "publication_state": "candidate",
        "authority": False,
        "review_required": True,
        "source_trace_id": evidence.trace_id,
        "source_task_id": evidence.task_id,
        "derived_from_asset_ids": sorted(set(validated_asset_ids)),
        "changed_paths": evidence.changed_paths,
        "proposed_claim": (
            "缓存降级修复必须在同一次验证中覆盖正常命中、缓存故障、租户隔离、"
            "draft 阻断、无重试风暴与缓存恢复。"
        ),
        "proposed_action": "运行 visible + hidden + recovery pytest 集，并保留逐项输出引用。",
        "verification": {
            "all_tests_passed": bool(evidence.tests) and len(passed_tests) == len(evidence.tests),
            "passed": len(passed_tests),
            "total": len(evidence.tests),
            "evidence_refs": sorted({test.output_ref for test in passed_tests}),
        },
        "review_gate": {
            "required_roles": ["agent-qa-sre", "agent-architect-product"],
            "checks": [
                "confirm assertions do not encode environment-specific secrets",
                "confirm repository/version scope",
                "confirm tests still pass on current default branch",
            ],
        },
    }
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    payload["content_hash"] = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / f"{payload['candidate_id']}.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return {"path": str(path), **payload}
