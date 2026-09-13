from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence

from .models import Asset, AssetType, Task
from .openai_provider import OpenAICompatibleConfig, OpenAICompatibleProvider
from .verification_discovery import DiscoveredTest, map_acceptance_criteria


@dataclass(frozen=True)
class AcceptanceCriterionSuggestion:
    criterion_id: str
    text: str
    category: str
    rationale: str
    source_asset_ids: List[str] = field(default_factory=list)
    source_titles: List[str] = field(default_factory=list)
    target_paths: List[str] = field(default_factory=list)
    candidate_test_ids: List[str] = field(default_factory=list)
    verification_method: str = "repository_test_or_ci"
    confidence: float = 0.0


@dataclass(frozen=True)
class AcceptancePlan:
    schema_version: str
    status: str
    generated_by: str
    generated_at: str
    context_fingerprint: str
    criteria: List[AcceptanceCriterionSuggestion]
    coverage: List[Dict[str, Any]]
    context_sources: List[str]
    safety: Dict[str, Any]
    fallback_reason: str = ""

    def to_dict(self) -> Dict[str, Any]:
        value = asdict(self)
        value["criteria"] = [asdict(item) for item in self.criteria]
        return value


class AcceptancePlanner:
    """Build a definition-of-done proposal from real task and team context.

    Planning is deliberately separated from validation.  The planner may only
    propose criteria and candidate test mappings; a trusted local/enterprise CI
    result is required before any criterion can become validated.
    """

    def __init__(self, *, mode: str = "deterministic", allow_external: bool = False) -> None:
        normalized = mode.strip().lower()
        self.mode = normalized if normalized in {"deterministic", "openai"} else "deterministic"
        self.allow_external = allow_external

    @classmethod
    def from_environment(cls) -> "AcceptancePlanner":
        return cls(
            mode=os.environ.get("TEAM_ASSET_ACCEPTANCE_PLANNER_MODE", "deterministic"),
            allow_external=os.environ.get("TEAM_ASSET_ALLOW_ACCEPTANCE_MODEL", "").lower()
            in {"1", "true", "yes"},
        )

    def plan(
        self,
        task: Task,
        assets: Sequence[Asset],
        *,
        repository_context: Optional[Mapping[str, Any]] = None,
    ) -> AcceptancePlan:
        context = _normalize_repository_context(repository_context or {})
        fallback_reason = ""
        if self.mode == "openai" and self.allow_external:
            try:
                criteria = self._model_criteria(task, assets, context)
                generated_by = "codebuddy-openai-compatible/acceptance-planner-v1"
            except (ValueError, RuntimeError, json.JSONDecodeError) as exc:
                criteria = self._deterministic_criteria(task, assets, context)
                generated_by = "contextual-deterministic/acceptance-planner-v2"
                fallback_reason = f"model_fallback:{type(exc).__name__}"
        else:
            criteria = self._deterministic_criteria(task, assets, context)
            generated_by = "contextual-deterministic/acceptance-planner-v2"
            if self.mode == "openai" and not self.allow_external:
                fallback_reason = "external_model_not_authorized"

        tests = _discovered_tests(assets, context)
        coverage = map_acceptance_criteria([item.text for item in criteria], tests)
        coverage_by_id = {item["criterion_id"]: item for item in coverage}
        hydrated: List[AcceptanceCriterionSuggestion] = []
        for item in criteria:
            mapped = coverage_by_id.get(item.criterion_id, {})
            hydrated.append(
                AcceptanceCriterionSuggestion(
                    **{
                        **asdict(item),
                        "candidate_test_ids": list(mapped.get("mapped_test_ids") or item.candidate_test_ids),
                        "verification_method": (
                            "trusted_ci_test"
                            if mapped.get("mapped_test_ids")
                            else "new_test_or_manual_confirmation"
                        ),
                    }
                )
            )

        canonical = json.dumps(
            {
                "task": task.to_dict(),
                "assets": [
                    {
                        "asset_id": item.asset_id,
                        "content_hash": item.content_hash,
                        "updated_at": item.updated_at,
                    }
                    for item in assets
                ],
                "repository_context": context,
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        sources = ["task"]
        sources.extend(sorted({item.source_type.value for item in assets}))
        if context:
            sources.append("repository_verification_context")
        return AcceptancePlan(
            schema_version="team-asset-acceptance-plan/v1",
            status="proposed" if hydrated else "not_requested",
            generated_by=generated_by,
            generated_at=datetime.now(timezone.utc).isoformat(),
            context_fingerprint=f"sha256:{hashlib.sha256(canonical.encode('utf-8')).hexdigest()}",
            criteria=hydrated,
            coverage=coverage,
            context_sources=list(dict.fromkeys(sources)),
            safety={
                "planner_can_validate": False,
                "requires_trusted_ci": True,
                "external_model_used": generated_by.startswith("codebuddy-"),
                "team_asset_content_sent_external": generated_by.startswith("codebuddy-"),
            },
            fallback_reason=fallback_reason,
        )

    def _deterministic_criteria(
        self,
        task: Task,
        assets: Sequence[Asset],
        context: Mapping[str, Any],
    ) -> List[AcceptanceCriterionSuggestion]:
        task_text = f"{task.title}\n{task.description}".lower()
        all_text = "\n".join(
            [task_text]
            + [
                " ".join([item.title, item.claim, item.action, *item.risks, *item.keywords]).lower()
                for item in assets
            ]
        )
        raw: List[tuple[str, str, str, tuple[str, ...]]] = []

        if _contains(all_text, "redis", "缓存", "cache") and _contains(
            all_text, "故障", "不可用", "超时", "5xx", "fallback", "回退", "降级"
        ):
            raw.append(("缓存不可用或超时时，服务必须安全降级，不能产生未处理的 5xx", "reliability", "任务与团队经验共同指出缓存故障边界", ("redis", "缓存", "故障", "回退", "5xx")))
        if _contains(all_text, "租户", "tenant", "隔离", "越权", "泄漏"):
            raw.append(("降级与正常路径都必须保持租户隔离，不得读取或返回其他租户数据", "security", "团队约束或历史经验包含多租户数据边界", ("租户", "tenant", "隔离", "泄漏")))
        # An asset being "published" is not evidence that the application
        # has draft/publication semantics. Likewise retries do not imply Redis.
        if _contains(all_text, "草稿", "draft") and _contains(all_text, "降级", "fallback", "回退"):
            raw.append(("降级路径只能返回已发布数据，不得暴露草稿或未发布配置", "business", "产品约束包含发布状态语义", ("草稿", "draft", "published", "发布")))
        if _contains(all_text, "重试", "retry", "重复调用", "storm") and _contains(all_text, "缓存", "redis", "cache"):
            raw.append(("单次请求中的缓存故障不得触发无界重试或重复读取", "reliability", "历史失败经验提示重试风暴风险", ("重试", "retry", "storm")))
        if _contains(all_text, "恢复", "recovery", "recover") and _contains(all_text, "redis", "缓存", "cache"):
            raw.append(("缓存恢复后，请求应重新使用正常缓存路径，避免故障结果长期污染", "reliability", "任务要求覆盖故障恢复路径", ("恢复", "recovery", "缓存")))

        # “数据库”本身不代表数据写入任务。只有任务描述明确要求写操作时，
        # 才增加幂等/一致性标准，避免旧规则把普通查询错误识别为写入场景。
        if _contains(task_text, "写入", "保存", "更新记录", "删除", "insert", "update", "delete", "事务"):
            raw.append(("失败与重试不得造成重复写入、部分提交或数据不一致", "reliability", "任务本身包含明确的数据写操作", ("写入", "重试", "事务", "update")))

        if task.task_type in {"bug_fix", "feature"}:
            raw.append(("问题场景应可稳定复现；修复后新增回归测试通过，且仓库原有测试保持通过", "engineering", "代码变更必须同时证明修复有效且未引入回归", ("回归", "测试", "regression")))

        target_paths = list(dict.fromkeys([*task.target_paths, *_strings(context.get("active_paths"))]))
        result: List[AcceptanceCriterionSuggestion] = []
        seen: set[str] = set()
        for text, category, rationale, terms in raw:
            fingerprint = re.sub(r"\W+", "", text).lower()
            if fingerprint in seen:
                continue
            seen.add(fingerprint)
            related = [item for item in assets if _asset_matches(item, terms)]
            if not related and assets and category != "engineering":
                # A business criterion must be attributable to a selected team
                # asset or the task itself; unrelated generic advice is omitted.
                if not any(term.lower() in task_text for term in terms):
                    continue
            paths = list(dict.fromkeys(
                [path for item in related for path in item.paths] + target_paths
            ))[:12]
            tests = list(dict.fromkeys(
                [test for item in related for test in item.tests] + _strings(context.get("test_ids"))
            ))[:20]
            confidence = min(0.97, 0.62 + 0.07 * len(related) + (0.08 if tests else 0.0))
            result.append(
                AcceptanceCriterionSuggestion(
                    criterion_id=f"criterion-{len(result) + 1}",
                    text=text,
                    category=category,
                    rationale=rationale,
                    source_asset_ids=[item.asset_id for item in related],
                    source_titles=[item.title for item in related],
                    target_paths=paths,
                    candidate_test_ids=tests,
                    confidence=round(confidence, 4),
                )
            )
        return result[:8]

    def _model_criteria(
        self,
        task: Task,
        assets: Sequence[Asset],
        context: Mapping[str, Any],
    ) -> List[AcceptanceCriterionSuggestion]:
        config = _acceptance_model_config()
        provider = OpenAICompatibleProvider(config)
        asset_payload = [
            {
                "asset_id": item.asset_id,
                "title": _redact(item.title),
                "type": item.asset_type.value,
                "claim": _redact(item.claim)[:1200],
                "action": _redact(item.action)[:1200],
                "risks": [_redact(value) for value in item.risks[:10]],
                "paths": item.paths[:20],
                "tests": item.tests[:30],
            }
            for item in assets[:8]
        ]
        prompt = json.dumps(
            {
                "task": {
                    "title": _redact(task.title),
                    "description": _redact(task.description),
                    "type": task.task_type,
                    "target_paths": task.target_paths,
                },
                "selected_team_assets": asset_payload,
                "repository_context": context,
            },
            ensure_ascii=False,
        )
        content = provider.complete([
            {
                "role": "system",
                "content": (
                    "你是 CodeBuddy 的验收规划器。只输出 JSON：{\"criteria\":[...]}. "
                    "每项必须含 text/category/rationale/source_asset_ids/target_paths/candidate_test_ids/confidence。"
                    "只能提出候选标准，不得宣称已通过；优先使用真实团队资产与仓库测试，最多 8 项。"
                ),
            },
            {"role": "user", "content": prompt},
        ])
        parsed = _parse_json_object(content)
        result: List[AcceptanceCriterionSuggestion] = []
        known_assets = {item.asset_id: item for item in assets}
        known_paths = set(task.target_paths)
        known_paths.update(path for item in assets for path in item.paths)
        known_paths.update(_strings(context.get("active_paths")))
        known_paths.update(_strings(context.get("target_paths")))
        known_tests = set(_strings(context.get("test_ids")))
        known_tests.update(test for item in assets for test in item.tests)
        for raw in _dicts(parsed.get("criteria"))[:8]:
            text = str(raw.get("text") or "").strip()[:1200]
            if not text:
                continue
            asset_ids = [item for item in _strings(raw.get("source_asset_ids")) if item in known_assets]
            result.append(
                AcceptanceCriterionSuggestion(
                    criterion_id=f"criterion-{len(result) + 1}",
                    text=text,
                    category=str(raw.get("category") or "business")[:80],
                    rationale=str(raw.get("rationale") or "基于任务与团队资产生成")[:1200],
                    source_asset_ids=asset_ids,
                    source_titles=[known_assets[item].title for item in asset_ids],
                    target_paths=[
                        item for item in _strings(raw.get("target_paths")) if item in known_paths
                    ][:12],
                    candidate_test_ids=[
                        item for item in _strings(raw.get("candidate_test_ids")) if item in known_tests
                    ][:20],
                    confidence=max(0.0, min(float(raw.get("confidence") or 0.6), 1.0)),
                )
            )
        if not result:
            raise ValueError("acceptance model returned no valid criteria")
        return result


def _acceptance_model_config() -> OpenAICompatibleConfig:
    # Require an explicit, dedicated planner endpoint. Falling back to the
    # same MemoryProxy route that is currently waiting for this plan would
    # create a request cycle.
    base_url = os.environ.get("TEAM_ASSET_ACCEPTANCE_OPENAI_BASE_URL", "").strip()
    if not base_url:
        raise ValueError("TEAM_ASSET_ACCEPTANCE_OPENAI_BASE_URL is required in model mode")
    return OpenAICompatibleConfig(
        base_url=base_url,
        model=os.environ.get("TEAM_ASSET_ACCEPTANCE_OPENAI_MODEL", ""),
        api_key=os.environ.get("TEAM_ASSET_ACCEPTANCE_OPENAI_API_KEY", ""),
        timeout_seconds=int(
            os.environ.get("TEAM_ASSET_ACCEPTANCE_OPENAI_TIMEOUT", "180")
        ),
    )


def _normalize_repository_context(value: Mapping[str, Any]) -> Dict[str, Any]:
    result = {
        "active_paths": _strings(value.get("active_paths"))[:20],
        "target_paths": _strings(value.get("target_paths"))[:20],
        "test_ids": _strings(value.get("test_ids"))[:80],
        "test_paths": _strings(value.get("test_paths"))[:80],
        "frameworks": _strings(value.get("frameworks"))[:20],
        "ci_providers": _strings(value.get("ci_providers"))[:20],
        "config_files": _strings(value.get("config_files"))[:40],
    }
    return {key: item for key, item in result.items() if item}


def _discovered_tests(assets: Sequence[Asset], context: Mapping[str, Any]) -> List[DiscoveredTest]:
    paths = _strings(context.get("test_paths"))
    active = _strings(context.get("active_paths")) + _strings(context.get("target_paths"))
    frameworks = _strings(context.get("frameworks"))
    result: List[DiscoveredTest] = []
    for index, test_id in enumerate(_strings(context.get("test_ids"))):
        result.append(DiscoveredTest(
            test_id=test_id,
            path=paths[index] if index < len(paths) else "",
            framework=frameworks[0] if frameworks else "repository",
            target_paths=active,
            confidence=0.84,
            reason="CodeBuddy 当前轮提供的仓库测试上下文",
        ))
    existing = {item.test_id for item in result}
    for asset in assets:
        for test_id in asset.tests:
            if test_id in existing:
                continue
            existing.add(test_id)
            result.append(DiscoveredTest(
                test_id=test_id,
                path="",
                framework="team-asset-test-hint",
                target_paths=list(asset.paths),
                confidence=0.68,
                reason=f"团队资产《{asset.title}》记录的测试线索",
            ))
    return result


def _asset_matches(asset: Asset, terms: Iterable[str]) -> bool:
    text = " ".join([asset.title, asset.claim, asset.action, *asset.risks, *asset.keywords]).lower()
    return any(term.lower() in text for term in terms)


def _contains(text: str, *terms: str) -> bool:
    return any(term.lower() in text for term in terms)


def _strings(value: Any) -> List[str]:
    if not isinstance(value, (list, tuple, set)):
        return []
    return list(dict.fromkeys(str(item).strip()[:600] for item in value if str(item).strip()))


def _dicts(value: Any) -> List[Dict[str, Any]]:
    return [dict(item) for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _parse_json_object(text: str) -> Dict[str, Any]:
    value = text.strip()
    if value.startswith("```"):
        value = re.sub(r"^```(?:json)?\s*", "", value, flags=re.I)
        value = re.sub(r"\s*```$", "", value)
    parsed = json.loads(value)
    if not isinstance(parsed, dict):
        raise ValueError("acceptance model response must be an object")
    return parsed


def _redact(text: str) -> str:
    value = re.sub(r"sk-mem-[A-Za-z0-9_-]+", "[REDACTED]", text, flags=re.I)
    value = re.sub(r"uky-[A-Za-z0-9_-]+", "[REDACTED]", value, flags=re.I)
    value = re.sub(
        r"(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s\"']+",
        r"\1[REDACTED]",
        value,
        flags=re.I,
    )
    return value
