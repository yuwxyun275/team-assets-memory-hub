from __future__ import annotations

import hashlib
from dataclasses import replace
import json
import re
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, Mapping

from .models import Asset, AssetType, EvidenceState, SourceType


_NATIVE_SOURCE = {
    "llm_wiki": SourceType.WIKI,
    "wiki": SourceType.WIKI,
    "code_graph": SourceType.CODE_GRAPH,
    "code-graph": SourceType.CODE_GRAPH,
    "chat_memory": SourceType.CHAT_MEMORY,
    "chat-memory": SourceType.CHAT_MEMORY,
    "skill": SourceType.SKILL,
}

_DEFAULT_SEMANTIC_TYPE = {
    SourceType.WIKI: AssetType.PROJECT_CONSTRAINT,
    SourceType.CHAT_MEMORY: AssetType.FAILURE_EXPERIENCE,
    SourceType.CODE_GRAPH: AssetType.CODE_KNOWLEDGE,
    SourceType.SKILL: AssetType.VALIDATION_WORKFLOW,
}

_INJECTION_MODE = {
    SourceType.WIKI: "wiki_query",
    SourceType.CHAT_MEMORY: "memory_hybrid_search",
    SourceType.CODE_GRAPH: "code_graph_tool",
    SourceType.SKILL: "skill_loader",
}

_TYPE_ALIASES = {
    "project_constraint": AssetType.PROJECT_CONSTRAINT,
    "constraint": AssetType.PROJECT_CONSTRAINT,
    "failure_experience": AssetType.FAILURE_EXPERIENCE,
    "failure": AssetType.FAILURE_EXPERIENCE,
    "code_knowledge": AssetType.CODE_KNOWLEDGE,
    "code": AssetType.CODE_KNOWLEDGE,
    "validation_workflow": AssetType.VALIDATION_WORKFLOW,
    "workflow": AssetType.VALIDATION_WORKFLOW,
    "product_knowledge": AssetType.PRODUCT_KNOWLEDGE,
    "product": AssetType.PRODUCT_KNOWLEDGE,
}


class NativeMemoryAssetAdapter:
    """Convert ACL-filtered Memory Hub assets into selector assets.

    The adapter accepts both the historical benchmark envelope and ordinary
    Memory Hub assets.  Hub primary-table fields remain authoritative, while
    optional metadata only enriches retrieval and evidence.  It never reads a
    private data plane directly; the returned handle tells the existing Proxy
    injector which permission-checked native mechanism must be used later.
    """

    def adapt_many(self, items: Iterable[Mapping[str, Any]]) -> list[Asset]:
        assets: list[Asset] = []
        for item in items:
            try:
                asset = self.adapt(item)
            except (KeyError, TypeError, ValueError, json.JSONDecodeError):
                asset = None
            if asset is not None:
                assets.append(asset)
        return assets

    def adapt(self, item: Mapping[str, Any]) -> Asset | None:
        runtime_id = str(item.get("asset_id") or "").strip()
        metadata = _json_object(item.get("metadata_json"))
        bench = metadata.get("team_asset_bench")
        bench = bench if isinstance(bench, dict) else {}
        portable = bench.get("asset_payload")
        portable = portable if isinstance(portable, dict) else {}
        team_id = str(item.get("team_id") or portable.get("team_id") or "").strip()
        native_type = str(item.get("asset_type") or "").strip().lower()
        source = _NATIVE_SOURCE.get(native_type)
        if source is None and portable:
            try:
                source = SourceType(str(portable.get("source_type") or ""))
            except ValueError:
                source = None
            if source is not None:
                native_type = {
                    SourceType.WIKI: "llm_wiki",
                    SourceType.CHAT_MEMORY: "chat_memory",
                    SourceType.CODE_GRAPH: "code_graph",
                    SourceType.SKILL: "skill",
                }[source]
        if not runtime_id or source is None:
            return None
        publication = item.get("quality_publication")
        if isinstance(publication, dict):
            snapshot = publication.get("snapshot") or {}
            report = publication.get("report") or {}
            scorecard = report.get("scorecard") or {}
            if (snapshot.get("asset_id") != runtime_id or not snapshot.get("body")
                    or report.get("decision") != "pass" or scorecard.get("quality") is None
                    or not publication.get("approved_by")):
                return None
            asset = self._native_asset(item, metadata, source, native_type, runtime_id, team_id)
            body = str(snapshot["body"])
            graph = _json_object(body) if source is SourceType.CODE_GRAPH else {}
            scope = snapshot.get("project_scope") or {}
            if not isinstance(scope, dict):
                return None
            if item.get("source_type") == "asset_learning" and (not scope.get("repository") or not scope.get("version")):
                return None
            repository = str(scope.get("repository") or graph.get("repository") or "")
            project_version = str(scope.get("version") or graph.get("revision") or "")
            workflow_scope = snapshot.get("workflow_scope") or {}
            if not isinstance(workflow_scope, dict):
                return None
            transferable = workflow_scope.get("suggested") in {"team", "cross_project"}
            if workflow_scope and (workflow_scope.get("admission") != "check_preconditions_before_execution"
                                   or not workflow_scope.get("requirements")):
                return None
            utility = item.get("quality_utility") or {}
            # Reviewed immutable content, never a live container implicitly certified by one page's report.
            return replace(asset, claim=str(snapshot.get("declared_scope") or asset.claim), action=body,
                version="*" if transferable else project_version or asset.version,
                risks=list(dict.fromkeys([*asset.risks, *(["synthetic_source"] if scope.get("synthetic") else []),
                    *(["workflow_preflight_required", "workflow_execution_unverified"] if workflow_scope else []),
                    *(["cross_project_adaptation_required"] if transferable else [])])),
                paths=list(dict.fromkeys([*asset.paths, *[str(n["path"]) for n in graph.get("nodes", []) if isinstance(n, dict) and n.get("path")]])),
                injection_mode="reviewed_snapshot", evidence_state=EvidenceState.REVIEWED,
                content_hash=str(report.get("snapshot_sha256") or ""),
                native_signals={**asset.native_signals, "intrinsic_quality": min(1.0, max(0.0, float(scorecard["quality"]) / 100))},
                historical_effect=min(1.0, max(0.0,
                    (float(utility["score"]) if utility.get("score") is not None else .5)
                    - min(.15, max(0.0, float(utility.get("applicability_penalty", 0))))
                    + min(.05, max(-.05, float(utility.get("applicability_adjustment", 0)))))),
                token_cost=max(asset.token_cost, len(body.encode("utf-8")) // 2 + 350),
                retrieval_handle={"asset_id": runtime_id, "revision_id": publication["revision_id"], "mode": "reviewed_snapshot", "content_included": True,
                                  "bound_repository": "" if transferable else repository, "bound_revision": "" if transferable else project_version,
                                  "workflow_scope": workflow_scope, "use_admission": "preflight_required" if workflow_scope else "normal"})
        if isinstance(portable, dict) and portable:
            return self._legacy_asset(item, metadata, bench, portable, source, runtime_id)
        if not team_id:
            return None
        return self._native_asset(item, metadata, source, native_type, runtime_id, team_id)

    def _legacy_asset(
        self,
        item: Mapping[str, Any],
        metadata: Mapping[str, Any],
        bench: Mapping[str, Any],
        portable: Mapping[str, Any],
        source: SourceType,
        runtime_id: str,
    ) -> Asset:
        payload = dict(portable)
        logical_id = str(bench.get("logical_asset_id") or payload.get("asset_id") or runtime_id)
        payload.update({
            "asset_id": logical_id,
            "runtime_asset_id": runtime_id,
            "native_asset_type": str(item.get("asset_type") or source.value),
            "title": str(item.get("name") or payload.get("title") or logical_id),
            "claim": str(item.get("description") or payload.get("claim") or ""),
            "source_ref": str(item.get("source_ref") or payload.get("source_ref") or ""),
            "version": str(bench.get("version") or item.get("version") or payload.get("version") or "*"),
            "updated_at": _timestamp(item.get("updated_at") or bench.get("updated_at") or payload.get("updated_at")),
            "visibility": str(item.get("visibility") or payload.get("visibility") or "team"),
            "status": str(item.get("status") or payload.get("status") or "approved"),
            "content_ref": str(item.get("content_ref") or payload.get("content_ref") or ""),
            "injection_mode": str(payload.get("injection_mode") or _INJECTION_MODE[source]),
            "retrieval_handle": self._handle(item, metadata, source, runtime_id),
            "native_signals": _native_signals(metadata),
            # ``NativeMemoryAssetAdapter`` only receives descriptors returned
            # by MemoryCore's list-accessible endpoint.  At that boundary the
            # runtime user/team/agent ACL has already been enforced.  Legacy
            # benchmark payloads may still carry portable role names such as
            # ``agent-new-backend``; comparing those names with a newly-created
            # Hub id (``agt-...``) would apply a second, incompatible ACL and
            # silently discard an asset that Core explicitly authorized.
            "allowed_agents": ["*"],
        })
        return Asset.from_dict(payload)

    def _native_asset(
        self,
        item: Mapping[str, Any],
        metadata: Mapping[str, Any],
        source: SourceType,
        native_type: str,
        runtime_id: str,
        team_id: str,
    ) -> Asset:
        title = str(item.get("name") or runtime_id).strip()
        description = str(item.get("description") or "").strip()
        semantic_type = _semantic_type(metadata, source, f"{title} {description}")
        version = _semantic_version(item, metadata)
        paths = _strings(metadata, "paths", "target_paths", "files")
        tests = _strings(metadata, "tests", "test_ids", "verification")
        risks = _strings(metadata, "risks", "risk_flags")
        keywords = _strings(metadata, "keywords", "tags", "topics")
        if not keywords:
            keywords = _keywords(f"{title} {description}")
        task_types = _strings(metadata, "task_types", "task_kinds") or ["*"]
        confidence = _float(item.get("confidence"), 0.5)
        status = str(item.get("status") or "approved")
        evidence = _evidence_state(metadata, source, status)
        updated = _timestamp(item.get("updated_at") or item.get("created_at"))
        content_ref = str(item.get("content_ref") or "")
        source_ref = str(item.get("source_ref") or content_ref or f"memory-hub://asset/{runtime_id}")
        claim = description or _default_claim(source, title)
        action = str(metadata.get("recommended_action") or metadata.get("action") or _default_action(source))
        token_cost = _token_cost(metadata, title, description)
        owner = str(item.get("owner_user_id") or metadata.get("contributor") or "team")
        expires_at = str(item.get("expires_at") or "")
        deprecated = status in {"deprecated", "rejected", "archived"} or _expired(expires_at)
        historical = _float(metadata.get("historical_effect"), 0.5)
        content_hash = hashlib.sha256(
            json.dumps(
                {"id": runtime_id, "version": version, "updated_at": updated, "description": description},
                ensure_ascii=False,
                sort_keys=True,
            ).encode("utf-8")
        ).hexdigest()
        return Asset(
            asset_id=runtime_id,
            runtime_asset_id=runtime_id,
            team_id=team_id,
            title=title,
            source_type=source,
            native_asset_type=native_type,
            asset_type=semantic_type,
            contributor=owner,
            source_ref=source_ref,
            claim=claim,
            action=action,
            evidence_state=evidence,
            version=version,
            updated_at=updated,
            token_cost=token_cost,
            keywords=keywords,
            task_types=task_types,
            paths=paths,
            tests=tests,
            risks=risks,
            # The input is already ACL-filtered by MemoryCore.  Do not apply a
            # second role-name filter inside the portable selector.
            allowed_agents=["*"],
            historical_effect=historical,
            deprecated=deprecated,
            superseded_by=_optional_string(metadata.get("superseded_by")),
            content_hash=content_hash,
            visibility=str(item.get("visibility") or "team"),
            status=status,
            content_ref=content_ref,
            injection_mode=_INJECTION_MODE[source],
            retrieval_handle=self._handle(item, metadata, source, runtime_id),
            native_signals=_native_signals(metadata),
        )

    @staticmethod
    def _handle(
        item: Mapping[str, Any],
        metadata: Mapping[str, Any],
        source: SourceType,
        runtime_id: str,
    ) -> Dict[str, Any]:
        handle: Dict[str, Any] = {
            "asset_id": runtime_id,
            "asset_type": str(item.get("asset_type") or source.value),
            "mode": _INJECTION_MODE[source],
        }
        content_ref = str(item.get("content_ref") or "").strip()
        if content_ref:
            handle["content_ref"] = content_ref
        if source is SourceType.CODE_GRAPH:
            handle["tools"] = ["search_code", "find_symbol", "get_call_graph"]
        elif source is SourceType.WIKI:
            handle["tools"] = ["query_wiki", "follow_wiki_links"]
        elif source is SourceType.CHAT_MEMORY:
            handle["retrieval"] = "bm25+embedding_rrf_when_enabled"
            layer = metadata.get("memory_layer") or metadata.get("layer")
            if layer:
                handle["layer"] = str(layer)
        elif source is SourceType.SKILL:
            handle["tools"] = ["load_skill"]
        return handle


def _semantic_type(metadata: Mapping[str, Any], source: SourceType, text: str) -> AssetType:
    explicit = str(metadata.get("semantic_asset_type") or metadata.get("team_asset_type") or "").lower()
    if explicit in _TYPE_ALIASES:
        return _TYPE_ALIASES[explicit]
    # The physical source has a stable default role (Wiki constraints,
    # ChatMemory experience, CodeGraph code knowledge, Skill workflow).  A
    # publisher may override it explicitly; guessing from a word such as
    # “故障” would otherwise turn all four sources into the same semantic type.
    return _DEFAULT_SEMANTIC_TYPE[source]


def _evidence_state(metadata: Mapping[str, Any], source: SourceType, status: str) -> EvidenceState:
    explicit = str(metadata.get("evidence_state") or "").lower()
    try:
        return EvidenceState(explicit)
    except ValueError:
        pass
    if status != "approved":
        return EvidenceState.CANDIDATE
    # Wiki/Skill normally pass a human publish boundary.  CodeGraph and
    # ChatMemory are source-derived and are therefore source-verified until a
    # task/test independently validates their effect.
    if source in {SourceType.WIKI, SourceType.SKILL}:
        return EvidenceState.REVIEWED
    return EvidenceState.SOURCE_VERIFIED


def _native_signals(metadata: Mapping[str, Any]) -> Dict[str, float]:
    nested = metadata.get("retrieval_signals") or metadata.get("retrieval_scores") or {}
    nested = nested if isinstance(nested, dict) else {}
    result: Dict[str, float] = {}
    for name in ("bm25", "vector", "graph"):
        value = nested.get(name, metadata.get(f"{name}_score"))
        if value is not None:
            result[name] = max(0.0, min(1.0, _float(value, 0.0)))
    return result


def _json_object(value: Any) -> Dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    if not value:
        return {}
    parsed = json.loads(str(value))
    return parsed if isinstance(parsed, dict) else {}


def _strings(metadata: Mapping[str, Any], *names: str) -> list[str]:
    for name in names:
        value = metadata.get(name)
        if isinstance(value, list):
            return list(dict.fromkeys(str(item).strip() for item in value if str(item).strip()))
        if isinstance(value, str) and value.strip():
            return list(dict.fromkeys(item.strip() for item in re.split(r"[,;\n]", value) if item.strip()))
    return []


def _keywords(text: str) -> list[str]:
    values = re.findall(r"[a-zA-Z_][a-zA-Z0-9_./:-]*|[\u4e00-\u9fff]{2,}", text.lower())
    return list(dict.fromkeys(values))[:24]


def _semantic_version(item: Mapping[str, Any], metadata: Mapping[str, Any]) -> str:
    for value in (
        metadata.get("project_version"), metadata.get("semantic_version"), metadata.get("version"),
    ):
        if value is not None and str(value).strip():
            return str(value).strip()
    # Memory Hub's integer version is an asset revision, not necessarily the
    # project version.  Treat it as wildcard for compatibility decisions while
    # retaining it in the retrieval handle/audit payload.
    return "*"


def _timestamp(value: Any) -> str:
    raw = str(value or "").strip()
    return raw or datetime.now(timezone.utc).isoformat()


def _token_cost(metadata: Mapping[str, Any], *texts: str) -> int:
    explicit = metadata.get("token_cost") or metadata.get("estimated_tokens")
    if explicit is not None:
        try:
            return max(24, min(4000, int(explicit)))
        except (TypeError, ValueError):
            pass
    char_count = sum(len(text) for text in texts)
    return max(48, min(320, 36 + char_count // 3))


def _default_claim(source: SourceType, title: str) -> str:
    labels = {
        SourceType.WIKI: "团队发布的 Wiki 约束与知识",
        SourceType.CHAT_MEMORY: "团队历史会话中沉淀的开发经验",
        SourceType.CODE_GRAPH: "当前项目代码结构与依赖关系",
        SourceType.SKILL: "团队发布的可复用执行与验证流程",
    }
    return f"{labels[source]}：{title}"


def _default_action(source: SourceType) -> str:
    return {
        SourceType.WIKI: "通过原生 Wiki 查询获取与当前任务最相关的段落，并核对版本与来源。",
        SourceType.CHAT_MEMORY: "通过原生混合检索查找相似问题、失败尝试和已验证经验。",
        SourceType.CODE_GRAPH: "通过 Code Graph 工具定位符号、调用关系和影响范围。",
        SourceType.SKILL: "按需加载 Skill 并执行其中与当前任务匹配的步骤。",
    }[source]


def _float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _optional_string(value: Any) -> str | None:
    raw = str(value or "").strip()
    return raw or None


def _expired(value: str) -> bool:
    if not value:
        return False
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed < datetime.now(timezone.utc)
    except ValueError:
        return False
