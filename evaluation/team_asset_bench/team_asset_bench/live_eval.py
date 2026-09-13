from __future__ import annotations

import json
import hashlib
import os
from pathlib import Path
from statistics import mean
from typing import Any, Dict, List, Optional

from .catalog import load_assets, load_task, project_root, write_catalog
from .evidence import EvidenceValidator, test_pass_rate
from .ledger import EvidenceLedger
from .live_agent import OpenAIToolCodingAgent
from .openai_provider import OpenAICompatibleConfig, OpenAICompatibleProvider
from .orchestrator import TeamAssetOrchestrator
from .receipt import build_receipt, write_receipt_html, write_receipt_json
from .runner import ARMS, _workspace


def run_real_model_matrix(
    root: Optional[Path] = None,
    *,
    repetitions: Optional[int] = None,
) -> Dict[str, Any]:
    if os.environ.get("TEAM_ASSET_ALLOW_EXTERNAL_MODEL", "").lower() not in {"1", "true", "yes"}:
        raise RuntimeError(
            "真实模型评测默认关闭；确认评测数据可发送后设置 TEAM_ASSET_ALLOW_EXTERNAL_MODEL=true"
        )
    benchmark_root = root or project_root()
    write_catalog(benchmark_root)
    task = load_task(benchmark_root)
    assets = load_assets(benchmark_root)
    repeat_count = repetitions or int(os.environ.get("TEAM_ASSET_EVAL_REPETITIONS", "3"))
    if repeat_count < 2:
        raise ValueError("真实模型评测至少重复 2 次，建议 3–5 次")
    provider = OpenAICompatibleProvider(OpenAICompatibleConfig.from_env())
    agent = OpenAIToolCodingAgent(provider, max_turns=int(os.environ.get("TEAM_ASSET_MAX_MODEL_TURNS", "12")))
    result_root = benchmark_root / "results" / "real_model"

    runs: Dict[str, List[Dict[str, Any]]] = {arm.name: [] for arm in ARMS}
    runtime: Dict[str, List[tuple[Any, EvidenceLedger, Any]]] = {arm.name: [] for arm in ARMS}
    for arm in ARMS:
        for index in range(1, repeat_count + 1):
            ledger = EvidenceLedger()
            package = TeamAssetOrchestrator(assets, ledger).select(
                task,
                strategy=arm.strategy,
                excluded_asset_ids=arm.excluded,
            )
            EvidenceValidator(ledger).confirm_injected(
                package,
                actor_id="openai-compatible-agent-harness",
                evidence_ref=f"prompt-sha256:{hashlib.sha256(package.markdown.encode('utf-8')).hexdigest()}",
                detail={"injection_point": "live_agent.system"},
            )
            temp = _workspace(benchmark_root)
            try:
                live = agent.execute(package, Path(temp.name))
            finally:
                temp.cleanup()
            validated = EvidenceValidator(ledger).validate(package, live.evidence)
            record = {
                "run": index,
                "trace_id": package.trace_id,
                "selected_asset_ids": [item.asset.asset_id for item in package.selected],
                "asset_token_cost": package.token_cost,
                "tests_total": len(live.evidence.tests),
                "tests_passed": sum(test.passed for test in live.evidence.tests),
                "test_pass_rate": test_pass_rate(live.evidence.tests),
                "task_completed": live.evidence.passed,
                "validated_asset_ids": validated,
                "tool_calls": len(live.evidence.tool_calls),
                "attempts": live.evidence.attempts,
                "duration_ms": live.evidence.duration_ms,
                "prompt_tokens": live.prompt_tokens,
                "completion_tokens": live.completion_tokens,
                "total_tokens": live.total_tokens,
                "model_turns": live.model_turns,
            }
            runs[arm.name].append(record)
            runtime[arm.name].append((package, ledger, live.evidence))
            run_dir = result_root / arm.name / f"run-{index}"
            receipt = build_receipt(package, ledger, live.evidence, arm=f"{arm.name}/run-{index}")
            write_receipt_json(receipt, run_dir / "asset-receipt.json")
            write_receipt_html(receipt, run_dir / "asset-receipt.html")

    aggregates = {name: _aggregate(records) for name, records in runs.items()}
    minimal = aggregates["minimal_team_assets"]
    comparisons: Dict[str, Any] = {
        "minimal_vs_no_assets": _delta(minimal, aggregates["no_assets"]),
        "minimal_vs_full_context": {
            **_delta(minimal, aggregates["full_context"]),
            "mean_asset_token_saving": round(
                aggregates["full_context"]["mean_asset_token_cost"] - minimal["mean_asset_token_cost"], 2
            ),
        },
        "asset_ablations": {},
    }
    ablation_assets = {
        "without_key_wiki": "asset-wiki-tenant-fallback",
        "without_failure_memory": "asset-memory-retry-storm",
        "without_code_graph": "asset-codegraph-cache-boundary",
        "without_validation_skill": "asset-skill-cache-fault-recovery",
    }
    for arm_name, asset_id in ablation_assets.items():
        delta = _delta(minimal, aggregates[arm_name])
        positive = delta["completion_rate_delta"] > 0 or delta["test_pass_rate_delta"] > 0
        comparisons["asset_ablations"][arm_name] = {
            "asset_id": asset_id,
            **delta,
            "positive": positive,
        }
        if positive:
            for package, ledger, evidence in runtime["minimal_team_assets"]:
                EvidenceValidator(ledger).mark_contributed(
                    package,
                    [asset_id],
                    "results/real-model-evaluation-summary.json#asset_ablations",
                    delta,
                )
                run_index = runs["minimal_team_assets"].index(
                    next(record for record in runs["minimal_team_assets"] if record["trace_id"] == package.trace_id)
                ) + 1
                receipt = build_receipt(
                    package,
                    ledger,
                    evidence,
                    arm=f"minimal_team_assets/run-{run_index}",
                    comparison=comparisons,
                )
                run_dir = result_root / "minimal_team_assets" / f"run-{run_index}"
                write_receipt_json(receipt, run_dir / "asset-receipt.json")
                write_receipt_html(receipt, run_dir / "asset-receipt.html")

    summary = {
        "schema_version": "team-asset-real-model-evaluation/v1",
        "mode": "real-openai-compatible-tool-agent",
        "model": OpenAICompatibleConfig.from_env().model,
        "repetitions": repeat_count,
        "hidden_tests_visible_to_model": False,
        "runs": runs,
        "aggregates": aggregates,
        "comparisons": comparisons,
    }
    output = benchmark_root / "results" / "real-model-evaluation-summary.json"
    output.write_text(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return summary


def _aggregate(records: List[Dict[str, Any]]) -> Dict[str, float]:
    return {
        "completion_rate": round(mean(1.0 if item["task_completed"] else 0.0 for item in records), 4),
        "mean_test_pass_rate": round(mean(item["test_pass_rate"] for item in records), 4),
        "mean_total_tokens": round(mean(item["total_tokens"] for item in records), 2),
        "mean_duration_ms": round(mean(item["duration_ms"] for item in records), 2),
        "mean_tool_calls": round(mean(item["tool_calls"] for item in records), 2),
        "mean_attempts": round(mean(item["attempts"] for item in records), 2),
        "mean_asset_token_cost": round(mean(item["asset_token_cost"] for item in records), 2),
    }


def _delta(enabled: Dict[str, float], baseline: Dict[str, float]) -> Dict[str, float]:
    return {
        "completion_rate_delta": round(enabled["completion_rate"] - baseline["completion_rate"], 4),
        "test_pass_rate_delta": round(enabled["mean_test_pass_rate"] - baseline["mean_test_pass_rate"], 4),
        "token_delta": round(enabled["mean_total_tokens"] - baseline["mean_total_tokens"], 2),
        "duration_ms_delta": round(enabled["mean_duration_ms"] - baseline["mean_duration_ms"], 2),
        "tool_call_delta": round(enabled["mean_tool_calls"] - baseline["mean_tool_calls"], 2),
        "attempt_delta": round(enabled["mean_attempts"] - baseline["mean_attempts"], 2),
    }
