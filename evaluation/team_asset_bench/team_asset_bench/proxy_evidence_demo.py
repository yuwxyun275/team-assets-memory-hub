from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any, Dict
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .catalog import project_root
from .register_hub import ACCEPTANCE_TESTS, _parse_env


ASSET_USES = (
    (
        "asset-wiki-tenant-fallback",
        "遵守团队权威约束，仅回退当前租户已发布的功能开关配置",
        "feature_flags/service.py:FeatureFlagService.get_flag",
    ),
    (
        "asset-memory-retry-storm",
        "复用历史故障经验，在单次请求内禁止 Redis 重试风暴",
        "feature_flags/service.py:FeatureFlagService.get_flag",
    ),
    (
        "asset-codegraph-cache-boundary",
        "依据调用图把修改收敛在缓存读取边界，避免改动存储层",
        "feature_flags/service.py:FeatureFlagService.get_flag",
    ),
    (
        "asset-skill-cache-fault-recovery",
        "执行正常、故障、租户隔离、无重试与恢复的一体化回归",
        "test:pytest -q tests hidden_tests",
    ),
)


def _post(url: str, headers: Dict[str, str], body: Dict[str, Any]) -> Dict[str, Any]:
    request = Request(
        url,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        method="POST",
        headers={"content-type": "application/json", **headers},
    )
    with urlopen(request, timeout=30) as response:
        value = json.loads(response.read().decode("utf-8"))
    return value if isinstance(value, dict) else {}


def _get(url: str, headers: Dict[str, str], query: Dict[str, str]) -> Dict[str, Any]:
    request = Request(
        f"{url}?{urlencode(query)}",
        method="GET",
        headers=headers,
    )
    with urlopen(request, timeout=30) as response:
        value = json.loads(response.read().decode("utf-8"))
    return value if isinstance(value, dict) else {}


def run(
    *,
    proxy_url: str,
    orchestrator_url: str,
    env_file: Path,
    binding_file: Path,
    token_file: Path,
    session_id: str,
) -> Dict[str, Any]:
    env = _parse_env(env_file)
    user_key = env.get("TEAM_ASSET_DEMO_USER_KEY", "")
    if not user_key.startswith("sk-mem-"):
        raise RuntimeError("validated sk-mem business key required")
    binding = json.loads(binding_file.read_text(encoding="utf-8"))
    logical_to_runtime_agent = {
        logical: runtime for runtime, logical in binding.get("agents", {}).items()
    }
    team_id = env["TEAM_ASSET_DEMO_TEAM_ID"]
    task_id = env["TEAM_ASSET_DEMO_TASK_ID"]
    agent_id = logical_to_runtime_agent["agent-new-backend"]
    headers = {
        "authorization": f"Bearer {user_key}",
        "x-conversation-id": session_id,
        "x-team-id": team_id,
        "x-agent-id": agent_id,
        "x-task-id": task_id,
    }
    user_message = {
        "role": "user",
        "content": "多租户功能开关读取接口在 Redis 异常时超时和 5xx，请实施最小安全修复并验证。",
    }
    first = _post(
        proxy_url,
        headers,
        {"model": "deepseek-v4-flash", "stream": False, "messages": [user_message]},
    )
    declarations = "\n".join(
        "<team_asset_use>"
        + json.dumps(
            {"asset_id": asset_id, "decision": decision, "target": target},
            ensure_ascii=False,
            separators=(",", ":"),
        )
        + "</team_asset_use>"
        for asset_id, decision, target in ASSET_USES
    )
    assistant = {
        "role": "assistant",
        "content": declarations,
        "tool_calls": [
            {
                "id": "call-edit-feature-flag",
                "type": "function",
                "function": {
                    "name": "apply_patch",
                    "arguments": json.dumps(
                        {"path": "feature_flags/service.py", "patch": "最小安全降级修改"},
                        ensure_ascii=False,
                    ),
                },
            },
            {
                "id": "call-test-regression",
                "type": "function",
                "function": {
                    "name": "shell",
                    "arguments": json.dumps(
                        {
                            "command": (
                                "python -m pytest -q tests hidden_tests # "
                                + " ".join(ACCEPTANCE_TESTS)
                            )
                        },
                        ensure_ascii=False,
                    ),
                },
            },
        ],
    }
    second = _post(
        proxy_url,
        headers,
        {
            "model": "deepseek-v4-flash",
            "stream": False,
            "messages": [
                user_message,
                assistant,
                {"role": "tool", "tool_call_id": "call-edit-feature-flag", "content": "修改已应用"},
                {
                    "role": "tool",
                    "tool_call_id": "call-test-regression",
                    "content": "9 passed; " + "; ".join(f"{name} PASSED" for name in ACCEPTANCE_TESTS),
                },
            ],
        },
    )
    trace_id = "trace-team-assets-" + hashlib.sha256(
        f"{session_id}\0{task_id}".encode("utf-8")
    ).hexdigest()[:20]
    service_token = token_file.read_text(encoding="utf-8").strip()
    receipt = _get(
        orchestrator_url.rstrip("/") + "/v1/receipt",
        {"authorization": f"Bearer {service_token}"},
        {"trace_id": trace_id},
    )
    return {
        "proxy_http_responses": [bool(first.get("choices")), bool(second.get("choices"))],
        "trace_id": trace_id,
        "team_id": team_id,
        "task_id": task_id,
        "agent_id": agent_id,
        "asset_count": len(ASSET_USES),
        "evidence_summary": receipt.get("summary", {}),
        "completion": receipt.get("completion", {}),
        "comparison": receipt.get("comparison", {}),
        "runtime": receipt.get("runtime", {}),
        "manual_contribution_called": False,
        "credentials_recorded": False,
        "request_body_recorded": False,
    }


def main() -> None:
    root = project_root()
    parser = argparse.ArgumentParser(description="Run a no-external-data CodeBuddy/Proxy evidence smoke.")
    parser.add_argument("--proxy-url", default="http://127.0.0.1:8096/codebuddy/default/v1/chat/completions")
    parser.add_argument("--orchestrator-url", default="http://127.0.0.1:8765")
    parser.add_argument("--env-file", type=Path, default=root / "runtime/new_asset_test_01.env")
    parser.add_argument("--binding-file", type=Path, default=root / "runtime/new_asset_test_01-binding.json")
    parser.add_argument("--token-file", type=Path, default=root / "runtime/orchestrator.token")
    parser.add_argument("--session-id", default="codebuddy-team-assets-auto-evidence-v1")
    args = parser.parse_args()
    result = run(
        proxy_url=args.proxy_url,
        orchestrator_url=args.orchestrator_url,
        env_file=args.env_file,
        binding_file=args.binding_file,
        token_file=args.token_file,
        session_id=args.session_id,
    )
    output = root / "results/new_asset_test_01-automatic-evidence.json"
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("CodeBuddy → Proxy 自动证据验收完成（凭据与请求正文均未记录）")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
