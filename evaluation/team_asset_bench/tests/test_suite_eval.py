from pathlib import Path

from team_asset_bench.benchmark_suite import SUITE_ARMS, load_benchmark_suite
from team_asset_bench.catalog import load_assets, project_root
from team_asset_bench.evidence import RunEvidence, TestEvidence as EvidenceTest
from team_asset_bench.live_agent import LiveAgentResult
from team_asset_bench.suite_eval import run_suite_matrix
from team_asset_bench.suite_report import render_resume_bullet
from team_asset_bench.suite_statistics import aggregate_arm, compare_arms, percentile


class FakeAgent:
    calls = 0

    def execute(self, package, workspace: Path) -> LiveAgentResult:
        type(self).calls += 1
        assert (workspace / "hidden_tests").is_dir()
        selected = len(package.selected)
        passed = package.task.task_id == "task-cache-outage-001"
        evidence = RunEvidence(
            trace_id=package.trace_id,
            task_id=package.task.task_id,
            changed_paths=["feature_flags/service.py"],
            decisions={},
            asset_targets={},
            tests=[EvidenceTest("independent_acceptance", passed, "pytest", "fake")],
            tool_calls=["read", "write"] + ["read-extra"] * max(0, 4 - selected),
            attempts=max(1, 4 - selected),
            duration_ms=10_000 + max(0, 4 - selected) * 1_000,
        )
        prompt_tokens = 1_000 + package.token_cost
        return LiveAgentResult(
            evidence=evidence,
            prompt_tokens=prompt_tokens,
            completion_tokens=200,
            total_tokens=prompt_tokens + 200,
            model_turns=2,
        )


def test_suite_manifest_reports_honest_current_coverage():
    suite = load_benchmark_suite(project_root())
    status = suite.status()
    assert status["target_runs"] == 1008
    assert status["actual"]["repositories"] == 1
    assert status["actual"]["scenario_types"] == 1
    assert status["actual"]["tasks"] == 1
    assert status["currently_schedulable_runs"] == 21
    assert status["coverage_ready"] is False


def test_percentile_uses_linear_interpolation():
    assert percentile([1, 2, 3, 4], 0.5) == 2.5
    assert percentile([100, 200, 300], 0.95) == 290.0


def test_aggregates_and_comparisons_include_exact_before_after_values():
    before = [
        {
            "status": "completed",
            "task_id": "a",
            "task_completed": False,
            "test_pass_rate": 0.5,
            "prompt_tokens": 100,
            "completion_tokens": 10,
            "total_tokens": 110,
            "duration_ms": 1_000,
            "tool_calls": 10,
            "attempts": 4,
            "asset_token_cost": 0,
        },
        {
            "status": "completed",
            "task_id": "b",
            "task_completed": True,
            "test_pass_rate": 1.0,
            "prompt_tokens": 100,
            "completion_tokens": 10,
            "total_tokens": 110,
            "duration_ms": 3_000,
            "tool_calls": 10,
            "attempts": 4,
            "asset_token_cost": 0,
        },
    ]
    after = [
        {
            **item,
            "task_completed": True,
            "test_pass_rate": 1.0,
            "prompt_tokens": 75,
            "total_tokens": 85,
            "duration_ms": item["duration_ms"] * 0.75,
            "tool_calls": 8,
            "attempts": 3,
        }
        for item in before
    ]
    comparison = compare_arms(aggregate_arm(after), aggregate_arm(before))
    assert comparison["completion"]["before_rate"] == 0.5
    assert comparison["completion"]["after_rate"] == 1.0
    assert comparison["completion"]["change_percentage_points"] == 50.0
    assert comparison["input_tokens"] == {
        "before": 200,
        "after": 150,
        "unit": "tokens",
        "absolute_change": -50.0,
        "reduction_percent": 25.0,
    }
    assert comparison["mean_tool_calls"]["reduction_percent"] == 20.0
    assert comparison["mean_attempts"]["reduction_percent"] == 25.0


def test_suite_runner_checkpoints_and_resumes(tmp_path):
    suite = load_benchmark_suite(project_root())
    FakeAgent.calls = 0

    def factory():
        return FakeAgent().execute

    summary = run_suite_matrix(
        suite,
        load_assets(project_root()),
        factory,
        repetitions=2,
        concurrency=1,
        result_root=tmp_path,
        bootstrap_iterations=20,
    )
    assert summary["matrix"]["requested_runs"] == len(SUITE_ARMS) * 2
    assert summary["matrix"]["valid_runs"] == len(SUITE_ARMS) * 2
    assert summary["matrix"]["complete"] is True
    assert summary["resume_ready"] is False
    assert FakeAgent.calls == len(SUITE_ARMS) * 2
    for record in summary["runs"]:
        assert (tmp_path / "runs" / record["run_id"] / "run.json").is_file()

    resumed = run_suite_matrix(
        suite,
        load_assets(project_root()),
        factory,
        repetitions=2,
        concurrency=1,
        result_root=tmp_path,
        bootstrap_iterations=20,
    )
    assert resumed["matrix"]["valid_runs"] == len(SUITE_ARMS) * 2
    assert FakeAgent.calls == len(SUITE_ARMS) * 2


def test_resume_copy_refuses_incomplete_scope():
    text = render_resume_bullet(
        {
            "resume_ready": False,
            "matrix": {"repositories": 1, "scenario_types": 1, "tasks": 1, "valid_runs": 21},
            "target": {"repositories": 4, "scenario_types": 6, "tasks": 48, "arms": 7, "repetitions": 3},
        }
    )
    assert "尚不能生成正式简历数字" in text
    assert "21/1008" in text


def test_changed_model_fingerprint_does_not_reuse_old_runs(tmp_path):
    suite = load_benchmark_suite(project_root())
    FakeAgent.calls = 0

    def factory():
        return FakeAgent().execute

    for model in ("model-a", "model-b"):
        run_suite_matrix(
            suite,
            load_assets(project_root()),
            factory,
            repetitions=1,
            result_root=tmp_path,
            model_metadata={"model": model, "temperature": 0},
            bootstrap_iterations=5,
        )
    assert FakeAgent.calls == len(SUITE_ARMS) * 2


def test_resume_copy_uses_absolute_before_after_metrics():
    summary = {
        "resume_ready": True,
        "task_noun": "工程任务",
        "matrix": {
            "repositories": 4,
            "scenario_types": 6,
            "tasks": 48,
            "arms": 7,
            "repetitions": 3,
            "valid_runs": 1008,
        },
        "comparisons": {
            "minimal_vs_no_assets": {
                "completion": {
                    "before_count": 84,
                    "before_total": 144,
                    "before_rate": 0.5833,
                    "after_count": 107,
                    "after_total": 144,
                    "after_rate": 0.7431,
                    "change_percentage_points": 15.98,
                },
                "p95_duration": {
                    "before": 612_800,
                    "after": 477_900,
                    "reduction_percent": 22.01,
                },
                "mean_tool_calls": {
                    "before": 31.4,
                    "after": 23.2,
                    "reduction_percent": 26.11,
                },
                "mean_attempts": {
                    "before": 4.8,
                    "after": 3.4,
                    "reduction_percent": 29.17,
                },
            },
            "minimal_vs_full_context": {
                "input_tokens": {
                    "before": 48_700_000,
                    "after": 33_100_000,
                    "reduction_percent": 32.03,
                }
            },
        },
    }
    text = render_resume_bullet(summary)
    assert "84/144（58.33%）" in text
    assert "107/144（74.31%，↑15.98 个百分点）" in text
    assert "48.70M" in text and "33.10M（↓32.03%）" in text
    assert "612.8s" in text and "477.9s（↓22.01%）" in text
    assert "31.4 次" in text and "23.2 次（↓26.11%）" in text
    assert "4.8 次" in text and "3.4 次（↓29.17%）" in text
