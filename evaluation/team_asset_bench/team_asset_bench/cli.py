from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from .catalog import load_assets, load_task, project_root, write_catalog
from .ledger import EvidenceLedger
from .orchestrator import TeamAssetOrchestrator
from .report import write_reports
from .runner import run_matrix
from .server import serve
from .live_eval import run_real_model_matrix
from .verification_discovery import discover_verification_plan
from .multi_turn_eval import run_multi_turn_real_model_evaluation
from .benchmark_suite import load_benchmark_suite
from .suite_eval import run_real_model_suite
from .suite_report import load_summary, write_suite_reports


def main() -> None:
    parser = argparse.ArgumentParser(description="Evidence-first team asset benchmark and orchestrator")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("ingest", help="Validate raw sources and build the normalized asset catalog")
    select = sub.add_parser("select", help="Print the minimal context package for the golden task")
    select.add_argument("--strategy", choices=["none", "minimal", "full"], default="minimal")
    sub.add_parser("evaluate", help="Run the reference seven-arm counterfactual matrix and reports")
    live = sub.add_parser("evaluate-live", help="Run repeated real-model counterfactual evaluation")
    live.add_argument("--repetitions", type=int, default=None)
    sub.add_parser("suite-status", help="Validate the multi-repository benchmark manifest and show coverage")
    suite_live = sub.add_parser(
        "evaluate-suite-live",
        help="Run the resumable multi-repository seven-arm real-model evaluation",
    )
    suite_live.add_argument("--repetitions", type=int, default=None)
    suite_live.add_argument("--concurrency", type=int, default=None)
    suite_live.add_argument("--max-retries", type=int, default=None)
    suite_live.add_argument("--max-runs", type=int, default=None)
    suite_live.add_argument("--task-id", action="append", default=[])
    suite_live.add_argument("--fresh", action="store_true", help="Ignore successful checkpoints and rerun")
    suite_report = sub.add_parser("report-suite", help="Regenerate the formal report and resume copy")
    suite_report.add_argument(
        "--summary",
        default="results/suite_live/evaluation-summary.json",
    )
    multi_turn = sub.add_parser("evaluate-multi-turn-live", help="运行真实模型逐轮推荐与反馈评测")
    multi_turn.add_argument("--repetitions", type=int, default=3)
    discover = sub.add_parser("discover-verification", help="从代码仓库自动发现测试与 CI 配置")
    discover.add_argument("--workspace", required=True)
    discover.add_argument("--changed-path", action="append", default=[])
    discover.add_argument("--acceptance-criterion", action="append", default=[])
    server = sub.add_parser("serve", help="Start the local orchestrator HTTP API")
    server.add_argument("--host", default=None)
    server.add_argument("--port", type=int, default=None)
    server.add_argument("--hub-env", default="", help="Memory Hub business identity env file")
    server.add_argument("--bindings-file", default="", help="Runtime-to-logical ID binding file")
    server.add_argument("--local-ci-auto", action="store_true", help="After observed edits/tests, run the independent local verifier")
    server.add_argument("--local-ci-allowed-root", action="append", default=[], help="Explicit repository root allowed for local CI; repeatable")
    server.add_argument("--local-ci-discover", action="store_true", help="Discover repository-owned tests for local CI")
    args = parser.parse_args()

    root = project_root()
    if args.command == "ingest":
        catalog, audit = write_catalog(root)
        print(json.dumps({"catalog": str(catalog), "audit": str(audit)}, ensure_ascii=False))
    elif args.command == "select":
        write_catalog(root)
        package = TeamAssetOrchestrator(load_assets(root), EvidenceLedger()).select(
            load_task(root), strategy=args.strategy
        )
        print(json.dumps(package.to_dict(), ensure_ascii=False, indent=2))
    elif args.command == "evaluate":
        summary = run_matrix(root)
        write_reports(summary, root / "results")
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    elif args.command == "evaluate-live":
        summary = run_real_model_matrix(root, repetitions=args.repetitions)
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    elif args.command == "suite-status":
        print(json.dumps(load_benchmark_suite(root).status(), ensure_ascii=False, indent=2))
    elif args.command == "evaluate-suite-live":
        summary = run_real_model_suite(
            root,
            repetitions=args.repetitions,
            concurrency=args.concurrency,
            resume=not args.fresh,
            max_retries=args.max_retries,
            max_runs=args.max_runs,
            task_ids=args.task_id,
        )
        report_paths = write_suite_reports(summary, root / "results" / "suite_live")
        print(
            json.dumps(
                {
                    "matrix": summary["matrix"],
                    "resume_ready": summary["resume_ready"],
                    "summary": str(root / "results" / "suite_live" / "evaluation-summary.json"),
                    "reports": report_paths,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    elif args.command == "report-suite":
        summary_path = Path(args.summary)
        if not summary_path.is_absolute():
            summary_path = root / summary_path
        summary = load_summary(summary_path)
        print(
            json.dumps(
                write_suite_reports(summary, summary_path.parent),
                ensure_ascii=False,
                indent=2,
            )
        )
    elif args.command == "evaluate-multi-turn-live":
        summary = run_multi_turn_real_model_evaluation(root, repetitions=args.repetitions)
        print(json.dumps({
            "schema_version": summary["schema_version"],
            "model": summary["model"],
            "repetitions": summary["repetitions"],
            "aggregates": summary["aggregates"],
            "comparisons": summary["comparisons"],
        }, ensure_ascii=False, indent=2))
    elif args.command == "discover-verification":
        plan = discover_verification_plan(
            Path(args.workspace),
            changed_paths=args.changed_path,
            acceptance_criteria=args.acceptance_criterion,
        )
        print(json.dumps(plan.to_dict(), ensure_ascii=False, indent=2))
    elif args.command == "serve":
        if args.hub_env:
            os.environ["TEAM_ASSET_HUB_ENV"] = args.hub_env
        if args.bindings_file:
            os.environ["TEAM_ASSET_BINDINGS_FILE"] = args.bindings_file
        if args.local_ci_auto:
            if not args.local_ci_allowed_root:
                parser.error("--local-ci-auto requires at least one --local-ci-allowed-root")
            os.environ["TEAM_ASSET_LOCAL_CI_AUTO"] = "1"
            os.environ["TEAM_ASSET_LOCAL_CI_ALLOWED_ROOTS"] = ",".join(args.local_ci_allowed_root)
        if args.local_ci_discover:
            os.environ["TEAM_ASSET_LOCAL_CI_DISCOVER"] = "1"
        serve(args.host, args.port)


if __name__ == "__main__":
    main()
