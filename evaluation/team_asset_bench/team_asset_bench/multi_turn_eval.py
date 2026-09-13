from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from pathlib import Path
from statistics import mean
from typing import Any, Dict, Iterable, List, Mapping, Optional

from .catalog import project_root
from .openai_provider import OpenAICompatibleConfig, OpenAICompatibleProvider
from .server import TeamAssetApi


ARMS = (
    {"name": "adaptive_minimal", "strategy": "minimal", "learn": True},
    {"name": "static_minimal", "strategy": "minimal", "learn": False},
    {"name": "full_context", "strategy": "full", "learn": False},
    {"name": "no_assets", "strategy": "none", "learn": False},
)


def run_multi_turn_real_model_evaluation(
    root: Optional[Path] = None,
    *,
    repetitions: int = 3,
) -> Dict[str, Any]:
    if os.environ.get("TEAM_ASSET_ALLOW_EXTERNAL_MODEL", "").lower() not in {"1", "true", "yes"}:
        raise RuntimeError("真实模型评测未获授权；需要 TEAM_ASSET_ALLOW_EXTERNAL_MODEL=true")
    if repetitions < 2:
        raise ValueError("多轮真实模型评测至少重复 2 次")
    benchmark_root = root or project_root()
    scenario_path = benchmark_root / "task_bundles" / "cache_outage_001" / "multi-turn-scenario.json"
    scenario = json.loads(scenario_path.read_text(encoding="utf-8"))
    turns = [item for item in scenario.get("turns", []) if isinstance(item, dict)]
    if not turns:
        raise ValueError("multi-turn scenario has no turns")
    config = OpenAICompatibleConfig.from_env()
    provider = OpenAICompatibleProvider(config)
    all_runs: Dict[str, List[Dict[str, Any]]] = {str(arm["name"]): [] for arm in ARMS}

    for arm in ARMS:
        arm_name = str(arm["name"])
        for repetition in range(1, repetitions + 1):
            with tempfile.TemporaryDirectory(prefix="team-asset-turn-eval-") as temp:
                api = TeamAssetApi(
                    root=benchmark_root,
                    state_db_path=Path(temp) / "runtime.sqlite3",
                )
                session_id = f"real-eval-{arm_name}-{repetition}"
                records: List[Dict[str, Any]] = []
                for turn_seq, turn in enumerate(turns, start=1):
                    expected = {str(item) for item in turn.get("expected_asset_ids", [])}
                    result = api.recommend_turn({
                        "session_id": session_id,
                        "turn_seq": turn_seq,
                        "strategy": arm["strategy"],
                        "current_query": str(turn.get("query") or ""),
                        "team_id": str(scenario.get("team_id") or "team-feature-platform"),
                        "agent_id": str(scenario.get("agent_id") or "agent-new-backend"),
                        "fallbacks": {
                            "repository": "team/feature-flag-service",
                            "version": "1.4",
                            "task_type": str(turn.get("task_type") or "bug_fix"),
                            "target_paths": list(turn.get("target_paths") or []),
                        },
                    })
                    selected = [str(item["asset"]["asset_id"]) for item in result.get("selected", [])]
                    ranks = {
                        str(item["asset"]["asset_id"]): int(item.get("rank") or 0)
                        for item in result.get("recalled", [])
                    }
                    if selected:
                        api.confirm_injected({
                            "trace_id": result["trace_id"],
                            "asset_ids": selected,
                            "context_hash": f"sha256:{hashlib.sha256(result['markdown'].encode('utf-8')).hexdigest()}",
                            "protocol": "real-model-multi-turn-eval",
                            "injection_point": "system.suffix:task_context",
                        })
                    judgement = _model_judgement(
                        provider,
                        query=str(turn.get("query") or ""),
                        context=str(result.get("markdown") or ""),
                        selected=selected,
                    )
                    judged_useful = set(judgement["useful_asset_ids"])
                    if arm["learn"]:
                        for asset_id in selected:
                            useful = asset_id in judged_useful
                            api.record_feedback({
                                "trace_id": result["trace_id"],
                                "asset_id": asset_id,
                                "signal": "useful" if useful else "not_applicable",
                                "reason": (
                                    "真实模型判断该资产直接帮助当前轮决策"
                                    if useful else "真实模型判断该资产与当前轮操作没有直接关系"
                                ),
                                "actor_type": "agent",
                                "actor_id": "openai-compatible-eval-agent",
                                "evidence_ref": judgement["response_ref"],
                            })
                    records.append({
                        "turn_seq": turn_seq,
                        "query": str(turn.get("query") or ""),
                        "expected_asset_ids": sorted(expected),
                        "selected_asset_ids": selected,
                        "model_useful_asset_ids": sorted(judged_useful),
                        "precision_at_selected": _precision(selected, expected),
                        "recall_at_selected": _recall(selected, expected),
                        "model_useful_precision": _precision(judged_useful, expected),
                        "noise_rate": round(1.0 - _precision(selected, expected), 4) if selected else 0.0,
                        "asset_token_cost": int(result.get("token_cost") or 0),
                        "prompt_tokens": judgement["prompt_tokens"],
                        "completion_tokens": judgement["completion_tokens"],
                        "expected_ranks": {asset_id: ranks.get(asset_id, 0) for asset_id in sorted(expected)},
                        "response_ref": judgement["response_ref"],
                    })
                all_runs[arm_name].append({
                    "repetition": repetition,
                    "turns": records,
                    "aggregate": _aggregate_turns(records),
                })

    aggregates = {
        name: _aggregate_runs(runs)
        for name, runs in all_runs.items()
    }
    adaptive = aggregates["adaptive_minimal"]
    static = aggregates["static_minimal"]
    full = aggregates["full_context"]
    summary = {
        "schema_version": "team-asset-real-model-multi-turn-evaluation/v1",
        "mode": "real-openai-compatible-multi-turn-feedback",
        "model": config.model,
        "scenario": str(scenario.get("name") or ""),
        "repetitions": repetitions,
        "turns_per_run": len(turns),
        "raw_model_content_stored": False,
        "runs": all_runs,
        "aggregates": aggregates,
        "comparisons": {
            "adaptive_vs_static": _delta(adaptive, static),
            "adaptive_vs_full": _delta(adaptive, full),
        },
        "interpretation": {
            "recommendation_quality_proven_by": "reviewed per-turn oracle labels",
            "model_adoption_proven_by": "real model structured selection; only response hash retained",
            "task_correctness_proven_by": "separate repository tests/CI, not this recommendation evaluation",
        },
    }
    output = benchmark_root / "results" / "real-model-multi-turn-evaluation.json"
    output.write_text(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return summary


def _model_judgement(
    provider: OpenAICompatibleProvider,
    *,
    query: str,
    context: str,
    selected: List[str],
) -> Dict[str, Any]:
    prompt = (
        "你正在模拟企业 AI Coding 会话中的单轮资产采用判断。"
        "只判断哪些已注入资产直接帮助当前轮决策；不要因为资产看起来专业就选择。"
        "只输出 JSON：{\"useful_asset_ids\":[\"asset-id\"],\"reason\":\"一句话\"}。\n\n"
        f"当前轮问题：{query}\n\n已注入团队资产：\n{context or '无团队资产'}"
    )
    completion = provider.chat([
        {"role": "system", "content": "你是严格的团队资产相关性评审员，只输出合法 JSON。"},
        {"role": "user", "content": prompt},
    ])
    raw = str(completion.message.get("content") or "")
    parsed = _json_object(raw)
    allowed = set(selected)
    useful = [
        str(item) for item in parsed.get("useful_asset_ids", [])
        if str(item) in allowed
    ] if isinstance(parsed.get("useful_asset_ids"), list) else []
    usage = completion.usage
    return {
        "useful_asset_ids": list(dict.fromkeys(useful)),
        "prompt_tokens": int(usage.get("prompt_tokens") or 0),
        "completion_tokens": int(usage.get("completion_tokens") or 0),
        "response_ref": f"sha256:{hashlib.sha256(raw.encode('utf-8')).hexdigest()}",
    }


def _json_object(text: str) -> Dict[str, Any]:
    try:
        value = json.loads(text)
        return value if isinstance(value, dict) else {}
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]*\}", text)
        if not match:
            return {}
        try:
            value = json.loads(match.group(0))
            return value if isinstance(value, dict) else {}
        except json.JSONDecodeError:
            return {}


def _precision(values: Iterable[str], expected: set[str]) -> float:
    items = set(values)
    return round(len(items & expected) / len(items), 4) if items else (1.0 if not expected else 0.0)


def _recall(values: Iterable[str], expected: set[str]) -> float:
    return round(len(set(values) & expected) / len(expected), 4) if expected else 1.0


def _aggregate_turns(turns: List[Mapping[str, Any]]) -> Dict[str, float]:
    return {
        "mean_precision": round(mean(float(item["precision_at_selected"]) for item in turns), 4),
        "mean_recall": round(mean(float(item["recall_at_selected"]) for item in turns), 4),
        "mean_model_useful_precision": round(mean(float(item["model_useful_precision"]) for item in turns), 4),
        "mean_noise_rate": round(mean(float(item["noise_rate"]) for item in turns), 4),
        "mean_asset_token_cost": round(mean(float(item["asset_token_cost"]) for item in turns), 2),
        "mean_model_tokens": round(mean(float(item["prompt_tokens"] + item["completion_tokens"]) for item in turns), 2),
    }


def _aggregate_runs(runs: List[Mapping[str, Any]]) -> Dict[str, float]:
    keys = list(runs[0]["aggregate"].keys())
    return {key: round(mean(float(run["aggregate"][key]) for run in runs), 4) for key in keys}


def _delta(left: Mapping[str, float], right: Mapping[str, float]) -> Dict[str, float]:
    return {key: round(float(left[key]) - float(right[key]), 4) for key in left if key in right}
