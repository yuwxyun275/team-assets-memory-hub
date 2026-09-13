from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, Iterable, List, Mapping, Sequence

from .ledger import EvidenceLedger
from .models import AssetState, ContextPackage


@dataclass
class AcceptanceContract:
    required_tests: List[str]
    require_code_change: bool
    target_paths: List[str]
    source: str
    criteria: List[str] = field(default_factory=list)
    version: str = "2"
    suggested_criteria: List[str] = field(default_factory=list)
    criteria_status: str = ""
    generated_by: str = ""
    verification_policy: str = "observed_tool"

    def __post_init__(self) -> None:
        allowed = {"not_requested", "proposed", "confirmed", "not_required"}
        if self.criteria_status not in allowed:
            self.criteria_status = "confirmed" if self.criteria else "not_requested"
        if self.verification_policy not in {"observed_tool", "trusted_ci"}:
            self.verification_policy = "trusted_ci"

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "AcceptanceContract":
        return cls(
            required_tests=_strings(value.get("required_tests")),
            require_code_change=value.get("require_code_change") is True,
            target_paths=_strings(value.get("target_paths")),
            source=str(value.get("source") or "unknown"),
            criteria=_strings(value.get("criteria")),
            version=str(value.get("version") or "2"),
            suggested_criteria=_strings(value.get("suggested_criteria")),
            criteria_status=str(value.get("criteria_status") or ""),
            generated_by=str(value.get("generated_by") or ""),
            verification_policy=str(value.get("verification_policy") or "observed_tool"),
        )


@dataclass
class TaskExecutionEvidence:
    changed_paths: List[str] = field(default_factory=list)
    tests: Dict[str, bool] = field(default_factory=dict)
    test_evidence: Dict[str, str] = field(default_factory=dict)
    independent_tests: Dict[str, bool] = field(default_factory=dict)
    independent_test_evidence: Dict[str, str] = field(default_factory=dict)
    acceptance_declarations: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    asset_declarations: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    observed_tool_calls: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    observed_tool_results: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    tool_call_ids: List[str] = field(default_factory=list)
    edit_call_ids: List[str] = field(default_factory=list)

    def observe(self, payload: Mapping[str, Any]) -> None:
        independent = (
            str(payload.get("evidence_origin") or "") == "trusted_ci"
            or (
                isinstance(payload.get("ci_run"), dict)
                and payload["ci_run"].get("trusted_for_validation") is True
            )
        )
        for declaration in _dicts(payload.get("acceptance_declarations")):
            criterion_id = str(declaration.get("criterion_id") or "").strip()
            if not criterion_id.startswith("criterion-"):
                continue
            mode = str(declaration.get("mode") or "automated").strip().lower()
            if mode not in {"automated", "manual"}:
                mode = "automated"
            self.acceptance_declarations[criterion_id] = {
                "criterion_id": criterion_id[:80],
                "mode": mode,
                "test_ids": _strings(declaration.get("test_ids")),
                "targets": _strings(declaration.get("targets")),
                "note": str(declaration.get("note") or "")[:1200],
                "mapping_source": str(declaration.get("mapping_source") or "codebuddy_declared")[:120],
            }

        for declaration in _dicts(payload.get("declarations")):
            asset_id = str(declaration.get("asset_id") or "").strip()
            decision = str(declaration.get("decision") or "").strip()
            target = str(declaration.get("target") or "").strip()
            if asset_id and decision and target:
                value = {
                    "asset_id": asset_id[:200],
                    "decision": decision[:1200],
                    "target": target[:600],
                    "source": str(declaration.get("source") or "model_declaration")[:120],
                    "evidence_ref": str(declaration.get("evidence_ref") or "")[:600],
                }
                # Only the server-derived plan+CI reconciliation path emits
                # these IDs. They let a repository's current test names prove
                # an asset whose historical metadata used older test aliases.
                if value["source"] == "acceptance_plan+trusted_ci":
                    value["validation_test_ids"] = _strings(
                        declaration.get("validation_test_ids")
                    )
                self.asset_declarations[asset_id] = value

        incoming_calls = {
            str(call.get("id")): call
            for call in _dicts(payload.get("tool_calls"))
            if str(call.get("id", ""))
        }
        for call_id, call in incoming_calls.items():
            self.observed_tool_calls[call_id] = {
                "id": call_id[:200],
                "name": str(call.get("name") or "unknown")[:200],
                "kind": str(call.get("kind") or "other")[:40],
                "target": str(call.get("target") or "")[:600],
                "command": str(call.get("command") or "")[:1200],
                "arguments": str(call.get("arguments") or "")[:2000],
                "change_hash": str(call.get("change_hash") or "")[:120],
                "changed_paths": _strings(call.get("changed_paths")),
                "test_ids": _strings(call.get("test_ids")),
            }
        calls = self.observed_tool_calls
        known_calls = set(self.tool_call_ids)
        known_edits = set(self.edit_call_ids)
        changed = set(self.changed_paths)
        for call_id, call in calls.items():
            known_calls.add(call_id)
            if str(call.get("kind")) == "edit":
                known_edits.add(call_id)
                changed.update(_strings(call.get("changed_paths")))
                target = str(call.get("target") or "").strip()
                if target:
                    changed.add(target)

        for result in _dicts(payload.get("tool_results")):
            call_id = str(result.get("tool_call_id") or "")
            call = calls.get(call_id)
            if call_id:
                self.observed_tool_results[call_id] = {
                    "tool_call_id": call_id[:200],
                    "success": result.get("success") is True,
                    "summary": str(result.get("summary") or "")[:1200],
                    "evidence_ref": str(result.get("evidence_ref") or f"tool-result:{call_id}")[:600],
                    "test_ids": _strings(result.get("test_ids")),
                }
            if call is None or str(call.get("kind")) != "test":
                continue
            test_ids = {
                *_strings(call.get("test_ids")),
                *_strings(result.get("test_ids")),
            }
            if not test_ids:
                continue
            passed = result.get("success") is True
            evidence_ref = str(result.get("evidence_ref") or f"tool-result:{call_id}")[:600]
            for test_id in test_ids:
                # A later successful rerun may repair a prior failure; a later
                # failure must also invalidate an earlier pass.
                self.tests[test_id] = passed
                self.test_evidence[test_id] = evidence_ref
                if independent:
                    self.independent_tests[test_id] = passed
                    self.independent_test_evidence[test_id] = evidence_ref
        self.changed_paths = sorted(changed)
        self.tool_call_ids = sorted(known_calls)
        self.edit_call_ids = sorted(known_edits)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "changed_paths": self.changed_paths,
            "tests": self.tests,
            "test_evidence": self.test_evidence,
            "independent_tests": self.independent_tests,
            "independent_test_evidence": self.independent_test_evidence,
            "acceptance_declarations": self.acceptance_declarations,
            "asset_declarations": self.asset_declarations,
            "observed_tool_calls": self.observed_tool_calls,
            "observed_tool_results": self.observed_tool_results,
            "tool_call_ids": self.tool_call_ids,
            "edit_call_ids": self.edit_call_ids,
        }

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "TaskExecutionEvidence":
        tests = value.get("tests") if isinstance(value.get("tests"), dict) else {}
        evidence = value.get("test_evidence") if isinstance(value.get("test_evidence"), dict) else {}
        independent_tests = (
            value.get("independent_tests")
            if isinstance(value.get("independent_tests"), dict)
            else {}
        )
        independent_evidence = (
            value.get("independent_test_evidence")
            if isinstance(value.get("independent_test_evidence"), dict)
            else {}
        )
        declarations = (
            value.get("acceptance_declarations")
            if isinstance(value.get("acceptance_declarations"), dict)
            else {}
        )
        asset_declarations = (
            value.get("asset_declarations")
            if isinstance(value.get("asset_declarations"), dict)
            else {}
        )
        observed_calls = (
            value.get("observed_tool_calls")
            if isinstance(value.get("observed_tool_calls"), dict)
            else {}
        )
        observed_results = (
            value.get("observed_tool_results")
            if isinstance(value.get("observed_tool_results"), dict)
            else {}
        )
        return cls(
            changed_paths=_strings(value.get("changed_paths")),
            tests={str(name): passed is True for name, passed in tests.items()},
            test_evidence={str(name): str(ref) for name, ref in evidence.items()},
            independent_tests={str(name): passed is True for name, passed in independent_tests.items()},
            independent_test_evidence={str(name): str(ref) for name, ref in independent_evidence.items()},
            acceptance_declarations={
                str(name): dict(item)
                for name, item in declarations.items()
                if isinstance(item, dict)
            },
            asset_declarations={
                str(name): dict(item)
                for name, item in asset_declarations.items()
                if isinstance(item, dict)
            },
            observed_tool_calls={
                str(name): dict(item)
                for name, item in observed_calls.items()
                if isinstance(item, dict)
            },
            observed_tool_results={
                str(name): dict(item)
                for name, item in observed_results.items()
                if isinstance(item, dict)
            },
            tool_call_ids=_strings(value.get("tool_call_ids")),
            edit_call_ids=_strings(value.get("edit_call_ids")),
        )

    def observer_payload(self, *, actor_id: str = "") -> Dict[str, Any]:
        """Return the durable subset needed to rebuild attribution state."""
        return {
            "actor_id": actor_id,
            "declarations": list(self.asset_declarations.values()),
            "tool_calls": list(self.observed_tool_calls.values()),
            "tool_results": list(self.observed_tool_results.values()),
        }


def acceptance_contract(
    task_detail: Mapping[str, Any],
    package: ContextPackage,
) -> AcceptanceContract:
    metadata = _json_object(task_detail.get("metadata_json"))
    declared = metadata.get("team_asset_acceptance")
    if isinstance(declared, dict):
        confirmed_criteria = _strings(declared.get("criteria"))
        suggested_criteria = _strings(declared.get("suggested_criteria"))
        status = str(declared.get("criteria_status") or "")
        if status not in {"not_requested", "proposed", "confirmed", "not_required"}:
            status = "confirmed" if confirmed_criteria else ("proposed" if suggested_criteria else "not_requested")
        criteria = confirmed_criteria or suggested_criteria
        if not criteria and status != "not_required":
            criteria = suggest_acceptance_criteria(
                str(task_detail.get("title") or package.task.title),
                str(task_detail.get("description") or package.task.description),
                package.task.task_type,
            )
            suggested_criteria = list(criteria)
            status = "proposed" if criteria else "not_requested"
        declared_tests = _strings(declared.get("required_tests"))
        declared_paths = _strings(declared.get("target_paths"))
        inferred_tests = sorted({test for item in package.selected for test in item.asset.tests})
        code_change_setting = declared.get("require_code_change")
        return AcceptanceContract(
            required_tests=declared_tests or inferred_tests,
            require_code_change=(
                code_change_setting
                if isinstance(code_change_setting, bool)
                else package.task.task_type in {"bug_fix", "feature"}
            ),
            target_paths=declared_paths or list(package.task.target_paths),
            criteria=criteria,
            suggested_criteria=suggested_criteria,
            criteria_status=status,
            generated_by=str(declared.get("generated_by") or ("deterministic-task-analyzer/v1" if status == "proposed" else "")),
            source=(
                "memory_hub_task.metadata_json.team_asset_acceptance"
                if declared_tests and declared_paths and isinstance(code_change_setting, bool)
                else "memory_hub_task_acceptance_with_runtime_inference"
            ),
            version=str(declared.get("version") or "2"),
            verification_policy=str(declared.get("verification_policy") or "trusted_ci"),
        )
    tests = sorted({test for item in package.selected for test in item.asset.tests})
    suggested = suggest_acceptance_criteria(
        str(task_detail.get("title") or package.task.title),
        str(task_detail.get("description") or package.task.description),
        package.task.task_type,
    )
    return AcceptanceContract(
        required_tests=tests,
        require_code_change=package.task.task_type in {"bug_fix", "feature"},
        target_paths=list(package.task.target_paths),
        source="system_generated_acceptance_with_team_asset_fallback",
        criteria=suggested,
        suggested_criteria=suggested,
        criteria_status="proposed" if suggested else "not_requested",
        generated_by="deterministic-task-analyzer/v1" if suggested else "",
        verification_policy="trusted_ci",
    )


def render_acceptance_context(contract: AcceptanceContract) -> str:
    """Render the task owner's definition of done for CodeBuddy.

    The model may propose a criterion-to-test mapping, but only observed tool
    results can satisfy it. This keeps planning flexible and verification
    independent from model self-reporting.
    """
    if not contract.criteria:
        return ""
    proposed = contract.criteria_status == "proposed"
    lines = [
        "<task_acceptance>",
        (
            "以下是系统根据任务描述生成的候选验收标准。它们用于发现测试覆盖缺口，"
            "在负责人确认前不代表业务已经验收："
            if proposed else
            "以下验收标准已经由任务负责人确认，属于本次任务的完成条件："
        ),
    ]
    for index, criterion in enumerate(contract.criteria, start=1):
        lines.append(f"[criterion-{index}] {criterion}")
    lines.extend(
        [
            "",
            "工作要求：",
            "1. 先把每条标准映射到仓库已有测试和团队 Skill；没有覆盖的标准要明确列为缺口并补充测试。",
            "2. 必须通过真实测试工具运行获得结果；失败、未运行或只口头说明都不算通过。",
            "3. 为每条标准确定验证方法后，最迟在调用对应测试工具的同一轮，先输出一条机器可读证据登记：",
            '<acceptance_evidence>{"criterion_id":"criterion-1","mode":"automated","test_ids":["test_name"],"targets":["path/to/file.py"],"note":"测试验证了什么"}</acceptance_evidence>',
            "4. 这只是测试计划登记，不代表通过；test_ids 必须与随后真实测试命令/结果中的名称一致，targets 必须与真实修改路径一致。",
            "5. 无法自动验证时使用 mode=manual，并说明原因；系统会标记为待人工确认，不会自动通过。",
            "6. 新增测试应作为普通仓库代码提交，现有 CI 会与回归测试一起执行；不要修改 CI 来隐藏失败。",
            "7. 阅读真实代码和测试后，如候选标准需要修订，可输出一次机器可读计划；这仍然只是建议，不能代表通过：",
            '<acceptance_plan>{"criteria":[{"text":"要验证的行为","category":"business","rationale":"为什么适用于当前任务","source_asset_ids":["asset-id"],"target_paths":["path/to/file.py"],"candidate_test_ids":["test_name"]}]}</acceptance_plan>',
        ]
    )
    if contract.required_tests:
        lines.append(f"任务级必须通过的测试：{'; '.join(contract.required_tests)}")
    if contract.target_paths:
        lines.append(f"任务级候选代码位置：{'; '.join(contract.target_paths)}")
    lines.append("</task_acceptance>")
    return "\n".join(lines)


def _evaluate_criteria(
    contract: AcceptanceContract,
    execution: TaskExecutionEvidence,
) -> List[Dict[str, Any]]:
    verified_tests = (
        execution.independent_tests
        if contract.verification_policy == "trusted_ci"
        else execution.tests
    )
    verified_evidence = (
        execution.independent_test_evidence
        if contract.verification_policy == "trusted_ci"
        else execution.test_evidence
    )
    results: List[Dict[str, Any]] = []
    for index, text in enumerate(contract.criteria, start=1):
        criterion_id = f"criterion-{index}"
        declaration = execution.acceptance_declarations.get(criterion_id)
        if declaration is None:
            results.append({
                "criterion_id": criterion_id,
                "text": text,
                "status": "pending",
                "reason": "CodeBuddy 尚未登记测试或人工验收方式",
                "test_ids": [],
                "targets": [],
                "evidence_refs": [],
            })
            continue

        mode = str(declaration.get("mode") or "automated")
        tests = _strings(declaration.get("test_ids"))
        targets = _strings(declaration.get("targets"))
        if mode == "manual":
            results.append({
                "criterion_id": criterion_id,
                "text": text,
                "status": "manual_review",
                "reason": str(declaration.get("note") or "需要人工确认"),
                "test_ids": tests,
                "targets": targets,
                "evidence_refs": [],
            })
            continue

        passed = [name for name in tests if verified_tests.get(name) is True]
        failed = [name for name in tests if verified_tests.get(name) is False]
        missing = [name for name in tests if name not in verified_tests]
        matched_paths = sorted({
            changed
            for changed in execution.changed_paths
            for target in targets
            if _path_matches(changed, target)
        })
        if not tests:
            status = "pending"
            reason = "没有登记可执行测试"
        elif failed:
            status = "failed"
            reason = f"测试失败：{'、'.join(failed)}"
        elif missing:
            status = "pending"
            reason = (
                f"尚未收到可信 CI 结果：{'、'.join(missing)}"
                if contract.verification_policy == "trusted_ci"
                else f"测试尚未运行：{'、'.join(missing)}"
            )
        elif contract.require_code_change and targets and not matched_paths:
            status = "pending"
            reason = "声明的代码位置没有观察到真实修改"
        else:
            status = "passed"
            reason = "真实测试结果与代码修改证据匹配" if contract.require_code_change else "登记的回归测试已实际通过；本任务不要求修改实现"
        results.append({
            "criterion_id": criterion_id,
            "text": text,
            "status": status,
            "reason": reason,
            "test_ids": tests,
            "passed_tests": passed,
            "failed_tests": failed,
            "missing_tests": missing,
            "targets": targets,
            "matched_paths": matched_paths,
            "evidence_refs": sorted({
                verified_evidence[name]
                for name in passed
                if name in verified_evidence
            }),
            "note": str(declaration.get("note") or ""),
            "mapping_source": str(declaration.get("mapping_source") or "codebuddy_declared"),
        })
    return results


def evaluate_completion(
    package: ContextPackage,
    ledger: EvidenceLedger,
    contract: AcceptanceContract,
    execution: TaskExecutionEvidence,
) -> Dict[str, Any]:
    latest = {
        item.asset.asset_id: ledger.latest_state(package.trace_id, package.task.task_id, item.asset.asset_id)
        for item in package.selected
    }
    used = sum(
        state in {AssetState.USED, AssetState.VALIDATED, AssetState.CONTRIBUTED}
        for state in latest.values()
    )
    validated = sum(
        state in {AssetState.VALIDATED, AssetState.CONTRIBUTED}
        for state in latest.values()
    )
    required = list(dict.fromkeys(contract.required_tests))
    verified_tests = (
        execution.independent_tests
        if contract.verification_policy == "trusted_ci"
        else execution.tests
    )
    passed = [name for name in required if verified_tests.get(name) is True]
    failed = [name for name in required if verified_tests.get(name) is False]
    missing = [name for name in required if name not in verified_tests]
    target_match = any(
        _path_matches(path, target)
        for path in execution.changed_paths
        for target in contract.target_paths
    )
    code_change_ok = not contract.require_code_change or target_match
    criterion_results = _evaluate_criteria(contract, execution)
    criteria_passed = sum(item["status"] == "passed" for item in criterion_results)
    all_criteria_verified = not criterion_results or criteria_passed == len(criterion_results)
    selected_count = len(package.selected)
    asset_evidence_checks = {
        "assets_selected": selected_count > 0,
        "all_selected_assets_used": selected_count > 0 and used == selected_count,
        "all_used_assets_validated": selected_count > 0 and validated == selected_count,
    }
    coding_task = package.task.task_type in {"bug_fix", "feature"}
    all_required_tests_passed = not required or len(passed) == len(required)
    no_observed_test_failures = not any(value is False for value in verified_tests.values())
    automated_evidence_observed = bool(verified_tests) or package.task.task_type not in {"bug_fix", "feature", "test"}
    engineering_checks = {
        "all_required_tests_passed": all_required_tests_passed,
        "no_observed_test_failures": no_observed_test_failures,
        "automated_test_evidence_observed": automated_evidence_observed,
        "required_code_change_observed": code_change_ok,
    }
    business_acceptance_complete = (
        contract.criteria_status == "not_required"
        or (
            contract.criteria_status == "confirmed"
            and bool(criterion_results)
            and all_criteria_verified
        )
    )
    business_acceptance_status = (
        "not_required" if contract.criteria_status == "not_required"
        else "proposed" if contract.criteria_status == "proposed"
        else "not_defined" if contract.criteria_status == "not_requested"
        else "passed" if business_acceptance_complete
        else "pending"
    )
    outcome_checks = {
        **engineering_checks,
        "all_acceptance_criteria_verified": all_criteria_verified,
        "business_acceptance_complete": business_acceptance_complete,
    }
    checks = {**asset_evidence_checks, **outcome_checks}
    # CI/验收回答“代码结果是否正确”，资产采用链只回答“哪些推荐真正有用”。
    # 一项推荐被忽略不应把已经通过独立验证的功能重新判成失败。
    engineering_complete = all(engineering_checks.values())
    # ``task_completed`` is kept as the engineering-compatible status used by
    # existing Task/CI integrations. Business acceptance is reported
    # independently and never inferred from a model suggestion.
    completed = engineering_complete
    if engineering_complete and business_acceptance_complete:
        completion_state = "completed"
    elif engineering_complete:
        completion_state = "engineering_completed_business_pending"
    elif failed or any(value is False for value in execution.tests.values()):
        completion_state = "engineering_failed"
    else:
        completion_state = "pending"
    if engineering_complete:
        status = "completed"
    elif used or execution.tool_call_ids:
        status = "in_progress"
    else:
        status = "pending"
    return {
        "status": status,
        "task_completed": completed,
        "completion_state": completion_state,
        "engineering_complete": engineering_complete,
        "business_acceptance_complete": business_acceptance_complete,
        "business_acceptance_status": business_acceptance_status,
        "acceptance_status": contract.criteria_status,
        "contract_source": contract.source,
        "contract_version": contract.version,
        "verification_policy": contract.verification_policy,
        "checks": checks,
        "outcome_checks": outcome_checks,
        "engineering_checks": engineering_checks,
        "asset_evidence_checks": asset_evidence_checks,
        "selected_assets": selected_count,
        "used_assets": used,
        "validated_assets": validated,
        "required_tests": required,
        "passed_tests": passed,
        "failed_tests": failed,
        "missing_tests": missing,
        "test_progress": {"passed": len(passed), "total": len(required)},
        "criterion_results": criterion_results,
        "criterion_progress": {"passed": criteria_passed, "total": len(criterion_results)},
        "changed_paths": execution.changed_paths,
        "target_paths": contract.target_paths,
        "tool_calls": len(execution.tool_call_ids),
        "edit_attempts": len(execution.edit_call_ids),
    }


def suggest_acceptance_criteria(title: str, description: str, task_type: str = "") -> List[str]:
    """Create explainable candidate criteria without claiming business authority."""
    text = f"{title}\n{description}".lower()
    result: List[str] = []
    is_bug = task_type == "bug_fix" or _contains(text, "修复", "故障", "异常", "报错", "失败", "超时", "5xx", "bug", "fix")
    is_feature = task_type == "feature" or _contains(text, "新增", "实现", "支持", "功能", "feature")
    is_cache = _contains(text, "redis", "缓存", "cache")
    is_timeout = _contains(text, "超时", "timeout", "5xx", "不可用", "故障")
    is_tenant = _contains(text, "租户", "tenant", "权限", "越权", "泄漏", "隔离")
    # “数据库/MySQL”也可能只是读取来源，不能据此推断写入一致性要求。
    is_write = _contains(text, "写入", "更新记录", "删除", "保存", "insert", "update", "delete", "事务")
    if is_bug:
        result.append("问题场景能够被稳定复现，修复后原问题不再出现")
    elif is_feature:
        result.append("任务描述中的目标功能在正常输入下可用，并有可重复的验证证据")
    else:
        result.append("任务描述中的目标结果能够被重复验证")
    if is_cache and is_timeout:
        result.extend([
            "缓存不可用或超时时，服务能够安全降级且不会产生未处理的 5xx",
            "缓存恢复后重新使用正常路径，不把故障期结果长期污染为正常结果",
        ])
    if is_tenant:
        result.append("任何异常与降级路径都保持权限边界，不读取或返回其他租户的数据")
    if is_write:
        result.append("失败与重试不会造成重复写入、部分提交或数据不一致")
    result.extend([
        "受影响模块的现有自动化测试与回归检查保持通过",
        "新增或改变的关键行为有自动化测试覆盖；无法自动化的部分明确标记为待人工确认",
    ])
    return list(dict.fromkeys(result))[:5]


def _contains(text: str, *terms: str) -> bool:
    return any(term in text for term in terms)


def _path_matches(changed: str, target: str) -> bool:
    changed = _comparable_path(changed)
    target = _comparable_path(target)
    if not changed or not target:
        return False
    changed_absolute = changed.startswith("/")
    target_absolute = target.startswith("/")
    # Two absolute paths must identify the same repository location.  A mere
    # shared suffix (for example two different repos containing service.py)
    # is not trustworthy evidence.
    if changed_absolute and target_absolute:
        return changed == target
    if changed_absolute:
        return changed.endswith("/" + target)
    if target_absolute:
        return target.endswith("/" + changed)
    return changed == target


def _comparable_path(value: str) -> str:
    """Normalize evidence paths without assuming which side is repository-relative."""
    path = str(value or "").strip().replace("\\", "/").removeprefix("file://")
    # Declarations may point at ``file.py:Symbol`` or ``file.py:42``.
    for extension in (".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".java", ".rs"):
        marker = path.find(extension + ":")
        if marker >= 0:
            path = path[: marker + len(extension)]
            break
    while path.startswith("./"):
        path = path[2:]
    while "//" in path:
        path = path.replace("//", "/")
    return path.rstrip("/")


def _dicts(value: Any) -> List[Dict[str, Any]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _strings(value: Any) -> List[str]:
    return [str(item) for item in value if str(item)] if isinstance(value, (list, tuple, set)) else []


def _json_object(value: Any) -> Dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    try:
        parsed = json.loads(str(value or "{}"))
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}
