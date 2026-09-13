from __future__ import annotations

import argparse
import json
from pathlib import Path
from urllib.request import Request, urlopen

from .ci_adapter import LocalCiRunner
from .verification_discovery import discover_verification_plan


def main() -> int:
    parser = argparse.ArgumentParser(description="运行可复现的本地 CI，并可将结果回传团队资产服务")
    parser.add_argument("--workspace", required=True, help="被验证的代码工作区")
    parser.add_argument("--before-workspace", default="", help="可选：修复前代码工作区，用同一组检查生成先失败后通过证据")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--manifest", help="JSON 流水线定义")
    source.add_argument("--discover", action="store_true", help="从仓库静态发现测试和 CI 配置")
    parser.add_argument("--trace-id", required=True, help="本轮团队资产 Trace")
    parser.add_argument("--turn-id", default="", help="可选的会话轮次 ID")
    parser.add_argument("--changed-path", action="append", default=[], help="本次真实修改路径，可重复")
    parser.add_argument("--acceptance-criterion", action="append", default=[], help="候选或已确认验收标准，可重复")
    parser.add_argument("--endpoint", default="", help="可选，团队资产服务地址")
    parser.add_argument("--service-token-file", default="", help="可选，服务令牌文件")
    parser.add_argument("--output", default="", help="可选，保存结构化 CI 结果")
    args = parser.parse_args()

    workspace = Path(args.workspace).expanduser()
    discovery = None
    if args.discover:
        discovery = discover_verification_plan(
            workspace,
            changed_paths=args.changed_path,
            acceptance_criteria=args.acceptance_criterion,
        )
        manifest = discovery.to_manifest()
    else:
        manifest_path = Path(str(args.manifest)).expanduser().resolve()
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(manifest, dict):
            raise ValueError("CI manifest must be a JSON object")
    if not manifest.get("checks"):
        raise ValueError("没有发现可安全执行的仓库测试；请检查测试配置或提供 reviewed manifest")
    runner = LocalCiRunner(workspace)
    if args.before_workspace:
        result = runner.run_before_after(
            manifest,
            before_workspace=Path(args.before_workspace).expanduser(),
            trace_id=args.trace_id,
            turn_id=args.turn_id,
            changed_paths=args.changed_path,
        )
    else:
        result = runner.run_manifest(
            manifest,
            trace_id=args.trace_id,
            turn_id=args.turn_id,
            changed_paths=args.changed_path,
        )
    if discovery is not None:
        result["verification_discovery"] = discovery.to_dict()
    rendered = json.dumps(result, ensure_ascii=False, indent=2)
    print(rendered)
    if args.output:
        Path(args.output).expanduser().write_text(rendered + "\n", encoding="utf-8")
    if args.endpoint:
        token = ""
        if args.service_token_file:
            token = Path(args.service_token_file).expanduser().read_text(encoding="utf-8").strip()
        request = Request(
            f"{args.endpoint.rstrip('/')}/v2/ci/runs",
            data=json.dumps(result, ensure_ascii=False).encode("utf-8"),
            method="POST",
            headers={
                "content-type": "application/json",
                **({"authorization": f"Bearer {token}"} if token else {}),
            },
        )
        with urlopen(request, timeout=10) as response:
            print(response.read().decode("utf-8"))
    regression = result.get("regression_proof") or {}
    complete = result["status"] == "passed" and (
        not args.before_workspace or regression.get("confirmed") is True
    )
    return 0 if complete else 1


if __name__ == "__main__":
    raise SystemExit(main())
