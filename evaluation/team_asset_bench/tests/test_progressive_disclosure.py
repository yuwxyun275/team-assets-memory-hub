import json

from team_asset_bench.server import TeamAssetApi
from team_asset_bench.native_assets import NativeMemoryAssetAdapter
from team_asset_bench.models import Task
from team_asset_bench.orchestrator import TeamAssetOrchestrator


def test_scene_adjustment_changes_only_bounded_historical_effect():
    item = {"asset_id": "wiki", "team_id": "team", "asset_type": "llm_wiki", "name": "Redis fallback",
            "status": "approved", "visibility": "team", "version": 1,
            "quality_publication": {"revision_id": "rev1", "approved_by": "reviewer",
                "snapshot": {"asset_id": "wiki", "body": "One fallback, no retries"},
                "report": {"decision": "pass", "scorecard": {"quality": 90}}}}
    adapter = NativeMemoryAssetAdapter()
    neutral = adapter.adapt(item)
    down = adapter.adapt({**item, "quality_utility": {"score": None, "applicability_adjustment": -.01}})
    up = adapter.adapt({**item, "quality_utility": {"score": None, "applicability_adjustment": .01}})
    assert down.historical_effect == .49
    assert neutral.historical_effect == .5
    assert up.historical_effect == .51
    assert down.native_signals["intrinsic_quality"] == up.native_signals["intrinsic_quality"] == .9
    assert adapter.adapt({**item, "quality_utility": {"score": 1, "applicability_adjustment": 99}}).historical_effect == 1


def test_reviewed_graph_uses_code_revision_and_paths_not_container_version():
    graph={"repository":"synthetic/flags","revision":"task-01-flags","nodes":[{"path":"service.py"}],"edges":[]}
    asset={"asset_id":"graph", "team_id":"team", "asset_type":"code_graph", "name":"定位图", "version":1,
           "status":"approved", "visibility":"team", "quality_publication":{"revision_id":"rev", "approved_by":"reviewer",
           "snapshot":{"asset_id":"graph","body":json.dumps(graph),"declared_scope":"synthetic slice"},
           "report":{"decision":"pass","scorecard":{"quality":100}}}}
    converted=NativeMemoryAssetAdapter().adapt(asset)
    assert converted.version=="task-01-flags"
    assert converted.paths==["service.py"]
    assert converted.retrieval_handle["bound_repository"]=="synthetic/flags"


def test_learned_scope_is_reviewed_and_blocks_other_projects_and_versions():
    item = {"asset_id": "learned", "team_id": "team", "asset_type": "llm_wiki", "source_type": "asset_learning",
            "name": "库存预留", "status": "approved", "visibility": "team", "version": 1,
            "metadata_json": json.dumps({"repository": "wrong/mutable", "project_version": "*"}),
            "quality_publication": {"revision_id": "reviewed", "approved_by": "reviewer",
                "snapshot": {"asset_id": "learned", "body": "同一请求只扣一次库存",
                    "project_scope": {"repository": "synthetic/inventory", "version": "v1", "synthetic": True}},
                "report": {"decision": "pass", "scorecard": {"quality": 90}}}}
    adapter = NativeMemoryAssetAdapter()
    asset = adapter.adapt(item)
    assert asset.version == "v1"
    assert asset.retrieval_handle["bound_repository"] == "synthetic/inventory"
    assert "synthetic_source" in asset.risks
    def gate(repository, version):
        task = Task("task", "team", "agent", "库存任务", "测试去重", repository, version, "bug_fix")
        return TeamAssetOrchestrator._hard_gate(task, asset)
    assert gate("synthetic/inventory", "v1") == []
    assert "repository_incompatible" in gate("unrelated/project", "v1")
    assert "version_incompatible" in gate("synthetic/inventory", "v2")
    del item["quality_publication"]["snapshot"]["project_scope"]
    assert adapter.adapt(item) is None


def test_transferable_workflow_is_available_for_adaptation_without_claiming_validation():
    item = {"asset_id": "learned", "team_id": "team", "asset_type": "skill", "source_type": "asset_learning",
            "name": "重复请求检查", "status": "approved", "visibility": "team", "version": 1,
            "quality_publication": {"revision_id": "reviewed", "approved_by": "reviewer",
                "snapshot": {"asset_id": "learned", "body": "执行前核对当前项目约定，未知时停止",
                    "project_scope": {"repository": "origin/repo", "version": "v1", "synthetic": True},
                    "workflow_scope": {"suggested": "cross_project", "requirements": ["明确副作用约定"],
                        "admission": "check_preconditions_before_execution", "verification_status": "unverified_workflow"}},
                "report": {"decision": "pass", "scorecard": {"quality": 90}}}}
    task = Task("task", "team", "agent", "检查", "检查重复副作用", "other/repo", "v2", "bug_fix")
    asset = NativeMemoryAssetAdapter().adapt(item)
    assert TeamAssetOrchestrator._hard_gate(task, asset) == []
    assert asset.retrieval_handle["use_admission"] == "preflight_required"
    assert "workflow_execution_unverified" in asset.risks
    assert "cross_project_adaptation_required" in asset.risks
    item["quality_publication"]["snapshot"]["workflow_scope"]["suggested"] = "project"
    restricted = NativeMemoryAssetAdapter().adapt(item)
    assert "repository_incompatible" in TeamAssetOrchestrator._hard_gate(task, restricted)
    del item["quality_publication"]["snapshot"]["workflow_scope"]["requirements"]
    assert NativeMemoryAssetAdapter().adapt(item) is None


def test_large_reviewed_assets_are_budgeted_as_pointers_only_in_progressive_mode(tmp_path):
    body = "Redis 故障后验证恢复，保持租户隔离，禁止请求内重试。" * 600
    asset = {
        "asset_id": "skill-progressive", "team_id": "team-feature-platform", "asset_type": "skill",
        "name": "Redis 缓存故障恢复验证", "description": "验证 Redis 缓存故障、单次回退、租户隔离及恢复",
        "owner_user_id": "owner", "version": 1, "visibility": "team", "status": "approved",
        "metadata_json": json.dumps({"paths": ["feature_flags/service.py"], "keywords": ["Redis", "恢复", "租户"]}),
        "quality_publication": {"revision_id": "reviewed-rev", "approved_by": "reviewer",
            "snapshot": {"asset_id": "skill-progressive", "body": body, "declared_scope": "多租户 Redis 故障与恢复"},
            "report": {"decision": "pass", "snapshot_sha256": "fixture", "scorecard": {"quality": 100}}},
    }
    payload = {"session_id": "progressive-session", "turn_seq": 1, "current_query": "验证 Redis 故障和缓存恢复，检查租户隔离",
        "team_id": "team-feature-platform", "agent_id": "agent-new-backend", "accessible_assets": [asset],
        "budget_ceiling": 900, "max_assets_ceiling": 4,
        "fallbacks": {"repository": "team/feature-flag-service", "version": "1.4", "task_type": "bug_fix", "target_paths": ["feature_flags/service.py"]}}
    full_api = TeamAssetApi(state_db_path=tmp_path / "full.sqlite3")
    assert not full_api.recommend_turn(payload)["selected"]
    progressive_api = TeamAssetApi(state_db_path=tmp_path / "progressive.sqlite3")
    result = progressive_api.recommend_turn({**payload, "progressive_disclosure": True})
    assert result["selected"]
    selected = result["selected"][0]["asset"]
    assert selected["token_cost"] == 500
    assert selected["retrieval_handle"]["content_included"] is False
    assert selected["retrieval_handle"]["revision_id"] == "reviewed-rev"
