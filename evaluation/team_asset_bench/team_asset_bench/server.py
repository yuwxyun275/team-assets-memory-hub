from __future__ import annotations

import json
import os
import re
import shlex
import hashlib
import hmac
import threading
from collections import Counter
from dataclasses import replace
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import parse_qs, unquote, urlparse
from urllib.request import Request, urlopen

from .catalog import load_assets, load_task, project_root
from .acceptance_planner import AcceptancePlanner
from .attribution import usage_attribution, validation_attribution
from .ci_adapter import LocalCiRunner, ci_observation, normalize_ci_run, pair_sequential_ci_runs
from .completion import (
    AcceptanceContract,
    TaskExecutionEvidence,
    acceptance_contract,
    evaluate_completion,
    render_acceptance_context,
)
from .verification_discovery import DiscoveredTest, discover_verification_plan, map_acceptance_criteria
from .contribution import TrustedEvaluationRegistry
from .ledger import EvidenceLedger, InvalidAssetTransition
from .models import Asset, AssetEvent, AssetState, ContextPackage, Task
from .native_assets import NativeMemoryAssetAdapter
from .observer import CodeBuddyEvidenceObserver
from .orchestrator import TeamAssetOrchestrator
from .runtime_store import RuntimeStore, SqliteEvidenceLedger
from .task_profile import TaskProfiler


class TeamAssetApi:
    def __init__(self, root: Optional[Path] = None, state_db_path: Optional[Path] = None) -> None:
        self.root = root or project_root()
        configured_db = os.environ.get("TEAM_ASSET_STATE_DB", "")
        db_path = state_db_path or (Path(configured_db).expanduser() if configured_db else self.root / "results" / "team-asset-runtime-v2.sqlite3")
        if not db_path.is_absolute():
            db_path = (self.root / db_path).resolve()
        self.state_store = RuntimeStore(db_path)
        self.ledger: EvidenceLedger = SqliteEvidenceLedger(db_path)
        self.orchestrator = TeamAssetOrchestrator(load_assets(self.root), self.ledger)
        self.bindings = _load_bindings(self.root)
        self.hub_authority = HubAuthority.from_environment(self.root)
        self.evidence_observer = CodeBuddyEvidenceObserver(self.ledger)
        self.acceptance_planner = AcceptancePlanner.from_environment()
        self.packages: Dict[str, ContextPackage] = {}
        self.external_bindings: Dict[str, Dict[str, str]] = {}
        self.responses: Dict[str, Dict[str, Any]] = {}
        self.candidates: Dict[str, Dict[str, Any]] = {}
        self.profiles: Dict[str, Dict[str, Any]] = {}
        self.contracts: Dict[str, AcceptanceContract] = {}
        self.executions: Dict[str, TaskExecutionEvidence] = {}
        self.comparisons: Dict[str, Dict[str, Any]] = {}
        self.recovered_traces: set[str] = set()
        self._lock = threading.RLock()
        self.evaluation_registry = TrustedEvaluationRegistry(self.root / "results" / "evaluation-summary.json")
        self._restore_runtime()

    def _restore_runtime(self) -> None:
        for item in self.state_store.load_traces():
            trace_id = item["trace_id"]
            self.packages[trace_id] = item["package"]
            response = item["response"]
            # Re-evaluate repository boundaries when upgrading the runtime.
            # Older receipts classified CodeBuddy's empty conversation folder
            # as a hard mismatch even when the user-selected task carried an
            # exact allow-listed local repository binding.
            stored_scope = response.get("repository_scope") if isinstance(response, dict) else None
            if isinstance(stored_scope, dict):
                expected = str(stored_scope.get("expected_repository") or "").strip()
                workspace = str(stored_scope.get("workspace_root") or "").strip()
                if expected and workspace:
                    response["repository_scope"] = _repository_scope(
                        {"source_url": expected},
                        {"task_source_url": expected, "workspace_root": workspace},
                    )
            self.responses[trace_id] = response
            self.external_bindings[trace_id] = item["external_binding"]
            self.profiles[trace_id] = item["profile"]
            self.contracts[trace_id] = AcceptanceContract.from_dict(item["contract"])
            self.executions[trace_id] = TaskExecutionEvidence.from_dict(item["execution"])
            if item.get("candidate"):
                self.candidates[trace_id] = item["candidate"]
            if item.get("comparison"):
                self.comparisons[trace_id] = item["comparison"]
            self.recovered_traces.add(trace_id)

    def select(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock:
            return self._select(payload)

    def _select(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        task_value = payload.get("task") if isinstance(payload.get("task"), dict) else {}
        default_task = load_task(self.root).to_dict()
        auto_profile = payload.get("auto_profile") is True
        merged_task = {**default_task, **task_value}
        external_binding = {
            "team_id": str(merged_task.get("team_id", "")),
            "agent_id": str(merged_task.get("agent_id", "")),
            "task_id": str(merged_task.get("task_id", "")),
        }
        # Memory Hub generates runtime IDs while the portable benchmark keeps
        # stable logical IDs. Only explicitly registered bindings may cross
        # that boundary; this is not a wildcard ACL bypass.
        for field, table in (("team_id", "teams"), ("agent_id", "agents"), ("task_id", "tasks")):
            value = external_binding[field]
            mapped = self.bindings.get(table, {}).get(value)
            if mapped:
                merged_task[field] = mapped
        requested_trace = str(payload.get("trace_id") or "")
        if requested_trace:
            with self._lock:
                if requested_trace in self.responses:
                    return self.responses[requested_trace]
        authority: Dict[str, Any] = {"mode": "portable_catalog"}
        active_assets = list(self.orchestrator.assets)
        task_detail = (
            dict(payload.get("task_detail") or {})
            if isinstance(payload.get("task_detail"), dict)
            else {}
        )
        # Preferred online path: MemoryProxy asks MemoryCore with the current
        # request's authenticated user key, then passes only the ACL-filtered
        # descriptors.  The orchestrator never receives that key and therefore
        # cannot accidentally rank assets belonging to a demo/service account.
        if "accessible_assets" in payload:
            runtime_assets = [
                item for item in (payload.get("accessible_assets") or [])
                if isinstance(item, dict)
            ]
            live_assets = self._assets_from_hub(runtime_assets)
            active_assets = live_assets
            authority = {
                "mode": "proxy_acl_snapshot",
                "team_id": external_binding["team_id"],
                "accessible_runtime_asset_count": len(runtime_assets),
                "live_content_asset_count": len(live_assets),
                "task_loaded_from_memory_hub": bool(task_detail),
                "native_adapter": "memory-hub-four-source/v1",
                "retrieval": "bm25+sparse-vector+native-signals+graph+rrf",
            }
        elif self.hub_authority is not None:
            runtime_assets = self.hub_authority.accessible_assets(
                external_binding["team_id"],
                external_binding["agent_id"],
            )
            live_assets = self._assets_from_hub(runtime_assets)
            active_assets = live_assets
            task_detail = task_detail or self.hub_authority.get_task(external_binding["task_id"]) or {}
            authority = {
                "mode": "live_memory_hub",
                "team_id": external_binding["team_id"],
                "accessible_runtime_asset_count": len(runtime_assets),
                "live_content_asset_count": len(live_assets),
                "task_loaded_from_memory_hub": bool(task_detail),
                "native_adapter": "memory-hub-four-source/v1",
                "retrieval": "bm25+sparse-vector+native-signals+graph+rrf",
            }
        if payload.get("progressive_disclosure") is True:
            # Budget the advertised card, not an unread 60k-character body.
            # Body remains available to LOCAL retrieval/acceptance analysis;
            # Proxy renders the upstream card and enforces its actual budget.
            active_assets = [replace(asset, token_cost=500,
                injection_mode="reviewed_pointer",
                retrieval_handle={**asset.retrieval_handle, "mode": "reviewed_pointer", "content_included": False})
                for asset in active_assets if asset.injection_mode == "reviewed_snapshot"]
        # Runtime asset descriptors use Memory Hub's team id, while benchmark
        # bindings may map the task onto a portable logical id.  ACL filtering
        # has already proved the external team boundary, so align the in-memory
        # comparison key without altering the asset's runtime id/provenance.
        active_assets = [replace(asset, team_id=str(merged_task.get("team_id") or asset.team_id)) for asset in active_assets]
        profile: Dict[str, Any] = {}
        if auto_profile:
            profiled = TaskProfiler().profile(
                merged_task,
                active_assets,
                task_detail=task_detail,
                query=str(payload.get("current_query") or ""),
                hints=payload.get("fallbacks") if isinstance(payload.get("fallbacks"), dict) else {},
                budget_ceiling=int(payload.get("budget_ceiling") or merged_task.get("token_budget") or 900),
                max_assets_ceiling=int(payload.get("max_assets_ceiling") or merged_task.get("max_assets") or 6),
            )
            task = profiled.task
            profile = profiled.provenance
        else:
            # Portable/offline evaluation keeps its reviewed task contract.
            if not merged_task.get("required_capabilities"):
                merged_task["required_capabilities"] = default_task["required_capabilities"]
            task = Task.from_dict(merged_task)
        contextual_effects = self.state_store.contextual_effects(
            task,
            (asset.asset_id for asset in active_assets),
        )
        orchestrator = TeamAssetOrchestrator(
            active_assets,
            self.ledger,
            historical_effects=contextual_effects,
        )
        package = orchestrator.select(
            task,
            strategy=str(payload.get("strategy", "minimal")),
            excluded_asset_ids=payload.get("excluded_asset_ids", []),
            trace_id=payload.get("trace_id"),
            external_url=str(payload.get("external_url", "http://127.0.0.1:8765")),
        )
        contract = acceptance_contract(task_detail, package)
        repository_context = (
            dict(payload.get("repository_context") or {})
            if isinstance(payload.get("repository_context"), dict)
            else {}
        )
        turn_context = (
            dict(payload.get("turn_context") or {})
            if isinstance(payload.get("turn_context"), dict)
            else {}
        )
        if turn_context.get("active_paths") and not repository_context.get("active_paths"):
            repository_context["active_paths"] = turn_context["active_paths"]
        if task.target_paths and not repository_context.get("target_paths"):
            repository_context["target_paths"] = list(task.target_paths)
        plan = self.acceptance_planner.plan(
            task,
            [item.asset for item in package.selected],
            repository_context=repository_context,
        )
        # A task owner's confirmed contract is authoritative.  Otherwise the
        # per-turn contextual planner replaces the old title/description-only
        # suggestion with an asset- and repository-grounded proposal.
        if contract.criteria_status not in {"confirmed", "not_required"} and plan.criteria:
            suggestions = [item.text for item in plan.criteria]
            contract = replace(
                contract,
                criteria=suggestions,
                suggested_criteria=suggestions,
                criteria_status="proposed",
                generated_by=plan.generated_by,
                source="codebuddy_contextual_acceptance_plan",
                verification_policy="trusted_ci",
            )
        acceptance_markdown = render_acceptance_context(contract)
        if acceptance_markdown:
            package.markdown = "\n\n".join(
                part for part in (package.markdown, acceptance_markdown) if part
            )
        repository_scope = _repository_scope(task_detail, repository_context)
        package.markdown = "\n\n".join(
            part for part in (package.markdown, _render_repository_scope(repository_scope)) if part
        )
        result = package.to_dict()
        result["acceptance_contract"] = contract.to_dict()
        result["acceptance_plan"] = plan.to_dict()
        result["repository_scope"] = repository_scope
        # Keep a content-hash-only baseline so an independent local runner can
        # detect repository edits even when a coding client omits its edit tool
        # call from the OpenAI-compatible history. Source contents never enter
        # the receipt or model context.
        result["_runtime_repository_snapshot"] = _repository_snapshot(repository_scope)
        logical_to_runtime = {
            logical_id: runtime_id for runtime_id, logical_id in self.bindings.get("assets", {}).items()
        }
        for group in ("recalled", "selected", "rejected"):
            for selection in result[group]:
                logical_id = str(selection["asset"]["asset_id"])
                runtime_id = str(
                    selection["asset"].get("runtime_asset_id")
                    or logical_to_runtime.get(logical_id)
                    or ""
                )
                if runtime_id:
                    selection["asset"]["runtime_asset_id"] = runtime_id
        result["asset_authority"] = authority
        result["task_profile"] = profile
        result["contextual_feedback"] = {
            "applied": bool(contextual_effects),
            "asset_effects": contextual_effects,
            "scope": "repository+version+task_type+module_with_decay",
        }
        if any(
            external_binding[field] != result["task"][field]
            for field in ("team_id", "agent_id", "task_id")
        ):
            result["external_binding"] = external_binding
        self.packages[package.trace_id] = package
        self.external_bindings[package.trace_id] = external_binding
        self.profiles[package.trace_id] = profile
        self.contracts[package.trace_id] = contract
        self.executions[package.trace_id] = TaskExecutionEvidence()
        self.responses[package.trace_id] = result
        self._persist_trace(package.trace_id)
        self._publish_trace(package.trace_id)
        return result

    def recommend_turn(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Select a fresh minimal context for one human conversation turn."""
        with self._lock:
            session_id = str(payload.get("session_id") or "").strip()
            if not session_id:
                raise ValueError("session_id is required")
            turn_seq = max(1, int(payload.get("turn_seq") or 1))
            task_value = dict(payload.get("task") or {}) if isinstance(payload.get("task"), dict) else {}
            team_id = str(task_value.get("team_id") or payload.get("team_id") or "").strip()
            agent_id = str(task_value.get("agent_id") or payload.get("agent_id") or "").strip()
            if not team_id or not agent_id:
                raise ValueError("team_id and agent_id are required for team asset ACL")
            digest = hashlib.sha256(f"{session_id}\0{turn_seq}".encode("utf-8")).hexdigest()[:20]
            turn_id = f"turn-{digest}"
            trace_id = f"trace-team-assets-turn-{digest}"
            query = _redact_business_secrets(str(payload.get("current_query") or "").strip())
            if not query:
                raise ValueError("current_query is required")
            task_id = str(task_value.get("task_id") or payload.get("task_id") or "").strip()
            if not task_id:
                task_id = f"session-task-{hashlib.sha256(session_id.encode('utf-8')).hexdigest()[:16]}"

            self._close_prior_turns(session_id, turn_seq)
            task_value.update({
                "team_id": team_id,
                "agent_id": agent_id,
                "task_id": task_id,
                "title": str(task_value.get("title") or f"CodeBuddy 第 {turn_seq} 轮动态任务"),
                "description": str(task_value.get("description") or query),
            })
            turn_context = dict(payload.get("turn_context") or {}) if isinstance(payload.get("turn_context"), dict) else {}
            active_paths = _string_list(turn_context.get("active_paths"), 12, 600)
            errors = _string_list(turn_context.get("errors"), 6, 600)
            recent_summary = _redact_business_secrets(str(turn_context.get("recent_summary") or ""))[:600]
            retrieval_query = "\n".join(filter(None, [
                query,
                f"当前活动代码：{'，'.join(active_paths)}" if active_paths else "",
                f"最近工具错误：{'；'.join(errors)}" if errors else "",
                f"近期会话摘要：{recent_summary}" if recent_summary and recent_summary != query else "",
            ]))
            fallbacks = dict(payload.get("fallbacks") or {}) if isinstance(payload.get("fallbacks"), dict) else {}
            if active_paths:
                fallbacks["target_paths"] = active_paths
            result = self._select({
                **payload,
                "trace_id": trace_id,
                "task": task_value,
                "auto_profile": True,
                "current_query": retrieval_query,
                "fallbacks": fallbacks,
                "strategy": str(payload.get("strategy") or "minimal"),
            })
            self.state_store.save_turn({
                "turn_id": turn_id,
                "trace_id": trace_id,
                "session_id": session_id,
                "turn_seq": turn_seq,
                "task_id": task_id,
                "team_id": team_id,
                "agent_id": agent_id,
                "query_hash": f"sha256:{hashlib.sha256(query.encode('utf-8')).hexdigest()}",
                "query_preview": query[:240],
                "context": {
                    "active_paths": active_paths,
                    "errors": errors,
                    "recent_summary": recent_summary,
                    "task_optional": str(payload.get("task_id") or task_value.get("task_id") or "").startswith("session-task-"),
                },
            })
            result["turn"] = {
                "turn_id": turn_id,
                "session_id": session_id,
                "turn_seq": turn_seq,
                "query_preview": query[:240],
                "dynamic_retrieval": True,
            }
            self.responses[trace_id] = result
            receipt = self._publish_trace(trace_id)
            result["turn_receipt"] = {
                "summary": receipt.get("summary", {}),
                "feedback": receipt.get("feedback", []),
            }
            self._persist_trace(trace_id)
            return result

    def record_feedback(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock:
            trace_id = str(payload.get("trace_id") or "")
            turn = self.state_store.turn_for_trace(trace_id)
            package = self.packages.get(trace_id)
            if turn is None or package is None:
                raise ValueError("unknown turn trace_id")
            asset_id = str(payload.get("asset_id") or "")
            selected = {item.asset.asset_id for item in package.selected}
            runtime_to_logical = _runtime_asset_bindings(package, self.bindings)
            asset_id = runtime_to_logical.get(asset_id, asset_id)
            if asset_id not in selected:
                raise ValueError("feedback asset must belong to the selected turn context")
            raw_signal = str(payload.get("signal") or "").lower()
            aliases = {"accepted": "useful", "corrected": "incorrect"}
            signal = aliases.get(raw_signal, raw_signal)
            # Absence of observed use is not proof of low utility. Only an
            # explicit, reasoned judgement is allowed to meaningfully change
            # future ranking; an implicit turn close is retained for audit but
            # has zero learning weight.
            weights = {
                "useful": 0.8,
                "not_applicable": -0.08,
                "duplicate": -0.18,
                "ignored": -0.03,
                "stale": -1.0,
                "incorrect": -2.0,
                "unobserved": 0.0,
            }
            if signal not in weights:
                raise ValueError(
                    "signal must be useful, not_applicable, duplicate, ignored, stale, incorrect, or unobserved"
                )
            reason = _redact_business_secrets(str(payload.get("reason") or ""))[:1200]
            if signal in {"stale", "incorrect"} and not reason:
                raise ValueError(f"{signal} feedback requires a reason")
            appended = self._append_feedback(
                turn,
                package,
                asset_id=asset_id,
                signal=signal,
                source=(
                    "explicit_user"
                    if str(payload.get("actor_type") or "").lower() == "user"
                    else "explicit_agent"
                ),
                weight=weights[signal],
                reason=reason,
                evidence_ref=str(payload.get("evidence_ref") or "") or None,
            )
            if signal == "incorrect":
                latest = self.ledger.latest_state(trace_id, package.task.task_id, asset_id)
                if latest is not AssetState.CORRECTED:
                    self.ledger.append(
                        trace_id=trace_id,
                        task_id=package.task.task_id,
                        asset_id=asset_id,
                        state=AssetState.CORRECTED,
                        actor_type="user",
                        actor_id=str(payload.get("actor_id") or package.task.agent_id),
                        target=str(payload.get("target") or "asset_recommendation"),
                        decision=reason,
                        evidence_ref=str(payload.get("evidence_ref") or "") or None,
                        detail={"feedback": "explicit_incorrect", "scope": "current_context"},
                    )
            receipt = self._publish_trace(trace_id)
            return {"appended": appended, "trace_id": trace_id, "feedback": receipt.get("feedback", [])}

    def record_ci_run(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock:
            run = normalize_ci_run(payload)
            trace_id = str(run["trace_id"])
            package = self.packages.get(trace_id)
            if package is None:
                raise ValueError("unknown trace_id for CI run")
            turn = self.state_store.turn_for_trace(trace_id)
            if turn is not None:
                run["turn_id"] = turn["turn_id"]
            contract = self.contracts.get(trace_id) or acceptance_contract({}, package)
            discovery = dict(run.get("verification_discovery") or {})
            repository_discovery = bool(
                discovery.get("schema_version") == "team-asset-verification-discovery/v1"
                and str(discovery.get("workspace_fingerprint") or "").startswith("sha256:")
            )
            coverage = list(discovery.get("acceptance_coverage") or [])
            if not coverage and contract.criteria:
                discovered = [
                    DiscoveredTest(
                        test_id=test_id,
                        path="",
                        framework=str(run.get("provider") or "ci"),
                        target_paths=list(contract.target_paths),
                        confidence=0.6,
                        reason="测试 ID 来自可信 CI 结果",
                    )
                    for test_id in dict.fromkeys(
                        test_id
                        for check in run.get("checks") or []
                        if isinstance(check, dict)
                        for test_id in check.get("test_ids") or []
                        if str(test_id)
                    )
                ]
                coverage = map_acceptance_criteria(contract.criteria, discovered)
                discovery["schema_version"] = discovery.get("schema_version") or "team-asset-verification-discovery/v1"
                discovery["acceptance_coverage"] = coverage
                run["verification_discovery"] = discovery
            if run.get("trusted_for_validation") is True and coverage and repository_discovery:
                self._merge_ci_discovery_into_plan(trace_id, coverage)
                discovered_test_ids = list(dict.fromkeys(
                    str(test_id)
                    for check in run.get("checks") or []
                    if isinstance(check, dict)
                    for test_id in check.get("test_ids") or []
                    if str(test_id)
                ))
                # Asset metadata supplies useful historical test hints, but it
                # is not the task owner's immutable contract. For an inferred
                # contract, the allowlisted independent runner's actual test
                # inventory is the authoritative engineering check set.
                if (
                    discovered_test_ids
                    and repository_discovery
                    and contract.source != "memory_hub_task.metadata_json.team_asset_acceptance"
                ):
                    contract = replace(
                        contract,
                        required_tests=discovered_test_ids,
                        source="trusted_ci_repository_discovery",
                    )
                    self.contracts[trace_id] = contract
                    response = self.responses.get(trace_id)
                    if isinstance(response, dict):
                        response["acceptance_contract"] = contract.to_dict()
            inserted = self.state_store.save_ci_run(run)
            if inserted and run.get("trusted_for_validation") is True:
                declarations = [
                    {
                        "criterion_id": str(item.get("criterion_id") or ""),
                        "mode": "automated",
                        "test_ids": list(item.get("mapped_test_ids") or []),
                        "targets": list(contract.target_paths),
                        "note": str(item.get("reason") or "仓库测试静态映射"),
                        "mapping_source": "repository_test_discovery",
                    }
                    for item in coverage
                    if isinstance(item, dict) and item.get("mapped_test_ids")
                ]
                normalized = {
                    "trace_id": trace_id,
                    "actor_id": "independent-ci-validator",
                    "evidence_origin": "trusted_ci",
                    "acceptance_declarations": declarations,
                    **ci_observation(run),
                }
                execution = self.executions.setdefault(trace_id, TaskExecutionEvidence())
                execution.observe(normalized)
                self.evidence_observer.observe(
                    package,
                    execution.observer_payload(actor_id="independent-ci-validator"),
                )
            receipt = self._publish_trace(trace_id)
            return {
                "inserted": inserted,
                "trusted_for_validation": run.get("trusted_for_validation") is True,
                "run": run,
                "receipt": receipt,
            }

    def _merge_ci_discovery_into_plan(
        self,
        trace_id: str,
        coverage: list[Dict[str, Any]],
    ) -> None:
        """Hydrate plan candidates with tests discovered by the trusted runner."""
        response = self.responses.get(trace_id)
        if not isinstance(response, dict):
            return
        raw_plan = response.get("acceptance_plan")
        if not isinstance(raw_plan, dict):
            return
        by_id = {
            str(item.get("criterion_id") or ""): item
            for item in coverage
            if isinstance(item, dict) and item.get("criterion_id")
        }
        criteria: list[Dict[str, Any]] = []
        for raw in raw_plan.get("criteria") or []:
            if not isinstance(raw, dict):
                continue
            item = dict(raw)
            mapped = by_id.get(str(item.get("criterion_id") or ""))
            if mapped is not None:
                discovered = _string_list(mapped.get("mapped_test_ids"), 100, 300)
                item["candidate_test_ids"] = list(dict.fromkeys([
                    *_string_list(item.get("candidate_test_ids"), 100, 300),
                    *discovered,
                ]))
            criteria.append(item)
        plan = dict(raw_plan)
        plan["criteria"] = criteria
        plan["coverage"] = coverage
        plan["context_sources"] = list(dict.fromkeys([
            *(plan.get("context_sources") or []),
            "trusted_ci_repository_discovery",
        ]))
        response["acceptance_plan"] = plan

    def session_receipt(self, session_id: str) -> Dict[str, Any]:
        turns = self.state_store.list_turns(session_id=session_id)
        if not turns:
            raise ValueError("unknown session_id")
        latest = next((item["receipt"] for item in reversed(turns) if item.get("receipt")), {}) or {}
        return self._aggregate_turn_receipts(session_id, turns, latest)

    def _close_prior_turns(self, session_id: str, current_turn_seq: int) -> None:
        for turn in self.state_store.list_turns(session_id=session_id):
            if turn["turn_seq"] >= current_turn_seq or turn["status"] == "closed":
                continue
            package = self.packages.get(turn["trace_id"])
            if package is None:
                continue
            for selection in package.selected:
                latest = self.ledger.latest_state(
                    package.trace_id, package.task.task_id, selection.asset.asset_id
                )
                if latest in {AssetState.SELECTED, AssetState.INJECTED}:
                    self._append_feedback(
                        turn,
                        package,
                        asset_id=selection.asset.asset_id,
                        signal="unobserved",
                        source="implicit_turn_close",
                        weight=0.0,
                        reason="进入下一轮时仍未观察到该资产影响代码、工具或验证动作",
                    )
            self.state_store.close_turn(turn["turn_id"])
            self._publish_trace(turn["trace_id"])

    def _append_feedback(
        self,
        turn: Dict[str, Any],
        package: ContextPackage,
        *,
        asset_id: str,
        signal: str,
        source: str,
        weight: float,
        reason: str,
        evidence_ref: Optional[str] = None,
    ) -> bool:
        module = "*"
        if package.task.target_paths:
            module = package.task.target_paths[0].split("/", 1)[0] or "*"
        return self.state_store.append_feedback({
            "turn_id": turn["turn_id"],
            "trace_id": package.trace_id,
            "asset_id": asset_id,
            "signal": signal,
            "source": source,
            "weight": weight,
            "repository": package.task.repository,
            "version": package.task.version,
            "task_type": package.task.task_type,
            "module": module,
            "reason": reason,
            "evidence_ref": evidence_ref,
        })

    def _aggregate_turn_receipts(
        self,
        session_id: str,
        turns: list[Dict[str, Any]],
        latest: Dict[str, Any],
    ) -> Dict[str, Any]:
        summaries = []
        aggregate = Counter()
        receipts: list[Dict[str, Any]] = []
        for turn in turns:
            receipt = turn.get("receipt") or {}
            if receipt:
                receipts.append(receipt)
            aggregate.update(receipt.get("summary") or {})
            feedback = self.state_store.feedback_for_turn(turn["turn_id"])
            summaries.append({
                "turn_id": turn["turn_id"],
                "trace_id": turn["trace_id"],
                "turn_seq": turn["turn_seq"],
                "query_preview": turn["query_preview"],
                "status": turn["status"],
                "summary": receipt.get("summary") or {},
                "selected_assets": [
                    {
                        "asset_id": item.get("asset_id"),
                        "title": item.get("title"),
                        "source_type": item.get("source_type"),
                        "states": item.get("states") or [],
                    }
                    for item in receipt.get("assets") or []
                ],
                "feedback": [
                    {
                        "asset_id": item.get("asset_id"),
                        "signal": item.get("signal"),
                        "source": item.get("source"),
                        "reason": item.get("reason"),
                    }
                    for item in feedback
                ],
                "ci_runs": receipt.get("ci_runs") or [],
                "acceptance_plan": receipt.get("acceptance_plan") or {},
            })
        # A status-only follow-up (for example, "完成了吗") is still a real
        # retrieval turn, but it must not erase the edit/test/CI evidence from
        # the immediately preceding execution turn.  Keep the latest turn in
        # the timeline while using the latest receipt that actually contains
        # engineering evidence as the task-level projection.
        active = _authoritative_session_receipt(receipts, latest)
        return {
            **active,
            "schema_version": "memory-hub-turn-asset-evidence/v4",
            "session_id": session_id,
            "latest_turn": summaries[-1] if summaries else None,
            "active_evidence_trace_id": str(active.get("trace_id") or ""),
            "last_verified_trace_id": next((str(r.get("trace_id") or "") for r in reversed(receipts)
                if (r.get("completion") or {}).get("task_completed") is True), ""),
            "latest_trace_id": str((latest or {}).get("trace_id") or ""),
            "turns": summaries,
            "session_summary": dict(aggregate),
            "dynamic_retrieval": True,
        }

    def confirm_injected(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Advance selected assets only after MemoryProxy applied their block."""
        with self._lock:
            return self._confirm_injected(payload)

    def _confirm_injected(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        trace_id = str(payload.get("trace_id", ""))
        package = self.packages.get(trace_id)
        if package is None:
            raise ValueError("unknown trace_id; select context before confirming injection")
        runtime_to_logical = _runtime_asset_bindings(package, self.bindings)
        requested = {
            runtime_to_logical.get(str(asset_id), str(asset_id))
            for asset_id in payload.get("asset_ids", [])
        }
        selected = {item.asset.asset_id: item.asset for item in package.selected}
        context_hash = str(payload.get("context_hash") or "")
        if not context_hash.startswith("sha256:"):
            raise ValueError("context_hash must be a sha256 reference")
        appended = []
        for asset_id in sorted(requested & set(selected)):
            if self.ledger.latest_state(trace_id, package.task.task_id, asset_id) is not AssetState.SELECTED:
                continue
            event = self.ledger.append(
                trace_id=trace_id,
                task_id=package.task.task_id,
                asset_id=asset_id,
                state=AssetState.INJECTED,
                actor_type="proxy",
                actor_id="memory-proxy",
                evidence_ref=context_hash,
                detail={
                    "protocol": str(payload.get("protocol") or "unknown")[:40],
                    "injection_point": str(payload.get("injection_point") or "unknown")[:120],
                    "request_trace_id": str(payload.get("request_trace_id") or "")[:160],
                    "token_cost": selected[asset_id].token_cost,
                    "confirmation": "post_apply_callback",
                },
            )
            appended.append(event.to_dict())
        receipt = self._publish_trace(trace_id)
        return {
            "trace_id": trace_id,
            "events_appended": appended,
            "summary": receipt.get("summary", {}),
        }

    def append_event(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock:
            return self._append_event(payload)

    def _append_event(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        event = self.ledger.append(
            trace_id=str(payload["trace_id"]),
            task_id=str(payload["task_id"]),
            asset_id=str(payload["asset_id"]),
            state=AssetState(str(payload["state"])),
            actor_type=str(payload.get("actor_type", "agent")),
            actor_id=str(payload.get("actor_id", "unknown")),
            target=payload.get("target"),
            decision=payload.get("decision"),
            evidence_ref=payload.get("evidence_ref"),
            detail=payload.get("detail") or {},
        )
        self._publish_trace(event.trace_id)
        return event.to_dict()

    def observe(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock:
            return self._observe(payload)

    def _observe(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        trace_id = str(payload.get("trace_id", ""))
        package = self.packages.get(trace_id)
        if package is None:
            raise ValueError("unknown trace_id; select context before observing evidence")
        runtime_to_logical = _runtime_asset_bindings(package, self.bindings)
        normalized = dict(payload)
        declarations = []
        for item in payload.get("declarations", []):
            if not isinstance(item, dict):
                continue
            value = dict(item)
            asset_id = str(value.get("asset_id", ""))
            value["asset_id"] = runtime_to_logical.get(asset_id, asset_id)
            declarations.append(value)
        normalized["declarations"] = declarations
        response = self.responses.get(trace_id) or {}
        scope = response.get("repository_scope") or {}
        normalized = _normalize_observation_paths(normalized, scope)
        plan_updated = self._apply_codebuddy_acceptance_plan(package, normalized)
        execution = self.executions.setdefault(trace_id, TaskExecutionEvidence())
        execution.observe(normalized)
        # Attribution inputs are durable. Replaying the accumulated sanitized
        # state makes a process restart harmless and joins a later tool result
        # with the original call that produced it.
        events = self.evidence_observer.observe(
            package,
            execution.observer_payload(
                actor_id=str(normalized.get("actor_id") or package.task.agent_id)
            ),
        )
        try:
            local_ci = self._maybe_run_local_ci(package, normalized, execution)
        except Exception as exc:  # CI is an independent verifier, never the request path.
            local_ci = {
                "status": "error",
                "reason": _redact_business_secrets(str(exc))[:600],
            }
        receipt = self._publish_trace(trace_id)
        return {
            "trace_id": trace_id,
            "events_appended": [event.to_dict() for event in events],
            "acceptance_plan_updated": plan_updated,
            "local_ci": local_ci,
            "summary": receipt.get("summary", {}),
        }

    def _maybe_run_local_ci(
        self,
        package: ContextPackage,
        payload: Dict[str, Any],
        execution: TaskExecutionEvidence,
    ) -> Optional[Dict[str, Any]]:
        """Run an operator-approved local CI profile after an observed edit/test.

        This is a development substitute for a signed GitHub/GitLab/Jenkins
        webhook.  It is disabled by default, requires an exact repository
        binding plus an operator allow-list, and never executes a command
        supplied by the model.
        """
        if not _truthy(os.environ.get("TEAM_ASSET_LOCAL_CI_AUTO", "")):
            return None
        response = self.responses.get(package.trace_id) or {}
        scope = response.get("repository_scope") or {}
        execution_root = str(scope.get("execution_root") or "").strip() if isinstance(scope, dict) else ""
        workspace_value = execution_root or str(payload.get("workspace_root") or "").strip()
        # Local CI is the independent verifier: it must not depend on the
        # coding model first claiming that its own tests passed. Wait for an
        # observed edit and either the final asset-use declaration or a test
        # attempt, then execute only the operator-reviewed manifest.
        has_final_declaration = bool(payload.get("declarations")) or bool(execution.asset_declarations)
        has_test_attempt = any(
            isinstance(item, dict) and str(item.get("kind") or "") == "test"
            for item in payload.get("tool_calls", [])
        ) or any(
            str(item.get("kind") or "") == "test"
            for item in execution.observed_tool_calls.values()
        ) or bool(execution.tests)
        if not workspace_value or not (has_final_declaration or has_test_attempt):
            return None
        try:
            workspace = Path(workspace_value).expanduser().resolve()
        except (OSError, RuntimeError):
            return {"status": "skipped", "reason": "workspace_path_invalid"}
        if not workspace.is_dir():
            return {"status": "skipped", "reason": "workspace_missing"}

        if not isinstance(scope, dict) or scope.get("status") not in {"matched_local_path", "matched_task_binding"}:
            return {"status": "skipped", "reason": "repository_binding_not_exact"}
        if not _path_is_allowed(workspace, os.environ.get("TEAM_ASSET_LOCAL_CI_ALLOWED_ROOTS", "")):
            return {"status": "skipped", "reason": "workspace_not_allowlisted"}

        if not execution.changed_paths:
            baseline = response.get("_runtime_repository_snapshot")
            detected_paths = _repository_changes(
                workspace,
                baseline if isinstance(baseline, dict) else {},
            )
            if detected_paths:
                execution.changed_paths = detected_paths
        if not execution.changed_paths:
            return {"status": "skipped", "reason": "code_change_not_observed"}

        contract = self.contracts.get(package.trace_id) or acceptance_contract({}, package)
        manifest_path_value = os.environ.get("TEAM_ASSET_LOCAL_CI_MANIFEST", "").strip()
        discovery = None
        if manifest_path_value:
            manifest_path = Path(manifest_path_value).expanduser()
            if not manifest_path.is_absolute():
                manifest_path = (self.root / manifest_path).resolve()
            manifest = _load_reviewed_ci_manifest(manifest_path, workspace)
            manifest_identity = str(manifest_path)
        elif _truthy(os.environ.get("TEAM_ASSET_LOCAL_CI_DISCOVER", "")):
            discovery = discover_verification_plan(
                workspace,
                changed_paths=execution.changed_paths,
                acceptance_criteria=contract.criteria,
            )
            manifest = discovery.to_manifest()
            manifest_identity = discovery.workspace_fingerprint
        else:
            return {"status": "skipped", "reason": "reviewed_manifest_not_configured"}
        if not manifest.get("checks"):
            return {"status": "skipped", "reason": "no_reviewed_checks"}

        run_fingerprint = _local_ci_run_fingerprint(
            workspace,
            execution.changed_paths,
            manifest_identity,
        )
        if any(
            str(item.get("provider_event_id") or "") == run_fingerprint
            for item in self.state_store.ci_runs(package.trace_id)
        ):
            return {"status": "unchanged", "provider_event_id": run_fingerprint}

        run = LocalCiRunner(
            workspace,
            timeout_seconds=int(os.environ.get("TEAM_ASSET_LOCAL_CI_TIMEOUT_SECONDS", "120")),
        ).run_manifest(
            manifest,
            trace_id=package.trace_id,
            changed_paths=execution.changed_paths,
        )
        run["provider_event_id"] = run_fingerprint
        if discovery is not None:
            run["verification_discovery"] = discovery.to_dict()
        recorded = self.record_ci_run(run)
        return {
            "status": str(recorded["run"].get("status") or "failed"),
            "run_id": recorded["run"].get("run_id"),
            "trusted_for_validation": recorded["trusted_for_validation"],
            "provider_event_id": run_fingerprint,
        }

    def _apply_codebuddy_acceptance_plan(
        self,
        package: ContextPackage,
        payload: Dict[str, Any],
    ) -> bool:
        raw_plan = payload.get("codebuddy_acceptance_plan")
        if not isinstance(raw_plan, dict):
            return False
        contract = self.contracts.get(package.trace_id) or acceptance_contract({}, package)
        if contract.criteria_status in {"confirmed", "not_required"}:
            return False
        raw_criteria = raw_plan.get("criteria")
        if not isinstance(raw_criteria, list):
            return False

        selected = {item.asset.asset_id: item.asset for item in package.selected}
        known_paths = set(package.task.target_paths)
        known_paths.update(path for asset in selected.values() for path in asset.paths)
        known_tests = {test for asset in selected.values() for test in asset.tests}
        execution = self.executions.get(package.trace_id)
        if execution is not None:
            known_paths.update(execution.changed_paths)
            known_tests.update(execution.tests)
            known_tests.update(execution.independent_tests)
            for call in execution.observed_tool_calls.values():
                known_paths.update(_string_list(call.get("changed_paths"), 40, 600))
                known_tests.update(_string_list(call.get("test_ids"), 100, 300))
        for call in payload.get("tool_calls") or []:
            if not isinstance(call, dict):
                continue
            known_paths.update(_string_list(call.get("changed_paths"), 40, 600))
            target = str(call.get("target") or "").strip()
            if target:
                known_paths.add(target[:600])
            known_tests.update(_string_list(call.get("test_ids"), 100, 300))
        for result in payload.get("tool_results") or []:
            if isinstance(result, dict):
                known_tests.update(_string_list(result.get("test_ids"), 100, 300))

        criteria: list[Dict[str, Any]] = []
        seen: set[str] = set()
        for raw in raw_criteria[:8]:
            if not isinstance(raw, dict):
                continue
            text = _redact_business_secrets(str(raw.get("text") or "").strip())[:1200]
            fingerprint = re.sub(r"\W+", "", text).lower()
            if not text or not fingerprint or fingerprint in seen:
                continue
            seen.add(fingerprint)
            source_ids = [
                asset_id
                for asset_id in _string_list(raw.get("source_asset_ids"), 12, 160)
                if asset_id in selected
            ]
            target_paths = [
                path
                for path in _string_list(raw.get("target_paths"), 20, 600)
                if path in known_paths
            ]
            test_ids = [
                test_id
                for test_id in _string_list(raw.get("candidate_test_ids"), 60, 300)
                if test_id in known_tests
            ]
            criteria.append({
                "criterion_id": f"criterion-{len(criteria) + 1}",
                "text": text,
                "category": str(raw.get("category") or "business")[:80],
                "rationale": _redact_business_secrets(str(raw.get("rationale") or "CodeBuddy 根据真实代码与测试修订"))[:1200],
                "source_asset_ids": source_ids,
                "source_titles": [selected[item].title for item in source_ids],
                "target_paths": target_paths,
                "candidate_test_ids": test_ids,
                "verification_method": "trusted_ci_test" if test_ids else "new_test_or_manual_confirmation",
                "confidence": 0.82 if source_ids and test_ids else 0.68,
            })
        if not criteria:
            return False

        suggestions = [item["text"] for item in criteria]
        self.contracts[package.trace_id] = replace(
            contract,
            criteria=suggestions,
            suggested_criteria=suggestions,
            criteria_status="proposed",
            generated_by="codebuddy-in-session/acceptance-planner-v1",
            source="codebuddy_real_context_acceptance_plan",
            verification_policy="trusted_ci",
        )
        response = self.responses.setdefault(package.trace_id, package.to_dict())
        previous = response.get("acceptance_plan")
        plan = dict(previous) if isinstance(previous, dict) else {}
        # Criterion IDs are positional. When the model replaces a proposal,
        # old declarations must not attest a different criterion at that ID.
        if execution is not None:
            prior = {item.get("criterion_id"): item for item in plan.get("criteria", []) if isinstance(item, dict)}
            for criterion_id in list(execution.acceptance_declarations):
                current = next((item for item in criteria if item["criterion_id"] == criterion_id), None)
                old = prior.get(criterion_id)
                if current is None or old is None or any(
                    old.get(key) != current.get(key)
                    for key in ("text", "source_asset_ids", "target_paths", "candidate_test_ids")
                ):
                    execution.acceptance_declarations.pop(criterion_id, None)
        plan.update({
            "schema_version": "team-asset-acceptance-plan/v1",
            "status": "proposed",
            "generated_by": "codebuddy-in-session/acceptance-planner-v1",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "criteria": criteria,
            "coverage": [
                {
                    "criterion_id": item["criterion_id"],
                    "text": item["text"],
                    "status": "mapped_candidate" if item["candidate_test_ids"] else "coverage_gap",
                    "mapped_test_ids": item["candidate_test_ids"],
                    "mapped_test_paths": [],
                    "confidence": item["confidence"],
                    "reason": (
                        "CodeBuddy 根据真实代码/测试建立候选映射，仍需可信 CI 执行"
                        if item["candidate_test_ids"]
                        else "尚无可信自动化测试覆盖"
                    ),
                }
                for item in criteria
            ],
            "context_sources": list(dict.fromkeys([
                *(plan.get("context_sources") or []),
                "codebuddy_current_turn",
            ])),
            "safety": {
                "planner_can_validate": False,
                "requires_trusted_ci": True,
                "external_model_used": True,
            },
        })
        response["acceptance_plan"] = plan
        response["acceptance_contract"] = self.contracts[package.trace_id].to_dict()
        self.responses[package.trace_id] = response
        return True

    def contribute(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Compatibility endpoint: clients cannot assert contribution.

        Contribution is a derived state. The server recomputes it from the
        task acceptance contract and a matching trusted counterfactual record;
        caller-provided paths or deltas are intentionally ignored.
        """
        with self._lock:
            trace_id = str(payload.get("trace_id", ""))
            package = self.packages.get(trace_id)
            if package is None:
                raise ValueError("unknown trace_id")
            receipt = self._publish_trace(trace_id)
            return {
                "trace_id": trace_id,
                "events_appended": [],
                "manual_contribution_disabled": True,
                "comparison": receipt.get("comparison", {}),
                "summary": receipt.get("summary", {}),
            }

    def receipt(self, trace_id: str) -> Dict[str, Any]:
        if trace_id not in self.packages:
            raise ValueError("unknown trace_id")
        return self._publish_trace(trace_id)

    def _persist_trace(self, trace_id: str) -> None:
        package = self.packages.get(trace_id)
        response = self.responses.get(trace_id)
        if package is None or response is None:
            return
        contract = self.contracts.get(trace_id) or acceptance_contract({}, package)
        execution = self.executions.get(trace_id) or TaskExecutionEvidence()
        self.state_store.save_trace(
            trace_id,
            package=package,
            response=response,
            external_binding=self.external_bindings.get(trace_id, {}),
            profile=self.profiles.get(trace_id, {}),
            contract=contract.to_dict(),
            execution=execution.to_dict(),
            candidate=self.candidates.get(trace_id),
            comparison=self.comparisons.get(trace_id),
        )

    def _reconcile_asset_evidence(
        self,
        package: ContextPackage,
        execution: TaskExecutionEvidence,
    ) -> None:
        """Join asset-backed planning with immutable CI observations.

        A coding model is not required to print internal JSON into its answer.
        When the task's acceptance plan names an asset, and a trusted CI run
        later observes the corresponding code path or exact test, that pair is
        sufficient for a conservative ``used`` edge. ``validated`` still
        requires a successful, explicitly named CI test.
        """
        response = self.responses.get(package.trace_id) or {}
        for run in self.state_store.ci_runs(package.trace_id):
            if run.get("trusted_for_validation") is not True:
                continue
            declarations = _asset_declarations_from_plan(package, response, run)
            if not declarations:
                continue
            normalized = {
                "trace_id": package.trace_id,
                "actor_id": "independent-ci-validator",
                "evidence_origin": "trusted_ci",
                "declarations": declarations,
                **ci_observation(run),
            }
            execution.observe(normalized)
            self.evidence_observer.observe(
                package,
                execution.observer_payload(actor_id="independent-ci-validator"),
            )

    def _assets_from_hub(self, items: list[Dict[str, Any]]) -> list[Asset]:
        return NativeMemoryAssetAdapter().adapt_many(items)

    def _publish_trace(self, trace_id: str) -> Dict[str, Any]:
        with self._lock:
            package = self.packages.get(trace_id)
            if package is None:
                return {}
            contract = self.contracts.get(trace_id) or acceptance_contract({}, package)
            execution = self.executions.get(trace_id) or TaskExecutionEvidence()
            self._reconcile_asset_evidence(package, execution)
            completion = evaluate_completion(package, self.ledger, contract, execution)

            # Contribution is computed, never accepted from the agent/client.
            comparison = self.evaluation_registry.finalize(package, self.ledger, completion)
            self.comparisons[trace_id] = comparison

            # Re-read after finalization so this receipt reflects newly derived
            # contributed events in the same publication cycle.
            events = self.ledger.events(trace_id=trace_id, task_id=package.task.task_id)
            by_asset: Dict[str, list[Any]] = {}
            for event in events:
                by_asset.setdefault(event.asset_id, []).append(event)
            logical_to_runtime = {
                logical: runtime for runtime, logical in self.bindings.get("assets", {}).items()
            }
            assets = []
            counts = Counter()
            for selection in package.selected:
                asset = selection.asset
                asset_events = by_asset.get(asset.asset_id, [])
                states = [event.state.value for event in asset_events]
                counts.update(set(states))
                used = next((event for event in asset_events if event.state is AssetState.USED), None)
                validated = next((event for event in asset_events if event.state is AssetState.VALIDATED), None)
                contributed = next((event for event in asset_events if event.state is AssetState.CONTRIBUTED), None)
                attribution = _receipt_attribution(asset, used, validated)
                assets.append(
                    {
                        "asset_id": asset.asset_id,
                        "runtime_asset_id": asset.runtime_asset_id or logical_to_runtime.get(asset.asset_id),
                        "title": asset.title,
                        "source_type": asset.source_type.value,
                        "asset_type": asset.asset_type.value,
                        "contributor": asset.contributor,
                        "source_ref": asset.source_ref,
                        "version": asset.version,
                        "updated_at": asset.updated_at,
                        "evidence_state": asset.evidence_state.value,
                        "states": states,
                        "score": selection.score,
                        "decision": used.decision if used else None,
                        "target": used.target if used else None,
                        "validation": validated.detail.get("summary") if validated else None,
                        "validation_ref": validated.evidence_ref if validated else None,
                        "attribution": attribution,
                        "contribution_ref": contributed.evidence_ref if contributed else None,
                        "risks": asset.risks,
                        "risk_flags": {
                            "expired": asset.deprecated,
                            "conflict": asset.evidence_state.value == "corrected",
                            "low_confidence": selection.score < 0.55,
                            "version_incompatible": (
                                package.task.version != "*"
                                and asset.version not in {"*", package.task.version}
                            ),
                        },
                    }
                )
            receipt: Dict[str, Any] = {
                "schema_version": "memory-hub-task-asset-evidence/v5",
                "trace_id": trace_id,
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "strategy": "minimal",
                "token_cost": package.token_cost,
                "authority": "live_memory_hub" if self.hub_authority else "portable_catalog",
                "summary": {
                    state.value: counts[state.value]
                    for state in AssetState
                    if state is not AssetState.CORRECTED
                },
                "assets": assets,
                "candidates": [],
                "task_profile": self.profiles.get(trace_id, {}),
                "acceptance_contract": contract.to_dict(),
                "acceptance_plan": dict(
                    (self.responses.get(trace_id) or {}).get("acceptance_plan") or {}
                ),
                "completion": completion,
                "comparison": comparison,
                "ci_runs": pair_sequential_ci_runs(self.state_store.ci_runs(trace_id)),
                "runtime": {
                    "durable": True,
                    "storage": "sqlite_wal",
                    "recovered_after_restart": trace_id in self.recovered_traces,
                },
            }
            # Runtime learning is queued by Core after persisting the task receipt.
            # Never manufacture a cache-specific candidate for unrelated tasks.
            receipt["candidate_generation"] = {"mode": "core_evidence_learning", "status": "asynchronous" if self.hub_authority else "unavailable_without_core"}
            turn = self.state_store.turn_for_trace(trace_id)
            if turn is not None:
                signal_weights = {
                    AssetState.USED: ("used", 0.8),
                    AssetState.VALIDATED: ("validated", 1.25),
                    AssetState.CONTRIBUTED: ("contributed", 1.8),
                    AssetState.CORRECTED: ("corrected", -2.0),
                }
                for event in events:
                    mapped = signal_weights.get(event.state)
                    if mapped is None:
                        continue
                    signal, weight = mapped
                    self._append_feedback(
                        turn,
                        package,
                        asset_id=event.asset_id,
                        signal=signal,
                        source="evidence_ledger",
                        weight=weight,
                        reason=event.decision or str(event.detail.get("summary") or event.state.value),
                        evidence_ref=event.evidence_ref,
                    )
                receipt["turn"] = {
                    "turn_id": turn["turn_id"],
                    "session_id": turn["session_id"],
                    "turn_seq": turn["turn_seq"],
                    "query_preview": turn["query_preview"],
                    "status": turn["status"],
                }
                receipt["feedback"] = [
                    {
                        "asset_id": item.get("asset_id"),
                        "signal": item.get("signal"),
                        "source": item.get("source"),
                        "weight": item.get("weight"),
                        "reason": item.get("reason"),
                        "evidence_ref": item.get("evidence_ref"),
                    }
                    for item in self.state_store.feedback_for_turn(turn["turn_id"])
                ]
                self.state_store.update_turn_receipt(trace_id, receipt)
            self._persist_trace(trace_id)
            if self.hub_authority is not None:
                external = self.external_bindings.get(trace_id, {})
                runtime_task_id = external.get("task_id", "")
                if runtime_task_id:
                    published = receipt
                    if turn is not None:
                        turns = self.state_store.list_turns(
                            session_id=turn["session_id"], task_id=turn["task_id"]
                        )
                        published = self._aggregate_turn_receipts(turn["session_id"], turns, receipt)
                    self.hub_authority.update_task_receipt(runtime_task_id, published)
            return receipt



def make_handler(api: TeamAssetApi, token: str):
    class Handler(BaseHTTPRequestHandler):
        server_version = "TeamAssetOrchestrator/7.0"

        def do_GET(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            if parsed.path == "/health":
                self._json(HTTPStatus.OK, {
                    "status": "ok" if api.state_store.ping() else "degraded",
                    "version": "7.0",
                    "assets": len(api.orchestrator.assets),
                    "durable": True,
                    "trace_count": api.state_store.trace_count(),
                    "native_asset_adapter": True,
                    "retrieval_pipeline": "bm25+sparse-vector+native-signals+graph+rrf",
                    "local_ci_auto": _truthy(os.environ.get("TEAM_ASSET_LOCAL_CI_AUTO", "")),
                    "local_ci_discovery": _truthy(os.environ.get("TEAM_ASSET_LOCAL_CI_DISCOVER", "")),
                    "local_ci_allowed_roots_configured": bool(
                        os.environ.get("TEAM_ASSET_LOCAL_CI_ALLOWED_ROOTS", "").strip()
                    ),
                    "runtime_asset_binding_count": len(api.bindings.get("assets") or {}),
                })
                return
            if not self._authorized():
                return
            if parsed.path == "/v1/events":
                query = parse_qs(parsed.query)
                events = api.ledger.events(
                    trace_id=_first(query, "trace_id"),
                    task_id=_first(query, "task_id"),
                    asset_id=_first(query, "asset_id"),
                )
                self._json(HTTPStatus.OK, {"events": [event.to_dict() for event in events]})
                return
            if parsed.path == "/v1/receipt":
                trace_id = _first(parse_qs(parsed.query), "trace_id") or ""
                try:
                    self._json(HTTPStatus.OK, api.receipt(trace_id))
                except ValueError as exc:
                    self._json(HTTPStatus.NOT_FOUND, {"error": "not_found", "message": str(exc)})
                return
            if parsed.path == "/v2/turns":
                query = parse_qs(parsed.query)
                self._json(HTTPStatus.OK, {
                    "turns": api.state_store.list_turns(
                        session_id=_first(query, "session_id"),
                        task_id=_first(query, "task_id"),
                    )
                })
                return
            if parsed.path == "/v2/sessions/receipt":
                session_id = _first(parse_qs(parsed.query), "session_id") or ""
                try:
                    self._json(HTTPStatus.OK, api.session_receipt(session_id))
                except ValueError as exc:
                    self._json(HTTPStatus.NOT_FOUND, {"error": "not_found", "message": str(exc)})
                return
            self._json(HTTPStatus.NOT_FOUND, {"error": "not_found"})

        def do_POST(self) -> None:  # noqa: N802
            if not self._authorized():
                return
            try:
                payload = self._payload()
                if self.path == "/v1/context/select":
                    self._json(HTTPStatus.OK, api.select(payload))
                    return
                if self.path == "/v1/events":
                    self._json(HTTPStatus.CREATED, api.append_event(payload))
                    return
                if self.path == "/v1/evidence/observe":
                    self._json(HTTPStatus.OK, api.observe(payload))
                    return
                if self.path == "/v1/evidence/injected":
                    self._json(HTTPStatus.OK, api.confirm_injected(payload))
                    return
                if self.path == "/v1/evidence/contribute":
                    self._json(HTTPStatus.OK, api.contribute(payload))
                    return
                if self.path == "/v2/turns/recommend":
                    self._json(HTTPStatus.OK, api.recommend_turn(payload))
                    return
                if self.path == "/v2/turns/feedback":
                    self._json(HTTPStatus.OK, api.record_feedback(payload))
                    return
                if self.path == "/v2/ci/runs":
                    # A remote provider cannot declare itself trusted in JSON.
                    # Trust comes from the provider-specific webhook signature.
                    provider = str(payload.get("provider") or "local-ci").lower()
                    if provider in {"github-actions", "gitlab-ci", "jenkins"}:
                        payload["webhook_verified"] = self._verify_ci_webhook(provider)
                    self._json(HTTPStatus.OK, api.record_ci_run(payload))
                    return
                self._json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            except (KeyError, ValueError, InvalidAssetTransition) as exc:
                self._json(HTTPStatus.BAD_REQUEST, {"error": "invalid_request", "message": str(exc)})

        def log_message(self, format: str, *args: object) -> None:
            # Deliberately omit headers/body so API keys and private asset text
            # cannot leak into access logs.
            print(f"[team-asset-api] {self.address_string()} {format % args}")

        def _authorized(self) -> bool:
            if not token:
                return True
            supplied = self.headers.get("authorization", "")
            if supplied != f"Bearer {token}":
                self._json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
                return False
            return True

        def _payload(self) -> Dict[str, Any]:
            length = int(self.headers.get("content-length", "0"))
            if length > 2_000_000:
                raise ValueError("payload_too_large")
            raw = self.rfile.read(length)
            self._raw_payload = raw
            value = json.loads(raw.decode("utf-8") or "{}")
            if not isinstance(value, dict):
                raise ValueError("JSON object required")
            return value

        def _verify_ci_webhook(self, provider: str) -> bool:
            raw = getattr(self, "_raw_payload", b"")
            if provider == "github-actions":
                secret = os.environ.get("TEAM_ASSET_GITHUB_WEBHOOK_SECRET", "")
                supplied = self.headers.get("x-hub-signature-256", "")
                expected = "sha256=" + hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
                return bool(secret and supplied and hmac.compare_digest(supplied, expected))
            if provider == "gitlab-ci":
                secret = os.environ.get("TEAM_ASSET_GITLAB_WEBHOOK_TOKEN", "")
                supplied = self.headers.get("x-gitlab-token", "")
                return bool(secret and supplied and hmac.compare_digest(supplied, secret))
            if provider == "jenkins":
                secret = os.environ.get("TEAM_ASSET_JENKINS_WEBHOOK_SECRET", "")
                supplied = self.headers.get("x-team-asset-ci-signature", "")
                expected = "sha256=" + hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
                return bool(secret and supplied and hmac.compare_digest(supplied, expected))
            return False

        def _json(self, status: HTTPStatus, value: Dict[str, Any]) -> None:
            body = json.dumps(value, ensure_ascii=False).encode("utf-8")
            self.send_response(int(status))
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return Handler


def serve(host: Optional[str] = None, port: Optional[int] = None) -> None:
    bind_host = host or os.environ.get("TEAM_ASSET_HOST", "127.0.0.1")
    bind_port = port or int(os.environ.get("TEAM_ASSET_PORT", "8765"))
    token = os.environ.get("TEAM_ASSET_SERVER_TOKEN", "")
    token_file = os.environ.get("TEAM_ASSET_SERVER_TOKEN_FILE", "")
    if token_file:
        path = Path(token_file).expanduser()
        if not path.is_absolute():
            path = (project_root() / path).resolve()
        if not path.is_file():
            raise ValueError("TEAM_ASSET_SERVER_TOKEN_FILE does not exist")
        token = path.read_text(encoding="utf-8").strip()
    if bind_host not in {"127.0.0.1", "localhost", "::1"} and not token:
        raise ValueError("non-loopback team asset API requires a service token")
    api = TeamAssetApi()
    server = ThreadingHTTPServer((bind_host, bind_port), make_handler(api, token))
    print(f"Team asset orchestrator listening on http://{bind_host}:{bind_port} (auth={'enabled' if token else 'local-only'})")
    server.serve_forever()


def _redact_business_secrets(value: str) -> str:
    result = re.sub(r"sk-mem-[A-Za-z0-9_-]+", "[REDACTED]", value, flags=re.I)
    result = re.sub(r"uky-[A-Za-z0-9_-]+", "[REDACTED]", result, flags=re.I)
    return result


def _string_list(value: Any, max_items: int, max_length: int) -> list[str]:
    if not isinstance(value, (list, tuple, set)):
        return []
    return list(dict.fromkeys(
        _redact_business_secrets(str(item).strip())[:max_length]
        for item in value
        if str(item).strip()
    ))[:max_items]


def _first(query: Dict[str, list], name: str) -> Optional[str]:
    values = query.get(name)
    return str(values[0]) if values else None


def _load_bindings(root: Path) -> Dict[str, Dict[str, str]]:
    configured = os.environ.get("TEAM_ASSET_BINDINGS_FILE", "")
    if configured:
        path = Path(configured).expanduser()
    else:
        hub_env = os.environ.get("TEAM_ASSET_HUB_ENV", "").strip()
        derived: Optional[Path] = None
        if hub_env:
            env_path = Path(hub_env).expanduser()
            if not env_path.is_absolute():
                env_path = (root / env_path).resolve()
            candidate = env_path.with_name(f"{env_path.stem}-binding.json")
            if candidate.is_file():
                derived = candidate
        path = derived or root / "runtime" / "hub-binding.json"
    if not path.is_absolute():
        path = (root / path).resolve()
    if not path.is_file():
        return {"teams": {}, "agents": {}, "tasks": {}, "assets": {}}
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("TEAM_ASSET_BINDINGS_FILE must contain a JSON object")
    result: Dict[str, Dict[str, str]] = {}
    for group in ("teams", "agents", "tasks", "assets"):
        table = value.get(group, {})
        if not isinstance(table, dict):
            raise ValueError(f"binding group {group} must be an object")
        result[group] = {str(key): str(item) for key, item in table.items()}
    return result


def _truthy(value: str) -> bool:
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _path_is_allowed(workspace: Path, configured: str) -> bool:
    """Require an explicit operator allow-list before executing repository tests."""
    values = [item.strip() for item in re.split(r"[,\n]", configured) if item.strip()]
    for value in values:
        try:
            root = Path(value).expanduser().resolve()
        except (OSError, RuntimeError):
            continue
        if workspace == root or root in workspace.parents:
            return True
    return False


def _normalize_observation_paths(
    payload: Dict[str, Any], scope: Dict[str, Any]
) -> Dict[str, Any]:
    """Canonicalize client file paths against the verified execution root.

    CodeBuddy may report an absolute path or a ``file://`` URI even though the
    task contract and assets use repository-relative paths. Evidence outside
    the verified repository is discarded rather than becoming a false match.
    """
    result = dict(payload)
    root_value = str(scope.get("execution_root") or scope.get("workspace_root") or "").strip()
    if not root_value:
        return result
    try:
        root = Path(root_value).expanduser().resolve()
    except (OSError, RuntimeError):
        return result

    def normalize(value: Any, *, preserve_suffix: bool = False) -> str:
        raw = str(value or "").strip()
        if not raw or raw.startswith("test:"):
            return raw
        if raw.startswith("file://"):
            raw = unquote(urlparse(raw).path)
        suffix = ""
        candidate_raw = raw
        if preserve_suffix:
            match = re.match(r"^(.*?\.[A-Za-z0-9_+-]+)(:.*)?$", raw)
            if match:
                candidate_raw = match.group(1)
                suffix = match.group(2) or ""
        candidate = Path(candidate_raw).expanduser()
        if not candidate.is_absolute():
            return str(candidate).replace("\\", "/").removeprefix("./") + suffix
        try:
            resolved = candidate.resolve()
            if resolved != root and root not in resolved.parents:
                return ""
            relative = str(resolved.relative_to(root)).replace("\\", "/")
            return relative + suffix
        except (OSError, RuntimeError, ValueError):
            return ""

    calls: list[Dict[str, Any]] = []
    for raw_call in payload.get("tool_calls", []):
        if not isinstance(raw_call, dict):
            continue
        call = dict(raw_call)
        call["target"] = normalize(call.get("target"), preserve_suffix=True)
        call["changed_paths"] = list(dict.fromkeys(
            path
            for item in call.get("changed_paths", [])
            if (path := normalize(item))
        ))
        calls.append(call)
    result["tool_calls"] = calls

    declarations: list[Dict[str, Any]] = []
    for raw_declaration in payload.get("declarations", []):
        if not isinstance(raw_declaration, dict):
            continue
        declaration = dict(raw_declaration)
        normalized_target = normalize(declaration.get("target"), preserve_suffix=True)
        if normalized_target:
            declaration["target"] = normalized_target
        declarations.append(declaration)
    result["declarations"] = declarations

    acceptance: list[Dict[str, Any]] = []
    for raw_declaration in payload.get("acceptance_declarations", []):
        if not isinstance(raw_declaration, dict):
            continue
        declaration = dict(raw_declaration)
        declaration["targets"] = list(dict.fromkeys(
            path
            for item in declaration.get("targets", [])
            if (path := normalize(item, preserve_suffix=True))
        ))
        acceptance.append(declaration)
    result["acceptance_declarations"] = acceptance
    return result


def _load_reviewed_ci_manifest(path: Path, workspace: Path) -> Dict[str, Any]:
    """Load an operator-controlled manifest and resolve external validator files.

    Relative arguments normally remain relative to the target workspace.  When
    an argument does not exist there but does exist beside the reviewed
    manifest, it is resolved to that external path.  This allows hidden tests
    to live outside the coding agent's repository while the independent runner
    can still execute them.
    """
    resolved = path.resolve()
    if not resolved.is_file():
        raise ValueError("TEAM_ASSET_LOCAL_CI_MANIFEST does not exist")
    if resolved.stat().st_size > 1_000_000:
        raise ValueError("TEAM_ASSET_LOCAL_CI_MANIFEST is too large")
    value = json.loads(resolved.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("reviewed CI manifest must be a JSON object")
    materialized = dict(value)
    checks: list[Dict[str, Any]] = []
    for raw in value.get("checks") or []:
        if not isinstance(raw, dict):
            continue
        check = dict(raw)
        argv: list[str] = []
        for item in raw.get("argv") or []:
            argument = str(item)
            candidate = Path(argument)
            if not candidate.is_absolute() and (resolved.parent / candidate).exists() and not (workspace / candidate).exists():
                argument = str((resolved.parent / candidate).resolve())
            argv.append(argument)
        check["argv"] = argv
        checks.append(check)
    materialized["checks"] = checks
    return materialized


def _local_ci_run_fingerprint(
    workspace: Path,
    changed_paths: list[str],
    manifest_identity: str,
) -> str:
    digest = hashlib.sha256(manifest_identity.encode("utf-8"))
    for raw in sorted(set(changed_paths)):
        try:
            candidate = Path(raw).expanduser()
            path = candidate.resolve() if candidate.is_absolute() else (workspace / candidate).resolve()
            if path != workspace and workspace not in path.parents:
                continue
            relative = str(path.relative_to(workspace))
            digest.update(relative.encode("utf-8"))
            if path.is_file():
                stat = path.stat()
                digest.update(f"{stat.st_size}:{stat.st_mtime_ns}".encode("utf-8"))
                if stat.st_size <= 10_000_000:
                    digest.update(path.read_bytes())
        except (OSError, RuntimeError, ValueError):
            continue
    return f"local-ci:{digest.hexdigest()}"


_SNAPSHOT_IGNORED_PARTS = {
    ".git", ".hg", ".svn", ".tox", ".venv", "venv", "node_modules",
    "dist", "build", "__pycache__", ".pytest_cache",
    "hidden_tests", "evaluator_tests", "grader_tests",
}
_SNAPSHOT_SUFFIXES = {
    ".c", ".cc", ".cpp", ".cs", ".go", ".h", ".hpp", ".java", ".js",
    ".jsx", ".json", ".kt", ".kts", ".php", ".py", ".rb", ".rs",
    ".scala", ".sh", ".sql", ".toml", ".ts", ".tsx", ".yaml", ".yml",
}
_SNAPSHOT_FILENAMES = {
    "Dockerfile", "Jenkinsfile", "Makefile", "Pipfile", "pytest.ini",
    "setup.cfg", "setup.py", "tox.ini",
}


def _repository_snapshot(scope: Dict[str, Any]) -> Dict[str, Any]:
    """Capture bounded source/test hashes for later independent change detection."""
    if scope.get("status") not in {"matched_local_path", "matched_task_binding"}:
        return {}
    root_value = str(scope.get("execution_root") or "").strip()
    if not root_value:
        return {}
    try:
        root = Path(root_value).expanduser().resolve()
    except (OSError, RuntimeError):
        return {}
    if not root.is_dir():
        return {}

    files: Dict[str, str] = {}
    total_bytes = 0
    truncated = False
    try:
        candidates = sorted(root.rglob("*"))
    except OSError:
        return {}
    for path in candidates:
        try:
            relative = path.relative_to(root)
            if any(part in _SNAPSHOT_IGNORED_PARTS for part in relative.parts):
                continue
            if path.is_symlink() or not path.is_file():
                continue
            if path.suffix.lower() not in _SNAPSHOT_SUFFIXES and path.name not in _SNAPSHOT_FILENAMES:
                continue
            size = path.stat().st_size
            if size > 5_000_000:
                continue
            if len(files) >= 4000 or total_bytes + size > 40_000_000:
                truncated = True
                break
            files[relative.as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
            total_bytes += size
        except (OSError, RuntimeError, ValueError):
            continue
    return {
        "schema_version": "repository-change-baseline/v1",
        "root": str(root),
        "files": files,
        "truncated": truncated,
    }


def _repository_changes(workspace: Path, baseline: Dict[str, Any]) -> list[str]:
    """Return source/test paths whose content differs from the saved baseline."""
    if baseline.get("schema_version") != "repository-change-baseline/v1":
        return []
    try:
        root = workspace.expanduser().resolve()
        baseline_root = Path(str(baseline.get("root") or "")).expanduser().resolve()
    except (OSError, RuntimeError):
        return []
    if root != baseline_root:
        return []
    previous = baseline.get("files")
    if not isinstance(previous, dict):
        return []
    current = _repository_snapshot({"status": "matched_local_path", "execution_root": str(root)})
    current_files = current.get("files")
    if not isinstance(current_files, dict):
        return []
    return sorted(
        path
        for path in set(previous) | set(current_files)
        if previous.get(path) != current_files.get(path)
    )


def _repository_scope(
    task_detail: Dict[str, Any], repository_context: Dict[str, Any]
) -> Dict[str, Any]:
    """Build a non-LLM repository boundary from task and client workspace facts."""
    expected = str(
        repository_context.get("task_source_url")
        or task_detail.get("source_url")
        or ""
    ).strip()
    workspace = str(repository_context.get("workspace_root") or "").strip()
    marker_names = (
        ".git", "pyproject.toml", "setup.py", "package.json", "go.mod",
        "pom.xml", "build.gradle", "Cargo.toml",
    )
    has_project_marker = False
    workspace_path: Optional[Path] = None
    if workspace:
        try:
            root = Path(workspace).expanduser().resolve()
            workspace_path = root
            has_project_marker = root.is_dir() and any((root / name).exists() for name in marker_names)
        except (OSError, RuntimeError):
            has_project_marker = False

    status = "ready_unbound"
    reason = "任务未绑定仓库，但当前工作区包含项目标识；开始前仍需核对项目名称"
    execution_root = workspace
    if not workspace:
        status = "blocked_workspace_unknown"
        reason = "CodeBuddy 未上报当前工作区"
    elif not expected and not has_project_marker:
        status = "blocked_empty_or_unbound"
        reason = "任务未绑定仓库，且当前工作区没有项目标识"
    elif expected.startswith("/"):
        try:
            expected_path = Path(expected).expanduser().resolve()
            workspace_path = workspace_path or Path(workspace).expanduser().resolve()
            if expected_path == workspace_path:
                status = "matched_local_path"
                reason = "当前工作区与任务绑定的本地仓库一致"
                execution_root = str(workspace_path)
            elif (
                expected_path.is_dir()
                and not has_project_marker
                and _path_is_allowed(
                    expected_path,
                    os.environ.get("TEAM_ASSET_LOCAL_CI_ALLOWED_ROOTS", ""),
                )
            ):
                # CodeBuddy Desktop may create an empty conversation workspace
                # even when the user explicitly selected a task whose sourceUrl
                # points at a real local repository. In that narrow case the
                # task binding is the execution boundary; a non-empty unrelated
                # project is never silently redirected.
                status = "matched_task_binding"
                reason = "当前会话工作区为空，已使用用户所选任务绑定且在允许目录内的本地仓库"
                execution_root = str(expected_path)
            else:
                status = "blocked_path_mismatch"
                reason = "当前工作区与任务绑定的本地仓库不一致"
        except (OSError, RuntimeError):
            status = "blocked_path_mismatch"
            reason = "无法验证任务绑定的本地仓库路径"
    elif expected:
        status = "verify_remote_binding"
        reason = "任务绑定了远程仓库；CodeBuddy 必须用 git remote 核对后才能修改"
    return {
        "status": status,
        "expected_repository": expected,
        "workspace_root": workspace,
        "execution_root": execution_root,
        "workspace_has_project_marker": has_project_marker,
        "reason": reason,
        "write_allowed": status in {"matched_local_path", "matched_task_binding", "ready_unbound", "verify_remote_binding"},
    }


def _render_repository_scope(scope: Dict[str, Any]) -> str:
    expected = str(scope.get("expected_repository") or "未绑定")
    workspace = str(scope.get("workspace_root") or "未知")
    execution_root = str(scope.get("execution_root") or workspace)
    write_allowed = scope.get("write_allowed") is True
    lines = [
        "<repository_scope>",
        f"任务绑定仓库：{expected}",
        f"当前 CodeBuddy 工作区：{workspace}",
        f"本次允许执行的任务仓库：{execution_root}",
        f"校验状态：{scope.get('status')}（{scope.get('reason')}）",
        "只能在当前已确认的任务仓库内读写。禁止搜索整个用户目录，禁止从其他项目复制代码或测试。",
        "禁止读取 hidden_tests、evaluator_tests、grader_tests 等独立验收目录；这些只允许由 CI/独立验证器执行。",
        "不得直接把本轮经验写回 Wiki、Skill 或其他团队资产目录；系统只生成 candidate，须在 Memory Hub 审核后发布。",
    ]
    if not write_allowed:
        lines.append("当前仓库校验未通过：停止代码修改与测试，明确提示用户先绑定/打开正确仓库。")
    elif str(scope.get("status")) == "verify_remote_binding":
        lines.append("修改前先读取当前仓库的 git remote；若与任务绑定仓库不一致，立即停止。")
    elif str(scope.get("status")) == "matched_task_binding":
        lines.append("当前会话工作区为空；请直接在上述任务绑定仓库内修改和运行测试，无需复制项目。")
    lines.append("</repository_scope>")
    return "\n".join(lines)


class HubAuthority:
    """Memory Hub is the live authority for permission *and* asset content."""

    def __init__(self, core_url: str, service_id: str, user_id: str, user_key: str) -> None:
        self.core_url = core_url.rstrip("/")
        self.service_id = service_id
        self.user_id = user_id
        self.user_key = user_key

    @classmethod
    def from_environment(cls, root: Path) -> Optional["HubAuthority"]:
        configured = os.environ.get("TEAM_ASSET_HUB_ENV", "")
        if not configured:
            return None
        path = Path(configured).expanduser()
        if not path.is_absolute():
            path = (root / path).resolve()
        values = _parse_env_file(path)
        # 兼容 Memory Hub 本地体验包原有的 DEMO_* 凭据文件，避免为了接入
        # 编排器复制一份业务 key。专用 TEAM_ASSET_DEMO_* 仍优先。
        key = values.get("TEAM_ASSET_DEMO_USER_KEY", "") or values.get("DEMO_USER_KEY", "")
        if not key.startswith("sk-mem-"):
            raise ValueError("TEAM_ASSET_HUB_ENV must contain a validated sk-mem business key")
        return cls(
            os.environ.get("TEAM_ASSET_CORE_URL", "http://127.0.0.1:8420"),
            os.environ.get("TEAM_ASSET_SERVICE_ID", "default"),
            values.get("TEAM_ASSET_DEMO_USER_ID", "") or values.get("DEMO_USER_ID", ""),
            key,
        )

    def accessible_assets(self, team_id: str, agent_id: str = "") -> list[Dict[str, Any]]:
        if not team_id or not self.user_id:
            return []
        items: list[Dict[str, Any]] = []
        offset = 0
        page_size = 100
        # Access is resolved by MemoryCore before any metadata reaches the
        # ranker. Passing agent_id is essential because fixed-asset bindings
        # and agent-scoped ACL grants are part of the permission decision.
        while offset < 1000:
            payload: Dict[str, Any] = {
                "user_id": self.user_id,
                "team_id": team_id,
                "action": "use",
                "limit": page_size,
                "offset": offset,
            }
            if agent_id:
                payload["agent_id"] = agent_id
            data = self._post("asset/list-accessible", payload)
            page = [item for item in ((data or {}).get("items") or []) if isinstance(item, dict)]
            items.extend(page)
            if len(page) < page_size:
                break
            offset += page_size
        return items

    def get_task(self, task_id: str) -> Optional[Dict[str, Any]]:
        if not task_id:
            return None
        return self._post("task/get", {"task_id": task_id})

    def update_task_receipt(self, task_id: str, receipt: Dict[str, Any]) -> None:
        current = self._post("task/get", {"task_id": task_id})
        if not current:
            raise RuntimeError("hub_receipt_task_unavailable")
        try:
            metadata = json.loads(str(current.get("metadata_json") or "{}"))
        except json.JSONDecodeError:
            metadata = {}
        metadata, active_receipt = _merge_task_receipt_metadata(metadata, receipt)
        update: Dict[str, Any] = {
            "task_id": task_id,
            "metadata_json": json.dumps(metadata, ensure_ascii=False),
        }
        if (active_receipt.get("completion") or {}).get("task_completed") is True:
            update["status"] = "completed"
        self._post(
            "task/update",
            update,
        )

    def ensure_candidate(self, team_id: str, candidate: Dict[str, Any]) -> Dict[str, Any]:
        items = (self._post("asset/list", {"team_id": team_id, "limit": 100}) or {}).get("items") or []
        existing = next(
            (item for item in items if str(item.get("asset_id")) == candidate["asset_id"]),
            None,
        )
        if existing:
            return {**candidate, "asset_id": str(existing["asset_id"]), "status": str(existing.get("status", "candidate"))}
        metadata = {
            "team_asset_candidate": candidate,
            "team_asset_bench": {
                "logical_asset_id": candidate["asset_id"],
                "asset_payload": candidate.get("asset_payload", {}),
                "evidence_state": "candidate",
                "version": "1.0",
                "updated_at": datetime.now(timezone.utc).isoformat(),
                "tests": candidate.get("tests", []),
                "risks": ["未经团队审核，不得注入 Coding Agent"],
            },
        }
        created = self._post(
            "asset/create",
            {
                "asset_id": candidate["asset_id"],
                "team_id": team_id,
                "asset_type": "skill",
                "name": candidate["title"],
                "description": candidate["verification"],
                "owner_user_id": self.user_id,
                "source_type": "task_feedback",
                "source_ref": f"trace:{candidate['source_trace_id']}",
                "visibility": "team",
                "status": "candidate",
                "confidence": 0.8,
                "metadata_json": json.dumps(metadata, ensure_ascii=False),
            },
        )
        return {**candidate, "asset_id": str((created or {}).get("asset_id", candidate["asset_id"])), "status": "candidate"}

    def _post(self, action: str, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        request = Request(
            f"{self.core_url}/v3/meta/{action.lstrip('/')}",
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
            headers={
                "content-type": "application/json",
                "x-tdai-user-key": self.user_key,
                "x-tdai-service-id": self.service_id,
            },
        )
        try:
            with urlopen(request, timeout=8) as response:
                value = json.loads(response.read().decode("utf-8"))
        except Exception as error:
            if action in {"task/update", "asset/create"}:
                # Do not acknowledge publication when Core denied the demo
                # publisher. Keep provider bodies and credentials out of logs.
                raise RuntimeError(f"hub_write_failed:{action}") from None
            return None
        if value.get("code") != 0:
            if action in {"task/update", "asset/create"}:
                raise RuntimeError(f"hub_write_failed:{action}")
            return None
        data = value.get("data") or {}
        return data if isinstance(data, dict) else {}


def _merge_task_receipt_metadata(
    metadata: Dict[str, Any],
    incoming: Dict[str, Any],
) -> tuple[Dict[str, Any], Dict[str, Any]]:
    """Keep a completed audit receipt authoritative over a partial retry.

    A task can have many CodeBuddy sessions and smoke checks.  A later trace
    that only reached recalled/selected must not erase a prior 9/9 result.
    We retain a compact, bounded attempt history and expose the partial retry
    separately for audit without changing the active receipt.
    """
    result = dict(metadata)
    incumbent = result.get("asset_evidence")
    incumbent = dict(incumbent) if isinstance(incumbent, dict) else {}
    incoming_complete = (incoming.get("completion") or {}).get("task_completed") is True
    incumbent_complete = (incumbent.get("completion") or {}).get("task_completed") is True
    replace_active = not incumbent_complete or incoming_complete
    active = dict(incoming) if replace_active else incumbent
    result["asset_evidence"] = active
    if not replace_active:
        result["asset_evidence_latest_attempt"] = dict(incoming)

    attempts = result.get("asset_evidence_history")
    history = [dict(item) for item in attempts if isinstance(item, dict)] if isinstance(attempts, list) else []
    compact = {
        "trace_id": str(incoming.get("trace_id") or ""),
        "generated_at": str(incoming.get("generated_at") or ""),
        "schema_version": str(incoming.get("schema_version") or ""),
        "summary": dict(incoming.get("summary") or {}),
        "completion": dict(incoming.get("completion") or {}),
        "comparison": dict(incoming.get("comparison") or {}),
    }
    history = [item for item in history if item.get("trace_id") != compact["trace_id"]]
    history.append(compact)
    result["asset_evidence_history"] = history[-20:]
    return result, active


def _runtime_asset_bindings(
    package: ContextPackage,
    configured: Dict[str, Dict[str, str]],
) -> Dict[str, str]:
    """Resolve IDs from the exact ACL-filtered package before static config.

    Memory Hub assigns runtime IDs while legacy evaluation assets may retain a
    stable logical ID.  The selected package already contains both identities,
    so evidence must not depend on an operator remembering to start the server
    with a matching binding file.  Static bindings remain a compatibility
    fallback for older persisted packages.
    """
    result = dict(configured.get("assets") or {})
    for selection in package.recalled:
        asset = selection.asset
        result.setdefault(asset.asset_id, asset.asset_id)
        if asset.runtime_asset_id:
            result[str(asset.runtime_asset_id)] = asset.asset_id
    return result


def _authoritative_session_receipt(
    receipts: list[Dict[str, Any]],
    latest: Dict[str, Any],
) -> Dict[str, Any]:
    """Project multi-turn evidence without letting chat-only turns erase work.

    The latest conversational turn is always shown in ``latest_turn``.  The
    task-level completion panel, however, follows the most recent turn that
    observed a code change, a test outcome, or an independent CI run.  This is
    deliberately session-scoped; evidence from another CodeBuddy session is
    not silently mixed into the active attempt.
    """
    active = dict(latest or {})
    for receipt in receipts:
        completion = receipt.get("completion") or {}
        test_progress = completion.get("test_progress") or {}
        changed = [str(p).replace("\\", "/") for p in completion.get("changed_paths") or []]
        targets = [str(p).replace("\\", "/").rstrip("/") for p in completion.get("target_paths") or []]
        task_type = ((receipt.get("task_profile") or {}).get("task_type") or {}).get("value")
        # A coding task's report write is an artifact, not a new implementation.
        # Do not suppress real source/config edits, explicit documentation
        # targets, unknown task types, failed tests, or any independent CI run.
        report_only = bool(changed and targets and task_type in {"bug_fix", "feature", "refactor"}
            and all(p.lower().endswith((".md", ".rst", ".txt", ".adoc")) for p in changed)
            and not any(p == t or p.startswith(t + "/") for p in changed for t in targets))
        has_engineering_evidence = bool(
            completion.get("task_completed") is True
            or (changed and not report_only)
            or completion.get("failed_tests")
            or int(test_progress.get("passed") or 0) > 0
            or receipt.get("ci_runs")
        )
        if has_engineering_evidence:
            active = dict(receipt)
    return active


def _asset_declarations_from_plan(
    package: ContextPackage,
    response: Dict[str, Any],
    run: Dict[str, Any],
) -> list[Dict[str, str]]:
    """Derive conservative adoption edges from plan provenance + trusted CI."""
    plan = response.get("acceptance_plan")
    criteria = plan.get("criteria") if isinstance(plan, dict) else None
    if not isinstance(criteria, list):
        return []
    observed_tests = {
        str(test_id)
        for check in run.get("checks") or []
        if isinstance(check, dict)
        for test_id in check.get("test_ids") or []
        if str(test_id)
    }
    discovery = run.get("verification_discovery")
    repository_discovery = bool(
        isinstance(discovery, dict)
        and discovery.get("schema_version") == "team-asset-verification-discovery/v1"
        and str(discovery.get("workspace_fingerprint") or "").startswith("sha256:")
    )
    changed_paths = _string_list(run.get("changed_paths"), 100, 600)
    declarations: list[Dict[str, str]] = []
    for selection in package.selected:
        asset = selection.asset
        linked = [
            item for item in criteria
            if isinstance(item, dict)
            and asset.asset_id in _string_list(item.get("source_asset_ids"), 20, 200)
        ]
        if not linked:
            continue
        candidate_tests = {
            test_id
            for item in linked
            for test_id in _string_list(item.get("candidate_test_ids"), 100, 300)
        }
        matching_tests = sorted(observed_tests & (candidate_tests | set(asset.tests)))
        candidate_paths = {
            path
            for item in linked
            for path in _string_list(item.get("target_paths"), 100, 600)
        } | set(asset.paths)
        matching_paths = sorted(
            path for path in changed_paths
            if any(_same_repository_path(path, expected) for expected in candidate_paths)
        )
        # Validation-workflow assets are evidenced most precisely by an exact
        # test ID; code-structure assets are evidenced by the edited path.
        if asset.source_type.value == "skill" and matching_tests:
            target = f"test:{matching_tests[0]}"
            action = f"可信 CI 执行了关联测试 {matching_tests[0]}"
        elif matching_paths:
            target = matching_paths[0]
            action = f"可信 CI 观察到关联代码位置 {matching_paths[0]} 被修改"
        elif matching_tests:
            target = f"test:{matching_tests[0]}"
            action = f"可信 CI 执行了关联测试 {matching_tests[0]}"
        else:
            continue
        declarations.append({
            "asset_id": asset.asset_id,
            "decision": f"验收计划引用《{asset.title}》，{action}",
            "target": target,
            "source": "acceptance_plan+trusted_ci",
            "evidence_ref": str(run.get("evidence_ref") or "")[:600],
            # Only repository discovery may establish a current test alias for
            # an older asset hint. A plain CI payload keeps exact asset test
            # matching and cannot broaden attribution by assertion alone.
            "validation_test_ids": matching_tests if repository_discovery else [],
        })
    return declarations


def _same_repository_path(left: str, right: str) -> bool:
    left = str(left).replace("\\", "/").removeprefix("./")
    right = str(right).replace("\\", "/").removeprefix("./")
    return bool(left and right) and (
        left == right or left.endswith("/" + right) or right.endswith("/" + left)
    )


def _receipt_attribution(
    asset: Asset,
    used: Optional[AssetEvent],
    validated: Optional[AssetEvent],
) -> Optional[Dict[str, Any]]:
    """Read V4 attribution or reconstruct it from immutable legacy evidence."""
    if validated and isinstance(validated.detail.get("attribution"), dict):
        return dict(validated.detail["attribution"])
    if used and isinstance(used.detail.get("attribution"), dict):
        base = dict(used.detail["attribution"])
    elif used:
        detail = used.detail
        base = usage_attribution(
            asset,
            {"decision": used.decision or "", "target": used.target or ""},
            {
                "id": str(used.evidence_ref or "").removeprefix("tool-call:"),
                "name": str(detail.get("tool_name") or "legacy-observation"),
                "kind": str(detail.get("tool_kind") or "other"),
                "target": used.target or "",
                "changed_paths": detail.get("changed_paths") or [],
                "change_hash": detail.get("change_hash") or "",
            },
        )
    else:
        return None
    if not validated:
        return base
    return validation_attribution(
        asset,
        base,
        matched_tests=[str(item) for item in validated.detail.get("matched_tests") or []],
        evidence_ref=str(validated.evidence_ref or ""),
        result_success=True,
    )


def _parse_env_file(path: Path) -> Dict[str, str]:
    if not path.is_file():
        return {}
    values: Dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or line.lstrip().startswith("#") or "=" not in line:
            continue
        name, raw = line.split("=", 1)
        parts = shlex.split(raw, posix=True)
        values[name] = parts[0] if parts else ""
    return values
