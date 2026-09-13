from __future__ import annotations

import hashlib
import json
import subprocess
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Sequence


ALLOWED_PROVIDERS = {"local-ci", "github-actions", "gitlab-ci", "jenkins", "trusted-replay"}


@dataclass(frozen=True)
class CiCheck:
    check_id: str
    name: str
    status: str
    source: str
    test_ids: List[str]
    summary: str
    evidence_ref: str
    duration_ms: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "check_id": self.check_id,
            "name": self.name,
            "status": self.status,
            "source": self.source,
            "test_ids": self.test_ids,
            "summary": self.summary,
            "evidence_ref": self.evidence_ref,
            "duration_ms": self.duration_ms,
        }


def normalize_ci_run(value: Mapping[str, Any]) -> Dict[str, Any]:
    """Validate a CI provider payload without trusting its prose conclusion."""
    trace_id = str(value.get("trace_id") or "").strip()
    if not trace_id:
        raise ValueError("trace_id is required")
    provider = str(value.get("provider") or "local-ci").strip().lower()
    if provider not in ALLOWED_PROVIDERS:
        raise ValueError(f"unsupported CI provider: {provider}")
    checks = [_normalize_check(item) for item in _dicts(value.get("checks"))]
    if not checks:
        raise ValueError("at least one CI check is required")
    evidence_ref = str(value.get("evidence_ref") or "").strip()
    if not evidence_ref.startswith("sha256:"):
        canonical = json.dumps([item.to_dict() for item in checks], ensure_ascii=False, sort_keys=True)
        evidence_ref = f"sha256:{hashlib.sha256(canonical.encode('utf-8')).hexdigest()}"
    status = "passed" if all(item.status == "passed" for item in checks) else "failed"
    commit_sha = str(value.get("commit_sha") or "")[:160]
    remote_provider = provider in {"github-actions", "gitlab-ci", "jenkins"}
    if remote_provider and not commit_sha:
        raise ValueError("remote CI evidence requires commit_sha")
    webhook_verified = value.get("webhook_verified") is True
    trusted_for_validation = not remote_provider or webhook_verified
    discovery = _normalize_verification_discovery(value.get("verification_discovery"))
    regression_proof = _normalize_regression_proof(value.get("regression_proof"))
    return {
        "run_id": str(value.get("run_id") or f"ci-{uuid.uuid4().hex[:16]}"),
        "trace_id": trace_id,
        "turn_id": str(value.get("turn_id") or ""),
        "provider": provider,
        "status": status,
        "commit_sha": commit_sha,
        "pipeline_ref": str(value.get("pipeline_ref") or "")[:600],
        "provider_event_id": str(value.get("provider_event_id") or "")[:200],
        "webhook_verified": webhook_verified,
        "trusted_for_validation": trusted_for_validation,
        "checks": [item.to_dict() for item in checks],
        "changed_paths": _strings(value.get("changed_paths"), limit=600),
        "evidence_ref": evidence_ref,
        "verification_discovery": discovery,
        "regression_proof": regression_proof,
        "execution_origin": str(value.get("execution_origin") or "independent_runner")[:80],
        "runner_identity": str(value.get("runner_identity") or provider)[:160],
        "created_at": str(value.get("created_at") or datetime.now(timezone.utc).isoformat()),
    }


def ci_observation(run: Mapping[str, Any]) -> Dict[str, Any]:
    """Convert a normalized CI run into the existing evidence observer protocol."""
    if run.get("trusted_for_validation") is not True:
        return {"tool_calls": [], "tool_results": [], "ci_run": dict(run)}
    tool_calls: List[Dict[str, Any]] = []
    tool_results: List[Dict[str, Any]] = []
    changed_paths = _strings(run.get("changed_paths"), limit=600)
    if changed_paths:
        tool_calls.append({
            "id": f"{run['run_id']}:changes",
            "name": "ci_changed_paths",
            "kind": "edit",
            "target": changed_paths[0],
            "changed_paths": changed_paths,
            "change_hash": str(run.get("evidence_ref") or ""),
        })
    for raw in _dicts(run.get("checks")):
        check_id = str(raw.get("check_id") or raw.get("name") or "check")
        call_id = f"{run['run_id']}:{check_id}"
        tests = _strings(raw.get("test_ids"), limit=600)
        tool_calls.append({
            "id": call_id,
            "name": f"ci:{raw.get('name') or check_id}",
            "kind": "test",
            "target": " ".join(tests),
            "command": f"{run.get('provider')} check {check_id}",
            "test_ids": tests,
        })
        tool_results.append({
            "tool_call_id": call_id,
            "success": raw.get("status") == "passed",
            "summary": str(raw.get("summary") or f"{check_id}: {raw.get('status')}")[:1200],
            "evidence_ref": str(raw.get("evidence_ref") or run.get("evidence_ref") or ""),
            "test_ids": tests,
        })
    return {
        "tool_calls": tool_calls,
        "tool_results": tool_results,
        "ci_run": dict(run),
    }


class LocalCiRunner:
    """Small reproducible CI runner; it executes reviewed argv arrays, never a shell string."""

    def __init__(self, workspace: Path, *, timeout_seconds: int = 120) -> None:
        self.workspace = workspace.resolve()
        if not self.workspace.is_dir():
            raise ValueError("CI workspace must be an existing directory")
        self.timeout_seconds = max(1, min(int(timeout_seconds), 1800))

    def run_manifest(
        self,
        manifest: Mapping[str, Any],
        *,
        trace_id: str,
        turn_id: str = "",
        changed_paths: Iterable[str] = (),
    ) -> Dict[str, Any]:
        checks: List[CiCheck] = []
        for raw in _dicts(manifest.get("checks")):
            checks.append(self._run_check(raw))
        canonical = json.dumps([item.to_dict() for item in checks], ensure_ascii=False, sort_keys=True)
        return normalize_ci_run({
            "run_id": f"ci-local-{uuid.uuid4().hex[:12]}",
            "trace_id": trace_id,
            "turn_id": turn_id,
            "provider": "local-ci",
            "commit_sha": str(manifest.get("commit_sha") or "working-tree"),
            "checks": [item.to_dict() for item in checks],
            "changed_paths": list(changed_paths),
            "evidence_ref": f"sha256:{hashlib.sha256(canonical.encode('utf-8')).hexdigest()}",
            "execution_origin": "independent_runner",
            "runner_identity": "team-asset-local-ci/v2",
        })

    def run_before_after(
        self,
        manifest: Mapping[str, Any],
        *,
        before_workspace: Path,
        trace_id: str,
        turn_id: str = "",
        changed_paths: Iterable[str] = (),
    ) -> Dict[str, Any]:
        """Run the same reviewed checks on baseline and patched workspaces.

        A confirmed proof requires at least one identical check to fail before
        and pass after, while every patched check passes.  The planner/agent
        cannot forge this transition because both executions happen here.
        """
        baseline = LocalCiRunner(
            before_workspace,
            timeout_seconds=self.timeout_seconds,
        ).run_manifest(
            manifest,
            trace_id=trace_id,
            turn_id=turn_id,
            changed_paths=changed_paths,
        )
        patched = self.run_manifest(
            manifest,
            trace_id=trace_id,
            turn_id=turn_id,
            changed_paths=changed_paths,
        )
        before_checks = {
            str(item.get("check_id")): item
            for item in _dicts(baseline.get("checks"))
        }
        after_checks = {
            str(item.get("check_id")): item
            for item in _dicts(patched.get("checks"))
        }
        transitions = [
            {
                "check_id": check_id,
                "before": str(before_checks[check_id].get("status") or "failed"),
                "after": str(after_checks[check_id].get("status") or "failed"),
            }
            for check_id in sorted(set(before_checks) & set(after_checks))
        ]
        proof = {
            "mode": "fail_before_pass_after",
            "baseline_status": baseline["status"],
            "patched_status": patched["status"],
            "baseline_evidence_ref": baseline["evidence_ref"],
            "patched_evidence_ref": patched["evidence_ref"],
            "baseline_workspace_fingerprint": _workspace_fingerprint(Path(before_workspace)),
            "patched_workspace_fingerprint": _workspace_fingerprint(self.workspace),
            "transitions": transitions,
        }
        proof["confirmed"] = bool(
            patched["status"] == "passed"
            and any(
                item["before"] == "failed" and item["after"] == "passed"
                for item in transitions
            )
        )
        combined = {
            **patched,
            "run_id": f"ci-local-pair-{uuid.uuid4().hex[:12]}",
            "regression_proof": proof,
            "evidence_ref": f"sha256:{hashlib.sha256(json.dumps(proof, sort_keys=True).encode('utf-8')).hexdigest()}",
        }
        return normalize_ci_run(combined)

    def _run_check(self, value: Mapping[str, Any]) -> CiCheck:
        check_id = str(value.get("id") or value.get("name") or "check")[:160]
        argv = value.get("argv")
        if not isinstance(argv, list) or not argv or not all(isinstance(item, str) and item for item in argv):
            raise ValueError(f"CI check {check_id} requires a non-empty argv array")
        relative_cwd = Path(str(value.get("cwd") or "."))
        cwd = (self.workspace / relative_cwd).resolve()
        if cwd != self.workspace and self.workspace not in cwd.parents:
            raise ValueError(f"CI check {check_id} cwd escapes workspace")
        started = datetime.now(timezone.utc)
        try:
            result = subprocess.run(
                list(argv),
                cwd=cwd,
                capture_output=True,
                text=True,
                timeout=min(int(value.get("timeout_seconds") or self.timeout_seconds), self.timeout_seconds),
                check=False,
            )
            output = f"{result.stdout}\n{result.stderr}".strip()
            status = "passed" if result.returncode == 0 else "failed"
        except subprocess.TimeoutExpired as exc:
            output = f"timeout after {exc.timeout}s"
            status = "failed"
        duration = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)
        redacted = _redact(output)[-4000:]
        evidence = f"sha256:{hashlib.sha256(output.encode('utf-8', errors='replace')).hexdigest()}"
        return CiCheck(
            check_id=check_id,
            name=str(value.get("name") or check_id)[:200],
            status=status,
            source=str(value.get("source") or "project")[:80],
            test_ids=_strings(value.get("test_ids"), limit=600),
            summary=redacted,
            evidence_ref=evidence,
            duration_ms=duration,
        )


def _normalize_check(value: Mapping[str, Any]) -> CiCheck:
    check_id = str(value.get("check_id") or value.get("id") or value.get("name") or "").strip()
    if not check_id:
        raise ValueError("CI check id is required")
    status = str(value.get("status") or "failed").strip().lower()
    if status not in {"passed", "failed"}:
        raise ValueError(f"invalid CI check status: {status}")
    evidence_ref = str(value.get("evidence_ref") or "").strip()
    if not evidence_ref.startswith("sha256:"):
        raw = json.dumps(dict(value), ensure_ascii=False, sort_keys=True)
        evidence_ref = f"sha256:{hashlib.sha256(raw.encode('utf-8')).hexdigest()}"
    return CiCheck(
        check_id=check_id[:160],
        name=str(value.get("name") or check_id)[:200],
        status=status,
        source=str(value.get("source") or "project")[:80],
        test_ids=_strings(value.get("test_ids"), limit=600),
        summary=_redact(str(value.get("summary") or ""))[:1200],
        evidence_ref=evidence_ref,
        duration_ms=max(0, int(value.get("duration_ms") or 0)),
    )


def _normalize_verification_discovery(value: Any) -> Dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    coverage: List[Dict[str, Any]] = []
    for raw in _dicts(value.get("acceptance_coverage"))[:100]:
        coverage.append({
            "criterion_id": str(raw.get("criterion_id") or "")[:80],
            "text": str(raw.get("text") or "")[:1200],
            "status": str(raw.get("status") or "coverage_gap")[:80],
            "mapped_test_ids": _strings(raw.get("mapped_test_ids"), limit=600),
            "mapped_test_paths": _strings(raw.get("mapped_test_paths"), limit=600),
            "confidence": max(0.0, min(float(raw.get("confidence") or 0), 1.0)),
            "reason": str(raw.get("reason") or "")[:1200],
        })
    return {
        "schema_version": str(value.get("schema_version") or "")[:120],
        "workspace_fingerprint": str(value.get("workspace_fingerprint") or "")[:160],
        "frameworks": _strings(value.get("frameworks"), limit=80),
        "ci_providers": _strings(value.get("ci_providers"), limit=80),
        "config_files": _strings(value.get("config_files"), limit=600),
        "acceptance_coverage": coverage,
        "discovery_warnings": _strings(value.get("discovery_warnings"), limit=1200),
    }


def _normalize_regression_proof(value: Any) -> Dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    if not any(
        value.get(key)
        for key in (
            "baseline_evidence_ref",
            "patched_evidence_ref",
            "baseline_workspace_fingerprint",
            "patched_workspace_fingerprint",
            "transitions",
        )
    ):
        # An absent proof must stay absent. Returning a synthetic
        # "failed -> failed" object makes the UI claim that a comparison ran
        # when only one ordinary CI execution exists.
        return {}
    transitions: List[Dict[str, str]] = []
    for raw in _dicts(value.get("transitions"))[:100]:
        before = str(raw.get("before") or "failed").lower()
        after = str(raw.get("after") or "failed").lower()
        if before not in {"passed", "failed"} or after not in {"passed", "failed"}:
            continue
        transitions.append({
            "check_id": str(raw.get("check_id") or "")[:160],
            "before": before,
            "after": after,
        })
    baseline_status = str(value.get("baseline_status") or "failed").lower()
    patched_status = str(value.get("patched_status") or "failed").lower()
    confirmed = bool(
        patched_status == "passed"
        and any(item["before"] == "failed" and item["after"] == "passed" for item in transitions)
    )
    return {
        "mode": "fail_before_pass_after",
        "confirmed": confirmed,
        "baseline_status": baseline_status if baseline_status in {"passed", "failed"} else "failed",
        "patched_status": patched_status if patched_status in {"passed", "failed"} else "failed",
        "baseline_evidence_ref": str(value.get("baseline_evidence_ref") or "")[:200],
        "patched_evidence_ref": str(value.get("patched_evidence_ref") or "")[:200],
        "baseline_workspace_fingerprint": str(value.get("baseline_workspace_fingerprint") or "")[:200],
        "patched_workspace_fingerprint": str(value.get("patched_workspace_fingerprint") or "")[:200],
        "transitions": transitions,
    }


def pair_sequential_ci_runs(runs: Sequence[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    """Decorate independently observed fail/pass runs as one regression pair.

    Local development frequently executes the reviewed CI manifest after each
    edit. The baseline and patched states therefore arrive as two immutable CI
    records rather than one ``run_before_after`` payload. Pair only runs from
    the same trusted runner, with overlapping changed paths and identical check
    IDs that actually transition from failed to passed.
    """
    result = [dict(item) for item in runs]
    for patched_index, patched in enumerate(result):
        existing = patched.get("regression_proof")
        if isinstance(existing, dict) and existing.get("confirmed") is True:
            continue
        if patched.get("status") != "passed" or patched.get("trusted_for_validation") is not True:
            continue
        patched_checks = {
            str(item.get("check_id") or ""): item
            for item in _dicts(patched.get("checks"))
            if str(item.get("check_id") or "")
        }
        if not patched_checks or not all(item.get("status") == "passed" for item in patched_checks.values()):
            continue
        patched_paths = set(_strings(patched.get("changed_paths"), limit=600))
        for baseline_index in range(patched_index - 1, -1, -1):
            baseline = result[baseline_index]
            if baseline.get("status") != "failed" or baseline.get("trusted_for_validation") is not True:
                continue
            if baseline.get("provider") != patched.get("provider"):
                continue
            if baseline.get("runner_identity") != patched.get("runner_identity"):
                continue
            baseline_paths = set(_strings(baseline.get("changed_paths"), limit=600))
            if patched_paths and baseline_paths and patched_paths.isdisjoint(baseline_paths):
                continue
            baseline_checks = {
                str(item.get("check_id") or ""): item
                for item in _dicts(baseline.get("checks"))
                if str(item.get("check_id") or "")
            }
            transitions = [
                {
                    "check_id": check_id,
                    "before": str(baseline_checks[check_id].get("status") or "failed"),
                    "after": str(patched_checks[check_id].get("status") or "failed"),
                }
                for check_id in sorted(set(baseline_checks) & set(patched_checks))
                if baseline_checks[check_id].get("status") == "failed"
                and patched_checks[check_id].get("status") == "passed"
            ]
            if not transitions:
                continue
            proof = {
                "mode": "observed_fail_then_pass",
                "confirmed": True,
                "baseline_status": "failed",
                "patched_status": "passed",
                "baseline_run_id": str(baseline.get("run_id") or ""),
                "patched_run_id": str(patched.get("run_id") or ""),
                "baseline_evidence_ref": str(baseline.get("evidence_ref") or ""),
                "patched_evidence_ref": str(patched.get("evidence_ref") or ""),
                "transitions": transitions,
            }
            patched["regression_proof"] = proof
            # Older local-CI receipts could contain a placeholder proof built
            # from an empty object ("failed -> failed").  Once a real pair is
            # found, replace that placeholder on the baseline record as well,
            # so API consumers cannot mistake the expected red run for a
            # failed patched result.
            baseline["regression_proof"] = {
                "mode": "baseline_observation",
                "confirmed": False,
                "baseline_status": "failed",
                "baseline_run_id": str(baseline.get("run_id") or ""),
                "baseline_evidence_ref": str(baseline.get("evidence_ref") or ""),
                "transitions": [],
            }
            baseline["regression_pair"] = {
                "role": "baseline",
                "paired_run_id": str(patched.get("run_id") or ""),
                "confirmed": True,
            }
            patched["regression_pair"] = {
                "role": "patched",
                "paired_run_id": str(baseline.get("run_id") or ""),
                "confirmed": True,
            }
            break
    return result


def _workspace_fingerprint(path: Path) -> str:
    resolved = path.expanduser().resolve()
    return f"sha256:{hashlib.sha256(str(resolved).encode('utf-8')).hexdigest()}"


def _dicts(value: Any) -> List[Dict[str, Any]]:
    return [dict(item) for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _strings(value: Any, *, limit: int) -> List[str]:
    if not isinstance(value, (list, tuple, set)):
        return []
    return list(dict.fromkeys(str(item).strip()[:limit] for item in value if str(item).strip()))


def _redact(text: str) -> str:
    import re

    result = re.sub(r"sk-mem-[A-Za-z0-9_-]+", "[REDACTED]", text, flags=re.I)
    result = re.sub(r"uky-[A-Za-z0-9_-]+", "[REDACTED]", result, flags=re.I)
    return result
