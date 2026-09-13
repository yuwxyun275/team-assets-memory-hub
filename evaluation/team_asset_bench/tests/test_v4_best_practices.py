from __future__ import annotations

import json
from pathlib import Path

import pytest

from team_asset_bench.attribution import usage_attribution, validation_attribution
from team_asset_bench.catalog import load_assets, project_root
from team_asset_bench.ci_adapter import normalize_ci_run
from team_asset_bench.ledger import EvidenceLedger
from team_asset_bench.models import AssetState
from team_asset_bench.server import TeamAssetApi, _merge_task_receipt_metadata, _receipt_attribution
from team_asset_bench.verification_discovery import discover_verification_plan


def test_repository_verification_is_discovered_instead_of_fixed_by_user(tmp_path):
    (tmp_path / "feature_flags").mkdir()
    (tmp_path / "feature_flags" / "service.py").write_text("def get_flag():\n    return None\n")
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_service.py").write_text(
        "from feature_flags.service import get_flag\n\ndef test_cache_fallback():\n    assert get_flag() is None\n"
    )
    (tmp_path / "pyproject.toml").write_text("[tool.pytest.ini_options]\ntestpaths=['tests']\n")

    plan = discover_verification_plan(
        tmp_path,
        changed_paths=["feature_flags/service.py"],
        acceptance_criteria=["Redis 缓存故障时必须安全回退"],
    )

    assert plan.frameworks == ["pytest"]
    assert plan.tests[0].test_id == "test_cache_fallback"
    assert plan.tests[0].target_paths == ["feature_flags/service.py"]
    assert plan.checks[0]["argv"][1:4] == ["-m", "pytest", "-q"]
    assert plan.workspace_fingerprint.startswith("sha256:")
    assert plan.acceptance_coverage[0]["status"] == "mapped_candidate"
    assert plan.acceptance_coverage[0]["mapped_test_ids"] == ["test_cache_fallback"]


def test_acceptance_discovery_reports_real_coverage_gap(tmp_path):
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_health.py").write_text(
        "def test_health_endpoint():\n    assert True\n"
    )

    plan = discover_verification_plan(
        tmp_path,
        acceptance_criteria=["租户权限变更必须留下不可抵赖的审计日志"],
    )

    assert plan.acceptance_coverage[0]["status"] == "coverage_gap"
    assert plan.acceptance_coverage[0]["mapped_test_ids"] == []


def test_audit_requirement_is_not_mapped_by_generic_database_write_test(tmp_path):
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_repository.py").write_text(
        "def test_database_write():\n    assert save_record() is True\n"
    )

    plan = discover_verification_plan(
        tmp_path,
        acceptance_criteria=["所有管理员操作必须写入审计平台"],
    )

    assert plan.acceptance_coverage[0]["status"] == "coverage_gap"
    assert plan.acceptance_coverage[0]["mapped_test_ids"] == []


def test_attribution_requires_declaration_change_and_specific_test():
    asset = next(item for item in load_assets(project_root()) if item.asset_id == "asset-wiki-tenant-fallback")
    usage = usage_attribution(
        asset,
        {"decision": "保持租户隔离", "target": "feature_flags/service.py:FeatureFlagService.get_flag"},
        {
            "id": "edit-1",
            "name": "apply_patch",
            "kind": "edit",
            "target": "feature_flags/service.py",
            "changed_paths": ["feature_flags/service.py"],
            "change_hash": "sha256:change",
        },
    )
    validated = validation_attribution(
        asset,
        usage,
        matched_tests=["test_outage_never_leaks_another_tenant"],
        evidence_ref="sha256:test-output",
        result_success=True,
    )

    assert usage["grade"] == "strong"
    assert validated["grade"] == "strong"
    assert validated["validation"]["matched_tests"] == ["test_outage_never_leaks_another_tenant"]


def test_feedback_distinguishes_not_applicable_from_incorrect(tmp_path):
    api = TeamAssetApi(state_db_path=tmp_path / "v4.sqlite3")
    result = api.recommend_turn({
        "session_id": "v4-feedback",
        "turn_seq": 1,
        "current_query": "Redis 故障时怎样避免租户数据泄漏",
        "team_id": "team-feature-platform",
        "agent_id": "agent-new-backend",
        "fallbacks": {"repository": "team/feature-flag-service", "version": "1.4", "task_type": "bug_fix"},
    })
    asset_id = result["selected"][0]["asset"]["asset_id"]
    response = api.record_feedback({
        "trace_id": result["trace_id"],
        "asset_id": asset_id,
        "signal": "not_applicable",
        "reason": "本轮只定位代码，尚未进入故障处理",
        "actor_type": "agent",
    })
    assert response["feedback"][0]["signal"] == "not_applicable"
    with pytest.raises(ValueError):
        api.record_feedback({
            "trace_id": result["trace_id"],
            "asset_id": asset_id,
            "signal": "incorrect",
        })


def test_remote_ci_must_bind_commit_and_verified_webhook():
    base = {
        "trace_id": "trace-v4-ci",
        "provider": "github-actions",
        "checks": [{"id": "pytest", "status": "passed", "test_ids": ["test_x"]}],
    }
    with pytest.raises(ValueError):
        normalize_ci_run(base)
    untrusted = normalize_ci_run({**base, "commit_sha": "abc123"})
    trusted = normalize_ci_run({**base, "commit_sha": "abc123", "webhook_verified": True})
    assert untrusted["trusted_for_validation"] is False
    assert trusted["trusted_for_validation"] is True


def test_partial_retry_cannot_overwrite_completed_task_receipt():
    completed = {
        "trace_id": "trace-completed",
        "completion": {"task_completed": True, "test_progress": {"passed": 9, "total": 9}},
        "summary": {"contributed": 4},
    }
    partial = {
        "trace_id": "trace-smoke",
        "completion": {"task_completed": False, "test_progress": {"passed": 0, "total": 9}},
        "summary": {"selected": 4, "injected": 0},
    }

    metadata, active = _merge_task_receipt_metadata({"asset_evidence": completed}, partial)

    assert active["trace_id"] == "trace-completed"
    assert metadata["asset_evidence_latest_attempt"]["trace_id"] == "trace-smoke"
    assert metadata["asset_evidence_history"][-1]["trace_id"] == "trace-smoke"


def test_legacy_events_reconstruct_attribution_without_inventing_evidence():
    asset = next(item for item in load_assets(project_root()) if item.asset_id == "asset-wiki-tenant-fallback")
    ledger = EvidenceLedger()
    common = {"trace_id": "legacy", "task_id": "task", "asset_id": asset.asset_id}
    ledger.append(**common, state=AssetState.RECALLED, actor_type="system", actor_id="test")
    ledger.append(**common, state=AssetState.SELECTED, actor_type="system", actor_id="test")
    ledger.append(**common, state=AssetState.INJECTED, actor_type="proxy", actor_id="test")
    used = ledger.append(
        **common,
        state=AssetState.USED,
        actor_type="agent",
        actor_id="test",
        target="feature_flags/service.py:FeatureFlagService.get_flag",
        decision="只回退当前租户已发布配置",
        evidence_ref="tool-call:edit-1",
        detail={
            "tool_name": "apply_patch",
            "tool_kind": "edit",
            "changed_paths": ["feature_flags/service.py"],
            "change_hash": "sha256:change",
        },
    )
    validated = ledger.append(
        **common,
        state=AssetState.VALIDATED,
        actor_type="validator",
        actor_id="test",
        evidence_ref="sha256:tests",
        detail={"matched_tests": ["test_outage_never_leaks_another_tenant"]},
    )

    attribution = _receipt_attribution(asset, used, validated)

    assert attribution is not None
    assert attribution["grade"] == "strong"
    assert attribution["validation"]["matched_tests"] == ["test_outage_never_leaks_another_tenant"]
