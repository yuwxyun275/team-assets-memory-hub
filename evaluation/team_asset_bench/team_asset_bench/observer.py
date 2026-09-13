from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional

from .attribution import usage_attribution, validation_attribution
from .ledger import EvidenceLedger
from .models import AssetEvent, AssetState, ContextPackage


@dataclass
class TraceObservationState:
    declarations: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    tool_calls: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    tool_results: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    seen: set[str] = field(default_factory=set)


class CodeBuddyEvidenceObserver:
    """Turn sanitized CodeBuddy traffic into trustworthy asset evidence.

    `used` requires two independent signals: an explicit asset-use declaration
    from the model and an observed edit/test tool call that matches its target.
    `validated` additionally requires a successful tool result. The observer
    never accepts a prose claim such as "tests passed" as validation evidence.
    """

    def __init__(self, ledger: EvidenceLedger) -> None:
        self.ledger = ledger
        self._traces: Dict[str, TraceObservationState] = {}

    def observe(self, package: ContextPackage, payload: Dict[str, Any]) -> List[AssetEvent]:
        state = self._traces.setdefault(package.trace_id, TraceObservationState())
        selected_ids = {item.asset.asset_id for item in package.selected}

        for declaration in _dicts(payload.get("declarations")):
            asset_id = str(declaration.get("asset_id", ""))
            decision = str(declaration.get("decision", "")).strip()
            target = str(declaration.get("target", "")).strip()
            signature = _signature("declaration", declaration)
            if signature in state.seen or asset_id not in selected_ids or not decision or not target:
                continue
            state.seen.add(signature)
            state.declarations[asset_id] = {
                "asset_id": asset_id,
                "decision": decision[:1200],
                "target": target[:600],
                "source": str(declaration.get("source") or "model_declaration")[:120],
                "evidence_ref": str(declaration.get("evidence_ref") or "")[:600],
                "validation_test_ids": (
                    _strings(declaration.get("validation_test_ids"), limit=600)
                    if str(declaration.get("source") or "") == "acceptance_plan+trusted_ci"
                    else []
                ),
            }

        for call in _dicts(payload.get("tool_calls")):
            call_id = str(call.get("id") or _signature("call", call)[:20])
            signature = _signature("call", call)
            if signature in state.seen:
                continue
            state.seen.add(signature)
            state.tool_calls[call_id] = {
                "id": call_id,
                "name": str(call.get("name", "unknown"))[:200],
                "kind": str(call.get("kind", "other"))[:40],
                "target": str(call.get("target", ""))[:600],
                "command": str(call.get("command", ""))[:1200],
                "arguments": str(call.get("arguments", ""))[:2000],
                "change_hash": str(call.get("change_hash", ""))[:120],
                "changed_paths": _strings(call.get("changed_paths"), limit=600),
                "test_ids": _strings(call.get("test_ids"), limit=600),
            }

        for result in _dicts(payload.get("tool_results")):
            call_id = str(result.get("tool_call_id", ""))
            if not call_id:
                continue
            signature = _signature("result", result)
            if signature in state.seen:
                continue
            state.seen.add(signature)
            state.tool_results[call_id] = {
                "tool_call_id": call_id,
                "success": result.get("success") is True,
                "summary": str(result.get("summary", ""))[:1200],
                "evidence_ref": str(result.get("evidence_ref", ""))[:600],
                "test_ids": _strings(result.get("test_ids"), limit=600),
            }

        appended: List[AssetEvent] = []
        actor_id = str(payload.get("actor_id") or package.task.agent_id)
        for selection in package.selected:
            asset = selection.asset
            declaration = state.declarations.get(asset.asset_id)
            if not declaration:
                continue

            latest = self.ledger.latest_state(package.trace_id, package.task.task_id, asset.asset_id)
            matching_action = self._matching_action(state, declaration["target"])
            if latest is AssetState.INJECTED and matching_action is not None:
                observed_result = state.tool_results.get(matching_action["id"], {})
                attribution = usage_attribution(asset, declaration, {**matching_action, "test_ids": sorted({
                    *matching_action.get("test_ids", []), *observed_result.get("test_ids", []),
                })})
                declaration_source = str(declaration.get("source") or "model_declaration")
                appended.append(
                    self.ledger.append(
                        trace_id=package.trace_id,
                        task_id=package.task.task_id,
                        asset_id=asset.asset_id,
                        state=AssetState.USED,
                        actor_type=(
                            "validator"
                            if declaration_source == "acceptance_plan+trusted_ci"
                            else "agent"
                        ),
                        actor_id=(
                            "independent-ci-attribution"
                            if declaration_source == "acceptance_plan+trusted_ci"
                            else actor_id
                        ),
                        target=declaration["target"],
                        decision=declaration["decision"],
                        evidence_ref=(
                            str(declaration.get("evidence_ref"))
                            or f"tool-call:{matching_action['id']}"
                        ),
                        detail={
                            "observation": (
                                "acceptance_plan+trusted_ci+matching_action"
                                if declaration_source == "acceptance_plan+trusted_ci"
                                else "model_declaration+matching_tool_call"
                            ),
                            "declaration_source": declaration_source,
                            "tool_name": matching_action["name"],
                            "tool_kind": matching_action["kind"],
                            "change_hash": matching_action.get("change_hash") or None,
                            "changed_paths": matching_action.get("changed_paths") or [],
                            "attribution": attribution,
                        },
                    )
                )
                latest = AssetState.USED

            if latest is AssetState.USED:
                effective_tests = (
                    declaration.get("validation_test_ids") or asset.tests
                )
                validation = self._successful_validation(state, effective_tests, declaration["target"])
                if validation is not None:
                    call, result, matched_tests = validation
                    evidence_ref = result.get("evidence_ref") or f"tool-result:{call['id']}"
                    used_event = next(
                        (
                            event for event in reversed(
                                self.ledger.events(
                                    trace_id=package.trace_id,
                                    task_id=package.task.task_id,
                                    asset_id=asset.asset_id,
                                )
                            )
                            if event.state is AssetState.USED
                        ),
                        None,
                    )
                    usage = (
                        dict(used_event.detail.get("attribution") or {})
                        if used_event is not None else {}
                    )
                    attribution = validation_attribution(
                        asset,
                        usage,
                        matched_tests=matched_tests,
                        evidence_ref=str(evidence_ref),
                        result_success=True,
                        expected_tests=effective_tests,
                    )
                    appended.append(
                        self.ledger.append(
                            trace_id=package.trace_id,
                            task_id=package.task.task_id,
                            asset_id=asset.asset_id,
                            state=AssetState.VALIDATED,
                            actor_type="validator",
                            actor_id="codebuddy-tool-observer",
                            evidence_ref=str(evidence_ref),
                            detail={
                                "command": call.get("command"),
                                "summary": result.get("summary"),
                                "required_tests": effective_tests,
                                "asset_test_hints": asset.tests,
                                "matched_tests": matched_tests,
                                "attribution": attribution,
                            },
                        )
                    )
        return appended

    @staticmethod
    def _matching_action(state: TraceObservationState, target: str) -> Optional[Dict[str, Any]]:
        path = target.removeprefix("test:").split(":", 1)[0].strip()
        for call in reversed(list(state.tool_calls.values())):
            haystack = " ".join(
                str(call.get(key, "")) for key in ("target", "command", "arguments")
            )
            if target.startswith("test:"):
                if call.get("kind") == "test" and _test_target_matches(call, state.tool_results.get(call["id"], {}), target):
                    return call
            elif call.get("kind") == "edit" and path and path in haystack:
                return call
        return None

    @staticmethod
    def _successful_validation(
        state: TraceObservationState,
        required_tests: Iterable[str],
        declared_target: str = "",
    ) -> Optional[tuple[Dict[str, Any], Dict[str, Any], List[str]]]:
        required = [str(item) for item in required_tests]
        for call in reversed(list(state.tool_calls.values())):
            if call.get("kind") != "test":
                continue
            # Assets without historical test IDs still need a result from the
            # declared validation action, not an unrelated successful probe.
            if not required and declared_target.startswith("test:"):
                if not _test_target_matches(call, state.tool_results.get(call["id"], {}), declared_target):
                    continue
            result = state.tool_results.get(str(call.get("id")))
            if not result or result.get("success") is not True:
                continue
            observed_ids = {
                *[str(item) for item in call.get("test_ids", [])],
                *[str(item) for item in result.get("test_ids", [])],
            }
            command_and_result = f"{call.get('command', '')} {result.get('summary', '')}"
            matched = [
                name
                for name in required
                if name in command_and_result or any(name in observed for observed in observed_ids)
            ]
            # A generic "9 passed" proves the suite, not the causal link from
            # this particular asset to its required checks. At least one
            # explicitly named required test is needed for per-asset validation.
            if not required:
                return call, result, sorted(observed_ids)
            if matched:
                return call, result, matched
        return None


def _test_target_matches(call: Dict[str, Any], result: Dict[str, Any], target: str) -> bool:
    raw = target.removeprefix("test:").strip()
    observed = {str(item) for item in [*call.get("test_ids", []), *result.get("test_ids", [])]}
    haystack = " ".join(str(call.get(key, "")) for key in ("target", "command", "arguments"))
    # Accept the model's file/test_a,test_b notation only when both the
    # file and every named test were actually observed, never by prose alone.
    grouped = re.fullmatch(r"(.+\.py)/(test_\w+(?:,test_\w+)*)", raw)
    if grouped:
        return grouped[1] in haystack and set(grouped[2].split(",")) <= observed
    path = raw.split(":", 1)[0].strip()
    return bool(path and (path in observed or path in haystack))


def _dicts(value: Any) -> List[Dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _strings(value: Any, *, limit: int) -> List[str]:
    if not isinstance(value, list):
        return []
    return [str(item)[:limit] for item in value if str(item)]


def _signature(kind: str, value: Dict[str, Any]) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(f"{kind}:{raw}".encode("utf-8")).hexdigest()
