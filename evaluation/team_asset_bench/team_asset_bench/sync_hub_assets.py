from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, Iterable, Optional
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from .catalog import load_assets, project_root
from .register_hub import MetaApi, _parse_env


WIKI_NAME = "多租户功能开关缓存降级规范"
SKILL_NAME = "缓存故障与恢复回归检查流程"
CODE_GRAPH_NAME = "FeatureFlagService 功能开关读取调用链"


class PanelApi:
    def __init__(self, base_url: str, service_id: str, user_key: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.service_id = service_id
        self.user_key = user_key

    def post(self, path: str, body: Dict[str, Any], timeout: int = 30) -> Dict[str, Any]:
        request = Request(
            f"{self.base_url}/api/v1/{path.lstrip('/')}",
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            method="POST",
            headers={
                "content-type": "application/json",
                "x-tdai-user-key": self.user_key,
                "x-tdai-service-id": self.service_id,
            },
        )
        try:
            with urlopen(request, timeout=timeout) as response:
                value = json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            body_text = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"panel {path} failed: HTTP {exc.code} {body_text[:300]}") from exc
        if value.get("code") != 0:
            raise RuntimeError(
                f"panel {path} failed: code={value.get('code')} message={value.get('message')}"
            )
        return value.get("data") or {}


def _items(api: MetaApi, key: str, action: str, body: Dict[str, Any]) -> list[Dict[str, Any]]:
    return list(api.post(action, key, {**body, "limit": 100}).get("items", []))


def _find_by_name(items: Iterable[Dict[str, Any]], name: str) -> Optional[Dict[str, Any]]:
    return next((item for item in items if str(item.get("name", "")) == name), None)


def _find_logical_asset(
    items: Iterable[Dict[str, Any]], logical_id: str, *fallback_names: str
) -> Optional[Dict[str, Any]]:
    for item in items:
        if str(item.get("name", "")) in fallback_names:
            return item
        try:
            metadata = json.loads(str(item.get("metadata_json", "{}")))
        except json.JSONDecodeError:
            continue
        if metadata.get("team_asset_bench", {}).get("logical_asset_id") == logical_id:
            return item
    return None


def _catalog_by_logical_id() -> Dict[str, Any]:
    return {asset.asset_id: asset for asset in load_assets(project_root())}


def prepare_git_repository(root: Path) -> Path:
    """Build a tiny, isolated git repository for the real Code Graph service."""
    source = root / "projects" / "feature_flag_service" / "base"
    runtime = root / "runtime" / "code-graph-source"
    bare = root / "runtime" / "git" / "feature-flag-service.git"
    if bare.is_dir():
        return bare

    runtime.parent.mkdir(parents=True, exist_ok=True)
    bare.parent.mkdir(parents=True, exist_ok=True)
    if runtime.exists():
        shutil.rmtree(runtime)
    shutil.copytree(source, runtime)
    subprocess.run(["git", "init", "--initial-branch", "main"], cwd=runtime, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.name", "Team Asset Benchmark"], cwd=runtime, check=True)
    subprocess.run(["git", "config", "user.email", "team-asset@example.invalid"], cwd=runtime, check=True)
    subprocess.run(["git", "add", "."], cwd=runtime, check=True)
    subprocess.run(
        ["git", "commit", "-m", "feature flag cache boundary baseline"],
        cwd=runtime,
        check=True,
        capture_output=True,
    )
    subprocess.run(["git", "clone", "--bare", str(runtime), str(bare)], check=True, capture_output=True)
    subprocess.run(["git", "--git-dir", str(bare), "update-server-info"], check=True)
    return bare


def _asset_metadata(logical_id: str) -> str:
    asset = _catalog_by_logical_id()[logical_id]
    return json.dumps(
        {
            "team_asset_bench": {
                "logical_asset_id": logical_id,
                "asset_type": asset.asset_type.value,
                "evidence_state": asset.evidence_state.value,
                "source_ref": asset.source_ref,
                "content_hash": asset.content_hash,
                "version": asset.version,
                "updated_at": asset.updated_at,
                "tests": asset.tests,
                "risks": asset.risks,
                # 运行时编排器直接从 Memory Hub 读取该快照。这样 Hub 页面、
                # Proxy 注入和证据回执使用同一份受权限与版本控制的内容，
                # 不再依赖旁路 catalog 补正文。
                "asset_payload": asset.to_dict(),
            }
        },
        ensure_ascii=False,
    )


def _enrich_asset(
    meta: MetaApi,
    key: str,
    runtime_id: str,
    logical_id: str,
    *,
    visibility: str = "team",
) -> None:
    asset = _catalog_by_logical_id()[logical_id]
    meta.post(
        "asset/update",
        key,
        {
            "asset_id": runtime_id,
            "name": asset.title,
            "description": asset.claim,
            "visibility": visibility,
            "status": "approved",
            "confidence": asset.historical_effect,
            "source_ref": asset.source_ref,
            "metadata_json": _asset_metadata(logical_id),
        },
    )


def sync(
    *,
    core_url: str,
    panel_url: str,
    service_id: str,
    env_file: Path,
    binding_file: Path,
    repo_url: str,
) -> Dict[str, Any]:
    env = _parse_env(env_file)
    key = env.get("TEAM_ASSET_DEMO_USER_KEY", "")
    user_id = env.get("TEAM_ASSET_DEMO_USER_ID", "")
    team_id = env.get("TEAM_ASSET_DEMO_TEAM_ID", "")
    if not key.startswith("sk-mem-"):
        raise RuntimeError("a validated sk-mem business key is required; legacy uky keys are forbidden")
    if not user_id or not team_id:
        raise RuntimeError("team runtime env is incomplete")

    binding = json.loads(binding_file.read_text(encoding="utf-8"))
    logical_to_runtime_agent = {logical: runtime for runtime, logical in binding.get("agents", {}).items()}
    senior_agent = logical_to_runtime_agent["agent-senior-backend"]
    qa_agent = logical_to_runtime_agent["agent-qa-sre"]

    meta = MetaApi(core_url, service_id)
    panel = PanelApi(panel_url, service_id, key)
    runtime_assets: Dict[str, str] = {}

    # 1) Wiki: actual raw content -> ingest pipeline -> team-visible meta asset.
    meta_assets = _items(meta, key, "asset/list", {"team_id": team_id})
    wiki_meta = _find_logical_asset(meta_assets, "asset-wiki-tenant-fallback", WIKI_NAME)
    if wiki_meta:
        wiki_id = str(wiki_meta["asset_id"])
        wiki_detail = panel.post("knowledge/wiki/get", {"wiki_id": wiki_id})
    else:
        wiki = panel.post("knowledge/wiki/create", {"team_id": team_id, "name": WIKI_NAME})
        wiki_id = str(wiki["wiki_id"])
        wiki_detail = wiki
    if str(wiki_detail.get("status", "draft")) not in {"processing", "ready"}:
        wiki_text = (project_root() / "raw/wiki/feature_flag_availability.md").read_text(encoding="utf-8")
        panel.post(
            "knowledge/wiki/raw/write",
            {"team_id": team_id, "wiki_id": wiki_id, "files": [{"filename": "feature_flag_availability.md", "content": wiki_text}]},
        )
        panel.post("knowledge/wiki/ingest", {"wiki_id": wiki_id}, timeout=60)
    _enrich_asset(meta, key, wiki_id, "asset-wiki-tenant-fallback")
    runtime_assets[wiki_id] = "asset-wiki-tenant-fallback"

    # 2) Skill: create in the real Skill service and bind ownership to QA/SRE.
    meta_assets = _items(meta, key, "asset/list", {"team_id": team_id})
    skill_meta = _find_logical_asset(
        meta_assets,
        "asset-skill-cache-fault-recovery",
        SKILL_NAME,
        "缓存故障与恢复回归 Skill",
    )
    if skill_meta:
        skill_id = str(skill_meta["asset_id"])
    else:
        body = (project_root() / "raw/skills/cache_fault_recovery/SKILL.md").read_text(encoding="utf-8")
        content = (
            "---\n"
            f"name: {SKILL_NAME}\n"
            "description: 验证缓存故障、租户隔离、无重试风暴和故障恢复行为。\n"
            "---\n\n"
            f"{body}"
        )
        skill = panel.post(
            "skill/create",
            {"user_id": user_id, "team_id": team_id, "agent_id": qa_agent, "name": SKILL_NAME, "content": content},
        )
        skill_id = str(skill["skill_id"])
    _enrich_asset(meta, key, skill_id, "asset-skill-cache-fault-recovery")
    runtime_assets[skill_id] = "asset-skill-cache-fault-recovery"

    # 3) Chat Memory: import the senior engineer's historical incident session.
    history = []
    for line in (project_root() / "raw/sessions/redis_outage_incident.jsonl").read_text(encoding="utf-8").splitlines():
        raw = json.loads(line)
        role = str(raw.get("role", "assistant"))
        if role == "tool":
            role = "assistant"
        history.append({"role": role, "content": str(raw.get("content", ""))})
    panel.post(
        "chat-memory/import",
        {
            "team_id": team_id,
            "agent_id": senior_agent,
            "session_id": "team-asset-redis-incident-v1",
            "messages": history,
        },
        timeout=60,
    )
    meta_assets = _items(meta, key, "asset/list", {"team_id": team_id, "asset_type": "chat_memory"})
    chat_meta = next(
        (
            item
            for item in meta_assets
            if senior_agent in str(item.get("asset_id", ""))
            or "资深后端工程师" in str(item.get("name", ""))
        ),
        None,
    )
    if not chat_meta:
        raise RuntimeError("chat memory import succeeded but its meta asset was not found")
    chat_id = str(chat_meta["asset_id"])
    _enrich_asset(meta, key, chat_id, "asset-memory-retry-storm")
    runtime_assets[chat_id] = "asset-memory-retry-storm"

    # 4) Code Graph: clone/build the isolated demo repository in the real KS.
    meta_assets = _items(meta, key, "asset/list", {"team_id": team_id})
    code_meta = _find_by_name(meta_assets, CODE_GRAPH_NAME)
    code_graph_id = str(code_meta["asset_id"]) if code_meta else ""
    if not code_graph_id:
        listed = panel.post("knowledge/code-graph/list", {"team_id": team_id, "limit": 100}).get("items", [])
        existing = next((item for item in listed if str(item.get("repo_name", "")) == CODE_GRAPH_NAME), None)
        if existing and str(existing.get("status", "")) == "failed":
            panel.post(
                "knowledge/code-graph/delete",
                {"code_graph_ids": [str(existing["code_graph_id"])]},
            )
            existing = None
        if existing:
            code_graph_id = str(existing["code_graph_id"])
        else:
            created = panel.post(
                "knowledge/code-graph/create",
                {"team_id": team_id, "repo_url": repo_url, "branch": "main", "repo_name": CODE_GRAPH_NAME},
                timeout=60,
            )
            code_graph_id = str(created["code_graph_id"])
        deadline = time.monotonic() + 120
        last_status = "pending"
        while time.monotonic() < deadline:
            detail = panel.post("knowledge/code-graph/get", {"code_graph_id": code_graph_id}, timeout=30)
            last_status = str(detail.get("status", ""))
            if last_status == "ready":
                break
            if last_status == "failed":
                raise RuntimeError(f"code graph build failed: {detail.get('sync_error') or detail.get('summary')}")
            time.sleep(2)
        if last_status != "ready":
            raise RuntimeError(f"code graph build timed out with status={last_status}")
        panel.post("knowledge/code-graph/register-meta", {"team_id": team_id, "code_graph_id": code_graph_id})
    _enrich_asset(meta, key, code_graph_id, "asset-codegraph-cache-boundary")
    runtime_assets[code_graph_id] = "asset-codegraph-cache-boundary"

    # Extend the runtime binding. The real IDs remain the permission authority;
    # logical IDs are stable benchmark identities used only for scoring/evidence.
    binding["assets"] = runtime_assets
    binding_file.write_text(json.dumps(binding, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(binding_file, 0o600)
    return {
        "team_id": team_id,
        "assets": [
            {"runtime_id": runtime_id, "logical_id": logical_id}
            for runtime_id, logical_id in runtime_assets.items()
        ],
        "binding_file": str(binding_file),
    }


def main() -> None:
    root = project_root()
    parser = argparse.ArgumentParser(description="Import the benchmark's four source types into a real Memory Hub team.")
    parser.add_argument("--core-url", default="http://127.0.0.1:8420")
    parser.add_argument("--panel-url", default="http://127.0.0.1:8125")
    parser.add_argument("--service-id", default="default")
    parser.add_argument("--env-file", type=Path, default=root / "runtime/new_asset_test_01.env")
    parser.add_argument("--binding-file", type=Path, default=root / "runtime/new_asset_test_01-binding.json")
    parser.add_argument(
        "--repo-url",
        default="https://github.com/carta/flipper-client.git",
        help="Repository URL reachable by the Knowledge service container.",
    )
    parser.add_argument("--prepare-repo-only", action="store_true")
    args = parser.parse_args()
    bare = prepare_git_repository(root)
    if args.prepare_repo_only:
        print(json.dumps({"prepared": True, "repository": str(bare)}, ensure_ascii=False))
        return
    result = sync(
        core_url=args.core_url,
        panel_url=args.panel_url,
        service_id=args.service_id,
        env_file=args.env_file,
        binding_file=args.binding_file,
        repo_url=args.repo_url,
    )
    print("四类资产已写入真实 Memory Hub（凭据未输出）")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
