from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass(frozen=True)
class OpenAICompatibleConfig:
    base_url: str
    model: str
    api_key: str
    timeout_seconds: int = 180
    temperature: float = 0.0
    seed: Optional[int] = None

    @classmethod
    def from_env(cls) -> "OpenAICompatibleConfig":
        raw_seed = os.environ.get("TEAM_ASSET_OPENAI_SEED", "").strip()
        return cls(
            base_url=os.environ.get("TEAM_ASSET_OPENAI_BASE_URL", "http://127.0.0.1:8096/codebuddy/default"),
            model=os.environ.get("TEAM_ASSET_OPENAI_MODEL", ""),
            api_key=os.environ.get("TEAM_ASSET_OPENAI_API_KEY", ""),
            timeout_seconds=int(os.environ.get("TEAM_ASSET_OPENAI_TIMEOUT", "180")),
            temperature=float(os.environ.get("TEAM_ASSET_OPENAI_TEMPERATURE", "0")),
            seed=int(raw_seed) if raw_seed else None,
        )


@dataclass
class ChatCompletionResult:
    message: Dict[str, Any]
    usage: Dict[str, int] = field(default_factory=dict)
    model: str = ""


class OpenAICompatibleProvider:
    """Vendor-neutral Chat Completions client; credentials are never logged."""

    def __init__(self, config: OpenAICompatibleConfig) -> None:
        if not config.model:
            raise ValueError("TEAM_ASSET_OPENAI_MODEL is required")
        if not config.api_key:
            raise ValueError("TEAM_ASSET_OPENAI_API_KEY is required")
        self.config = config

    def complete(self, messages: List[Dict[str, str]], *, extra_headers: Optional[Dict[str, str]] = None) -> str:
        result = self.chat(messages, extra_headers=extra_headers)
        return str(result.message.get("content") or "")

    def chat(
        self,
        messages: List[Dict[str, Any]],
        *,
        tools: Optional[List[Dict[str, Any]]] = None,
        extra_headers: Optional[Dict[str, str]] = None,
    ) -> ChatCompletionResult:
        url = self.config.base_url.rstrip("/")
        if not url.endswith("/v1/chat/completions"):
            url += "/v1/chat/completions"
        payload: Dict[str, Any] = {
            "model": self.config.model,
            "stream": False,
            "messages": messages,
            "temperature": self.config.temperature,
        }
        if self.config.seed is not None:
            payload["seed"] = self.config.seed
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = {
            "authorization": f"Bearer {self.config.api_key}",
            "content-type": "application/json",
            "user-agent": "TeamAssetBench/1.0",
            **(extra_headers or {}),
        }
        request = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=self.config.timeout_seconds) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            # Do not include request headers/body because they contain the key.
            raise RuntimeError(f"OpenAI-compatible endpoint returned HTTP {exc.code}") from exc
        message = payload["choices"][0]["message"]
        usage = payload.get("usage") or {}
        return ChatCompletionResult(
            message=message if isinstance(message, dict) else {"content": str(message)},
            usage={
                key: int(value)
                for key, value in usage.items()
                if isinstance(value, (int, float))
            },
            model=str(payload.get("model") or self.config.model),
        )
