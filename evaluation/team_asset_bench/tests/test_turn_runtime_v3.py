from __future__ import annotations

import sys

from team_asset_bench.ci_adapter import LocalCiRunner
from team_asset_bench.server import TeamAssetApi, _authoritative_session_receipt


def _recommend(api: TeamAssetApi, *, turn: int, query: str):
    return api.recommend_turn({
        "session_id": "session-v3-test",
        "turn_seq": turn,
        "current_query": query,
        "team_id": "team-feature-platform",
        "agent_id": "agent-new-backend",
        "fallbacks": {
            "repository": "team/feature-flag-service",
            "version": "1.4",
            "task_type": "bug_fix",
            "target_paths": ["feature_flags/service.py"],
        },
    })


def test_each_human_turn_gets_a_distinct_context_and_prior_unused_assets_are_feedback(tmp_path):
    api = TeamAssetApi(state_db_path=tmp_path / "v3.sqlite3")
    first = _recommend(api, turn=1, query="先理解功能开关的读取链路")
    second = _recommend(api, turn=2, query="Redis 故障时怎样安全回退并避免跨租户")

    assert first["trace_id"] != second["trace_id"]
    assert first["turn"]["turn_seq"] == 1
    assert second["turn"]["turn_seq"] == 2
    turns = api.state_store.list_turns(session_id="session-v3-test")
    assert [item["status"] for item in turns] == ["closed", "active"]
    feedback = api.state_store.feedback_for_turn(turns[0]["turn_id"])
    assert feedback
    assert {item["signal"] for item in feedback} == {"unobserved"}
    assert {item["weight"] for item in feedback} == {0.0}


def test_task_board_is_optional_for_dynamic_turn_retrieval(tmp_path):
    api = TeamAssetApi(state_db_path=tmp_path / "taskless.sqlite3")
    result = _recommend(api, turn=1, query="Redis 超时后接口返回 5xx，请定位问题")

    assert result["selected"]
    assert result["task"]["task_id"].startswith("session-task-")
    assert result["turn"]["dynamic_retrieval"] is True


def test_contextual_feedback_changes_future_ranking_without_replacing_reviewed_prior(tmp_path):
    api = TeamAssetApi(state_db_path=tmp_path / "feedback.sqlite3")
    first = _recommend(api, turn=1, query="Redis 故障时如何安全回退同租户已发布配置")
    selected = first["selected"]
    asset_id = selected[0]["asset"]["asset_id"]
    original = next(item for item in first["recalled"] if item["asset"]["asset_id"] == asset_id)
    api.record_feedback({
        "trace_id": first["trace_id"],
        "asset_id": asset_id,
        "signal": "accepted",
        "reason": "该约束直接决定了本轮实现边界",
    })

    second = _recommend(api, turn=2, query="Redis 故障时如何安全回退同租户已发布配置")
    reranked = next(item for item in second["recalled"] if item["asset"]["asset_id"] == asset_id)

    # Closing turn 1 records only neutral unobserved telemetry; the explicit
    # useful (legacy accepted alias) signal increases same-context utility.
    assert reranked["features"]["historical_effect"] > original["features"]["historical_effect"]
    assert reranked["score"] > original["score"]


def test_independent_ci_can_validate_used_asset_but_not_ignored_recommendations(tmp_path):
    api = TeamAssetApi(state_db_path=tmp_path / "ci.sqlite3")
    result = _recommend(api, turn=1, query="修复 Redis 故障时跨租户读取已发布配置的问题")
    trace_id = result["trace_id"]
    selected = result["selected"]
    asset = next(item["asset"] for item in selected if item["asset"]["tests"])
    asset_id = asset["asset_id"]
    required_test = asset["tests"][0]
    api.confirm_injected({
        "trace_id": trace_id,
        "asset_ids": [item["asset"]["asset_id"] for item in selected],
        "context_hash": "sha256:turn-context",
    })
    api.observe({
        "trace_id": trace_id,
        "declarations": [{
            "asset_id": asset_id,
            "decision": "采用团队约束修复故障回退边界",
            "target": "feature_flags/service.py:FeatureFlagService.get_flag",
        }],
        "tool_calls": [{
            "id": "edit-v3",
            "name": "apply_patch",
            "kind": "edit",
            "target": "feature_flags/service.py",
            "changed_paths": ["feature_flags/service.py"],
        }],
    })
    response = api.record_ci_run({
        "run_id": "ci-v3-1",
        "trace_id": trace_id,
        "provider": "local-ci",
        "changed_paths": ["feature_flags/service.py"],
        "checks": [{
            "id": "hidden-feature-test",
            "name": "隐藏功能测试",
            "status": "passed",
            "source": "hidden",
            "test_ids": [required_test],
            "summary": f"1 passed: {required_test}",
            "evidence_ref": "sha256:hidden-test-output",
        }],
        "evidence_ref": "sha256:ci-run",
    })

    matching = next(item for item in response["receipt"]["assets"] if item["asset_id"] == asset_id)
    assert "used" in matching["states"]
    assert "validated" in matching["states"]
    assert matching["attribution"]["grade"] in {"moderate", "strong"}
    assert required_test in matching["attribution"]["validation"]["matched_tests"]
    assert response["receipt"]["ci_runs"][0]["provider"] == "local-ci"
    assert response["receipt"]["summary"]["validated"] == 1


def test_local_ci_runner_executes_reviewed_argv_without_shell(tmp_path):
    runner = LocalCiRunner(tmp_path)
    result = runner.run_manifest(
        {
            "checks": [{
                "id": "python-smoke",
                "name": "Python 冒烟验证",
                "argv": [sys.executable, "-c", "print('ok')"],
                "source": "project",
                "test_ids": ["test_smoke"],
            }]
        },
        trace_id="trace-local-ci",
        turn_id="turn-local-ci",
        changed_paths=["feature_flags/service.py"],
    )

    assert result["status"] == "passed"
    assert result["checks"][0]["test_ids"] == ["test_smoke"]
    assert result["evidence_ref"].startswith("sha256:")


def test_status_only_follow_up_does_not_erase_previous_execution_evidence(tmp_path):
    api = TeamAssetApi(state_db_path=tmp_path / "status-follow-up.sqlite3")
    executed = _recommend(api, turn=1, query="修复 Redis 故障回退")
    api.observe({
        "trace_id": executed["trace_id"],
        "tool_calls": [{
            "id": "edit-before-status-question",
            "name": "replace_in_file",
            "kind": "edit",
            "target": "feature_flags/service.py",
            "changed_paths": ["feature_flags/service.py"],
            "change_hash": "sha256:status-follow-up-edit",
        }],
    })
    status_question = _recommend(api, turn=2, query="完成了吗现在")

    receipt = api.session_receipt("session-v3-test")

    assert receipt["active_evidence_trace_id"] == executed["trace_id"]
    assert receipt["latest_trace_id"] == status_question["trace_id"]
    assert receipt["completion"]["changed_paths"] == ["feature_flags/service.py"]
    assert receipt["latest_turn"]["query_preview"] == "完成了吗现在"


def test_report_write_after_verified_code_does_not_erase_ci_projection():
    verified = {"trace_id": "verified", "completion": {"task_completed": True}, "summary": {"validated": 4}}
    report = {"trace_id": "report", "task_profile": {"task_type": {"value": "bug_fix"}},
              "completion": {"changed_paths": ["RESULT.md"], "target_paths": ["service.py"]}}
    assert _authoritative_session_receipt([verified, report], report)["trace_id"] == "verified"
    # Genuine new execution evidence must supersede the old successful result.
    for changes in [
        {"changed_paths": ["service.py"]}, {"changed_paths": ["config.yaml"]},
        {"failed_tests": ["test_new_regression"]}, {"target_paths": ["RESULT.md"]},
    ]:
        new = {**report, "completion": {**report["completion"], **changes}}
        assert _authoritative_session_receipt([verified, new], new)["trace_id"] == "report"
    ci = {**report, "ci_runs": [{"status": "failed"}]}
    assert _authoritative_session_receipt([verified, ci], ci)["trace_id"] == "report"
    unknown = {**report, "task_profile": {}}
    assert _authoritative_session_receipt([verified, unknown], unknown)["trace_id"] == "report"
