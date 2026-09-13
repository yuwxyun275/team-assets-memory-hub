from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .models import SourceType, Task


SUITE_SCHEMA_VERSION = "team-asset-benchmark-suite/v1"


class SuiteValidationError(ValueError):
    pass


@dataclass(frozen=True)
class RepositorySpec:
    repository: str
    fixture: Path
    language: str
    test_framework: str


@dataclass(frozen=True)
class TaskSpec:
    task: Task
    bundle_name: str
    bundle_dir: Path
    scenario_type: str
    repository: RepositorySpec


@dataclass(frozen=True)
class SuiteArm:
    name: str
    strategy: str
    excluded_source_types: Tuple[SourceType, ...] = ()


SUITE_ARMS: Sequence[SuiteArm] = (
    SuiteArm("no_assets", "none"),
    SuiteArm("full_context", "full"),
    SuiteArm("minimal_team_assets", "minimal"),
    SuiteArm("without_wiki", "minimal", (SourceType.WIKI,)),
    SuiteArm("without_chat_memory", "minimal", (SourceType.CHAT_MEMORY,)),
    SuiteArm("without_code_graph", "minimal", (SourceType.CODE_GRAPH,)),
    SuiteArm("without_skill", "minimal", (SourceType.SKILL,)),
)


@dataclass(frozen=True)
class BenchmarkSuite:
    root: Path
    name: str
    dataset_provenance: str
    task_noun: str
    targets: Dict[str, int]
    scenario_catalog: Tuple[str, ...]
    repositories: Tuple[RepositorySpec, ...]
    tasks: Tuple[TaskSpec, ...]

    @property
    def repository_count(self) -> int:
        return len({item.task.repository for item in self.tasks})

    @property
    def scenario_type_count(self) -> int:
        return len({item.scenario_type for item in self.tasks})

    @property
    def task_count(self) -> int:
        return len(self.tasks)

    def expected_runs(self, repetitions: Optional[int] = None) -> int:
        count = repetitions if repetitions is not None else self.targets["repetitions"]
        return self.task_count * len(SUITE_ARMS) * count

    def target_runs(self) -> int:
        return self.targets["tasks"] * self.targets["arms"] * self.targets["repetitions"]

    def status(self) -> Dict[str, Any]:
        actual = {
            "repositories": self.repository_count,
            "scenario_types": self.scenario_type_count,
            "tasks": self.task_count,
            "arms": len(SUITE_ARMS),
            "repetitions": self.targets["repetitions"],
        }
        checks = {key: actual[key] == self.targets[key] for key in self.targets}
        return {
            "schema_version": "team-asset-benchmark-suite-status/v1",
            "name": self.name,
            "dataset_provenance": self.dataset_provenance,
            "task_noun": self.task_noun,
            "target": dict(self.targets),
            "actual": actual,
            "target_runs": self.target_runs(),
            "currently_schedulable_runs": self.expected_runs(),
            "coverage_ready": all(checks.values()),
            "checks": checks,
            "repositories": sorted({item.task.repository for item in self.tasks}),
            "scenario_types": sorted({item.scenario_type for item in self.tasks}),
            "task_ids": [item.task.task_id for item in self.tasks],
        }


def _safe_path(root: Path, relative: str, label: str) -> Path:
    candidate = (root / relative).resolve()
    resolved_root = root.resolve()
    if candidate != resolved_root and resolved_root not in candidate.parents:
        raise SuiteValidationError(f"{label} escapes benchmark root: {relative}")
    return candidate


def load_benchmark_suite(root: Path, manifest: Optional[Path] = None) -> BenchmarkSuite:
    benchmark_root = root.resolve()
    manifest_path = manifest or benchmark_root / "benchmark-suite.json"
    value = json.loads(manifest_path.read_text(encoding="utf-8"))
    if value.get("schema_version") != SUITE_SCHEMA_VERSION:
        raise SuiteValidationError(f"unsupported suite schema: {value.get('schema_version')!r}")

    raw_targets = value.get("targets") or {}
    targets: Dict[str, int] = {}
    for key in ("repositories", "scenario_types", "tasks", "arms", "repetitions"):
        number = raw_targets.get(key)
        if not isinstance(number, int) or number < 1:
            raise SuiteValidationError(f"targets.{key} must be a positive integer")
        targets[key] = number
    if targets["arms"] != len(SUITE_ARMS):
        raise SuiteValidationError(
            f"targets.arms must match the implemented matrix size {len(SUITE_ARMS)}"
        )

    scenario_catalog = tuple(str(item) for item in value.get("scenario_catalog") or [])
    if len(set(scenario_catalog)) != len(scenario_catalog):
        raise SuiteValidationError("scenario_catalog contains duplicates")
    if len(scenario_catalog) != targets["scenario_types"]:
        raise SuiteValidationError("scenario_catalog must declare exactly targets.scenario_types entries")

    repositories_by_id: Dict[str, RepositorySpec] = {}
    for raw in value.get("repositories") or []:
        repository_id = str(raw.get("repository") or "").strip()
        if not repository_id or repository_id in repositories_by_id:
            raise SuiteValidationError(f"missing or duplicate repository: {repository_id!r}")
        fixture = _safe_path(benchmark_root, str(raw.get("fixture") or ""), "repository fixture")
        if not fixture.is_dir():
            raise SuiteValidationError(f"repository fixture does not exist: {fixture}")
        repositories_by_id[repository_id] = RepositorySpec(
            repository=repository_id,
            fixture=fixture,
            language=str(raw.get("language") or "python"),
            test_framework=str(raw.get("test_framework") or "pytest"),
        )

    tasks: List[TaskSpec] = []
    seen_task_ids = set()
    for raw in value.get("tasks") or []:
        bundle_name = str(raw.get("bundle") or "").strip()
        scenario_type = str(raw.get("scenario_type") or "").strip()
        if scenario_type not in scenario_catalog:
            raise SuiteValidationError(
                f"task bundle {bundle_name!r} uses an unknown scenario_type {scenario_type!r}"
            )
        bundle_dir = _safe_path(benchmark_root, f"task_bundles/{bundle_name}", "task bundle")
        task_path = bundle_dir / "task.json"
        hidden_tests = bundle_dir / "hidden_tests"
        if not task_path.is_file():
            raise SuiteValidationError(f"task.json does not exist for bundle {bundle_name!r}")
        if not hidden_tests.is_dir() or not any(hidden_tests.rglob("test_*.py")):
            raise SuiteValidationError(f"hidden tests do not exist for bundle {bundle_name!r}")
        task = Task.from_dict(json.loads(task_path.read_text(encoding="utf-8")))
        if task.task_id in seen_task_ids:
            raise SuiteValidationError(f"duplicate task_id: {task.task_id}")
        seen_task_ids.add(task.task_id)
        repository = repositories_by_id.get(task.repository)
        if repository is None:
            raise SuiteValidationError(
                f"task {task.task_id!r} references undeclared repository {task.repository!r}"
            )
        fixture_override = raw.get("fixture")
        if fixture_override:
            override = _safe_path(benchmark_root, str(fixture_override), "task fixture")
            if not override.is_dir():
                raise SuiteValidationError(f"task fixture does not exist: {override}")
            repository = RepositorySpec(
                repository=repository.repository,
                fixture=override,
                language=repository.language,
                test_framework=repository.test_framework,
            )
        tasks.append(
            TaskSpec(
                task=task,
                bundle_name=bundle_name,
                bundle_dir=bundle_dir,
                scenario_type=scenario_type,
                repository=repository,
            )
        )

    if not tasks:
        raise SuiteValidationError("benchmark suite contains no tasks")
    return BenchmarkSuite(
        root=benchmark_root,
        name=str(value.get("name") or "TeamAssetBench"),
        dataset_provenance=str(value.get("dataset_provenance") or "unspecified"),
        task_noun=str(value.get("task_noun") or "工程任务"),
        targets=targets,
        scenario_catalog=scenario_catalog,
        repositories=tuple(repositories_by_id.values()),
        tasks=tuple(tasks),
    )


def fixture_fingerprint(paths: Sequence[Path]) -> str:
    digest = hashlib.sha256()
    ignored = {".DS_Store", ".git", "__pycache__", ".pytest_cache", ".pyc"}
    for root in paths:
        for path in sorted(root.rglob("*")):
            relative = path.relative_to(root)
            if any(part in ignored or part.endswith(".pyc") for part in relative.parts):
                continue
            if not path.is_file():
                continue
            digest.update(str(relative).encode("utf-8"))
            digest.update(b"\0")
            digest.update(path.read_bytes())
            digest.update(b"\0")
    return digest.hexdigest()
