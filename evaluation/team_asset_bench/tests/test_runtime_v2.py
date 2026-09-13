from team_asset_bench.catalog import load_task, project_root
import json

from team_asset_bench.completion import AcceptanceContract, TaskExecutionEvidence, acceptance_contract, _evaluate_criteria, evaluate_completion
from team_asset_bench.ledger import EvidenceLedger
from team_asset_bench.models import ContextPackage
from team_asset_bench.models import AssetState
from team_asset_bench.register_hub import ACCEPTANCE_TESTS
from team_asset_bench.server import TeamAssetApi


USES = {
    "asset-wiki-tenant-fallback": (
        "遵守团队多租户已发布配置约束",
        "feature_flags/service.py:FeatureFlagService.get_flag",
    ),
    "asset-memory-retry-storm": (
        "禁止 Redis 请求内重试风暴",
        "feature_flags/service.py:FeatureFlagService.get_flag",
    ),
    "asset-codegraph-cache-boundary": (
        "把修改收敛在缓存读取边界",
        "feature_flags/service.py:FeatureFlagService.get_flag",
    ),
    "asset-skill-cache-fault-recovery": (
        "执行故障和恢复回归流程",
        "test:pytest -q tests hidden_tests",
    ),
}


def test_regression_acceptance_does_not_require_an_unnecessary_implementation_edit():
    from dataclasses import replace
    contract = AcceptanceContract(source="test", required_tests=["test_existing"], require_code_change=False,
        target_paths=["inventory.py"], criteria=["重复请求不重复扣减"], verification_policy="trusted_ci")
    execution = TaskExecutionEvidence(independent_tests={"test_existing": True},
        independent_test_evidence={"test_existing": "sha256:ci"},
        acceptance_declarations={"criterion-1": {"mode": "automated", "test_ids": ["test_existing"], "targets": ["inventory.py"]}})
    assert _evaluate_criteria(contract, execution)[0]["status"] == "passed"
    assert _evaluate_criteria(replace(contract, require_code_change=True), execution)[0]["status"] == "pending"
    execution.independent_tests = {}
    assert _evaluate_criteria(contract, execution)[0]["status"] == "pending"


def test_regression_task_cannot_complete_before_any_test_result():
    from dataclasses import replace
    task = replace(load_task(project_root()), task_type="test")
    package = ContextPackage("regression", task, [], [], [], 0, "")
    contract = AcceptanceContract(source="test", required_tests=[], require_code_change=False, target_paths=[])
    assert evaluate_completion(package, EvidenceLedger(), contract, TaskExecutionEvidence())["engineering_complete"] is False


def _selected(api: TeamAssetApi, trace_id: str):
    result = api.select({"trace_id": trace_id, "task": load_task(project_root()).to_dict()})
    selected = [item["asset"]["asset_id"] for item in result["selected"]]
    api.contracts[trace_id] = AcceptanceContract(
        required_tests=list(ACCEPTANCE_TESTS),
        require_code_change=True,
        target_paths=["feature_flags/service.py"],
        source="test_task_contract",
    )
    api.confirm_injected({
        "trace_id": trace_id,
        "asset_ids": selected,
        "context_hash": "sha256:test-context",
        "protocol": "openai",
        "injection_point": "system.suffix:task_context",
        "request_trace_id": "request-test",
    })
    return selected


def _observe(api: TeamAssetApi, trace_id: str, tests):
    api.observe({
        "trace_id": trace_id,
        "actor_id": "agent-new-backend",
        "declarations": [
            {"asset_id": asset_id, "decision": decision, "target": target}
            for asset_id, (decision, target) in USES.items()
        ],
        "tool_calls": [
            {
                "id": "edit-1",
                "name": "apply_patch",
                "kind": "edit",
                "target": "feature_flags/service.py",
                "changed_paths": ["feature_flags/service.py"],
                "change_hash": "sha256:change",
            },
            {
                "id": "test-1",
                "name": "shell",
                "kind": "test",
                "target": "tests hidden_tests",
                "command": "pytest -q tests hidden_tests " + " ".join(tests),
                "test_ids": list(tests),
            },
        ],
        "tool_results": [
            {
                "tool_call_id": "test-1",
                "success": True,
                "summary": f"{len(tests)} passed; " + " ".join(tests),
                "evidence_ref": "sha256:test-result",
                "test_ids": list(tests),
            }
        ],
    })


def test_empty_advanced_fields_use_runtime_recommendations(tmp_path):
    api = TeamAssetApi(project_root(), tmp_path / "runtime.sqlite3")
    trace_id = "trace-auto-acceptance"
    api.select({"trace_id": trace_id, "task": load_task(project_root()).to_dict()})
    package = api.packages[trace_id]
    detail = {
        "metadata_json": json.dumps({
            "team_asset_acceptance": {
                "criteria": ["缓存故障时接口仍能安全返回"],
                "required_tests": [],
                "require_code_change": None,
                "target_paths": [],
            }
        }, ensure_ascii=False)
    }

    contract = acceptance_contract(detail, package)

    assert contract.required_tests
    assert contract.criteria == ["缓存故障时接口仍能安全返回"]
    assert contract.target_paths == package.task.target_paths
    assert contract.require_code_change is True
    assert contract.source == "memory_hub_task_acceptance_with_runtime_inference"


def test_empty_human_acceptance_becomes_proposed_candidate_not_business_fact(tmp_path):
    api = TeamAssetApi(project_root(), tmp_path / "runtime.sqlite3")
    trace_id = "trace-proposed-acceptance"
    api.select({"trace_id": trace_id, "task": load_task(project_root()).to_dict()})
    package = api.packages[trace_id]
    detail = {
        "title": "修复 Redis 故障时接口超时",
        "description": "缓存不可用时安全回退数据库",
        "metadata_json": json.dumps({
            "team_asset_acceptance": {
                "version": "2",
                "criteria": [],
                "suggested_criteria": [],
                "criteria_status": "not_requested",
                "required_tests": [],
                "target_paths": [],
            }
        }, ensure_ascii=False),
    }

    contract = acceptance_contract(detail, package)

    assert contract.criteria_status == "proposed"
    assert contract.suggested_criteria
    assert any("缓存" in item for item in contract.suggested_criteria)


def test_human_criteria_require_real_test_evidence(tmp_path):
    api = TeamAssetApi(project_root(), tmp_path / "runtime.sqlite3")
    trace_id = "trace-criterion-evidence"
    _selected(api, trace_id)
    api.contracts[trace_id] = AcceptanceContract(
        required_tests=["test_outage_never_leaks_another_tenant"],
        require_code_change=True,
        target_paths=["feature_flags/service.py"],
        source="test_task_contract",
        criteria=["Redis 故障时不得读取其他租户数据"],
    )
    api.observe({
        "trace_id": trace_id,
        "actor_id": "agent-new-backend",
        "acceptance_declarations": [{
            "criterion_id": "criterion-1",
            "mode": "automated",
            "test_ids": ["test_outage_never_leaks_another_tenant"],
            "targets": ["feature_flags/service.py"],
            "note": "隔离测试覆盖 Redis 故障路径",
        }],
        "declarations": [
            {"asset_id": asset_id, "decision": decision, "target": target}
            for asset_id, (decision, target) in USES.items()
        ],
        "tool_calls": [{
            "id": "edit-criterion",
            "name": "apply_patch",
            "kind": "edit",
            "target": "feature_flags/service.py",
            "changed_paths": ["feature_flags/service.py"],
        }, {
            "id": "test-criterion",
            "name": "shell",
            "kind": "test",
            "command": "pytest -q tests/test_service.py::test_outage_never_leaks_another_tenant",
            "test_ids": ["test_outage_never_leaks_another_tenant"],
        }],
        "tool_results": [{
            "tool_call_id": "test-criterion",
            "success": True,
            "summary": "1 passed: test_outage_never_leaks_another_tenant",
            "evidence_ref": "sha256:criterion-test-result",
            "test_ids": ["test_outage_never_leaks_another_tenant"],
        }],
    })
    completion = api.receipt(trace_id)["completion"]
    assert completion["checks"]["all_acceptance_criteria_verified"] is True
    assert completion["criterion_progress"] == {"passed": 1, "total": 1}
    assert completion["criterion_results"][0]["status"] == "passed"
    assert completion["criterion_results"][0]["evidence_refs"] == ["sha256:criterion-test-result"]
    assert completion["engineering_complete"] is True
    assert completion["business_acceptance_complete"] is True


def test_trusted_ci_maps_repository_tests_to_confirmed_criteria(tmp_path):
    api = TeamAssetApi(project_root(), tmp_path / "runtime.sqlite3")
    trace_id = "trace-ci-criteria-mapping"
    _selected(api, trace_id)
    api.contracts[trace_id] = AcceptanceContract(
        required_tests=["test_outage_does_not_retry_redis"],
        require_code_change=True,
        target_paths=["feature_flags/service.py"],
        source="confirmed_task_contract",
        criteria=["Redis 故障时单次请求不得重复重试缓存"],
        criteria_status="confirmed",
    )

    response = api.record_ci_run({
        "trace_id": trace_id,
        "provider": "local-ci",
        "changed_paths": ["feature_flags/service.py"],
        "checks": [{
            "id": "pytest",
            "name": "仓库 pytest",
            "status": "passed",
            "test_ids": ["test_outage_does_not_retry_redis"],
            "evidence_ref": "sha256:ci-test-output",
        }],
        "verification_discovery": {
            "schema_version": "team-asset-verification-discovery/v1",
            "acceptance_coverage": [{
                "criterion_id": "criterion-1",
                "text": "Redis 故障时单次请求不得重复重试缓存",
                "status": "mapped_candidate",
                "mapped_test_ids": ["test_outage_does_not_retry_redis"],
                "mapped_test_paths": ["hidden_tests/test_fallback.py"],
                "confidence": 0.91,
                "reason": "测试名称与故障、重试语义匹配",
            }],
        },
    })

    completion = response["receipt"]["completion"]
    assert completion["engineering_complete"] is True
    assert completion["business_acceptance_complete"] is True
    assert completion["criterion_results"][0]["mapping_source"] == "repository_test_discovery"
    assert response["receipt"]["ci_runs"][0]["verification_discovery"]["acceptance_coverage"][0]["status"] == "mapped_candidate"


def test_model_claim_without_tool_result_cannot_pass_criterion(tmp_path):
    api = TeamAssetApi(project_root(), tmp_path / "runtime.sqlite3")
    trace_id = "trace-criterion-prose-only"
    _selected(api, trace_id)
    api.contracts[trace_id] = AcceptanceContract(
        required_tests=[],
        require_code_change=False,
        target_paths=[],
        source="test_task_contract",
        criteria=["接口返回正确数据"],
    )
    api.observe({
        "trace_id": trace_id,
        "acceptance_declarations": [{
            "criterion_id": "criterion-1",
            "mode": "automated",
            "test_ids": ["test_returns_data"],
            "targets": [],
            "note": "模型声称已通过",
        }],
    })
    completion = api.receipt(trace_id)["completion"]
    assert completion["task_completed"] is False
    assert completion["criterion_results"][0]["status"] == "pending"
    assert "尚未运行" in completion["criterion_results"][0]["reason"]


def test_partial_tests_cannot_complete_or_contribute(tmp_path):
    api = TeamAssetApi(project_root(), tmp_path / "runtime.sqlite3")
    trace_id = "trace-partial-contract"
    selected = _selected(api, trace_id)
    partial = (
        "test_cache_hit_returns_tenant_flag",
        "test_outage_never_leaks_another_tenant",
        "test_outage_does_not_retry_redis",
        "test_recovery_uses_cache_without_database_fallback",
    )
    _observe(api, trace_id, partial)
    receipt = api.receipt(trace_id)
    assert receipt["summary"]["validated"] == len(selected)
    assert receipt["summary"]["contributed"] == 0
    assert receipt["completion"]["task_completed"] is False
    assert receipt["completion"]["test_progress"] == {"passed": 4, "total": 9}
    assert receipt["comparison"]["reason"] == "engineering_verification_not_complete"
    assert receipt["candidates"] == []


def test_full_contract_auto_contributes_and_survives_restart(tmp_path):
    database = tmp_path / "runtime.sqlite3"
    trace_id = "trace-complete-contract"
    api = TeamAssetApi(project_root(), database)
    selected = _selected(api, trace_id)
    _observe(api, trace_id, ACCEPTANCE_TESTS)
    receipt = api.receipt(trace_id)
    assert receipt["completion"]["task_completed"] is True
    assert receipt["completion"]["engineering_complete"] is True
    assert receipt["completion"]["business_acceptance_complete"] is False
    assert receipt["completion"]["business_acceptance_status"] == "not_defined"
    assert receipt["completion"]["test_progress"] == {"passed": 9, "total": 9}
    assert receipt["summary"]["contributed"] == len(selected)
    assert receipt["comparison"]["status"] == "contributed"
    assert receipt["candidates"] == []
    assert receipt["candidate_generation"]["status"] == "unavailable_without_core"

    recovered = TeamAssetApi(project_root(), database)
    after_restart = recovered.receipt(trace_id)
    assert after_restart["completion"]["task_completed"] is True
    assert after_restart["summary"]["contributed"] == len(selected)
    assert after_restart["runtime"]["recovered_after_restart"] is True
    assert recovered.state_store.trace_count() == 1

    # State callbacks are idempotent; a retry never creates duplicate evidence.
    again = recovered.confirm_injected({
        "trace_id": trace_id,
        "asset_ids": selected,
        "context_hash": "sha256:test-context",
    })
    assert again["events_appended"] == []
    assert all(
        recovered.ledger.latest_state(trace_id, load_task(project_root()).task_id, asset_id)
        is AssetState.CONTRIBUTED
        for asset_id in selected
    )
