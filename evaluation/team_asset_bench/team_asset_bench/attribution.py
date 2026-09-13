from __future__ import annotations

from pathlib import PurePosixPath
import re
from typing import Any, Dict, Iterable, Mapping, Sequence

from .models import Asset


def usage_attribution(
    asset: Asset,
    declaration: Mapping[str, str],
    action: Mapping[str, Any],
) -> Dict[str, Any]:
    """Build an explainable, conservative asset→decision→change link."""
    declared_target = _path(str(declaration.get("target") or ""))
    changed_paths = _paths(action.get("changed_paths") or [])
    action_target = _path(str(action.get("target") or ""))
    if action_target:
        changed_paths.add(action_target)
    asset_paths = _paths(asset.paths)
    declared_test = (
        str(declaration.get("target") or "").removeprefix("test:").strip()
        if str(declaration.get("target") or "").startswith("test:")
        else ""
    )
    observed_tests = {str(item) for item in action.get("test_ids", [])}
    grouped_tests = re.fullmatch(r"(.+\.py)/(test_\w+(?:,test_\w+)*)", declared_test)
    declared_tests = set(grouped_tests[2].split(",")) if grouped_tests else {declared_test}
    matched_paths = sorted(
        path for path in changed_paths
        if _matches(path, declared_target) or any(_matches(path, expected) for expected in asset_paths)
    )
    signals = {
        "structured_declaration": bool(declaration.get("decision") and declaration.get("target")),
        "observed_edit_or_test": str(action.get("kind")) in {"edit", "test"},
        "target_matches_observation": bool(matched_paths) or bool(
            declared_test
            and (
                declared_test in observed_tests
                or declared_test in str(action.get("command") or "")
                or (grouped_tests and grouped_tests[1] in str(action.get("command") or "") and declared_tests <= observed_tests)
            )
        ),
        "change_hash_present": str(action.get("change_hash") or "").startswith("sha256:"),
    }
    confidence = (
        0.25 * signals["structured_declaration"]
        + 0.30 * signals["observed_edit_or_test"]
        + 0.30 * signals["target_matches_observation"]
        + 0.15 * signals["change_hash_present"]
    )
    return {
        "schema_version": "asset-attribution/v1",
        "confidence": round(confidence, 3),
        "grade": _grade(confidence),
        "signals": signals,
        "decision": str(declaration.get("decision") or "")[:1200],
        "declared_target": str(declaration.get("target") or "")[:600],
        "observed_action": {
            "tool_call_id": str(action.get("id") or "")[:200],
            "tool_name": str(action.get("name") or "")[:200],
            "kind": str(action.get("kind") or "")[:40],
            "changed_paths": sorted(changed_paths),
            "matched_paths": matched_paths,
            "matched_tests": sorted(observed_tests & declared_tests) if declared_test else [],
            "change_hash": str(action.get("change_hash") or "")[:120] or None,
        },
    }


def validation_attribution(
    asset: Asset,
    usage: Mapping[str, Any],
    *,
    matched_tests: Sequence[str],
    evidence_ref: str,
    result_success: bool,
    expected_tests: Sequence[str] | None = None,
) -> Dict[str, Any]:
    """Extend a usage edge with independently observed test evidence."""
    required = set(asset.tests if expected_tests is None else expected_tests)
    matched = sorted(required & {str(item) for item in matched_tests}) if required else sorted(set(matched_tests))
    usage_confidence = float(usage.get("confidence") or 0.0)
    test_specificity = 1.0 if matched and required else (0.7 if matched else 0.0)
    independent_evidence = evidence_ref.startswith("sha256:") or evidence_ref.startswith("ci:")
    confidence = min(
        1.0,
        usage_confidence * 0.55
        + test_specificity * 0.30
        + (0.15 if result_success and independent_evidence else 0.0),
    )
    return {
        **dict(usage),
        "confidence": round(confidence, 3),
        "grade": _grade(confidence),
        "validation": {
            "required_tests": sorted(required),
            "matched_tests": matched,
            "test_specificity": test_specificity,
            "success": result_success,
            "independent_evidence": independent_evidence,
            "evidence_ref": evidence_ref[:600],
        },
    }


def _paths(values: Iterable[Any]) -> set[str]:
    return {path for value in values if (path := _path(str(value)))}


def _path(value: str) -> str:
    raw = value.removeprefix("test:").split(":", 1)[0].strip().replace("\\", "/")
    if not raw:
        return ""
    return str(PurePosixPath(raw)).lstrip("./")


def _matches(left: str, right: str) -> bool:
    return bool(left and right and (left == right or left.endswith(right) or right.endswith(left)))


def _grade(confidence: float) -> str:
    if confidence >= 0.85:
        return "strong"
    if confidence >= 0.65:
        return "moderate"
    return "weak"
