from __future__ import annotations

import json
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Tuple

from .evidence import RunEvidence
from .models import ContextPackage
from .openai_provider import OpenAICompatibleProvider
from .runner import ReferenceCodingAgent


ASSET_USE_RE = re.compile(r"<team_asset_use>\s*(\{[\s\S]*?\})\s*</team_asset_use>")


TOOLS: List[Dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "读取当前 Python 项目中的文件；隐藏测试不可读取。",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_code",
            "description": "在当前 Python 项目中搜索文本；隐藏测试不可读取。",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "写入项目文件的完整新内容。只能修改当前工作区，不能修改隐藏测试。",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"},
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_visible_tests",
            "description": "运行开发阶段可见的 pytest 测试。隐藏测试由独立验证器在任务结束后执行。",
            "parameters": {"type": "object", "properties": {}},
        },
    },
]


@dataclass
class LiveAgentResult:
    evidence: RunEvidence
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    model_turns: int


class OpenAIToolCodingAgent:
    """Small, repeatable coding loop for real-model counterfactual evaluation.

    It intentionally exposes only four workspace-scoped tools and withholds
    hidden tests. This is the formal evaluation runner; interactive CodeBuddy
    uses the same asset context and is observed by MemoryProxy separately.
    """

    def __init__(self, provider: OpenAICompatibleProvider, max_turns: int = 12) -> None:
        self.provider = provider
        self.max_turns = max_turns

    def execute(self, package: ContextPackage, workspace: Path) -> LiveAgentResult:
        started = time.perf_counter()
        messages: List[Dict[str, Any]] = [
            {
                "role": "system",
                "content": (
                    "你是团队的新成员后端工程师。请先检查代码，再实施最小安全修复。"
                    "不要读取隐藏测试，不要修改测试来绕过问题。真实采用团队资产后，必须输出其"
                    "<team_asset_use> JSON 声明；没有影响实际操作的资产不要声明。\n\n"
                    + (package.markdown or "本组实验不提供团队资产。")
                ),
            },
            {"role": "user", "content": package.task.description},
        ]
        changed_paths: List[str] = []
        tool_log: List[str] = []
        decisions: Dict[str, str] = {}
        targets: Dict[str, str] = {}
        prompt_tokens = completion_tokens = total_tokens = 0
        model_turns = 0

        for _ in range(self.max_turns):
            completion = self.provider.chat(messages, tools=TOOLS)
            model_turns += 1
            prompt_tokens += completion.usage.get("prompt_tokens", 0)
            completion_tokens += completion.usage.get("completion_tokens", 0)
            total_tokens += completion.usage.get("total_tokens", 0)
            assistant = dict(completion.message)
            messages.append(assistant)
            content = str(assistant.get("content") or "")
            self._capture_declarations(content, package, decisions, targets)
            calls = assistant.get("tool_calls") or []
            if not isinstance(calls, list) or not calls:
                break
            for call in calls:
                if not isinstance(call, dict):
                    continue
                call_id = str(call.get("id") or f"call-{len(tool_log) + 1}")
                fn = call.get("function") or {}
                name = str(fn.get("name") or "")
                try:
                    args = json.loads(str(fn.get("arguments") or "{}"))
                except json.JSONDecodeError:
                    args = {}
                output, changed, log_entry = self._execute_tool(workspace, name, args)
                if changed and changed not in changed_paths:
                    changed_paths.append(changed)
                tool_log.append(log_entry)
                messages.append({"role": "tool", "tool_call_id": call_id, "content": output[:12000]})

        tests, _ = ReferenceCodingAgent._run_independent_tests(workspace)
        for test in tests:
            test.output_ref = "independent-validator:pytest-visible+hidden"
        evidence = RunEvidence(
            trace_id=package.trace_id,
            task_id=package.task.task_id,
            changed_paths=changed_paths,
            decisions=decisions,
            asset_targets=targets,
            tests=tests,
            tool_calls=tool_log,
            attempts=sum(1 for item in tool_log if item.startswith("write:")),
            duration_ms=int((time.perf_counter() - started) * 1000),
        )
        return LiveAgentResult(
            evidence=evidence,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=total_tokens or prompt_tokens + completion_tokens,
            model_turns=model_turns,
        )

    @staticmethod
    def _capture_declarations(
        content: str,
        package: ContextPackage,
        decisions: Dict[str, str],
        targets: Dict[str, str],
    ) -> None:
        selected = {item.asset.asset_id for item in package.selected}
        for match in ASSET_USE_RE.finditer(content):
            try:
                value = json.loads(match.group(1))
            except json.JSONDecodeError:
                continue
            asset_id = str(value.get("asset_id", ""))
            decision = str(value.get("decision", "")).strip()
            target = str(value.get("target", "")).strip()
            if asset_id in selected and decision and target:
                decisions[asset_id] = decision
                targets[asset_id] = target

    def _execute_tool(
        self,
        workspace: Path,
        name: str,
        args: Dict[str, Any],
    ) -> Tuple[str, str, str]:
        try:
            if name == "read_file":
                path = self._safe_path(workspace, str(args.get("path", "")), write=False)
                return path.read_text(encoding="utf-8"), "", f"read:{path.relative_to(workspace.resolve())}"
            if name == "search_code":
                query = str(args.get("query", ""))
                matches = []
                for path in sorted(workspace.rglob("*.py")):
                    if "hidden_tests" in path.parts:
                        continue
                    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                        if query.lower() in line.lower():
                            matches.append(f"{path.relative_to(workspace)}:{line_no}:{line}")
                return "\n".join(matches[:200]), "", f"search:{query[:100]}"
            if name == "write_file":
                path = self._safe_path(workspace, str(args.get("path", "")), write=True)
                content = str(args.get("content", ""))
                path.write_text(content, encoding="utf-8")
                relative = str(path.relative_to(workspace.resolve()))
                return f"已写入 {relative}", relative, f"write:{relative}"
            if name == "run_visible_tests":
                result = subprocess.run(
                    [sys.executable, "-m", "pytest", "-q", "tests"],
                    cwd=workspace,
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    check=False,
                    timeout=60,
                )
                return f"exit_code={result.returncode}\n{result.stdout}", "", "pytest:visible"
            return f"不支持的工具：{name}", "", f"unsupported:{name}"
        except Exception as exc:
            return f"工具执行失败：{type(exc).__name__}: {exc}", "", f"error:{name}"

    @staticmethod
    def _safe_path(workspace: Path, raw: str, *, write: bool) -> Path:
        candidate = (workspace / raw).resolve()
        root = workspace.resolve()
        if candidate != root and root not in candidate.parents:
            raise ValueError("路径越出工作区")
        relative = candidate.relative_to(root)
        if "hidden_tests" in relative.parts:
            raise ValueError("隐藏测试不可读取或修改")
        if write and relative.parts and relative.parts[0] == "tests":
            raise ValueError("评测期间禁止修改测试")
        if candidate.is_dir():
            raise ValueError("需要文件路径")
        return candidate
