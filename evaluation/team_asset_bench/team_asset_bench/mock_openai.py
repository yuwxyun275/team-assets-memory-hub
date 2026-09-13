from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List

from .catalog import project_root


ASSET_ID_RE = re.compile(r"\[asset:([^\]]+)\]")


def _message_text(message: Dict[str, Any]) -> str:
    content = message.get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(str(item.get("text", "")) for item in content if isinstance(item, dict))
    return ""


def make_handler(audit_path: Path, api_key: str):
    class Handler(BaseHTTPRequestHandler):
        server_version = "TeamAssetLocalOpenAIMock/1.0"

        def do_GET(self) -> None:  # noqa: N802
            if not self._authorized():
                return
            if self.path.rstrip("/").endswith("/models"):
                self._json(HTTPStatus.OK, {"object": "list", "data": [{"id": "local-team-assets-smoke"}]})
                return
            self._json(HTTPStatus.NOT_FOUND, {"error": {"type": "not_found"}})

        def do_POST(self) -> None:  # noqa: N802
            if not self._authorized():
                return
            if not self.path.rstrip("/").endswith("/chat/completions"):
                self._json(HTTPStatus.NOT_FOUND, {"error": {"type": "not_found"}})
                return
            payload = self._payload()
            texts: List[str] = [
                _message_text(message)
                for message in payload.get("messages", [])
                if isinstance(message, dict)
            ]
            prompt = "\n".join(texts)
            asset_ids = sorted(set(ASSET_ID_RE.findall(prompt)))
            audit = {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "protocol": "openai_chat_completions",
                "model": str(payload.get("model", "")),
                "message_count": len(texts),
                "team_assets_present": "<team_assets>" in prompt,
                "asset_ids": asset_ids,
                "asset_count": len(asset_ids),
                "prompt_sha256": hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
                "authorization_value_recorded": False,
                "request_body_recorded": False,
            }
            audit_path.parent.mkdir(parents=True, exist_ok=True)
            audit_path.write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            self._json(
                HTTPStatus.OK,
                {
                    "id": "chatcmpl-local-team-assets-smoke",
                    "object": "chat.completion",
                    "created": 0,
                    "model": str(payload.get("model", "local-team-assets-smoke")),
                    "choices": [
                        {
                            "index": 0,
                            "finish_reason": "stop",
                            "message": {
                                "role": "assistant",
                                "content": "LOCAL_SMOKE_OK: team asset context received by the upstream boundary.",
                            },
                        }
                    ],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                },
            )

        def log_message(self, format: str, *args: object) -> None:
            # Never log headers or bodies: the Proxy's client credential must
            # remain local to its authentication boundary.
            print(f"[local-openai-mock] {self.address_string()} {format % args}")

        def _payload(self) -> Dict[str, Any]:
            length = int(self.headers.get("content-length", "0"))
            if length > 4_000_000:
                raise ValueError("payload_too_large")
            value = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            if not isinstance(value, dict):
                raise ValueError("JSON object required")
            return value

        def _authorized(self) -> bool:
            if not api_key:
                return True
            if self.headers.get("authorization", "") != f"Bearer {api_key}":
                self._json(HTTPStatus.UNAUTHORIZED, {"error": {"type": "unauthorized"}})
                return False
            return True

        def _json(self, status: HTTPStatus, value: Dict[str, Any]) -> None:
            body = json.dumps(value, ensure_ascii=False).encode("utf-8")
            self.send_response(int(status))
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description="Local OpenAI-compatible sink for safe Proxy injection tests.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8770)
    parser.add_argument("--audit", type=Path, default=project_root() / "results/live-proxy-integration.json")
    parser.add_argument("--api-key-file", type=Path)
    args = parser.parse_args()
    api_key = args.api_key_file.read_text(encoding="utf-8").strip() if args.api_key_file else ""
    server = ThreadingHTTPServer((args.host, args.port), make_handler(args.audit, api_key))
    print(f"Local OpenAI mock listening on http://{args.host}:{args.port} (auth={'enabled' if api_key else 'disabled'})")
    server.serve_forever()


if __name__ == "__main__":
    main()
