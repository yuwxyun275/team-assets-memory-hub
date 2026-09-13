from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
import time
import uuid
from concurrent.futures import Future, ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence

from .benchmark_suite import (
    SUITE_ARMS,
    BenchmarkSuite,
    SuiteArm,
    TaskSpec,
    fixture_fingerprint,
    load_benchmark_suite,
)
from .catalog import load_assets, project_root, write_catalog
from .evidence import EvidenceValidator, test_pass_rate
from .ledger import EvidenceLedger
from .live_agent import LiveAgentResult, OpenAIToolCodingAgent
from .models import Asset, ContextPackage
from .openai_provider import OpenAICompatibleConfig, OpenAICompatibleProvider
from .orchestrator import TeamAssetOrchestrator
from .receipt import build_receipt, write_receipt_html, write_receipt_json
from .suite_statistics import (
    aggregate_arm,
    compare_arms,
    comparison_confidence_intervals,
)


RUN_SCHEMA_VERSION = "team-asset-suite-run/v1"
SUMMARY_SCHEMA_VERSION = "team-asset-suite-evaluation/v1"
SAFE_ID_RE = re.compile(r"[^a-zA-Z0-9_.-]+")
RunExecutor = Callable[[ContextPackage, Path], LiveAgentResult]


@dataclass(frozen=True)
class RunRequest:
    task_spec: TaskSpec
    arm: SuiteArm
    repetition: int

    @property
    def run_id(self) -> str:
        raw = f"{self.task_spec.task.task_id}--{self.arm.name}--r{self.repetition:02d}"
        return SAFE_ID_RE.sub("-", raw).strip("-")


class RunStore:
    def __init__(self, result_root: Path) -> None:
        self.result_root = result_root
        self.runs_root = result_root / "runs"
        self.runs_root.mkdir(parents=True, exist_ok=True)

    def run_dir(self, run_id: str) -> Path:
        return self.runs_root / run_id

    def run_path(self, run_id: str) -> Path:
        return self.run_dir(run_id) / "run.json"

    def load(self, run_id: str) -> Optional[Dict[str, Any]]:
        path = self.run_path(run_id)
        if not path.is_file():
            return None
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if value.get("schema_version") != RUN_SCHEMA_VERSION or value.get("run_id") != run_id:
            return None
        return value

    def write(self, record: Mapping[str, Any]) -> Path:
        run_id = str(record["run_id"])
        run_dir = self.run_dir(run_id)
        run_dir.mkdir(parents=True, exist_ok=True)
        destination = self.run_path(run_id)
        temporary = run_dir / f"run.{uuid.uuid4().hex}.tmp"
        temporary.write_text(
            json.dumps(record, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        temporary.replace(destination)
        return destination


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _copy_task_workspace(task_spec: TaskSpec) -> tempfile.TemporaryDirectory[str]:
    temporary = tempfile.TemporaryDirectory(prefix=f"team-asset-{task_spec.bundle_name}-")
    workspace = Path(temporary.name)
    shutil.copytree(task_spec.repository.fixture, workspace, dirs_exist_ok=True)
    shutil.copytree(task_spec.bundle_dir / "hidden_tests", workspace / "hidden_tests", dirs_exist_ok=True)
    return temporary


def _excluded_asset_ids(assets: Sequence[Asset], task_spec: TaskSpec, arm: SuiteArm) -> List[str]:
    excluded_sources = set(arm.excluded_source_types)
    return sorted(
        asset.asset_id
        for asset in assets
        if asset.team_id == task_spec.task.team_id and asset.source_type in excluded_sources
    )


def _run_once(
    request: RunRequest,
    assets: Sequence[Asset],
    executor: RunExecutor,
    store: RunStore,
    fixture_hash: str,
    experiment_fingerprint: str,
) -> Dict[str, Any]:
    started_at = _utc_now()
    wall_started = time.perf_counter()
    ledger = EvidenceLedger()
    excluded_asset_ids = _excluded_asset_ids(assets, request.task_spec, request.arm)
    package = TeamAssetOrchestrator(assets, ledger).select(
        request.task_spec.task,
        strategy=request.arm.strategy,
        excluded_asset_ids=excluded_asset_ids,
        trace_id=f"trace-{request.run_id}",
    )
    EvidenceValidator(ledger).confirm_injected(
        package,
        actor_id="openai-compatible-suite-harness",
        evidence_ref=f"prompt-sha256:{hashlib.sha256(package.markdown.encode('utf-8')).hexdigest()}",
        detail={"injection_point": "live_agent.system", "run_id": request.run_id},
    )
    temporary = _copy_task_workspace(request.task_spec)
    try:
        live = executor(package, Path(temporary.name))
    finally:
        temporary.cleanup()
    validated = EvidenceValidator(ledger).validate(package, live.evidence)
    selected_source_types = sorted({item.asset.source_type.value for item in package.selected})
    record: Dict[str, Any] = {
        "schema_version": RUN_SCHEMA_VERSION,
        "run_id": request.run_id,
        "experiment_fingerprint": experiment_fingerprint,
        "status": "completed",
        "started_at": started_at,
        "finished_at": _utc_now(),
        "wall_duration_ms": int((time.perf_counter() - wall_started) * 1000),
        "task_id": request.task_spec.task.task_id,
        "task_title": request.task_spec.task.title,
        "repository": request.task_spec.task.repository,
        "repository_fixture_sha256": fixture_hash,
        "scenario_type": request.task_spec.scenario_type,
        "arm": request.arm.name,
        "strategy": request.arm.strategy,
        "repetition": request.repetition,
        "trace_id": package.trace_id,
        "excluded_source_types": [item.value for item in request.arm.excluded_source_types],
        "excluded_asset_ids": excluded_asset_ids,
        "selected_asset_ids": [item.asset.asset_id for item in package.selected],
        "selected_source_types": selected_source_types,
        "asset_token_cost": package.token_cost,
        "tests_total": len(live.evidence.tests),
        "tests_passed": sum(1 for test in live.evidence.tests if test.passed),
        "test_pass_rate": test_pass_rate(live.evidence.tests),
        "task_completed": live.evidence.passed,
        "validated_asset_ids": validated,
        "changed_paths": list(live.evidence.changed_paths),
        "tool_calls": len(live.evidence.tool_calls),
        "attempts": live.evidence.attempts,
        "duration_ms": live.evidence.duration_ms,
        "prompt_tokens": live.prompt_tokens,
        "completion_tokens": live.completion_tokens,
        "total_tokens": live.total_tokens,
        "model_turns": live.model_turns,
    }
    run_dir = store.run_dir(request.run_id)
    receipt = build_receipt(
        package,
        ledger,
        live.evidence,
        arm=f"{request.arm.name}/{request.task_spec.task.task_id}/r{request.repetition}",
    )
    write_receipt_json(receipt, run_dir / "asset-receipt.json")
    write_receipt_html(receipt, run_dir / "asset-receipt.html")
    store.write(record)
    return record


def _run_with_retries(
    request: RunRequest,
    assets: Sequence[Asset],
    executor: RunExecutor,
    store: RunStore,
    fixture_hash: str,
    experiment_fingerprint: str,
    max_retries: int,
) -> Dict[str, Any]:
    started_at = _utc_now()
    last_error: Optional[Exception] = None
    for attempt in range(1, max_retries + 2):
        try:
            record = _run_once(
                request,
                assets,
                executor,
                store,
                fixture_hash,
                experiment_fingerprint,
            )
            record["infrastructure_attempt"] = attempt
            store.write(record)
            return record
        except Exception as exc:
            last_error = exc
    record = {
        "schema_version": RUN_SCHEMA_VERSION,
        "run_id": request.run_id,
        "experiment_fingerprint": experiment_fingerprint,
        "status": "infrastructure_error",
        "started_at": started_at,
        "finished_at": _utc_now(),
        "task_id": request.task_spec.task.task_id,
        "task_title": request.task_spec.task.title,
        "repository": request.task_spec.task.repository,
        "repository_fixture_sha256": fixture_hash,
        "scenario_type": request.task_spec.scenario_type,
        "arm": request.arm.name,
        "strategy": request.arm.strategy,
        "repetition": request.repetition,
        "infrastructure_attempt": max_retries + 1,
        "error_type": type(last_error).__name__ if last_error else "UnknownError",
        "error": str(last_error)[:1000] if last_error else "unknown infrastructure error",
    }
    store.write(record)
    return record


def build_run_requests(
    suite: BenchmarkSuite,
    *,
    repetitions: int,
    task_ids: Optional[Iterable[str]] = None,
) -> List[RunRequest]:
    selected_ids = set(task_ids or [])
    if selected_ids:
        known_ids = {item.task.task_id for item in suite.tasks}
        missing = selected_ids - known_ids
        if missing:
            raise ValueError(f"unknown task ids: {sorted(missing)}")
    tasks = [item for item in suite.tasks if not selected_ids or item.task.task_id in selected_ids]
    return [
        RunRequest(task_spec=task_spec, arm=arm, repetition=repetition)
        for task_spec in tasks
        for arm in SUITE_ARMS
        for repetition in range(1, repetitions + 1)
    ]


def run_suite_matrix(
    suite: BenchmarkSuite,
    assets: Sequence[Asset],
    executor_factory: Callable[[], RunExecutor],
    *,
    repetitions: int,
    concurrency: int = 1,
    resume: bool = True,
    max_retries: int = 1,
    max_runs: Optional[int] = None,
    task_ids: Optional[Iterable[str]] = None,
    result_root: Optional[Path] = None,
    model_metadata: Optional[Mapping[str, Any]] = None,
    bootstrap_iterations: int = 2000,
) -> Dict[str, Any]:
    if repetitions < 1:
        raise ValueError("repetitions must be at least 1")
    if concurrency < 1:
        raise ValueError("concurrency must be at least 1")
    if max_retries < 0:
        raise ValueError("max_retries cannot be negative")
    output_root = result_root or suite.root / "results" / "suite_live"
    store = RunStore(output_root)
    requests = build_run_requests(suite, repetitions=repetitions, task_ids=task_ids)
    requested_run_count = len(requests)
    fingerprints = {
        task.task.task_id: fixture_fingerprint(
            [task.repository.fixture, task.bundle_dir / "hidden_tests"]
        )
        for task in suite.tasks
    }
    experiment_fingerprint = _experiment_fingerprint(
        suite,
        assets,
        fingerprints,
        dict(model_metadata or {}),
    )
    existing: Dict[str, Dict[str, Any]] = {}
    pending: List[RunRequest] = []
    for request in requests:
        record = store.load(request.run_id) if resume else None
        if (
            record
            and record.get("status") == "completed"
            and record.get("experiment_fingerprint") == experiment_fingerprint
        ):
            existing[request.run_id] = record
        else:
            pending.append(request)
    if max_runs is not None:
        if max_runs < 0:
            raise ValueError("max_runs cannot be negative")
        pending = pending[:max_runs]

    produced: Dict[str, Dict[str, Any]] = {}
    if concurrency == 1:
        executor = executor_factory()
        for request in pending:
            produced[request.run_id] = _run_with_retries(
                request,
                assets,
                executor,
                store,
                fingerprints[request.task_spec.task.task_id],
                experiment_fingerprint,
                max_retries,
            )
    else:
        with ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix="team-asset-bench") as pool:
            futures: Dict[Future[Dict[str, Any]], RunRequest] = {}
            for request in pending:
                executor = executor_factory()
                future = pool.submit(
                    _run_with_retries,
                    request,
                    assets,
                    executor,
                    store,
                    fingerprints[request.task_spec.task.task_id],
                    experiment_fingerprint,
                    max_retries,
                )
                futures[future] = request
            for future in as_completed(futures):
                request = futures[future]
                produced[request.run_id] = future.result()

    records: List[Dict[str, Any]] = []
    for request in requests:
        record = produced.get(request.run_id) or existing.get(request.run_id)
        if record is None and resume:
            stored = store.load(request.run_id)
            if stored and stored.get("experiment_fingerprint") == experiment_fingerprint:
                record = stored
        if record is not None:
            records.append(record)
    summary = build_suite_summary(
        suite,
        records,
        repetitions=repetitions,
        requested_run_count=requested_run_count,
        selected_task_ids=sorted(set(task_ids or [])),
        model_metadata=dict(model_metadata or {}),
        experiment_fingerprint=experiment_fingerprint,
        bootstrap_iterations=bootstrap_iterations,
    )
    _write_json_atomic(output_root / "evaluation-summary.json", summary)
    return summary


def build_suite_summary(
    suite: BenchmarkSuite,
    records: Sequence[Mapping[str, Any]],
    *,
    repetitions: int,
    requested_run_count: int,
    selected_task_ids: Sequence[str],
    model_metadata: Mapping[str, Any],
    experiment_fingerprint: str = "",
    bootstrap_iterations: int = 2000,
) -> Dict[str, Any]:
    by_arm: Dict[str, List[Mapping[str, Any]]] = {arm.name: [] for arm in SUITE_ARMS}
    for item in records:
        arm = str(item.get("arm"))
        if arm in by_arm:
            by_arm[arm].append(item)
    aggregates = {name: aggregate_arm(values) for name, values in by_arm.items()}

    comparisons: Dict[str, Any] = {}
    pairs = {
        "minimal_vs_no_assets": ("minimal_team_assets", "no_assets"),
        "minimal_vs_full_context": ("minimal_team_assets", "full_context"),
    }
    for name, (after_name, before_name) in pairs.items():
        comparison = compare_arms(aggregates[after_name], aggregates[before_name])
        comparison["paired_task_bootstrap_ci95"] = comparison_confidence_intervals(
            by_arm[after_name],
            by_arm[before_name],
            iterations=bootstrap_iterations,
        )
        comparisons[name] = comparison

    ablation_names = {
        "wiki": "without_wiki",
        "chat_memory": "without_chat_memory",
        "code_graph": "without_code_graph",
        "skill": "without_skill",
    }
    contributions: Dict[str, Any] = {}
    for source_type, ablation_name in ablation_names.items():
        comparison = compare_arms(
            aggregates["minimal_team_assets"], aggregates[ablation_name]
        )
        comparison["paired_task_bootstrap_ci95"] = comparison_confidence_intervals(
            by_arm["minimal_team_assets"],
            by_arm[ablation_name],
            iterations=bootstrap_iterations,
        )
        contributions[source_type] = comparison
    comparisons["asset_source_ablations"] = contributions

    valid_runs = sum(1 for item in records if item.get("status") == "completed")
    infrastructure_failures = sum(1 for item in records if item.get("status") != "completed")
    status = suite.status()
    used_task_ids = {str(item.get("task_id")) for item in records}
    complete_matrix = len(records) == requested_run_count and valid_runs == requested_run_count
    completed_records = [item for item in records if item.get("status") == "completed"]
    data_quality = {
        "hidden_tests_recorded_for_every_run": bool(completed_records)
        and all(int(item.get("tests_total", 0)) > 0 for item in completed_records),
        "input_token_usage_recorded_for_every_run": bool(completed_records)
        and all(int(item.get("prompt_tokens", 0)) > 0 for item in completed_records),
        "duration_recorded_for_every_run": bool(completed_records)
        and all(float(item.get("duration_ms", 0)) > 0 for item in completed_records),
        "balanced_arm_sample_sizes": len(
            {aggregate["valid_runs"] for aggregate in aggregates.values()}
        ) == 1,
    }
    data_quality["ready"] = all(data_quality.values())
    target_scope = (
        status["coverage_ready"]
        and repetitions == suite.targets["repetitions"]
        and not selected_task_ids
        and used_task_ids == {item.task.task_id for item in suite.tasks}
    )
    return {
        "schema_version": SUMMARY_SCHEMA_VERSION,
        "experiment_fingerprint": experiment_fingerprint,
        "generated_at": _utc_now(),
        "benchmark": suite.name,
        "mode": "real-openai-compatible-tool-agent",
        "dataset_provenance": suite.dataset_provenance,
        "task_noun": suite.task_noun,
        "model": dict(model_metadata),
        "matrix": {
            "repositories": len({str(item.get("repository")) for item in records}),
            "scenario_types": len({str(item.get("scenario_type")) for item in records}),
            "tasks": len(used_task_ids),
            "arms": len(SUITE_ARMS),
            "repetitions": repetitions,
            "requested_runs": requested_run_count,
            "recorded_runs": len(records),
            "valid_runs": valid_runs,
            "infrastructure_failures": infrastructure_failures,
            "complete": complete_matrix,
        },
        "target": status["target"],
        "coverage": status,
        "data_quality": data_quality,
        "resume_ready": bool(
            target_scope
            and complete_matrix
            and data_quality["ready"]
            and valid_runs == suite.target_runs()
        ),
        "aggregates": aggregates,
        "comparisons": comparisons,
        "runs": sorted(records, key=lambda item: str(item.get("run_id"))),
    }


def run_real_model_suite(
    root: Optional[Path] = None,
    *,
    repetitions: Optional[int] = None,
    concurrency: Optional[int] = None,
    resume: bool = True,
    max_retries: Optional[int] = None,
    max_runs: Optional[int] = None,
    task_ids: Optional[Iterable[str]] = None,
) -> Dict[str, Any]:
    if os.environ.get("TEAM_ASSET_ALLOW_EXTERNAL_MODEL", "").lower() not in {"1", "true", "yes"}:
        raise RuntimeError(
            "真实模型评测默认关闭。确认评测数据可发送后设置 TEAM_ASSET_ALLOW_EXTERNAL_MODEL=true"
        )
    benchmark_root = root or project_root()
    suite = load_benchmark_suite(benchmark_root)
    write_catalog(benchmark_root)
    assets = load_assets(benchmark_root)
    repeat_count = repetitions or int(
        os.environ.get("TEAM_ASSET_EVAL_REPETITIONS", str(suite.targets["repetitions"]))
    )
    worker_count = concurrency or int(os.environ.get("TEAM_ASSET_EVAL_CONCURRENCY", "1"))
    retry_count = max_retries if max_retries is not None else int(
        os.environ.get("TEAM_ASSET_EVAL_MAX_RETRIES", "1")
    )
    config = OpenAICompatibleConfig.from_env()
    max_turns = int(os.environ.get("TEAM_ASSET_MAX_MODEL_TURNS", "12"))

    def factory() -> RunExecutor:
        provider = OpenAICompatibleProvider(config)
        agent = OpenAIToolCodingAgent(provider, max_turns=max_turns)
        return agent.execute

    return run_suite_matrix(
        suite,
        assets,
        factory,
        repetitions=repeat_count,
        concurrency=worker_count,
        resume=resume,
        max_retries=retry_count,
        max_runs=max_runs,
        task_ids=task_ids,
        model_metadata={
            "provider": "openai-compatible",
            "base_url": config.base_url,
            "model": config.model,
            "max_turns": max_turns,
            "timeout_seconds": config.timeout_seconds,
            "temperature": config.temperature,
            "seed": config.seed,
        },
        bootstrap_iterations=int(os.environ.get("TEAM_ASSET_BOOTSTRAP_ITERATIONS", "2000")),
    )


def _write_json_atomic(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.parent / f"{path.name}.{uuid.uuid4().hex}.tmp"
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def _experiment_fingerprint(
    suite: BenchmarkSuite,
    assets: Sequence[Asset],
    fixture_hashes: Mapping[str, str],
    model_metadata: Mapping[str, Any],
) -> str:
    payload = {
        "suite": suite.status(),
        "tasks": [
            {
                "task": item.task.to_dict(),
                "bundle": item.bundle_name,
                "scenario_type": item.scenario_type,
                "fixture_sha256": fixture_hashes[item.task.task_id],
            }
            for item in suite.tasks
        ],
        "assets": [asset.to_dict() for asset in sorted(assets, key=lambda item: item.asset_id)],
        "model": dict(model_metadata),
        "arms": [
            {
                "name": arm.name,
                "strategy": arm.strategy,
                "excluded_source_types": [item.value for item in arm.excluded_source_types],
            }
            for arm in SUITE_ARMS
        ],
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()
