from __future__ import annotations

import json
import math
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Any, Dict, Iterable, Mapping, Sequence

from .models import Asset, AssetType, Task
from .orchestrator import TOKEN_RE


@dataclass(frozen=True)
class ProfiledTask:
    task: Task
    provenance: Dict[str, Dict[str, Any]]


class TaskProfiler:
    """Build an auditable task profile from the board task and live assets.

    Runtime identity and the board title/description are authoritative. Repo,
    version, paths, capabilities and context budget are inferred with explicit
    provenance instead of silently inheriting the benchmark's task.json.
    """

    def profile(
        self,
        seed: Mapping[str, Any],
        assets: Sequence[Asset],
        *,
        task_detail: Mapping[str, Any] | None = None,
        query: str = "",
        hints: Mapping[str, Any] | None = None,
        budget_ceiling: int = 900,
        max_assets_ceiling: int = 6,
    ) -> ProfiledTask:
        detail = dict(task_detail or {})
        hints = dict(hints or {})
        metadata = _json_object(detail.get("metadata_json"))
        declared = metadata.get("team_asset_profile")
        declared = declared if isinstance(declared, dict) else {}
        acceptance = metadata.get("team_asset_acceptance")
        acceptance = acceptance if isinstance(acceptance, dict) else {}
        confirmed_criteria = [
            str(item).strip()
            for item in acceptance.get("criteria", [])
            if str(item).strip()
        ] if isinstance(acceptance.get("criteria"), list) else []
        suggested_criteria = [
            str(item).strip()
            for item in acceptance.get("suggested_criteria", [])
            if str(item).strip()
        ] if isinstance(acceptance.get("suggested_criteria"), list) else []
        acceptance_criteria = confirmed_criteria or suggested_criteria

        title = str(detail.get("title") or seed.get("title") or "未命名 Coding 任务").strip()
        board_description = str(detail.get("description") or seed.get("description") or "").strip()
        description = board_description
        if query and query.strip() and query.strip() not in board_description:
            description = f"{board_description}\n当前 CodeBuddy 请求：{query.strip()}".strip()
        if not description:
            description = query.strip()
        if acceptance_criteria:
            description = "\n".join([
                description,
                "验收标准：" + "；".join(acceptance_criteria),
            ]).strip()
        semantic_text = " ".join(item for item in (title, description) if item)

        task_type, type_reason = self._task_type(semantic_text)
        source_repository = self._repository_from_source_url(detail.get("source_url"))
        repository, repository_source = self._first_nonempty(
            (declared.get("repository"), "task.metadata_json.team_asset_profile.repository"),
            (source_repository, "task.source_url.git_repository"),
            (hints.get("repository"), "proxy_fallback.repository"),
            (seed.get("repository"), "request.repository"),
            default="*",
        )
        version, version_source = self._first_nonempty(
            (declared.get("version"), "task.metadata_json.team_asset_profile.version"),
            (hints.get("version"), "proxy_fallback.version"),
            (seed.get("version"), "request.version"),
            default=self._majority_version(assets),
        )

        required, capability_reasons = self._capabilities(semantic_text, task_type, detail)
        explicit_paths = declared.get("target_paths") or hints.get("target_paths") or []
        target_paths = [str(item) for item in explicit_paths if str(item).strip()][:4]
        if target_paths:
            path_reasons = {path: "task metadata or recent CodeBuddy tool path" for path in target_paths}
        else:
            target_paths, path_reasons = self._target_paths(semantic_text, assets)
        if not target_paths:
            seed_paths = seed.get("target_paths") or []
            target_paths = [str(item) for item in seed_paths if str(item).strip()][:4]
            path_reasons = {path: "request/proxy configured fallback" for path in target_paths}

        max_assets = max(1, min(int(max_assets_ceiling or 6), len(required) or 2))
        minimum_cost = self._minimum_capability_cost(required, assets, version)
        calculated_budget = max(240, int(math.ceil((minimum_cost * 1.15) / 20.0) * 20))
        effective_budget_ceiling = max(1, int(budget_ceiling or 900))
        token_budget = min(effective_budget_ceiling, calculated_budget)

        value = {
            "task_id": str(seed.get("task_id") or detail.get("task_id") or ""),
            "team_id": str(seed.get("team_id") or detail.get("team_id") or ""),
            "agent_id": str(seed.get("agent_id") or ""),
            "title": title,
            "description": description,
            "repository": repository,
            "version": version or "*",
            "task_type": task_type,
            "token_budget": token_budget,
            "max_assets": max_assets,
            "target_paths": target_paths,
            "required_capabilities": [item.value for item in required],
        }
        provenance = {
            "title": {"source": "memory_hub_task" if detail.get("title") else "request", "value": title},
            "description": {
                "source": "memory_hub_task" if detail.get("description") else "request_or_current_query",
                "value": description,
                "acceptance_criteria_included": bool(acceptance_criteria),
                "acceptance_criteria_status": (
                    "confirmed" if confirmed_criteria
                    else "proposed" if suggested_criteria
                    else "not_requested"
                ),
                "current_query_appended_for_relevance": bool(
                    query and query.strip() and query.strip() not in board_description
                ),
            },
            "task_type": {"source": "rule_router", "value": task_type, "reason": type_reason},
            "repository": {"source": repository_source, "value": repository},
            "version": {"source": version_source, "value": version or "*"},
            "target_paths": {
                "source": "task_or_recent_tool_path_else_team_assets/code_graph",
                "value": target_paths,
                "reasons": path_reasons,
            },
            "required_capabilities": {
                "source": "risk_and_task_router",
                "value": [item.value for item in required],
                "reasons": capability_reasons,
            },
            "max_assets": {
                "source": "capability_count_with_admin_ceiling",
                "value": max_assets,
                "ceiling": int(max_assets_ceiling or 6),
            },
            "token_budget": {
                "source": "minimum_capability_cost_plus_15_percent_with_admin_ceiling",
                "value": token_budget,
                "minimum_capability_cost": minimum_cost,
                "ceiling": effective_budget_ceiling,
            },
        }
        return ProfiledTask(Task.from_dict(value), provenance)

    @staticmethod
    def _task_type(text: str) -> tuple[str, str]:
        lowered = text.lower()
        # Reviewing an existing implementation is not a request to implement
        # a feature. Conditional repairs during regression remain test work.
        conditional = re.sub(r"(?:仅|只)(?:在)?发现问题时(?:才)?(?:修改代码|修复)", "", lowered)
        conditional = re.sub(r"(?:检查|核对|审查)[^。；\n]{0,80}?实现", "检查现有代码", conditional)
        if re.search(r"回归检查|回归验证|regression (?:check|verif)|检查[^。；\n]{0,40}运行回归测试", conditional) and not re.search(r"请修复|需要修复|修复[^。；\n]{0,30}问题|新增功能|实现新|implement|add a feature", conditional):
            return "test", "explicit regression verification of existing implementation"
        if re.search(r"故障|异常|报错|修复|bug|5xx|timeout|超时|失败", lowered):
            return "bug_fix", "matched failure/repair vocabulary"
        if re.search(r"新增|实现|feature|需求|开发", lowered):
            return "feature", "matched feature vocabulary"
        if re.search(r"测试|验证|test|回归", lowered):
            return "test", "matched test vocabulary"
        return "maintenance", "no stronger task-type signal"

    @staticmethod
    def _capabilities(
        text: str,
        task_type: str,
        detail: Mapping[str, Any],
    ) -> tuple[list[AssetType], Dict[str, str]]:
        required: list[AssetType] = [AssetType.CODE_KNOWLEDGE, AssetType.VALIDATION_WORKFLOW]
        reasons: Dict[str, str] = {
            AssetType.CODE_KNOWLEDGE.value: "coding task requires code-location knowledge",
            AssetType.VALIDATION_WORKFLOW.value: "coding result must be independently verified",
        }
        if task_type == "bug_fix":
            required.insert(0, AssetType.FAILURE_EXPERIENCE)
            reasons[AssetType.FAILURE_EXPERIENCE.value] = "bug fix benefits from prior failure and invalid-attempt evidence"
        risk = str(detail.get("risk_level") or "").lower()
        if risk in {"high", "critical"} or re.search(r"租户|权限|安全|泄漏|发布|草稿|一致性|数据", text, re.I):
            required.insert(0, AssetType.PROJECT_CONSTRAINT)
            reasons[AssetType.PROJECT_CONSTRAINT.value] = "high-risk/business-boundary vocabulary requires team constraints"
        return list(dict.fromkeys(required)), reasons

    @staticmethod
    def _target_paths(text: str, assets: Sequence[Asset]) -> tuple[list[str], Dict[str, str]]:
        task_terms = {match.group(0).lower() for match in TOKEN_RE.finditer(text)}
        scores: Dict[str, float] = defaultdict(float)
        reasons: Dict[str, list[str]] = defaultdict(list)
        for asset in assets:
            asset_text = " ".join([asset.title, asset.claim, asset.action, *asset.keywords])
            asset_terms = {match.group(0).lower() for match in TOKEN_RE.finditer(asset_text)}
            overlap = len(task_terms & asset_terms)
            if overlap == 0:
                continue
            source_bonus = 2.0 if asset.source_type.value == "code_graph" else 0.5
            for path in asset.paths:
                if not path or path.startswith(("tests", "hidden_tests")):
                    continue
                scores[path] += overlap + source_bonus
                reasons[path].append(f"{asset.asset_id}:overlap={overlap},source={asset.source_type.value}")
        ranked = sorted(scores, key=lambda path: (-scores[path], path))[:4]
        return ranked, {path: "; ".join(reasons[path]) for path in ranked}

    @staticmethod
    def _minimum_capability_cost(required: Iterable[AssetType], assets: Sequence[Asset], version: str) -> int:
        total = 0
        for capability in required:
            costs = [
                asset.token_cost
                for asset in assets
                if asset.asset_type is capability
                and not asset.deprecated
                and (version == "*" or asset.version in {"*", version})
            ]
            total += min(costs) if costs else 160
        return total

    @staticmethod
    def _majority_version(assets: Sequence[Asset]) -> str:
        counts = Counter(asset.version for asset in assets if asset.version and asset.version != "*")
        return counts.most_common(1)[0][0] if counts else "*"

    @staticmethod
    def _repository_from_source_url(value: Any) -> str:
        """Treat source_url as a repository only when it actually looks like Git."""
        raw = str(value or "").strip().removesuffix(".git").rstrip("/")
        match = re.search(r"(?:github\.com|gitlab\.com|gitee\.com)[:/]([^/]+/[^/#?]+)$", raw, re.I)
        return match.group(1) if match else ""

    @staticmethod
    def _first_nonempty(*pairs: tuple[Any, str], default: str) -> tuple[str, str]:
        for value, source in pairs:
            if value is not None and str(value).strip():
                return str(value).strip(), source
        return default, "inferred_default"


def _json_object(value: Any) -> Dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    if not value:
        return {}
    try:
        parsed = json.loads(str(value))
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}
