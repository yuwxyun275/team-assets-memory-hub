from __future__ import annotations

import hashlib
import json
import math
import re
import uuid
from datetime import datetime, timezone
from typing import Dict, Iterable, List, Optional, Sequence, Set

from .ledger import EvidenceLedger
from .hybrid_retrieval import HybridAssetRetriever, RetrievalSignals
from .models import (
    Asset,
    AssetState,
    AssetType,
    ContextPackage,
    EvidenceState,
    Selection,
    SelectionFeatures,
    SourceType,
    Task,
    TRUST_BY_EVIDENCE,
)


TOKEN_RE = re.compile(r"[a-zA-Z_][a-zA-Z0-9_./:-]*|[\u4e00-\u9fff]{2,}")


class TeamAssetOrchestrator:
    """Permission-first, evidence-aware, token-budgeted team asset selector."""

    def __init__(
        self,
        assets: Sequence[Asset],
        ledger: Optional[EvidenceLedger] = None,
        historical_effects: Optional[Dict[str, float]] = None,
        retriever: Optional[HybridAssetRetriever] = None,
    ) -> None:
        self.assets = list(assets)
        self.ledger = ledger or EvidenceLedger()
        self.historical_effects = dict(historical_effects or {})
        self.retriever = retriever or HybridAssetRetriever()

    def select(
        self,
        task: Task,
        *,
        strategy: str = "minimal",
        excluded_asset_ids: Optional[Iterable[str]] = None,
        trace_id: Optional[str] = None,
        external_url: str = "http://127.0.0.1:8765",
    ) -> ContextPackage:
        if strategy not in {"none", "minimal", "full"}:
            raise ValueError(f"unsupported strategy: {strategy}")
        trace = trace_id or f"trace-{uuid.uuid4().hex[:16]}"
        excluded = set(excluded_asset_ids or [])
        recalled: List[Selection] = []
        accessible = [
            asset for asset in self.assets
            if asset.team_id == task.team_id
            and ("*" in asset.allowed_agents or task.agent_id in asset.allowed_agents)
        ]
        retrieval_signals = self.retriever.rank(task, accessible)
        candidates = self.retriever.recalled_candidates(
            accessible,
            retrieval_signals,
            limit=max(12, task.max_assets * 5),
        )

        for asset in candidates:
            signals = retrieval_signals.get(asset.asset_id, RetrievalSignals())
            selection = self._score(task, asset, signals)
            recalled.append(selection)
            self.ledger.append(
                trace_id=trace,
                task_id=task.task_id,
                asset_id=asset.asset_id,
                state=AssetState.RECALLED,
                actor_type="system",
                actor_id="team-asset-orchestrator",
                detail={
                    "score": selection.score,
                    "features": selection.features.to_dict(),
                    "retrieval": {
                        "pipeline": "bm25+sparse_vector+native_graph+rrf",
                        "source_type": asset.source_type.value,
                        "runtime_asset_id": asset.runtime_asset_id,
                    },
                },
            )

        recalled.sort(key=lambda item: (-item.score, item.asset.asset_id))
        for index, item in enumerate(recalled, start=1):
            item.rank = index

        if strategy == "none":
            for item in recalled:
                item.reasons.append("strategy_no_assets")
            return ContextPackage(trace, task, recalled, [], recalled, 0, "")

        eligible: List[Selection] = []
        for item in recalled:
            asset = item.asset
            reasons = self._hard_gate(task, asset)
            if asset.asset_id in excluded:
                reasons.append("counterfactual_exclusion")
            if reasons:
                item.reasons.extend(reasons)
            else:
                eligible.append(item)

        if strategy == "full":
            selected = eligible[:]
        else:
            selected = self._minimal_set(task, eligible)

        selected_ids = {item.asset.asset_id for item in selected}
        token_cost = sum(item.asset.token_cost for item in selected)
        for item in recalled:
            item.selected = item.asset.asset_id in selected_ids
            if item.selected:
                item.reasons.append("selected_under_budget")
                self.ledger.append(
                    trace_id=trace,
                    task_id=task.task_id,
                    asset_id=item.asset.asset_id,
                    state=AssetState.SELECTED,
                    actor_type="system",
                    actor_id="team-asset-orchestrator",
                    detail={"rank": item.rank, "score": item.score, "strategy": strategy},
                )
            elif not item.reasons:
                item.reasons.append("lower_marginal_value")

        rejected = [item for item in recalled if not item.selected]
        markdown = self._render_context(task, trace, selected, external_url)
        return ContextPackage(trace, task, recalled, selected, rejected, token_cost, markdown)

    def _minimal_set(self, task: Task, eligible: Sequence[Selection]) -> List[Selection]:
        selected: List[Selection] = []
        selected_ids: Set[str] = set()
        token_cost = 0

        # First cover every task capability with its strongest trustworthy asset.
        for capability in task.required_capabilities or self.infer_capabilities(task):
            candidate = next(
                (
                    item
                    for item in eligible
                    if item.asset.asset_type is capability and item.asset.asset_id not in selected_ids
                ),
                None,
            )
            if candidate and len(selected) < task.max_assets and token_cost + candidate.asset.token_cost <= task.token_budget:
                selected.append(candidate)
                selected_ids.add(candidate.asset.asset_id)
                token_cost += candidate.asset.token_cost

        # Fill only when an item adds source diversity and has meaningful marginal score.
        source_types = {item.asset.source_type for item in selected}
        for item in eligible:
            if item.asset.asset_id in selected_ids or len(selected) >= task.max_assets:
                continue
            if token_cost + item.asset.token_cost > task.token_budget:
                item.reasons.append("token_budget")
                continue
            adds_source = item.asset.source_type not in source_types
            if item.score < 0.52 or (not adds_source and item.score < 0.72):
                continue
            selected.append(item)
            selected_ids.add(item.asset.asset_id)
            source_types.add(item.asset.source_type)
            token_cost += item.asset.token_cost
        return sorted(selected, key=lambda item: item.rank)

    def _score(self, task: Task, asset: Asset, retrieval: RetrievalSignals) -> Selection:
        lexical = retrieval.bm25
        task_type_match = 1.0 if task.task_type in asset.task_types or "*" in asset.task_types else 0.0
        path_match = 1.0 if set(task.target_paths) & set(asset.paths) else (0.45 if asset.paths else 0.25)
        trust = TRUST_BY_EVIDENCE[asset.evidence_state]
        if asset.injection_mode == "reviewed_snapshot":
            trust *= asset.native_signals.get("intrinsic_quality", 1.0)
        freshness = self._freshness(asset.updated_at)
        version_compatibility = 1.0 if task.version == "*" or asset.version in {"*", task.version} else 0.0
        capability_match = 1.0 if asset.asset_type in (task.required_capabilities or self.infer_capabilities(task)) else 0.25
        token_efficiency = min(1.0, 160.0 / max(40, asset.token_cost))
        contextual_effect = min(
            1.0,
            max(0.0, asset.historical_effect + (0.0 if asset.injection_mode == "reviewed_snapshot" else self.historical_effects.get(asset.asset_id, 0.0))),
        )
        features = SelectionFeatures(
            lexical_relevance=round(lexical, 4),
            task_type_match=task_type_match,
            path_match=path_match,
            trust=trust,
            freshness=freshness,
            version_compatibility=version_compatibility,
            historical_effect=contextual_effect,
            capability_match=capability_match,
            token_efficiency=token_efficiency,
            bm25_relevance=retrieval.bm25,
            vector_relevance=retrieval.vector,
            graph_relevance=retrieval.graph,
            rrf_score=retrieval.rrf,
        )
        score = (
            retrieval.combined * 0.30
            + task_type_match * 0.07
            + path_match * 0.08
            + trust * 0.15
            + freshness * 0.06
            + version_compatibility * 0.10
            + contextual_effect * 0.09
            + capability_match * 0.11
            + token_efficiency * 0.04
        )
        return Selection(asset=asset, score=round(score, 4), features=features, selected=False, reasons=[])

    @staticmethod
    def _hard_gate(task: Task, asset: Asset) -> List[str]:
        reasons: List[str] = []
        if asset.evidence_state is EvidenceState.CANDIDATE:
            reasons.append("unreviewed_candidate")
        if asset.evidence_state is EvidenceState.CORRECTED:
            reasons.append("corrected_asset")
        if asset.deprecated:
            reasons.append("deprecated_asset")
        if asset.status != "approved":
            reasons.append("not_published_for_use")
        if task.version != "*" and asset.version not in {"*", task.version}:
            reasons.append("version_incompatible")
        bound_repo = asset.retrieval_handle.get("bound_repository")
        if bound_repo and str(bound_repo).rstrip("/") != str(task.repository).rstrip("/"):
            reasons.append("repository_incompatible")
        return reasons

    @staticmethod
    def infer_capabilities(task: Task) -> List[AssetType]:
        if task.task_type == "bug_fix":
            return [
                AssetType.CODE_KNOWLEDGE,
                AssetType.FAILURE_EXPERIENCE,
                AssetType.VALIDATION_WORKFLOW,
                AssetType.PROJECT_CONSTRAINT,
            ]
        if task.task_type == "feature":
            return [AssetType.PRODUCT_KNOWLEDGE, AssetType.CODE_KNOWLEDGE, AssetType.VALIDATION_WORKFLOW]
        return [AssetType.CODE_KNOWLEDGE, AssetType.VALIDATION_WORKFLOW]

    @staticmethod
    def _terms(text: str) -> Set[str]:
        return {match.group(0).lower() for match in TOKEN_RE.finditer(text)}

    @staticmethod
    def _freshness(value: str) -> float:
        try:
            updated = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if updated.tzinfo is None:
                updated = updated.replace(tzinfo=timezone.utc)
            age_days = max(0.0, (datetime.now(timezone.utc) - updated).total_seconds() / 86400)
            return round(math.exp(-age_days / 730), 4)
        except ValueError:
            return 0.5

    @staticmethod
    def _render_context(task: Task, trace_id: str, selected: Sequence[Selection], external_url: str) -> str:
        if not selected:
            return ""
        lines = [
            "<team_assets>",
            f"任务：{task.task_id} | 证据 Trace：{trace_id}",
            "以下内容来自当前团队在 Memory Hub 中有权使用的资产。资产不是绝对真理，必须结合当前代码核验。",
            "只有资产真实影响了具体决策、代码位置、工具调用或验证动作，才允许声明为已采用。",
        ]
        for item in selected:
            asset = item.asset
            lines.extend(
                [
                    "",
                    f"[asset:{asset.asset_id}] {asset.title}",
                    f"类型：{asset.asset_type.value} | 来源：{asset.source_type.value} | 贡献者：{asset.contributor}",
                    f"原始证据状态：{asset.evidence_state.value} | 版本：{asset.version} | 相关度：{item.score:.4f}",
                    (
                        "检索证据："
                        f"BM25={item.features.bm25_relevance:.3f}，"
                        f"向量={item.features.vector_relevance:.3f}，"
                        f"图结构={item.features.graph_relevance:.3f}，"
                        f"RRF={item.features.rrf_score:.3f}"
                    ),
                    f"适用原因：{asset.claim}",
                    f"建议动作：{asset.action}",
                    f"调用方式：{asset.injection_mode}",
                    (
                        "原生检索句柄："
                        + json.dumps(asset.retrieval_handle, ensure_ascii=False, sort_keys=True)
                        if asset.retrieval_handle else "原生检索句柄：无（上下文已直接提供）"
                    ),
                    f"来源位置：{asset.source_ref}",
                    f"目标路径：{', '.join(asset.paths) if asset.paths else '需要从当前仓库确认'}",
                    f"验证要求：{'; '.join(asset.tests) if asset.tests else '执行当前任务对应测试'}",
                    f"风险：{'; '.join(asset.risks) if asset.risks else '暂无已知风险'}",
                ]
            )
        lines.extend(
            [
                "",
                "当且仅当某项资产真实改变了操作后，请在回复中输出一行机器可读声明：",
                '<team_asset_use>{"asset_id":"资产 ID","decision":"该资产影响的具体决策","target":"实际修改的文件/函数或 test:测试目标"}</team_asset_use>',
                "声明必须与真实文件修改或测试工具调用对应；只复述资产内容不算采用。",
                "若当前代码或用户反馈能够判断资产效果，请输出反馈声明：",
                '<team_asset_feedback>{"asset_id":"资产 ID","signal":"useful | not_applicable | duplicate | stale | incorrect","reason":"具体原因","target":"冲突位置或 asset_recommendation"}</team_asset_feedback>',
                "单纯未采用无需主动声明，系统只会记录为中性的 unobserved；只有明确不适用、重复、过期或错误才会降权，stale/incorrect 必须说明可核验原因。",
                "执行测试时请显式运行上方资产列出的测试名称（可逐项执行）；只有测试 ID 与资产验证要求匹配，才会记为 validated。",
                f"证据观察端点：{external_url.rstrip('/')}/v1/evidence/observe",
                "必须有独立测试结果才能进入 validated；只有反事实对照才能进入 contributed。",
                "</team_assets>",
            ]
        )
        return "\n".join(lines)


def stable_content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
