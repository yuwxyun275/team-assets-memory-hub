from __future__ import annotations

import json
import sys
from dataclasses import replace

from team_asset_bench.acceptance_planner import AcceptancePlanner
from team_asset_bench.catalog import load_assets, load_task, project_root
from team_asset_bench.ci_adapter import LocalCiRunner, normalize_ci_run
from team_asset_bench.completion import TaskExecutionEvidence
from team_asset_bench.server import (
    TeamAssetApi,
    _load_reviewed_ci_manifest,
    _normalize_observation_paths,
    _repository_scope,
)


def test_contextual_acceptance_is_grounded_in_selected_assets_and_repository_tests():
    task = load_task(project_root())
    assets = load_assets(project_root())
    planner = AcceptancePlanner(mode="deterministic")

    plan = planner.plan(
        task,
        assets,
        repository_context={
            "active_paths": ["feature_flags/service.py"],
            "test_ids": [
                "test_outage_never_leaks_another_tenant",
                "test_outage_does_not_retry_redis",
            ],
            "test_paths": ["hidden_tests/test_fallback.py"],
            "frameworks": ["pytest"],
        },
    )

    assert plan.status == "proposed"
    assert "repository_verification_context" in plan.context_sources
    assert all(item.source_asset_ids or item.category == "engineering" for item in plan.criteria)
    tenant = next(item for item in plan.criteria if "租户隔离" in item.text)
    assert tenant.source_asset_ids
    assert "test_outage_never_leaks_another_tenant" in tenant.candidate_test_ids
    assert plan.safety["planner_can_validate"] is False
    assert plan.safety["requires_trusted_ci"] is True


def test_database_read_task_does_not_invent_write_acceptance():
    task = load_task(project_root())
    planner = AcceptancePlanner(mode="deterministic")
    plan = planner.plan(task, load_assets(project_root()))

    assert not any("重复写入" in item.text or "部分提交" in item.text for item in plan.criteria)


def test_published_inventory_experience_does_not_invent_cache_or_draft_requirements():
    task = replace(load_task(project_root()), title="库存回归验证", description="检查请求去重，按需复用已发布的团队经验", task_type="test")
    asset = replace(load_assets(project_root())[0], title="已发布库存经验", claim="相同请求重试不重复扣减", action="核对当前库存实现并测试", risks=[], keywords=["库存", "重试"])
    plan = AcceptancePlanner(mode="deterministic").plan(task, [asset])
    assert not any("草稿" in item.text or "缓存" in item.text for item in plan.criteria)


def test_server_uses_contextual_plan_but_preserves_confirmed_owner_contract(tmp_path):
    api = TeamAssetApi(project_root(), tmp_path / "planner.sqlite3")
    result = api.recommend_turn({
        "session_id": "contextual-plan-session",
        "turn_seq": 1,
        "current_query": "Redis 故障时安全回退并保持租户隔离",
        "team_id": "team-feature-platform",
        "agent_id": "agent-new-backend",
        "fallbacks": {
            "repository": "team/feature-flag-service",
            "version": "1.4",
            "task_type": "bug_fix",
            "target_paths": ["feature_flags/service.py"],
        },
        "repository_context": {
            "active_paths": ["feature_flags/service.py"],
            "test_ids": ["test_outage_never_leaks_another_tenant"],
            "frameworks": ["pytest"],
        },
    })

    assert result["acceptance_plan"]["generated_by"].endswith("acceptance-planner-v2")
    assert result["acceptance_contract"]["criteria_status"] == "proposed"
    assert result["acceptance_contract"]["criteria"] == [
        item["text"] for item in result["acceptance_plan"]["criteria"]
    ]
    receipt = api.receipt(result["trace_id"])
    assert receipt["acceptance_plan"]["context_fingerprint"].startswith("sha256:")


def test_local_ci_proves_fail_before_pass_after(tmp_path):
    before = tmp_path / "before"
    after = tmp_path / "after"
    before.mkdir()
    after.mkdir()
    (before / "fixed.txt").write_text("broken", encoding="utf-8")
    (after / "fixed.txt").write_text("fixed", encoding="utf-8")
    command = (
        "from pathlib import Path; "
        "raise SystemExit(0 if Path('fixed.txt').read_text().strip() == 'fixed' else 1)"
    )
    manifest = {
        "checks": [{
            "id": "new-regression-test",
            "name": "新增故障回归测试",
            "argv": [sys.executable, "-c", command],
            "test_ids": ["test_bug_no_longer_reproduces"],
        }]
    }

    result = LocalCiRunner(after).run_before_after(
        manifest,
        before_workspace=before,
        trace_id="trace-before-after",
        changed_paths=["fixed.txt"],
    )

    assert result["status"] == "passed"
    assert result["regression_proof"]["confirmed"] is True
    assert result["regression_proof"]["transitions"] == [{
        "check_id": "new-regression-test",
        "before": "failed",
        "after": "passed",
    }]
    assert result["execution_origin"] == "independent_runner"


def test_unverified_remote_ci_cannot_become_trusted_even_with_regression_claim():
    result = normalize_ci_run({
        "trace_id": "trace-untrusted-proof",
        "provider": "github-actions",
        "commit_sha": "abc123",
        "checks": [{"id": "tests", "status": "passed", "test_ids": ["test_x"]}],
        "regression_proof": {
            "baseline_status": "failed",
            "patched_status": "passed",
            "transitions": [{"check_id": "tests", "before": "failed", "after": "passed"}],
        },
    })

    assert result["regression_proof"]["confirmed"] is True
    assert result["trusted_for_validation"] is False


def test_plain_ci_run_does_not_invent_failed_regression_proof():
    result = normalize_ci_run({
        "trace_id": "trace-no-proof",
        "provider": "local-ci",
        "checks": [{"id": "tests", "status": "passed", "test_ids": ["test_x"]}],
    })

    assert result["regression_proof"] == {}


def test_plan_provenance_and_trusted_ci_advance_assets_and_pair_red_green_runs(tmp_path):
    api = TeamAssetApi(project_root(), tmp_path / "derived-attribution.sqlite3")
    result = api.recommend_turn({
        "session_id": "derived-attribution-session",
        "turn_seq": 1,
        "current_query": "修复 Redis 缓存故障并验证租户隔离和恢复路径",
        "team_id": "team-feature-platform",
        "agent_id": "agent-new-backend",
        "fallbacks": {
            "repository": "team/feature-flag-service",
            "version": "1.4",
            "task_type": "bug_fix",
            "target_paths": ["feature_flags/service.py"],
        },
    })
    trace_id = result["trace_id"]
    api.confirm_injected({
        "trace_id": trace_id,
        "asset_ids": [item["asset"]["asset_id"] for item in result["selected"]],
        "context_hash": "sha256:injected",
        "protocol": "openai",
    })
    tests = sorted({
        test_id
        for item in result["selected"]
        for test_id in item["asset"].get("tests", [])
    })
    check = {
        "id": "repository-tests",
        "test_ids": tests,
        "evidence_ref": "sha256:check",
    }
    api.record_ci_run({
        "run_id": "ci-before",
        "trace_id": trace_id,
        "provider": "local-ci",
        "runner_identity": "reviewed-runner",
        "changed_paths": ["feature_flags/service.py"],
        "checks": [{**check, "status": "failed"}],
        "evidence_ref": "sha256:before",
    })
    final = api.record_ci_run({
        "run_id": "ci-after",
        "trace_id": trace_id,
        "provider": "local-ci",
        "runner_identity": "reviewed-runner",
        "changed_paths": ["feature_flags/service.py"],
        "checks": [{**check, "status": "passed"}],
        "evidence_ref": "sha256:after",
    })["receipt"]

    assert final["summary"]["used"] > 0
    assert final["summary"]["validated"] > 0
    assert final["ci_runs"][0]["regression_pair"]["role"] == "baseline"
    assert final["ci_runs"][0]["regression_proof"] == {
        "mode": "baseline_observation",
        "confirmed": False,
        "baseline_status": "failed",
        "baseline_run_id": "ci-before",
        "baseline_evidence_ref": "sha256:before",
        "transitions": [],
    }
    assert final["ci_runs"][1]["regression_proof"]["confirmed"] is True
    assert final["ci_runs"][1]["regression_proof"]["transitions"] == [{
        "check_id": "repository-tests",
        "before": "failed",
        "after": "passed",
    }]


def test_codebuddy_test_is_preliminary_until_independent_ci_reports(tmp_path):
    api = TeamAssetApi(project_root(), tmp_path / "independent.sqlite3")
    result = api.recommend_turn({
        "session_id": "independent-ci-session",
        "turn_seq": 1,
        "current_query": "修复 Redis 故障时的安全回退",
        "team_id": "team-feature-platform",
        "agent_id": "agent-new-backend",
        "fallbacks": {
            "repository": "team/feature-flag-service",
            "version": "1.4",
            "task_type": "bug_fix",
            "target_paths": ["feature_flags/service.py"],
        },
    })
    trace_id = result["trace_id"]
    required = result["acceptance_contract"]["required_tests"]
    assert result["acceptance_contract"]["verification_policy"] == "trusted_ci"

    api.observe({
        "trace_id": trace_id,
        "tool_calls": [{
            "id": "edit-local",
            "name": "apply_patch",
            "kind": "edit",
            "target": "feature_flags/service.py",
            "changed_paths": ["feature_flags/service.py"],
        }, {
            "id": "test-local",
            "name": "pytest",
            "kind": "test",
            "test_ids": required,
        }],
        "tool_results": [{
            "tool_call_id": "test-local",
            "success": True,
            "test_ids": required,
            "evidence_ref": "sha256:codebuddy-local-test",
        }],
    })
    preliminary = api.receipt(trace_id)["completion"]
    assert preliminary["engineering_complete"] is False
    assert preliminary["missing_tests"] == required

    verified = api.record_ci_run({
        "trace_id": trace_id,
        "provider": "local-ci",
        "changed_paths": ["feature_flags/service.py"],
        "checks": [{
            "id": "repository-tests",
            "status": "passed",
            "test_ids": required,
            "evidence_ref": "sha256:independent-ci-test",
        }],
    })["receipt"]["completion"]
    assert verified["engineering_complete"] is True
    assert verified["missing_tests"] == []


def test_observed_edit_and_test_trigger_allowlisted_independent_local_ci(tmp_path, monkeypatch):
    workspace = tmp_path / "repo"
    target = workspace / "feature_flags" / "service.py"
    target.parent.mkdir(parents=True)
    target.write_text("FIXED = True\n", encoding="utf-8")
    (workspace / "pyproject.toml").write_text("[project]\nname='demo'\nversion='1.0'\n", encoding="utf-8")

    api = TeamAssetApi(project_root(), tmp_path / "auto-ci.sqlite3")
    result = api.recommend_turn({
        "session_id": "auto-local-ci-session",
        "turn_seq": 1,
        "current_query": "修复 Redis 故障时的安全回退",
        "team_id": "team-feature-platform",
        "agent_id": "agent-new-backend",
        "task_detail": {
            "task_id": "task-auto-local-ci",
            "title": "Redis 故障安全回退",
            "source_url": str(workspace),
        },
        "repository_context": {
            "workspace_root": str(workspace),
            "task_source_url": str(workspace),
        },
        "fallbacks": {
            "repository": "team/feature-flag-service",
            "version": "1.4",
            "task_type": "bug_fix",
            "target_paths": ["feature_flags/service.py"],
        },
    })
    required = result["acceptance_contract"]["required_tests"]
    manifest = tmp_path / "reviewed-ci.json"
    manifest.write_text(json.dumps({
        "checks": [{
            "id": "reviewed-regression",
            "name": "受控独立验证",
            "argv": [sys.executable, "-c", "raise SystemExit(0)"],
            "test_ids": required,
        }]
    }), encoding="utf-8")
    monkeypatch.setenv("TEAM_ASSET_LOCAL_CI_AUTO", "1")
    monkeypatch.setenv("TEAM_ASSET_LOCAL_CI_ALLOWED_ROOTS", str(tmp_path))
    monkeypatch.setenv("TEAM_ASSET_LOCAL_CI_MANIFEST", str(manifest))

    observed = api.observe({
        "trace_id": result["trace_id"],
        "workspace_root": str(workspace),
        "tool_calls": [{
            "id": "edit-auto-ci",
            "name": "apply_patch",
            "kind": "edit",
            "target": "feature_flags/service.py",
            "changed_paths": ["feature_flags/service.py"],
        }, {
            "id": "agent-test",
            "name": "pytest",
            "kind": "test",
            "test_ids": required,
        }],
        "tool_results": [{
            "tool_call_id": "agent-test",
            "success": True,
            "test_ids": required,
            "evidence_ref": "sha256:agent-preliminary",
        }],
    })

    assert observed["local_ci"]["status"] == "passed"
    receipt = api.receipt(result["trace_id"])
    assert receipt["completion"]["engineering_complete"] is True
    assert receipt["ci_runs"][0]["runner_identity"] == "team-asset-local-ci/v2"


def test_repository_snapshot_recovers_edit_when_codebuddy_history_omits_edit_tool(tmp_path, monkeypatch):
    workspace = tmp_path / "repo"
    target = workspace / "feature_flags" / "service.py"
    target.parent.mkdir(parents=True)
    target.write_text("FIXED = False\n", encoding="utf-8")
    tests = workspace / "tests" / "test_service.py"
    tests.parent.mkdir(parents=True)
    tests.write_text("def test_smoke(): assert True\n", encoding="utf-8")
    (workspace / "pyproject.toml").write_text(
        "[project]\nname='demo'\nversion='1.0'\n",
        encoding="utf-8",
    )

    api = TeamAssetApi(project_root(), tmp_path / "snapshot-auto-ci.sqlite3")
    result = api.recommend_turn({
        "session_id": "snapshot-auto-ci-session",
        "turn_seq": 1,
        "current_query": "修复 Redis 故障时的安全回退",
        "team_id": "team-feature-platform",
        "agent_id": "agent-new-backend",
        "task_detail": {
            "task_id": "task-snapshot-auto-ci",
            "title": "Redis 故障安全回退",
            "source_url": str(workspace),
        },
        "repository_context": {
            "workspace_root": str(workspace),
            "task_source_url": str(workspace),
        },
        "fallbacks": {
            "repository": "team/feature-flag-service",
            "version": "1.4",
            "task_type": "bug_fix",
            "target_paths": ["feature_flags/service.py"],
        },
    })
    required = result["acceptance_contract"]["required_tests"]
    manifest = tmp_path / "snapshot-reviewed-ci.json"
    manifest.write_text(json.dumps({
        "checks": [{
            "id": "reviewed-regression",
            "name": "受控独立验证",
            "argv": [sys.executable, "-c", "raise SystemExit(0)"],
            "test_ids": required,
        }]
    }), encoding="utf-8")
    monkeypatch.setenv("TEAM_ASSET_LOCAL_CI_AUTO", "1")
    monkeypatch.setenv("TEAM_ASSET_LOCAL_CI_ALLOWED_ROOTS", str(tmp_path))
    monkeypatch.setenv("TEAM_ASSET_LOCAL_CI_MANIFEST", str(manifest))

    # CodeBuddy changed the file, but its next request retained only the broad
    # pytest call and omitted the edit tool from message history.
    target.write_text("FIXED = True\n", encoding="utf-8")
    observed = api.observe({
        "trace_id": result["trace_id"],
        "workspace_root": str(workspace),
        "tool_calls": [{
            "id": "broad-pytest",
            "name": "execute_command",
            "kind": "test",
            "command": "python -m pytest tests/ -q",
            "test_ids": [],
        }],
    })

    assert observed["local_ci"]["status"] == "passed"
    receipt = api.receipt(result["trace_id"])
    assert receipt["completion"]["engineering_complete"] is True
    assert receipt["completion"]["changed_paths"] == ["feature_flags/service.py"]
    assert receipt["ci_runs"][0]["runner_identity"] == "team-asset-local-ci/v2"


def test_runtime_agent_gets_all_four_acl_assets_and_current_repo_tests_complete_task(tmp_path, monkeypatch):
    workspace = tmp_path / "repo"
    target = workspace / "feature_flags" / "service.py"
    target.parent.mkdir(parents=True)
    target.write_text("FIXED = False\n", encoding="utf-8")
    tests = workspace / "tests" / "test_service.py"
    tests.parent.mkdir(parents=True)
    test_names = [
        "test_cache_hit_returns_tenant_flag",
        "test_cache_miss_returns_none",
        "test_normal_path_does_not_read_database",
        "test_outage_falls_back_to_published_configuration",
        "test_outage_preserves_tenant_isolation",
        "test_outage_hides_draft_flags",
        "test_outage_does_not_retry_redis",
        "test_recovery_uses_cache_without_database_fallback",
    ]
    tests.write_text(
        "\n\n".join(f"def {name}():\n    assert True" for name in test_names) + "\n",
        encoding="utf-8",
    )
    (workspace / "pyproject.toml").write_text(
        "[project]\nname='demo'\nversion='1.0'\n",
        encoding="utf-8",
    )

    native_types = {
        "wiki": "llm_wiki",
        "chat_memory": "chat_memory",
        "code_graph": "code_graph",
        "skill": "skill",
    }
    four_asset_ids = {
        "asset-wiki-tenant-fallback",
        "asset-memory-retry-storm",
        "asset-codegraph-cache-boundary",
        "asset-skill-cache-fault-recovery",
    }
    accessible_assets = []
    for index, asset in enumerate(
        (item for item in load_assets(project_root()) if item.asset_id in four_asset_ids),
        start=1,
    ):
        accessible_assets.append({
            "asset_id": f"runtime-asset-{index}",
            "team_id": "team-feature-platform",
            "asset_type": native_types[asset.source_type.value],
            "name": asset.title,
            "description": asset.claim,
            "visibility": "team",
            "status": "approved",
            "updated_at": "2026-09-03T00:00:00Z",
            "metadata_json": json.dumps({
                "team_asset_bench": {
                    "logical_asset_id": asset.asset_id,
                    "asset_payload": asset.to_dict(),
                }
            }, ensure_ascii=False),
        })

    api = TeamAssetApi(project_root(), tmp_path / "four-assets-auto-ci.sqlite3")
    monkeypatch.setenv("TEAM_ASSET_LOCAL_CI_AUTO", "1")
    monkeypatch.setenv("TEAM_ASSET_LOCAL_CI_ALLOWED_ROOTS", str(tmp_path))
    monkeypatch.setenv("TEAM_ASSET_LOCAL_CI_DISCOVER", "1")
    result = api.recommend_turn({
        "session_id": "four-assets-auto-ci-session",
        "turn_seq": 1,
        "current_query": "修复 Redis 故障安全回退、租户隔离、草稿泄漏、重试与恢复问题",
        "team_id": "team-feature-platform",
        "agent_id": "agt-runtime-backend-666",
        "accessible_assets": accessible_assets,
        "task_detail": {
            "task_id": "task-four-assets-auto-ci",
            "title": "Redis 故障安全回退",
            "source_url": str(workspace),
        },
        "repository_context": {
            "workspace_root": str(workspace),
            "task_source_url": str(workspace),
        },
        "fallbacks": {
            "repository": "team/feature-flag-service",
            "version": "1.4",
            "task_type": "bug_fix",
            "target_paths": ["feature_flags/service.py"],
        },
        "budget_ceiling": 760,
        "max_assets_ceiling": 4,
    })

    assert len(result["recalled"]) == 4
    assert len(result["selected"]) == 4
    api.confirm_injected({
        "trace_id": result["trace_id"],
        "asset_ids": [item["asset"]["asset_id"] for item in result["selected"]],
        "context_hash": "sha256:four-assets-context",
    })
    target.write_text("FIXED = True\n", encoding="utf-8")
    observed = api.observe({
        "trace_id": result["trace_id"],
        "workspace_root": str(workspace),
        "tool_calls": [{
            "id": "broad-pytest-four-assets",
            "name": "execute_command",
            "kind": "test",
            "command": "python -m pytest tests/ -q",
            "test_ids": [],
        }],
    })

    assert observed["local_ci"]["status"] == "passed"
    receipt = api.receipt(result["trace_id"])
    assert receipt["completion"]["task_completed"] is True, json.dumps(
        {"summary": receipt["summary"], "completion": receipt["completion"], "assets": receipt["assets"]},
        ensure_ascii=False,
        indent=2,
    )
    assert receipt["summary"]["used"] == 4
    assert receipt["summary"]["validated"] == 4
    assert receipt["summary"]["contributed"] == 4


def test_empty_codebuddy_workspace_uses_exact_allowlisted_task_binding(tmp_path, monkeypatch):
    empty_workspace = tmp_path / "conversation-workspace"
    bound_repository = tmp_path / "task-repository"
    empty_workspace.mkdir()
    bound_repository.mkdir()
    (bound_repository / "pyproject.toml").write_text("[project]\nname='demo'\n", encoding="utf-8")
    monkeypatch.setenv("TEAM_ASSET_LOCAL_CI_ALLOWED_ROOTS", str(tmp_path))

    scope = _repository_scope(
        {"source_url": str(bound_repository)},
        {"workspace_root": str(empty_workspace)},
    )

    assert scope["status"] == "matched_task_binding"
    assert scope["execution_root"] == str(bound_repository.resolve())
    assert scope["write_allowed"] is True


def test_nonempty_unrelated_workspace_is_never_redirected(tmp_path, monkeypatch):
    current_repository = tmp_path / "current"
    bound_repository = tmp_path / "bound"
    current_repository.mkdir()
    bound_repository.mkdir()
    (current_repository / "pyproject.toml").write_text("[project]\nname='wrong'\n", encoding="utf-8")
    monkeypatch.setenv("TEAM_ASSET_LOCAL_CI_ALLOWED_ROOTS", str(tmp_path))

    scope = _repository_scope(
        {"source_url": str(bound_repository)},
        {"workspace_root": str(current_repository)},
    )

    assert scope["status"] == "blocked_path_mismatch"
    assert scope["write_allowed"] is False


def test_codebuddy_absolute_and_uri_paths_become_repository_relative(tmp_path):
    repository = tmp_path / "repo"
    repository.mkdir()
    payload = {
        "tool_calls": [{
            "id": "edit-1",
            "kind": "edit",
            "target": (repository / "feature_flags" / "service.py").as_uri(),
            "changed_paths": [str(repository / "feature_flags" / "service.py")],
        }],
        "declarations": [{
            "asset_id": "asset-wiki",
            "decision": "安全回退",
            "target": f"{repository}/feature_flags/service.py:FeatureFlagService.get_flag",
        }],
    }

    normalized = _normalize_observation_paths(payload, {"execution_root": str(repository)})

    assert normalized["tool_calls"][0]["target"] == "feature_flags/service.py"
    assert normalized["tool_calls"][0]["changed_paths"] == ["feature_flags/service.py"]
    assert normalized["declarations"][0]["target"] == "feature_flags/service.py:FeatureFlagService.get_flag"


def test_relative_ci_path_matches_absolute_acceptance_target_without_cross_repo_false_positive(tmp_path):
    from team_asset_bench.completion import _path_matches

    repository = tmp_path / "repo"
    other_repository = tmp_path / "other"
    target = str(repository / "feature_flags" / "service.py")

    assert _path_matches("feature_flags/service.py", target) is True
    assert _path_matches(target, "feature_flags/service.py:FeatureFlagService.get_flag") is True
    assert _path_matches(
        str(other_repository / "feature_flags" / "service.py"),
        target,
    ) is False


def test_attribution_inputs_survive_restart_and_late_tool_result():
    execution = TaskExecutionEvidence()
    execution.observe({
        "declarations": [{
            "asset_id": "asset-wiki",
            "decision": "保持租户隔离",
            "target": "feature_flags/service.py",
        }],
        "tool_calls": [{
            "id": "edit-1",
            "name": "replace_in_file",
            "kind": "edit",
            "target": "feature_flags/service.py",
            "changed_paths": ["feature_flags/service.py"],
        }, {
            "id": "test-1",
            "name": "execute_command",
            "kind": "test",
            "command": "pytest test_outage",
            "test_ids": ["test_outage"],
        }],
    })

    restored = TaskExecutionEvidence.from_dict(execution.to_dict())
    restored.observe({
        "tool_results": [{
            "tool_call_id": "test-1",
            "success": True,
            "test_ids": ["test_outage"],
            "evidence_ref": "sha256:test-result",
        }],
    })

    assert restored.tests["test_outage"] is True
    assert restored.observer_payload()["declarations"][0]["asset_id"] == "asset-wiki"
    assert {item["id"] for item in restored.observer_payload()["tool_calls"]} == {"edit-1", "test-1"}


def test_task_bound_repository_can_trigger_ci_from_final_declaration(tmp_path, monkeypatch):
    empty_workspace = tmp_path / "conversation-workspace"
    bound_repository = tmp_path / "task-repository"
    empty_workspace.mkdir()
    target = bound_repository / "feature_flags" / "service.py"
    target.parent.mkdir(parents=True)
    target.write_text("FIXED = True\n", encoding="utf-8")
    (bound_repository / "pyproject.toml").write_text("[project]\nname='demo'\n", encoding="utf-8")

    api = TeamAssetApi(project_root(), tmp_path / "bound-auto-ci.sqlite3")
    monkeypatch.setenv("TEAM_ASSET_LOCAL_CI_ALLOWED_ROOTS", str(tmp_path))
    result = api.recommend_turn({
        "session_id": "bound-auto-local-ci-session",
        "turn_seq": 1,
        "current_query": "修复 Redis 故障时的安全回退",
        "team_id": "team-feature-platform",
        "agent_id": "agent-new-backend",
        "task_detail": {
            "task_id": "task-bound-auto-local-ci",
            "title": "Redis 故障安全回退",
            "source_url": str(bound_repository),
        },
        "repository_context": {
            "workspace_root": str(empty_workspace),
            "task_source_url": str(bound_repository),
        },
        "fallbacks": {
            "repository": "team/feature-flag-service",
            "version": "1.4",
            "task_type": "bug_fix",
            "target_paths": ["feature_flags/service.py"],
        },
    })
    required = result["acceptance_contract"]["required_tests"]
    selected_asset = result["selected"][0]["asset"]["asset_id"]
    manifest = tmp_path / "bound-reviewed-ci.json"
    manifest.write_text(json.dumps({
        "checks": [{
            "id": "reviewed-regression",
            "name": "受控独立验证",
            "argv": [sys.executable, "-c", "raise SystemExit(0)"],
            "test_ids": required,
        }]
    }), encoding="utf-8")
    monkeypatch.setenv("TEAM_ASSET_LOCAL_CI_AUTO", "1")
    monkeypatch.setenv("TEAM_ASSET_LOCAL_CI_MANIFEST", str(manifest))

    observed = api.observe({
        "trace_id": result["trace_id"],
        "workspace_root": str(empty_workspace),
        "declarations": [{
            "asset_id": selected_asset,
            "decision": "按团队约束完成安全回退",
            "target": str(target),
        }],
        "tool_calls": [{
            "id": "edit-bound-ci",
            "name": "replace_in_file",
            "kind": "edit",
            "target": str(target),
            "changed_paths": [str(target)],
            "change_hash": "sha256:edit",
        }],
    })

    assert observed["local_ci"]["status"] == "passed"
    receipt = api.receipt(result["trace_id"])
    assert receipt["completion"]["engineering_complete"] is True
    assert receipt["completion"]["changed_paths"] == ["feature_flags/service.py"]


def test_reviewed_manifest_keeps_hidden_validator_outside_agent_workspace(tmp_path):
    workspace = tmp_path / "repo"
    workspace.mkdir()
    manifest_dir = tmp_path / "validator"
    hidden = manifest_dir / "hidden_tests" / "test_private.py"
    hidden.parent.mkdir(parents=True)
    hidden.write_text("def test_private(): assert True\n", encoding="utf-8")
    manifest = manifest_dir / "ci.json"
    manifest.write_text(json.dumps({
        "checks": [{
            "id": "hidden",
            "argv": [sys.executable, "-m", "pytest", "hidden_tests/test_private.py"],
        }]
    }), encoding="utf-8")

    loaded = _load_reviewed_ci_manifest(manifest, workspace)

    assert not (workspace / "hidden_tests").exists()
    assert loaded["checks"][0]["argv"][-1] == str(hidden.resolve())


def test_codebuddy_can_refine_proposal_but_cannot_mark_it_passed(tmp_path):
    api = TeamAssetApi(project_root(), tmp_path / "codebuddy-plan.sqlite3")
    result = api.recommend_turn({
        "session_id": "codebuddy-plan-session",
        "turn_seq": 1,
        "current_query": "修复 Redis 故障时跨租户读取问题",
        "team_id": "team-feature-platform",
        "agent_id": "agent-new-backend",
        "fallbacks": {
            "repository": "team/feature-flag-service",
            "version": "1.4",
            "task_type": "bug_fix",
            "target_paths": ["feature_flags/service.py"],
        },
    })
    asset = next(item["asset"] for item in result["selected"] if item["asset"]["tests"])
    test_id = asset["tests"][0]
    response = api.observe({
        "trace_id": result["trace_id"],
        "codebuddy_acceptance_plan": {
            "criteria": [{
                "text": "故障回退不得读取其他租户数据",
                "category": "security",
                "rationale": "读取真实服务代码后确认租户过滤是关键边界",
                "source_asset_ids": [asset["asset_id"], "hallucinated-asset"],
                "target_paths": ["feature_flags/service.py", "unknown.py"],
                "candidate_test_ids": [test_id, "hallucinated_test"],
            }],
        },
    })

    assert response["acceptance_plan_updated"] is True
    receipt = api.receipt(result["trace_id"])
    criterion = receipt["acceptance_plan"]["criteria"][0]
    assert criterion["source_asset_ids"] == [asset["asset_id"]]
    assert criterion["target_paths"] == ["feature_flags/service.py"]
    assert criterion["candidate_test_ids"] == [test_id]
    assert receipt["acceptance_contract"]["criteria_status"] == "proposed"
    assert receipt["completion"]["business_acceptance_complete"] is False

    # A later response can refer to tests observed in an earlier tool turn.
    # Replacing criterion-1 must discard an old manual mapping at that ID.
    api.observe({"trace_id": result["trace_id"], "acceptance_declarations": [{
        "criterion_id": "criterion-1", "mode": "manual", "note": "old criterion was inapplicable",
    }], "tool_calls": [{"id": "new-test", "kind": "test", "test_ids": ["test_new_boundary"]}],
       "tool_results": [{"tool_call_id": "new-test", "success": True, "test_ids": ["test_new_boundary"]}]})
    api.observe({"trace_id": result["trace_id"], "codebuddy_acceptance_plan": {"criteria": [{
        "text": "当前实现的新边界", "source_asset_ids": [asset["asset_id"]],
        "target_paths": ["feature_flags/service.py"],
        "candidate_test_ids": ["test_new_boundary", "nonexistent_test"],
    }]}})
    updated = api.receipt(result["trace_id"])
    assert updated["acceptance_plan"]["criteria"][0]["candidate_test_ids"] == ["test_new_boundary"]
    assert "criterion-1" not in api.executions[result["trace_id"]].acceptance_declarations
    assert updated["completion"]["business_acceptance_complete"] is False
