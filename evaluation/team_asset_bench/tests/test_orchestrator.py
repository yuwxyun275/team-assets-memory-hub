from pathlib import Path

from team_asset_bench.catalog import build_catalog, load_assets, load_task, project_root
from team_asset_bench.ledger import EvidenceLedger, InvalidAssetTransition
from team_asset_bench.models import AssetState
from team_asset_bench.orchestrator import TeamAssetOrchestrator
from team_asset_bench.server import TeamAssetApi
from team_asset_bench.task_profile import TaskProfiler


def test_regression_of_existing_implementation_is_not_a_feature_or_required_repair():
    text = "真实模型 · 库存回归验证。检查库存请求幂等性实现并运行回归测试。仅在发现问题时修改代码。"
    assert TaskProfiler._task_type(text)[0] == "test"
    assert TaskProfiler._task_type("请修复重复扣减库存问题并运行回归测试")[0] == "bug_fix"
    assert TaskProfiler._task_type("实现新功能并补充测试")[0] == "feature"


def test_minimal_context_covers_four_non_substitutable_team_sources():
    root = project_root()
    assets, _ = build_catalog(root, root / "raw" / "source_manifest.json")
    package = TeamAssetOrchestrator(assets, EvidenceLedger()).select(load_task(root), strategy="minimal")
    assert {item.asset.source_type.value for item in package.selected} == {
        "wiki",
        "chat_memory",
        "code_graph",
        "skill",
    }
    assert len(package.selected) == 4
    assert package.token_cost <= package.task.token_budget
    assert "asset-wiki-legacy-global-lookup" not in {item.asset.asset_id for item in package.selected}
    assert "asset-skill-full-cache-rebuild" not in {item.asset.asset_id for item in package.selected}


def test_selection_does_not_claim_injection_before_proxy_ack():
    root = project_root()
    ledger = EvidenceLedger()
    package = TeamAssetOrchestrator(load_assets(root), ledger).select(
        load_task(root), strategy="minimal", trace_id="trace-selection-only"
    )
    assert all(
        ledger.latest_state(package.trace_id, package.task.task_id, item.asset.asset_id) is AssetState.SELECTED
        for item in package.selected
    )


def test_task_profile_is_inferred_from_board_text_and_team_assets():
    root = project_root()
    profiled = TaskProfiler().profile(
        {
            "task_id": "task-runtime",
            "team_id": "team-feature-platform",
            "agent_id": "agent-new-backend",
            "title": "开始执行",
            "description": "开始执行",
        },
        load_assets(root),
        task_detail={
            "title": "多租户 Feature Flag 缓存故障安全回退",
            "description": "Redis 异常时出现超时和 5xx，修复后必须验证租户隔离。",
            "risk_level": "high",
            "metadata_json": '{"team_asset_profile":{"repository":"team/feature-flag-service","version":"1.4"}}',
        },
        query="开始执行",
        budget_ceiling=760,
        max_assets_ceiling=4,
    )
    assert profiled.task.task_type == "bug_fix"
    assert profiled.task.repository == "team/feature-flag-service"
    assert profiled.task.version == "1.4"
    assert "feature_flags/service.py" in profiled.task.target_paths
    assert {item.value for item in profiled.task.required_capabilities} == {
        "project_constraint", "failure_experience", "code_knowledge", "validation_workflow"
    }
    assert profiled.task.token_budget <= 760


def test_acl_filtered_asset_is_not_even_recalled():
    root = project_root()
    assets, _ = build_catalog(root, root / "raw" / "source_manifest.json")
    package = TeamAssetOrchestrator(assets, EvidenceLedger()).select(load_task(root), strategy="full")
    assert "asset-private-architecture-draft" not in {item.asset.asset_id for item in package.recalled}


def test_used_requires_target_and_decision():
    ledger = EvidenceLedger()
    ledger.append(
        trace_id="trace",
        task_id="task",
        asset_id="asset",
        state=AssetState.RECALLED,
        actor_type="system",
        actor_id="test",
    )
    ledger.append(
        trace_id="trace",
        task_id="task",
        asset_id="asset",
        state=AssetState.SELECTED,
        actor_type="system",
        actor_id="test",
    )
    ledger.append(
        trace_id="trace",
        task_id="task",
        asset_id="asset",
        state=AssetState.INJECTED,
        actor_type="system",
        actor_id="test",
    )
    try:
        ledger.append(
            trace_id="trace",
            task_id="task",
            asset_id="asset",
            state=AssetState.USED,
            actor_type="agent",
            actor_id="test",
        )
    except InvalidAssetTransition as exc:
        assert "target and decision" in str(exc)
    else:
        raise AssertionError("used without evidence must fail")


def test_runtime_hub_ids_require_an_explicit_binding(tmp_path):
    root = project_root()
    api = TeamAssetApi(root, tmp_path / "runtime.sqlite3")
    api.ledger = EvidenceLedger()
    api.orchestrator = TeamAssetOrchestrator(load_assets(root), api.ledger)
    api.bindings = {
        "teams": {"team-runtime": "team-feature-platform"},
        "agents": {"agent-runtime": "agent-new-backend"},
        "tasks": {"task-runtime": "task-cache-outage-001"},
    }
    result = api.select(
        {
            "task": {
                "team_id": "team-runtime",
                "agent_id": "agent-runtime",
                "task_id": "task-runtime",
            }
        }
    )
    assert result["external_binding"] == {
        "team_id": "team-runtime",
        "agent_id": "agent-runtime",
        "task_id": "task-runtime",
    }
    assert len(result["selected"]) == 4


def test_proxy_injection_ack_advances_only_selected_assets(tmp_path):
    root = project_root()
    api = TeamAssetApi(root, tmp_path / "runtime.sqlite3")
    api.ledger = EvidenceLedger()
    api.orchestrator = TeamAssetOrchestrator(load_assets(root), api.ledger)
    result = api.select({"trace_id": "trace-proxy-ack", "task": load_task(root).to_dict()})
    selected_ids = [item["asset"]["asset_id"] for item in result["selected"]]
    confirmed = api.confirm_injected({
        "trace_id": "trace-proxy-ack",
        "asset_ids": [*selected_ids, "asset-not-selected"],
        "context_hash": "sha256:context",
        "protocol": "openai",
        "injection_point": "system.suffix:task_context",
        "request_trace_id": "request-1",
    })
    assert len(confirmed["events_appended"]) == len(selected_ids)
    assert all(
        api.ledger.latest_state("trace-proxy-ack", result["task"]["task_id"], asset_id)
        is AssetState.INJECTED
        for asset_id in selected_ids
    )
