from __future__ import annotations

import math
import random
from collections import defaultdict
from statistics import mean
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple, Union


Number = Union[int, float]


def percentile(values: Iterable[Number], quantile: float) -> float:
    ordered = sorted(float(item) for item in values)
    if not ordered:
        return 0.0
    if quantile <= 0:
        return ordered[0]
    if quantile >= 1:
        return ordered[-1]
    position = (len(ordered) - 1) * quantile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    weight = position - lower
    return ordered[lower] * (1.0 - weight) + ordered[upper] * weight


def percent_change(after: Number, before: Number) -> Optional[float]:
    baseline = float(before)
    if baseline == 0:
        return None
    return round((float(after) - baseline) / baseline * 100.0, 2)


def percent_reduction(after: Number, before: Number) -> Optional[float]:
    change = percent_change(after, before)
    return None if change is None else round(-change, 2)


def _wilson_interval(successes: int, total: int, z: float = 1.959963984540054) -> List[float]:
    if total <= 0:
        return [0.0, 0.0]
    p = successes / total
    denominator = 1.0 + z * z / total
    center = (p + z * z / (2.0 * total)) / denominator
    margin = z * math.sqrt((p * (1.0 - p) + z * z / (4.0 * total)) / total) / denominator
    return [round(max(0.0, center - margin), 4), round(min(1.0, center + margin), 4)]


def aggregate_arm(records: Sequence[Mapping[str, Any]]) -> Dict[str, Any]:
    valid = [item for item in records if item.get("status") == "completed"]
    completion_count = sum(1 for item in valid if item.get("task_completed"))
    prompt_tokens = [float(item.get("prompt_tokens", 0)) for item in valid]
    completion_tokens = [float(item.get("completion_tokens", 0)) for item in valid]
    total_tokens = [float(item.get("total_tokens", 0)) for item in valid]
    durations = [float(item.get("duration_ms", 0)) for item in valid]
    tool_calls = [float(item.get("tool_calls", 0)) for item in valid]
    attempts = [float(item.get("attempts", 0)) for item in valid]
    test_rates = [float(item.get("test_pass_rate", 0)) for item in valid]
    asset_tokens = [float(item.get("asset_token_cost", 0)) for item in valid]

    def average(values: Sequence[float]) -> float:
        return round(mean(values), 2) if values else 0.0

    return {
        "scheduled_runs": len(records),
        "valid_runs": len(valid),
        "infrastructure_failures": len(records) - len(valid),
        "distinct_tasks": len({str(item.get("task_id")) for item in valid}),
        "completion_count": completion_count,
        "completion_rate": round(completion_count / len(valid), 4) if valid else 0.0,
        "completion_rate_ci95": _wilson_interval(completion_count, len(valid)),
        "mean_test_pass_rate": round(mean(test_rates), 4) if test_rates else 0.0,
        "total_input_tokens": int(sum(prompt_tokens)),
        "mean_input_tokens": average(prompt_tokens),
        "total_output_tokens": int(sum(completion_tokens)),
        "mean_output_tokens": average(completion_tokens),
        "total_tokens": int(sum(total_tokens)),
        "mean_total_tokens": average(total_tokens),
        "p50_duration_ms": round(percentile(durations, 0.50), 2),
        "p95_duration_ms": round(percentile(durations, 0.95), 2),
        "mean_duration_ms": average(durations),
        "mean_tool_calls": average(tool_calls),
        "mean_attempts": average(attempts),
        "mean_asset_token_cost": average(asset_tokens),
    }


def compare_arms(after: Mapping[str, Any], before: Mapping[str, Any]) -> Dict[str, Any]:
    completion_after = float(after["completion_rate"])
    completion_before = float(before["completion_rate"])
    return {
        "completion": {
            "before_count": int(before["completion_count"]),
            "before_total": int(before["valid_runs"]),
            "before_rate": completion_before,
            "after_count": int(after["completion_count"]),
            "after_total": int(after["valid_runs"]),
            "after_rate": completion_after,
            "change_percentage_points": round((completion_after - completion_before) * 100.0, 2),
            "relative_change_percent": percent_change(completion_after, completion_before),
        },
        "input_tokens": _before_after(
            after["total_input_tokens"], before["total_input_tokens"], "tokens", reduction=True
        ),
        "p95_duration": _before_after(
            after["p95_duration_ms"], before["p95_duration_ms"], "ms", reduction=True
        ),
        "mean_tool_calls": _before_after(
            after["mean_tool_calls"], before["mean_tool_calls"], "calls_per_run", reduction=True
        ),
        "mean_attempts": _before_after(
            after["mean_attempts"], before["mean_attempts"], "attempts_per_run", reduction=True
        ),
        "mean_test_pass_rate": {
            "before": float(before["mean_test_pass_rate"]),
            "after": float(after["mean_test_pass_rate"]),
            "change_percentage_points": round(
                (float(after["mean_test_pass_rate"]) - float(before["mean_test_pass_rate"])) * 100.0,
                2,
            ),
        },
    }


def _before_after(after: Number, before: Number, unit: str, *, reduction: bool) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "before": before,
        "after": after,
        "unit": unit,
        "absolute_change": round(float(after) - float(before), 2),
    }
    if reduction:
        payload["reduction_percent"] = percent_reduction(after, before)
    else:
        payload["change_percent"] = percent_change(after, before)
    return payload


def paired_task_bootstrap(
    after_records: Sequence[Mapping[str, Any]],
    before_records: Sequence[Mapping[str, Any]],
    metric: Callable[[Sequence[Mapping[str, Any]]], float],
    *,
    iterations: int = 2000,
    seed: int = 20260904,
) -> Optional[List[float]]:
    after_by_task = _group_by_task(after_records)
    before_by_task = _group_by_task(before_records)
    task_ids = sorted(set(after_by_task) & set(before_by_task))
    if not task_ids or iterations < 1:
        return None
    generator = random.Random(seed)
    deltas: List[float] = []
    for _ in range(iterations):
        sampled = [generator.choice(task_ids) for _ in task_ids]
        after_sample: List[Mapping[str, Any]] = []
        before_sample: List[Mapping[str, Any]] = []
        for task_id in sampled:
            after_sample.extend(after_by_task[task_id])
            before_sample.extend(before_by_task[task_id])
        deltas.append(metric(after_sample) - metric(before_sample))
    return [round(percentile(deltas, 0.025), 4), round(percentile(deltas, 0.975), 4)]


def comparison_confidence_intervals(
    after_records: Sequence[Mapping[str, Any]],
    before_records: Sequence[Mapping[str, Any]],
    *,
    iterations: int = 2000,
) -> Dict[str, Optional[List[float]]]:
    valid_after = [item for item in after_records if item.get("status") == "completed"]
    valid_before = [item for item in before_records if item.get("status") == "completed"]

    def completion(items: Sequence[Mapping[str, Any]]) -> float:
        return mean(1.0 if item.get("task_completed") else 0.0 for item in items) if items else 0.0

    def average(field: str) -> Callable[[Sequence[Mapping[str, Any]]], float]:
        def value(items: Sequence[Mapping[str, Any]]) -> float:
            return mean(float(item.get(field, 0)) for item in items) if items else 0.0

        return value

    return {
        "completion_rate_delta": paired_task_bootstrap(
            valid_after, valid_before, completion, iterations=iterations
        ),
        "mean_input_token_delta": paired_task_bootstrap(
            valid_after, valid_before, average("prompt_tokens"), iterations=iterations
        ),
        "mean_duration_ms_delta": paired_task_bootstrap(
            valid_after, valid_before, average("duration_ms"), iterations=iterations
        ),
        "mean_tool_call_delta": paired_task_bootstrap(
            valid_after, valid_before, average("tool_calls"), iterations=iterations
        ),
        "mean_attempt_delta": paired_task_bootstrap(
            valid_after, valid_before, average("attempts"), iterations=iterations
        ),
    }


def _group_by_task(records: Sequence[Mapping[str, Any]]) -> Dict[str, List[Mapping[str, Any]]]:
    grouped: Dict[str, List[Mapping[str, Any]]] = defaultdict(list)
    for item in records:
        grouped[str(item.get("task_id"))].append(item)
    return grouped
