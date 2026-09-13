from __future__ import annotations

import argparse
import json
import os
import secrets
import shlex
from pathlib import Path
from typing import Any, Dict, Iterable, Optional
from urllib.request import Request, urlopen

from .catalog import project_root


AGENTS = (
    (
        "agent-architect-product",
        "架构与产品约束维护者",
        "维护团队权威产品约束、租户隔离边界和版本风险。",
        "你负责确认团队级产品与架构约束，只发布可追溯、经过审核的结论。",
    ),
    (
        "agent-senior-backend",
        "资深后端工程师",
        "沉淀历史实现方案、失败经验与最小安全修改模式。",
        "你负责贡献历史开发经验，明确适用条件、失败路径和代码决策。",
    ),
    (
        "agent-qa-sre",
        "QA/SRE 工程师",
        "维护故障注入、恢复验证、回归测试和上线检查工作流。",
        "你负责把团队经验转化为可执行验证证据，不能把未测试结论标为有效。",
    ),
    (
        "agent-new-backend",
        "新成员后端工程师",
        "执行新 Coding 任务，并使用经过权限与版本筛选的最小团队上下文。",
        "你负责完成任务，必须声明资产影响的决策、代码位置与验证结果。",
    ),
)

ACCEPTANCE_TESTS = (
    "test_cache_hit_returns_tenant_flag",
    "test_cache_miss_returns_none",
    "test_normal_path_does_not_read_database",
    "test_outage_falls_back_to_published_flag_for_same_tenant",
    "test_outage_never_leaks_another_tenant",
    "test_outage_never_exposes_draft_flag",
    "test_outage_does_not_retry_redis",
    "test_recovery_uses_cache_without_database_fallback",
    "test_missing_flag_during_outage_returns_none",
)

ACCEPTANCE_CRITERIA = (
    "Redis 缓存不可用时，功能开关读取应快速回退，不能持续超时或返回 5xx。",
    "回退结果只能来自当前租户已经发布的配置，不能读取其他租户或草稿配置。",
    "Redis 正常时仍走缓存路径，不应额外读取数据库；Redis 恢复后也应自动恢复正常路径。",
    "修复必须通过缓存命中、故障回退、租户隔离、草稿隔离和恢复路径测试。",
)


class MetaApi:
    def __init__(self, base_url: str, service_id: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.service_id = service_id

    def post(self, path: str, key: str, body: Dict[str, Any]) -> Dict[str, Any]:
        request = Request(
            f"{self.base_url}/v3/meta/{path}",
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            method="POST",
            headers={
                "content-type": "application/json",
                "x-tdai-user-key": key,
                "x-tdai-service-id": self.service_id,
            },
        )
        with urlopen(request, timeout=15) as response:
            value = json.loads(response.read().decode("utf-8"))
        if value.get("code") != 0:
            raise RuntimeError(f"{path} failed: code={value.get('code')} message={value.get('message')}")
        return value.get("data") or {}


def _parse_env(path: Path) -> Dict[str, str]:
    if not path.is_file():
        return {}
    result: Dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or line.lstrip().startswith("#") or "=" not in line:
            continue
        name, raw = line.split("=", 1)
        if not name.replace("_", "").isalnum():
            continue
        parts = shlex.split(raw, posix=True)
        result[name] = parts[0] if parts else ""
    return result


def _first(items: Iterable[Dict[str, Any]], field: str, expected: str) -> str:
    for item in items:
        if str(item.get(field, "")) == expected:
            return str(item.get(field.replace("name", "id"), ""))
    return ""


def _ensure_secret_file(path: Path, prefix: str) -> None:
    """Create a local-only service credential without ever printing its value."""
    if not path.is_file() or not path.read_text(encoding="utf-8").strip():
        path.write_text(f"{prefix}{secrets.token_urlsafe(32)}", encoding="utf-8")
    os.chmod(path, 0o600)


def register(
    core_url: str,
    service_id: str,
    admin_key_path: Path,
    output_env: Path,
    binding_path: Path,
    reuse_user_env: Optional[Path] = None,
    team_name: str = "Feature Flag 团队资产精品演示",
    task_title: str = "多租户 Feature Flag 缓存故障安全回退",
) -> Dict[str, Any]:
    if not admin_key_path.is_file():
        raise RuntimeError(f"missing admin key file: {admin_key_path}")
    admin_key = admin_key_path.read_text(encoding="utf-8").strip()
    if not admin_key:
        raise RuntimeError("admin key file is empty")

    previous = _parse_env(output_env)
    reusable = _parse_env(reuse_user_env) if reuse_user_env else {}
    api = MetaApi(core_url, service_id)
    user_id = reusable.get("DEMO_USER_ID", "")
    user_key = reusable.get("DEMO_USER_KEY", "")
    reused_existing_user = bool(user_id and user_key)
    if reused_existing_user:
        if not user_key.startswith("sk-mem-"):
            raise RuntimeError("reusable business key must use the sk-mem prefix; legacy uky keys are forbidden")
    else:
        username = "team-asset-bench"
        users = api.post("user/list", admin_key, {"username": username, "limit": 20}).get("items", [])
        user_id = next((str(item["user_id"]) for item in users if item.get("username") == username), "")
        user_key = (
            previous.get("TEAM_ASSET_DEMO_USER_KEY", "")
            if previous.get("TEAM_ASSET_DEMO_USER_ID") == user_id
            else ""
        )
        if not user_id:
            created = api.post("user/create", admin_key, {"username": username})
            user_id = str(created["user_id"])
            user_key = str(created["default_user_key"])
        elif not user_key:
            created = api.post(
                "user-key/create",
                admin_key,
                {"user_id": user_id, "name": "team-asset-bench-local"},
            )
            user_key = str(created["key_value"])
        if not user_key.startswith("sk-mem-"):
            raise RuntimeError("created business key did not use the required sk-mem prefix")

    teams = api.post("team/list", user_key, {"user_id": user_id, "name": team_name, "limit": 20}).get("items", [])
    team_id = next((str(item["team_id"]) for item in teams if item.get("name") == team_name), "")
    if not team_id:
        team_id = str(
            api.post(
                "team/create",
                user_key,
                {
                    "name": team_name,
                    "owner_user_id": user_id,
                    "description": "题目四精品项目：多角色、多来源、可验证的团队资产复用闭环。",
                },
            )["team_id"]
        )

    existing_agents = api.post(
        "agent/list",
        user_key,
        {"team_id": team_id, "owner_user_id": user_id, "status": "active", "limit": 100},
    ).get("items", [])
    agent_ids: Dict[str, str] = {}
    for logical_id, name, description, prompt in AGENTS:
        agent_id = next((str(item["agent_id"]) for item in existing_agents if item.get("name") == name), "")
        if not agent_id:
            agent_id = str(
                api.post(
                    "agent/create",
                    user_key,
                    {
                        "team_id": team_id,
                        "owner_user_id": user_id,
                        "name": name,
                        "description": description,
                        "prompt": prompt,
                        "visibility": "team",
                        "status": "active",
                    },
                )["agent_id"]
            )
        agent_ids[logical_id] = agent_id

    tasks = api.post(
        "task/list",
        user_key,
        {"team_id": team_id, "creator_user_id": user_id, "title": task_title, "limit": 20},
    ).get("items", [])
    task_id = next((str(item["task_id"]) for item in tasks if item.get("title") == task_title), "")
    task_profile_metadata = {
        "team_asset_profile": {
            "repository": "team/feature-flag-service",
            "version": "1.4",
            "profile_source": "team_task_owner_reviewed",
        },
        "team_asset_acceptance": {
            "version": "1",
            "criteria": list(ACCEPTANCE_CRITERIA),
            "required_tests": list(ACCEPTANCE_TESTS),
            "require_code_change": True,
            "target_paths": ["feature_flags/service.py"],
            "source": "team_task_owner_reviewed",
        },
    }
    if not task_id:
        task_id = str(
            api.post(
                "task/create",
                user_key,
                {
                    "team_id": team_id,
                    "creator_user_id": user_id,
                    "title": task_title,
                    "description": (
                        "多租户功能开关读取接口在缓存异常时出现超时和 5xx；"
                        "实施最小安全修复并提交可验证的测试证据。"
                    ),
                    "source_type": "manual",
                    "status": "running",
                    "risk_level": "high",
                    "metadata_json": json.dumps(task_profile_metadata, ensure_ascii=False),
                    "linked_agents": [
                        {"agent_id": agent_ids[logical_id], "role_in_task": role}
                        for logical_id, role in (
                            ("agent-architect-product", "constraint_owner"),
                            ("agent-senior-backend", "experience_contributor"),
                            ("agent-qa-sre", "validator"),
                            ("agent-new-backend", "executor"),
                        )
                    ],
                },
            )["task_id"]
        )
    else:
        current_task = api.post("task/get", user_key, {"task_id": task_id})
        try:
            current_metadata = json.loads(str(current_task.get("metadata_json") or "{}"))
        except json.JSONDecodeError:
            current_metadata = {}
        current_metadata.update(task_profile_metadata)
        api.post(
            "task/update",
            user_key,
            {
                "task_id": task_id,
                "risk_level": "high",
                "metadata_json": json.dumps(current_metadata, ensure_ascii=False),
            },
        )

    runtime = output_env.parent
    runtime.mkdir(parents=True, exist_ok=True)
    os.chmod(runtime, 0o700)
    _ensure_secret_file(runtime / "orchestrator.token", "team-assets-orchestrator-")
    _ensure_secret_file(runtime / "mock-upstream.token", "team-assets-mock-")
    output_env.write_text(
        "\n".join(
            [
                f"TEAM_ASSET_DEMO_USER_ID={shlex.quote(user_id)}",
                f"TEAM_ASSET_DEMO_USER_KEY={shlex.quote(user_key)}",
                f"TEAM_ASSET_DEMO_TEAM_ID={shlex.quote(team_id)}",
                f"TEAM_ASSET_DEMO_TASK_ID={shlex.quote(task_id)}",
                f"TEAM_ASSET_DEMO_EXECUTOR_ID={shlex.quote(agent_ids['agent-new-backend'])}",
                "",
            ]
        ),
        encoding="utf-8",
    )
    os.chmod(output_env, 0o600)

    try:
        existing_bindings = json.loads(binding_path.read_text(encoding="utf-8")) if binding_path.is_file() else {}
    except json.JSONDecodeError:
        existing_bindings = {}
    bindings = {
        "teams": {team_id: "team-feature-platform"},
        "agents": {external: logical for logical, external in agent_ids.items()},
        "tasks": {task_id: "task-cache-outage-001"},
        # sync_hub_assets writes the logical ↔ runtime asset mapping later.
        # Registration is idempotent and must not erase those mappings on rerun.
        "assets": existing_bindings.get("assets", {}),
    }
    binding_path.write_text(json.dumps(bindings, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(binding_path, 0o600)
    return {
        "user_id": user_id,
        "team_id": team_id,
        "task_id": task_id,
        "agents": {logical: {"id": agent_ids[logical], "name": name} for logical, name, _, _ in AGENTS},
        "credential_file": str(output_env),
        "binding_file": str(binding_path),
        "orchestrator_token_file": str(runtime / "orchestrator.token"),
        "mock_upstream_token_file": str(runtime / "mock-upstream.token"),
        "reused_existing_business_user": reused_existing_user,
    }


def main() -> None:
    root = project_root()
    repository = root.parents[1]
    parser = argparse.ArgumentParser(description="Register the golden team in a local Memory Hub/Core stack.")
    parser.add_argument("--core-url", default="http://127.0.0.1:8420")
    parser.add_argument("--service-id", default="default")
    parser.add_argument("--admin-key-file", type=Path, default=repository / "deploy/global-images/.admin-key")
    parser.add_argument("--output-env", type=Path, default=root / "runtime/hub-demo.env")
    parser.add_argument("--binding-file", type=Path, default=root / "runtime/hub-binding.json")
    parser.add_argument("--team-name", default="Feature Flag 团队资产精品演示")
    parser.add_argument("--task-title", default="多租户 Feature Flag 缓存故障安全回退")
    parser.add_argument(
        "--reuse-user-env",
        type=Path,
        default=repository / "deploy/global-images/.env.memory-demo",
        help="Existing validated sk-mem user env to reuse so CodeBuddy can see the new team.",
    )
    args = parser.parse_args()
    result = register(
        args.core_url,
        args.service_id,
        args.admin_key_file,
        args.output_env,
        args.binding_file,
        args.reuse_user_env,
        args.team_name,
        args.task_title,
    )
    print("Memory Hub 精品团队已幂等注册（凭据未输出）")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
