from __future__ import annotations

import json

from team_asset_bench.catalog import load_assets, load_task, project_root
from team_asset_bench.hybrid_retrieval import HybridAssetRetriever
from team_asset_bench.ledger import EvidenceLedger
from team_asset_bench.models import AssetType, SourceType
from team_asset_bench.native_assets import NativeMemoryAssetAdapter
from team_asset_bench.orchestrator import TeamAssetOrchestrator
from team_asset_bench.server import HubAuthority, TeamAssetApi


def _hub_asset(asset_id: str, asset_type: str, *, name: str, description: str, metadata=None):
    return {
        "asset_id": asset_id,
        "team_id": "team-native",
        "asset_type": asset_type,
        "name": name,
        "description": description,
        "owner_user_id": "user-owner",
        "source_type": "native",
        "source_ref": f"hub://{asset_type}/{asset_id}",
        "content_ref": f"native://{asset_type}/{asset_id}",
        "version": 3,
        "visibility": "team",
        "status": "approved",
        "confidence": 0.8,
        "updated_at": "2026-09-01T00:00:00Z",
        "metadata_json": json.dumps(metadata or {}, ensure_ascii=False),
    }


def test_normal_hub_assets_no_longer_require_benchmark_payload():
    items = [
        _hub_asset("wiki-native", "llm_wiki", name="租户发布规范", description="故障时只读取当前租户已发布配置"),
        _hub_asset("memory-native", "chat_memory", name="Redis 故障复盘", description="历史事故表明不得跨租户回退"),
        _hub_asset(
            "graph-native",
            "code_graph",
            name="Feature Flag 调用图",
            description="缓存与数据库回退调用关系",
            metadata={"paths": ["feature_flags/service.py"]},
        ),
        _hub_asset("skill-native", "skill", name="故障回归 Skill", description="运行租户隔离与缓存恢复测试"),
    ]

    assets = NativeMemoryAssetAdapter().adapt_many(items)

    assert len(assets) == 4
    assert {asset.source_type for asset in assets} == set(SourceType)
    assert {asset.asset_type for asset in assets} == {
        AssetType.PROJECT_CONSTRAINT,
        AssetType.FAILURE_EXPERIENCE,
        AssetType.CODE_KNOWLEDGE,
        AssetType.VALIDATION_WORKFLOW,
    }
    assert all(asset.runtime_asset_id == asset.asset_id for asset in assets)
    assert {asset.injection_mode for asset in assets} == {
        "wiki_query", "memory_hybrid_search", "code_graph_tool", "skill_loader",
    }


def test_hybrid_rank_exposes_bm25_vector_graph_and_rrf_signals():
    task = load_task(project_root())
    assets = NativeMemoryAssetAdapter().adapt_many([
        _hub_asset(
            "graph-relevant",
            "code_graph",
            name="Feature Flag Redis 回退调用图",
            description="定位缓存异常后的数据库回退路径",
            metadata={
                "paths": ["feature_flags/service.py"],
                "retrieval_signals": {"vector": 0.93, "graph": 0.96},
            },
        ),
        _hub_asset(
            "wiki-unrelated",
            "llm_wiki",
            name="前端颜色规范",
            description="按钮颜色与字号",
        ),
    ])
    # Use the task's actual team for this isolated ranker check.
    assets = [type(asset)(**{**asset.__dict__, "team_id": task.team_id}) for asset in assets]
    signals = HybridAssetRetriever().rank(task, assets)

    relevant = signals["graph-relevant"]
    unrelated = signals["wiki-unrelated"]
    assert relevant.bm25 > unrelated.bm25
    assert relevant.vector > unrelated.vector
    assert relevant.graph > unrelated.graph
    assert relevant.rrf > unrelated.rrf
    assert relevant.combined > unrelated.combined


def test_native_assets_enter_minimal_context_with_native_retrieval_handles():
    task_value = load_task(project_root()).to_dict()
    task_value.update({"team_id": "team-native", "agent_id": "agent-native", "version": "*"})
    from team_asset_bench.models import Task

    task = Task.from_dict(task_value)
    assets = NativeMemoryAssetAdapter().adapt_many([
        _hub_asset("wiki", "llm_wiki", name="租户约束", description="故障回退必须保持租户隔离"),
        _hub_asset("memory", "chat_memory", name="Redis 事故复盘", description="缓存故障不得跨租户读取"),
        _hub_asset(
            "graph", "code_graph", name="回退代码图", description="定位 Redis 数据库回退调用",
            metadata={"paths": ["feature_flags/service.py"]},
        ),
        _hub_asset("skill", "skill", name="回归测试流程", description="执行 Redis 故障与租户隔离测试"),
    ])
    package = TeamAssetOrchestrator(assets, EvidenceLedger()).select(task, trace_id="trace-native-v5")

    assert len(package.selected) == 4
    assert "原生检索句柄" in package.markdown
    assert "BM25=" in package.markdown
    assert "code_graph_tool" in package.markdown


def test_legacy_benchmark_assets_remain_compatible_and_keep_runtime_id():
    source = load_assets(project_root())[0]
    item = _hub_asset(
        "wiki-runtime-v5",
        "llm_wiki",
        name="Hub 实时名称",
        description="Hub 实时正文",
        metadata={
            "team_asset_bench": {
                "logical_asset_id": source.asset_id,
                "version": source.version,
                "asset_payload": source.to_dict(),
            }
        },
    )
    item["team_id"] = source.team_id

    asset = NativeMemoryAssetAdapter().adapt(item)

    assert asset is not None
    assert asset.asset_id == source.asset_id
    assert asset.runtime_asset_id == "wiki-runtime-v5"
    assert asset.title == "Hub 实时名称"
    assert asset.claim == "Hub 实时正文"


def test_acl_filtered_legacy_asset_does_not_reapply_portable_agent_alias():
    source = next(item for item in load_assets(project_root()) if item.allowed_agents != ["*"])
    item = _hub_asset(
        "runtime-acl-authorized",
        "llm_wiki",
        name=source.title,
        description=source.claim,
        metadata={
            "team_asset_bench": {
                "logical_asset_id": source.asset_id,
                "asset_payload": source.to_dict(),
            }
        },
    )
    item["team_id"] = source.team_id

    asset = NativeMemoryAssetAdapter().adapt(item)

    assert asset is not None
    # MemoryCore already authorized the runtime Agent before returning this
    # descriptor; a stale portable role name must not filter it a second time.
    assert asset.allowed_agents == ["*"]


def test_hub_authority_passes_agent_to_acl_and_pages_results():
    authority = HubAuthority("http://core", "default", "user-1", "sk-mem-test")
    calls = []

    def fake_post(action, payload):
        calls.append((action, dict(payload)))
        offset = int(payload.get("offset", 0))
        count = 100 if offset == 0 else 1
        return {"items": [{"asset_id": f"asset-{offset + index}"} for index in range(count)]}

    authority._post = fake_post  # type: ignore[method-assign]
    assets = authority.accessible_assets("team-native", "agent-native")

    assert len(assets) == 101
    assert len(calls) == 2
    assert all(call[1]["agent_id"] == "agent-native" for call in calls)
    assert all(call[1]["action"] == "use" for call in calls)


def test_hub_authority_accepts_existing_memory_demo_credentials(tmp_path, monkeypatch):
    env_file = tmp_path / "memory-demo.env"
    env_file.write_text(
        "DEMO_USER_ID=user-existing\nDEMO_USER_KEY=sk-mem-existing\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("TEAM_ASSET_HUB_ENV", str(env_file))

    authority = HubAuthority.from_environment(project_root())

    assert authority is not None
    assert authority.user_id == "user-existing"
    assert authority.user_key == "sk-mem-existing"


def test_team_asset_api_uses_native_adapter_for_generic_assets():
    api = TeamAssetApi.__new__(TeamAssetApi)
    assets = api._assets_from_hub([
        _hub_asset("wiki-generic", "llm_wiki", name="普通 Wiki", description="无竞赛 metadata 也可召回")
    ])
    assert [asset.asset_id for asset in assets] == ["wiki-generic"]


def test_each_conversation_turn_uses_recent_tool_paths_for_ranking(tmp_path):
    task = load_task(project_root())
    api = TeamAssetApi(project_root(), tmp_path / "turn-v5.sqlite3")
    result = api.recommend_turn({
        "session_id": "session-native-v5",
        "turn_seq": 5,
        "current_query": "继续处理刚才的 Redis 错误",
        "team_id": task.team_id,
        "agent_id": task.agent_id,
        "fallbacks": {"repository": task.repository, "version": task.version, "task_type": "bug_fix"},
        "turn_context": {
            "active_paths": ["feature_flags/service.py"],
            "errors": ["CacheUnavailable"],
        },
    })

    assert result["turn"]["turn_seq"] == 5
    assert result["task"]["target_paths"] == ["feature_flags/service.py"]
    assert "CacheUnavailable" in result["task"]["description"]
    assert result["task_profile"]["target_paths"]["source"].startswith("task_or_recent_tool_path")


def test_proxy_acl_snapshot_is_the_live_authority(tmp_path):
    task = load_task(project_root())
    api = TeamAssetApi(project_root(), tmp_path / "proxy-acl.sqlite3")
    item = _hub_asset(
        "wiki-current-user",
        "llm_wiki",
        name="Redis 租户隔离规范",
        description="缓存故障时必须按当前租户回退已发布配置",
    )
    item["team_id"] = task.team_id
    result = api.recommend_turn({
        "session_id": "session-proxy-acl",
        "turn_seq": 1,
        "current_query": "修复 Redis 故障回退并保持租户隔离",
        "team_id": task.team_id,
        "agent_id": task.agent_id,
        "accessible_assets": [item],
        "task_detail": {"task_id": task.task_id, "title": task.title},
        "fallbacks": {
            "repository": task.repository,
            "version": task.version,
            "task_type": "bug_fix",
        },
    })

    assert result["asset_authority"]["mode"] == "proxy_acl_snapshot"
    assert result["asset_authority"]["accessible_runtime_asset_count"] == 1
    assert [item["asset"]["asset_id"] for item in result["selected"]] == ["wiki-current-user"]


def test_runtime_asset_id_is_resolved_from_selected_package_without_static_binding(tmp_path):
    task = load_task(project_root())
    source = next(item for item in load_assets(project_root()) if item.source_type is SourceType.WIKI)
    runtime_id = "wiki-runtime-not-in-binding-file"
    item = _hub_asset(
        runtime_id,
        "llm_wiki",
        name="实时租户约束",
        description="缓存故障回退必须保持当前租户边界",
        metadata={
            "team_asset_bench": {
                "logical_asset_id": source.asset_id,
                "version": source.version,
                "asset_payload": source.to_dict(),
            }
        },
    )
    item["team_id"] = task.team_id
    api = TeamAssetApi(project_root(), tmp_path / "runtime-id.sqlite3")
    result = api.recommend_turn({
        "session_id": "runtime-id-session",
        "turn_seq": 1,
        "current_query": "修复 Redis 故障回退并保持租户隔离",
        "team_id": task.team_id,
        "agent_id": task.agent_id,
        "accessible_assets": [item],
        "fallbacks": {
            "repository": task.repository,
            "version": task.version,
            "task_type": "bug_fix",
            "target_paths": ["feature_flags/service.py"],
        },
    })
    trace_id = result["trace_id"]

    api.confirm_injected({
        "trace_id": trace_id,
        "asset_ids": [runtime_id],
        "context_hash": "sha256:runtime-context",
    })
    observed = api.observe({
        "trace_id": trace_id,
        "declarations": [{
            "asset_id": runtime_id,
            "decision": "按实时 Wiki 保持租户隔离",
            "target": "feature_flags/service.py",
        }],
        "tool_calls": [{
            "id": "edit-runtime-id",
            "name": "replace_in_file",
            "kind": "edit",
            "target": "feature_flags/service.py",
            "changed_paths": ["feature_flags/service.py"],
            "change_hash": "sha256:runtime-edit",
        }],
    })

    assert observed["summary"]["used"] == 1
    assert api.receipt(trace_id)["assets"][0]["runtime_asset_id"] == runtime_id
