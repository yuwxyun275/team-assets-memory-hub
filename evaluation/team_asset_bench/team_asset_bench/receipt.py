from __future__ import annotations

import html
import json
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from .evidence import RunEvidence, test_pass_rate
from .ledger import EvidenceLedger
from .models import AssetEvent, AssetState, ContextPackage


def build_receipt(
    package: ContextPackage,
    ledger: EvidenceLedger,
    evidence: RunEvidence,
    *,
    arm: str,
    comparison: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    by_asset: Dict[str, List[AssetEvent]] = defaultdict(list)
    for event in ledger.events(trace_id=package.trace_id, task_id=package.task.task_id):
        by_asset[event.asset_id].append(event)

    assets: List[Dict[str, Any]] = []
    for selection in package.recalled:
        events = by_asset.get(selection.asset.asset_id, [])
        used = next((event for event in events if event.state.value == "used"), None)
        validated = next((event for event in events if event.state.value == "validated"), None)
        contributed = next((event for event in events if event.state.value == "contributed"), None)
        assets.append(
            {
                "asset_id": selection.asset.asset_id,
                "title": selection.asset.title,
                "asset_type": selection.asset.asset_type.value,
                "source_type": selection.asset.source_type.value,
                "contributor": selection.asset.contributor,
                "source_ref": selection.asset.source_ref,
                "version": selection.asset.version,
                "evidence_state": selection.asset.evidence_state.value,
                "selection_score": selection.score,
                "selected": selection.selected,
                "rejection_reasons": [] if selection.selected else selection.reasons,
                "states": [event.state.value for event in events],
                "target": used.target if used else None,
                "decision": used.decision if used else None,
                "attribution": (
                    dict(validated.detail.get("attribution") or {})
                    if validated else dict(used.detail.get("attribution") or {}) if used else None
                ),
                "validation_ref": validated.evidence_ref if validated else None,
                "contribution_ref": contributed.evidence_ref if contributed else None,
                "risks": selection.asset.risks,
            }
        )

    return {
        "schema_version": "team-asset-receipt/v1",
        "arm": arm,
        "trace_id": package.trace_id,
        "task": package.task.to_dict(),
        "summary": {
            "recalled": len(package.recalled),
            "selected": len(package.selected),
            "injected": sum(
                1
                for selection in package.selected
                if ledger.latest_state(package.trace_id, package.task.task_id, selection.asset.asset_id)
                in {AssetState.INJECTED, AssetState.USED, AssetState.VALIDATED, AssetState.CONTRIBUTED}
            ),
            "used": sum(1 for asset in assets if "used" in asset["states"]),
            "validated": sum(1 for asset in assets if "validated" in asset["states"]),
            "contributed": sum(1 for asset in assets if "contributed" in asset["states"]),
            "token_cost": package.token_cost,
            "test_pass_rate": test_pass_rate(evidence.tests),
            "task_completed": evidence.passed,
            "tool_calls": len(evidence.tool_calls),
            "attempts": evidence.attempts,
            "duration_ms": evidence.duration_ms,
        },
        "assets": assets,
        "changes": evidence.changed_paths,
        "tests": [test.__dict__ for test in evidence.tests],
        "comparison": comparison or {},
    }


def write_receipt_json(receipt: Dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def render_receipt_html(receipt: Dict[str, Any]) -> str:
    summary = receipt["summary"]
    asset_rows = []
    for asset in receipt["assets"]:
        state = asset["states"][-1] if asset["states"] else "not_recalled"
        css = "ok" if state in {"validated", "contributed"} else "warn" if asset["selected"] else "muted"
        asset_rows.append(
            "<tr>"
            f"<td><code>{html.escape(asset['asset_id'])}</code><br>{html.escape(asset['title'])}</td>"
            f"<td>{html.escape(asset['source_type'])}<br>{html.escape(asset['contributor'])}</td>"
            f"<td><span class='{css}'>{html.escape(state)}</span><br>score {asset['selection_score']:.3f}</td>"
            f"<td>{html.escape(asset.get('decision') or '仅候选/背景')}<br><code>{html.escape(asset.get('target') or '-')}</code></td>"
            f"<td>{html.escape(asset.get('validation_ref') or '-')}</td>"
            "</tr>"
        )
    tests = "".join(
        f"<li><span class='{'ok' if test['passed'] else 'bad'}'>{'PASS' if test['passed'] else 'FAIL'}</span> "
        f"{html.escape(test['name'])} <code>{html.escape(test['command'])}</code></li>"
        for test in receipt["tests"]
    )
    return f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>团队资产使用回执 · {html.escape(receipt['task']['title'])}</title>
<style>
body{{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:#f5f7fb;color:#172033}}
main{{max-width:1180px;margin:32px auto;padding:0 24px}} h1{{margin-bottom:6px}} .sub{{color:#64748b}}
.cards{{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin:24px 0}} .card{{background:white;border:1px solid #e2e8f0;border-radius:12px;padding:16px}}
.n{{font-size:28px;font-weight:700}} table{{width:100%;border-collapse:collapse;background:white;border-radius:12px;overflow:hidden}}
th,td{{padding:13px;text-align:left;border-bottom:1px solid #e2e8f0;vertical-align:top}} th{{background:#eef2ff}}
code{{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}} .ok{{color:#087f5b;font-weight:700}} .bad{{color:#c92a2a;font-weight:700}} .warn{{color:#e67700;font-weight:700}} .muted{{color:#94a3b8}}
section{{margin:28px 0}} @media(max-width:900px){{.cards{{grid-template-columns:repeat(2,1fr)}}}}
</style></head><body><main>
<h1>团队资产使用回执</h1><div class="sub">{html.escape(receipt['task']['title'])} · {html.escape(receipt['arm'])} · {html.escape(receipt['trace_id'])}</div>
<div class="cards">
<div class="card"><div class="n">{summary['recalled']}</div>召回</div><div class="card"><div class="n">{summary['selected']}</div>筛选/注入</div>
<div class="card"><div class="n">{summary['used']}</div>实际采用</div><div class="card"><div class="n">{summary['validated']}</div>验证</div>
<div class="card"><div class="n">{summary['contributed']}</div>产生贡献</div><div class="card"><div class="n">{summary['token_cost']}</div>资产 Token</div>
</div>
<section><h2>资产 → 决策/修改 → 验证</h2><table><thead><tr><th>资产</th><th>来源/贡献者</th><th>状态</th><th>影响</th><th>验证证据</th></tr></thead><tbody>{''.join(asset_rows)}</tbody></table></section>
<section><h2>测试结果</h2><p>通过率：<strong>{summary['test_pass_rate'] * 100:.1f}%</strong> · 任务完成：<strong>{'是' if summary['task_completed'] else '否'}</strong></p><ul>{tests}</ul></section>
</main></body></html>"""


def write_receipt_html(receipt: Dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render_receipt_html(receipt), encoding="utf-8")
