from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Mapping, Optional


def _pct(rate: float) -> str:
    return f"{rate * 100:.2f}%"


def _number(value: float, digits: int = 2) -> str:
    rendered = f"{value:.{digits}f}"
    return rendered.rstrip("0").rstrip(".")


def _tokens(value: float) -> str:
    if abs(value) >= 1_000_000:
        return f"{value / 1_000_000:.2f}M"
    if abs(value) >= 1_000:
        return f"{value / 1_000:.2f}K"
    return str(int(round(value)))


def _decrease(before: float, after: float, reduction: Optional[float], unit: str = "") -> str:
    suffix = unit
    before_text = _number(before) + suffix
    after_text = _number(after) + suffix
    if reduction is None:
        return f"从 **{before_text}** 变为 **{after_text}**"
    if reduction >= 0:
        return f"从 **{before_text}** 降至 **{after_text}（↓{reduction:.2f}%）**"
    return f"从 **{before_text}** 增至 **{after_text}（↑{abs(reduction):.2f}%）**"


def render_resume_bullet(summary: Mapping[str, Any]) -> str:
    if not summary.get("resume_ready"):
        matrix = summary.get("matrix") or {}
        target = summary.get("target") or {}
        return (
            "当前结果尚不能生成正式简历数字。"
            f"已覆盖 {matrix.get('repositories', 0)}/{target.get('repositories', 0)} 个仓库、"
            f"{matrix.get('scenario_types', 0)}/{target.get('scenario_types', 0)} 类场景、"
            f"{matrix.get('tasks', 0)}/{target.get('tasks', 0)} 个任务，"
            f"获得 {matrix.get('valid_runs', 0)}/{target.get('tasks', 0) * target.get('arms', 0) * target.get('repetitions', 0)} 次有效运行。"
        )

    matrix = summary["matrix"]
    comparisons = summary["comparisons"]
    versus_none = comparisons["minimal_vs_no_assets"]
    versus_full = comparisons["minimal_vs_full_context"]
    completion = versus_none["completion"]
    token = versus_full["input_tokens"]
    duration = versus_none["p95_duration"]
    tools = versus_none["mean_tool_calls"]
    attempts = versus_none["mean_attempts"]
    point_change = float(completion["change_percentage_points"])
    point_direction = "↑" if point_change >= 0 else "↓"
    task_noun = str(summary.get("task_noun") or "工程任务")
    completion_text = (
        f"从 **{completion['before_count']}/{completion['before_total']}（{_pct(completion['before_rate'])}）**"
        f"提升至 **{completion['after_count']}/{completion['after_total']}（{_pct(completion['after_rate'])}，"
        f"{point_direction}{abs(point_change):.2f} 个百分点）**"
    )
    token_text = (
        f"从 **{_tokens(float(token['before']))}** 降至 **{_tokens(float(token['after']))}"
        f"（↓{float(token['reduction_percent']):.2f}%）**"
        if token.get("reduction_percent") is not None and float(token["reduction_percent"]) >= 0
        else _decrease(float(token["before"]), float(token["after"]), token.get("reduction_percent"))
    )
    duration_text = _decrease(
        float(duration["before"]) / 1000.0,
        float(duration["after"]) / 1000.0,
        duration.get("reduction_percent"),
        "s",
    )
    tool_text = _decrease(
        float(tools["before"]), float(tools["after"]), tools.get("reduction_percent"), " 次"
    )
    attempt_text = _decrease(
        float(attempts["before"]),
        float(attempts["after"]),
        attempts.get("reduction_percent"),
        " 次",
    )
    return (
        "**全链路评测体系建设：**"
        f"设计覆盖 **{matrix['repositories']} 个代码仓库、{matrix['scenario_types']} 类工程场景和 "
        f"{matrix['tasks']} 个{task_noun}**的 TeamAssetBench，针对无资产、全量资产、最小资产及"
        f"四类资产单独移除开展 **{matrix['arms']} 组反事实实验**，每组重复 {matrix['repetitions']} 次，"
        f"累计完成 **{matrix['valid_runs']} 次有效 Agent 运行**。最小资产组合将任务完成率{completion_text}。"
        f"相较全量资产，将总 Input Token {token_text}。相较无资产，将 P95 完成时间{duration_text}、"
        f"单任务工具调用{tool_text}、平均修改尝试{attempt_text}，并通过四类资产移除实验量化其对"
        "业务正确性、返工成本、代码定位效率和验证覆盖率的边际贡献。"
    )


def render_markdown_report(summary: Mapping[str, Any]) -> str:
    matrix = summary["matrix"]
    target = summary["target"]
    lines = [
        "# TeamAssetBench 全链路评测报告",
        "",
        f"- 生成时间：{summary.get('generated_at', '-')}",
        f"- 模型：{(summary.get('model') or {}).get('model', '-')}",
        f"- 数据来源：{summary.get('dataset_provenance', '-')}",
        f"- 简历可用：{'是' if summary.get('resume_ready') else '否'}",
        "",
        "## 实验规模",
        "",
        "| 指标 | 当前值 | 正式目标 |",
        "| --- | ---: | ---: |",
        f"| 代码仓库 | {matrix['repositories']} | {target['repositories']} |",
        f"| 工程场景 | {matrix['scenario_types']} | {target['scenario_types']} |",
        f"| 工程任务 | {matrix['tasks']} | {target['tasks']} |",
        f"| 实验组 | {matrix['arms']} | {target['arms']} |",
        f"| 重复次数 | {matrix['repetitions']} | {target['repetitions']} |",
        f"| 有效运行 | {matrix['valid_runs']} | {target['tasks'] * target['arms'] * target['repetitions']} |",
        f"| 基础设施失败 | {matrix['infrastructure_failures']} | 0 |",
        "",
        "## 分组结果",
        "",
        "| 实验组 | 完成任务 | 完成率 | Input Token | P95 时间 | 平均工具调用 | 平均修改尝试 |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for name, aggregate in summary["aggregates"].items():
        lines.append(
            f"| {name} | {aggregate['completion_count']}/{aggregate['valid_runs']} | "
            f"{_pct(aggregate['completion_rate'])} | {_tokens(aggregate['total_input_tokens'])} | "
            f"{aggregate['p95_duration_ms'] / 1000.0:.2f}s | {aggregate['mean_tool_calls']:.2f} | "
            f"{aggregate['mean_attempts']:.2f} |"
        )
    lines.extend(
        [
            "",
            "## 简历表述",
            "",
            render_resume_bullet(summary),
            "",
            "## 统计口径",
            "",
            "- 任务完成只由独立隐藏测试决定",
            "- Input Token 使用模型接口返回的 prompt token",
            "- P95 使用每次 Agent 端到端执行时间",
            "- 工具调用和修改尝试均按有效运行计算单任务均值",
            "- 模型限流和服务异常记为基础设施失败，不记为任务失败",
            "- 对照组使用按任务配对的 Bootstrap 95% 置信区间",
            "",
        ]
    )
    return "\n".join(lines)


def write_suite_reports(summary: Mapping[str, Any], result_root: Path) -> Dict[str, str]:
    result_root.mkdir(parents=True, exist_ok=True)
    report_path = result_root / "FORMAL_SUITE_EVALUATION_REPORT_CN.md"
    resume_path = result_root / "RESUME_METRICS_CN.md"
    report_path.write_text(render_markdown_report(summary), encoding="utf-8")
    resume_path.write_text(render_resume_bullet(summary) + "\n", encoding="utf-8")
    return {"report": str(report_path), "resume": str(resume_path)}


def load_summary(path: Path) -> Dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))
