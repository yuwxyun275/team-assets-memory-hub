from __future__ import annotations

import html
import json
from pathlib import Path
from typing import Any, Dict


def render_markdown(summary: Dict[str, Any]) -> str:
    runs = summary["runs"]
    rows = []
    labels = {
        "no_assets": "无团队资产",
        "minimal_team_assets": "最小团队资产",
        "full_context": "全量合格上下文",
        "without_key_wiki": "移除关键 Wiki",
        "without_failure_memory": "移除失败经验",
        "without_code_graph": "移除 Code Graph",
        "without_validation_skill": "移除验证 Skill",
    }
    for name, run in runs.items():
        rows.append(
            f"| {labels.get(name, name)} | {run['selected']} | {run['asset_token_cost']} | "
            f"{run['tests_passed']}/{run['tests_total']} | {run['agent_validation_coverage'] * 100:.1f}% | "
            f"{run['tool_calls']} | {'通过' if run['task_completed'] else '失败'} |"
        )
    effects = summary["comparisons"]["asset_ablations"]
    effect_lines = []
    for effect in effects.values():
        effect_lines.append(
            f"- `{effect['asset_id']}`：测试通过率增益 {effect['test_pass_rate_delta'] * 100:.1f} 个百分点，"
            f"节省工具调用 {effect['tool_call_saving']}，验证覆盖增益 {effect['validation_coverage_delta'] * 100:.1f} 个百分点，"
            f"减少尝试 {effect['attempt_reduction']}。"
        )
    live = summary.get("live_proxy_integration") or {}
    live_lines = (
        f"- CodeBuddy OpenAI 兼容请求：HTTP 200；\n"
        f"- Proxy 上游边界检测到团队资产：`{str(bool(live.get('team_assets_present'))).lower()}`；\n"
        f"- 注入资产：{live.get('asset_count', 0)} 项，ID 为 "
        f"{', '.join(f'`{item}`' for item in live.get('asset_ids', [])) or '无'}；\n"
        f"- 凭据值被审计记录：`{str(bool(live.get('authorization_value_recorded'))).lower()}`；"
        f"请求正文被审计保存：`{str(bool(live.get('request_body_recorded'))).lower()}`。"
        if live
        else "- 尚未执行本地 Proxy 集成冒烟。"
    )
    automatic = summary.get("automatic_proxy_evidence") or {}
    stage = automatic.get("evidence_summary") or {}
    automatic_lines = (
        f"- Trace：`{automatic.get('trace_id', '未知')}`；\n"
        f"- Proxy 自动观测：召回 {stage.get('recalled', 0)}、筛选 {stage.get('selected', 0)}、"
        f"注入 {stage.get('injected', 0)}、采用 {stage.get('used', 0)}、"
        f"验证 {stage.get('validated', 0)}、贡献 {stage.get('contributed', 0)}；\n"
        f"- 凭据被记录：`{str(bool(automatic.get('credentials_recorded'))).lower()}`；"
        f"请求正文被保存：`{str(bool(automatic.get('request_body_recorded'))).lower()}`。"
        if automatic
        else "- 尚未执行 Proxy 自动证据验收。"
    )
    real_model = summary.get("real_model_evaluation") or {}
    if real_model.get("status") == "completed":
        real_model_lines = (
            f"已完成 OpenAI 兼容真实模型评测；模型 `{real_model.get('model', '未记录')}`，"
            f"每组重复 {real_model.get('repetitions', 0)} 次。完整原始数据见 "
            "`results/real-model-evaluation-summary.json`。"
        )
    else:
        real_model_lines = (
            "真实模型多轮评测代码已经完成，但本次未执行："
            f"{real_model.get('reason', '未获得外部数据发送授权')}。"
            "这项状态会被明确报告，绝不把确定性参考策略冒充真实模型成绩。"
        )
    return f"""# TeamAssetBench 精品项目正式评测报告

## 1. 结论

本项目建立了可重复的团队资产证据链：原始团队资料形成候选资产，经来源、权限、版本和验证状态治理后，针对新任务选择最小上下文，并把资产与具体决策、代码目标、测试证据及反事实结果关联。

本次离线运行采用**确定性参考策略**，目的不是伪装成某个大模型成绩，而是验证任务包、隐藏测试、资产状态机和反事实协议本身可重复。另用本地 OpenAI 兼容模拟上游完成了真实 CodeBuddy 协议 → MemoryProxy → 编排器的无外发注入和自动证据验收；真实模型完成率作为独立实验记录。

## 2. 精品任务

- 项目：Python 多租户 Feature Flag Service
- 新任务：缓存异常导致读取接口间歇性超时和 5xx
- 未在任务描述中泄露：published-only、tenant isolation、禁止重试风暴、恢复测试等项目专属知识
- 团队角色：架构/产品、资深后端、QA/SRE、新成员执行者
- 资产来源：Wiki、Chat Memory、Code Graph、Skill，并包含过期、无关、候选和 ACL 受限干扰项

## 3. 对照结果

| 策略 | 注入资产 | 资产 Token | 独立测试 | Agent 验证覆盖 | 工具调用 | 任务结果 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
{chr(10).join(rows)}

最小资产相对无资产的测试通过率增益为 **{summary['comparisons']['minimal_vs_no_assets']['test_pass_rate_delta'] * 100:.1f} 个百分点**。最小资产与全量合格上下文保持相同任务结果，并节省 **{summary['comparisons']['minimal_vs_full_context']['asset_token_saving']} 个资产 Token**。

## 4. 单资产反事实贡献

{chr(10).join(effect_lines)}

只有在 `used → validated` 已成立且对应消融指标出现正向差异时，资产才进入 `contributed`。被注入但没有映射到行动的资产不会被声明为使用。

## 5. 可信状态规则

1. `recalled`：通过团队和 ACL 过滤后进入候选集合。
2. `selected`：通过版本、审核状态、相关性和预算筛选。
3. `injected`：实际进入 CodeBuddy 上下文或工具面。
4. `used`：必须关联具体目标与决策，模型自述不足以成立。
5. `validated`：必须存在真实测试或独立验证器证据。
6. `contributed`：必须有无资产/单资产消融带来的结果、成本或验证覆盖增益。

## 6. 真实 Proxy 注入冒烟（不外发资产）

{live_lines}

该冒烟只证明协议、认证、Session 绑定、四源选择与注入边界连通，不把本地模拟模型的固定响应计入任务完成率。

## 7. Proxy 自动使用证据

{automatic_lines}

`used` 只接受模型的结构化资产采用声明与真实编辑/工具调用的交叉映射；`validated` 只接受后续工具结果中的测试成功证据；`contributed` 由服务端在独立工程验证完成且匹配可信反事实评测后自动派生。业务验收与工程验证分开显示，系统候选标准不会被冒充为产品结论。Memory Hub Task 抽屉直接读取这条真实 Trace，不再依赖事后补证脚本伪造前半段。

## 8. 任务经验回流与人工审核

本确定性评测生成的是历史离线示例候选 `{summary['feedback_candidate']['candidate_id']}`，不代表真实模型已提炼成功。当前运行时由 MemoryCore 在任务结果或后续反馈形成后异步判断：复用已有资产、提出修订、生成项目经验／失败模式／Skill／Workflow 候选，或因证据不足不生成。新内容保留来源与引用，进入 `candidate`，通过质量评估后由负责人审核发布；任务抽屉跳转到质量中心完成该流程。候选生成、审核通过、实际采用和测试验证分别记录，彼此不能替代。

## 9. 真实模型反事实评测状态

{real_model_lines}

真实评测运行器采用同一基础仓库、隐藏测试和七组实验，每组至少重复两次，记录完成率、测试通过率、Token、时延、工具调用与尝试次数。模型层只依赖 OpenAI 兼容接口，不绑定厂商。

## 10. 对主办方隐藏数据的适配方式

- Session：JSONL 轨迹适配器；
- 文档：Markdown/文本适配器；
- 代码：Git 仓库与 AST/Code Graph 适配器；
- Skill：SKILL.md/结构化工作流适配器；
- 模型：通过 OpenAI Chat Completions 兼容接口配置，不绑定厂商；
- 资产协议：统一保留来源、贡献者、适用版本、权限、验证状态和内容哈希。

## 11. 当前边界

- 离线成绩是参考策略验证，不等同于真实模型完成率；
- 当前只完成一个精品 Python 项目，尚未主张跨项目统计显著性；
- Code Graph 已由本地 Python 目标仓库真实构建，但当前只覆盖一个精品项目；
- 编排器的证据写入端点已有独立服务 Token，生产部署仍需 TLS、长期审计保留与高可用存储。
"""


def render_dashboard(summary: Dict[str, Any]) -> str:
    cards = []
    rows = []
    for name, run in summary["runs"].items():
        good = run["task_completed"]
        rows.append(
            f"<tr><td><code>{html.escape(name)}</code></td><td>{run['selected']}</td><td>{run['asset_token_cost']}</td>"
            f"<td>{run['tests_passed']}/{run['tests_total']}</td><td>{run['agent_validation_coverage'] * 100:.0f}%</td>"
            f"<td>{run['tool_calls']}</td><td class='{'ok' if good else 'bad'}'>{'PASS' if good else 'FAIL'}</td></tr>"
        )
    minimal = summary["runs"]["minimal_team_assets"]
    cards.extend(
        [
            ("最小资产任务完成", "PASS" if minimal["task_completed"] else "FAIL"),
            ("测试通过率", f"{minimal['test_pass_rate'] * 100:.0f}%"),
            ("实际资产 Token", str(minimal["asset_token_cost"])),
            ("来源类型", str(len(minimal["selected_source_types"]))),
        ]
    )
    card_html = "".join(f"<div class='card'><small>{html.escape(label)}</small><b>{html.escape(value)}</b></div>" for label, value in cards)
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TeamAssetBench 评测看板</title><style>
body{{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#07111f;color:#dbeafe;margin:0}}
main{{max-width:1180px;margin:40px auto;padding:0 24px}} h1{{font-size:34px;margin-bottom:6px}} p{{color:#93a4bd}}
.cards{{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:26px 0}} .card{{background:#101d31;border:1px solid #243957;border-radius:14px;padding:18px}}
.card small{{display:block;color:#8ca3bf}} .card b{{display:block;font-size:28px;margin-top:8px;color:#67e8f9}}
table{{width:100%;border-collapse:collapse;background:#101d31;border-radius:14px;overflow:hidden}} th,td{{padding:14px;border-bottom:1px solid #243957;text-align:left}}
th{{color:#93c5fd;background:#14243c}} code{{color:#c4b5fd}} .ok{{color:#6ee7b7;font-weight:700}} .bad{{color:#fda4af;font-weight:700}}
@media(max-width:800px){{.cards{{grid-template-columns:repeat(2,1fr)}}}}
</style></head><body><main><h1>团队资产因果评测看板</h1><p>Python Feature Flag 精品项目 · 确定性参考策略 · 不冒充真实模型成绩</p>
<div class="cards">{card_html}</div><table><thead><tr><th>策略</th><th>资产</th><th>Token</th><th>独立测试</th><th>验证覆盖</th><th>工具调用</th><th>结果</th></tr></thead><tbody>{''.join(rows)}</tbody></table>
</main></body></html>"""


def write_reports(summary: Dict[str, Any], results_dir: Path) -> None:
    (results_dir / "FORMAL_EVALUATION_REPORT_CN.md").write_text(render_markdown(summary), encoding="utf-8")
    (results_dir / "evaluation-dashboard.html").write_text(render_dashboard(summary), encoding="utf-8")
