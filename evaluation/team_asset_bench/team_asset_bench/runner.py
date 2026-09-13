from __future__ import annotations

import json
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

from .catalog import load_assets, load_task, project_root, write_catalog
from .evidence import EvidenceValidator, RunEvidence, TestEvidence, test_pass_rate
from .feedback import generate_candidate_asset
from .ledger import EvidenceLedger
from .models import ContextPackage
from .orchestrator import TeamAssetOrchestrator
from .receipt import build_receipt, write_receipt_html, write_receipt_json


WIKI_ASSET = "asset-wiki-tenant-fallback"
MEMORY_ASSET = "asset-memory-retry-storm"
GRAPH_ASSET = "asset-codegraph-cache-boundary"
SKILL_ASSET = "asset-skill-cache-fault-recovery"


@dataclass(frozen=True)
class Arm:
    name: str
    strategy: str
    excluded: Tuple[str, ...] = ()


ARMS: Sequence[Arm] = (
    Arm("no_assets", "none"),
    Arm("minimal_team_assets", "minimal"),
    Arm("full_context", "full"),
    Arm("without_key_wiki", "minimal", (WIKI_ASSET,)),
    Arm("without_failure_memory", "minimal", (MEMORY_ASSET,)),
    Arm("without_code_graph", "minimal", (GRAPH_ASSET,)),
    Arm("without_validation_skill", "minimal", (SKILL_ASSET,)),
)


CORRECT_SERVICE = '''from typing import Optional

from .cache import CacheUnavailable, FakeRedis
from .repository import FlagRepository


class FeatureFlagService:
    def __init__(self, cache: FakeRedis, repository: FlagRepository) -> None:
        self.cache = cache
        self.repository = repository

    def get_flag(self, tenant_id: str, key: str) -> Optional[dict]:
        try:
            cached = self.cache.get(f"{tenant_id}:{key}")
        except CacheUnavailable:
            fallback = self.repository.get_published(tenant_id, key)
            return fallback.response("database") if fallback else None
        return cached.response("cache") if cached else None
'''


UNSAFE_GLOBAL_SERVICE = '''from typing import Optional

from .cache import CacheUnavailable, FakeRedis
from .repository import FlagRepository


class FeatureFlagService:
    def __init__(self, cache: FakeRedis, repository: FlagRepository) -> None:
        self.cache = cache
        self.repository = repository

    def get_flag(self, tenant_id: str, key: str) -> Optional[dict]:
        try:
            cached = self.cache.get(f"{tenant_id}:{key}")
        except CacheUnavailable:
            fallback = self.repository.get_any_by_key(key)
            return fallback.response("database") if fallback else None
        return cached.response("cache") if cached else None
'''


RETRY_STORM_SERVICE = '''from typing import Optional

from .cache import CacheUnavailable, FakeRedis
from .repository import FlagRepository


class FeatureFlagService:
    def __init__(self, cache: FakeRedis, repository: FlagRepository) -> None:
        self.cache = cache
        self.repository = repository

    def get_flag(self, tenant_id: str, key: str) -> Optional[dict]:
        cached = None
        for _ in range(3):
            try:
                cached = self.cache.get(f"{tenant_id}:{key}")
                break
            except CacheUnavailable:
                continue
        if cached:
            return cached.response("cache")
        fallback = self.repository.get_published(tenant_id, key)
        return fallback.response("database") if fallback else None
'''


class ReferenceCodingAgent:
    """Deterministic policy used to validate the benchmark itself without model cost.

    It is intentionally named reference rather than AI: live model runs use the
    OpenAI-compatible provider. The reference run proves that the task bundle,
    hidden tests, evidence state machine and counterfactual protocol are sound.
    """

    def execute(self, package: ContextPackage, workspace: Path, arm: Arm, results_dir: Path) -> RunEvidence:
        started = time.perf_counter()
        selected_ids = {selection.asset.asset_id for selection in package.selected}
        service_path = workspace / "feature_flags" / "service.py"

        if WIKI_ASSET not in selected_ids:
            implementation = UNSAFE_GLOBAL_SERVICE
        elif MEMORY_ASSET not in selected_ids:
            implementation = RETRY_STORM_SERVICE
        else:
            implementation = CORRECT_SERVICE
        service_path.write_text(implementation, encoding="utf-8")

        tool_calls = ["read:feature_flags/service.py"]
        if GRAPH_ASSET not in selected_ids:
            tool_calls.extend(
                [
                    "read:feature_flags/cache.py",
                    "read:feature_flags/repository.py",
                    "search:get_flag",
                    "search:get_published",
                ]
            )
        tool_calls.append("patch:feature_flags/service.py")
        tool_calls.append("pytest:visible")
        if SKILL_ASSET in selected_ids:
            tool_calls.append("pytest:visible+hidden+recovery")

        tests, log_text = self._run_independent_tests(workspace)
        arm_dir = results_dir / arm.name
        arm_dir.mkdir(parents=True, exist_ok=True)
        # Keep executable evidence in a tracked text artifact. The repository's
        # global *.log rule is intentionally for runtime logs and would make a
        # benchmark receipt point at a missing file after clone.
        test_log = arm_dir / "pytest-output.txt"
        test_log.write_text(log_text, encoding="utf-8")
        for test in tests:
            test.output_ref = str(test_log.relative_to(project_root()))

        decisions: Dict[str, str] = {}
        targets: Dict[str, str] = {}
        if GRAPH_ASSET in selected_ids:
            decisions[GRAPH_ASSET] = "根据代码图谱把改动收敛在缓存边界 FeatureFlagService.get_flag。"
            targets[GRAPH_ASSET] = "feature_flags/service.py:FeatureFlagService.get_flag"
        if WIKI_ASSET in selected_ids:
            decisions[WIKI_ASSET] = "按租户读取已发布配置，并把降级响应来源标记为 database。"
            targets[WIKI_ASSET] = "feature_flags/service.py:FeatureFlagService.get_flag"
        if MEMORY_ASSET in selected_ids:
            decisions[MEMORY_ASSET] = "只捕获一次 CacheUnavailable，禁止请求内重试，避免工作线程饱和。"
            targets[MEMORY_ASSET] = "feature_flags/service.py:FeatureFlagService.get_flag"
        if SKILL_ASSET in selected_ids:
            decisions[SKILL_ASSET] = "在同一次验证中运行正常、故障、租户隔离、无重试和恢复测试。"
            targets[SKILL_ASSET] = "test:pytest-visible-hidden-recovery"

        return RunEvidence(
            trace_id=package.trace_id,
            task_id=package.task.task_id,
            changed_paths=["feature_flags/service.py"],
            decisions=decisions,
            asset_targets=targets,
            tests=tests,
            tool_calls=tool_calls,
            attempts=1 if MEMORY_ASSET in selected_ids else 2,
            duration_ms=int((time.perf_counter() - started) * 1000),
        )

    @staticmethod
    def _run_independent_tests(workspace: Path) -> Tuple[List[TestEvidence], str]:
        env = dict(os.environ)
        # Keep the runner's own dependency path (for example an isolated
        # pytest installation) while placing the evaluated workspace first.
        # Replacing PYTHONPATH outright makes an otherwise reproducible
        # harness depend on globally installed packages.
        env["PYTHONPATH"] = os.pathsep.join(
            item for item in (str(workspace), env.get("PYTHONPATH", "")) if item
        )
        collect = subprocess.run(
            [sys.executable, "-m", "pytest", "--collect-only", "-q", "tests", "hidden_tests"],
            cwd=str(workspace),
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
        node_ids = [line.strip() for line in collect.stdout.splitlines() if "::test_" in line]
        evidence: List[TestEvidence] = []
        chunks = ["$ pytest --collect-only -q tests hidden_tests", collect.stdout]
        for node_id in node_ids:
            result = subprocess.run(
                [sys.executable, "-m", "pytest", "-q", node_id],
                cwd=str(workspace),
                env=env,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                check=False,
            )
            chunks.extend([f"$ pytest -q {node_id}", result.stdout])
            evidence.append(
                TestEvidence(
                    name=node_id.rsplit("::", 1)[-1],
                    passed=result.returncode == 0,
                    command=f"python -m pytest -q {node_id}",
                    output_ref="",
                )
            )
        return evidence, "\n".join(chunks)


def _workspace(benchmark_root: Path) -> tempfile.TemporaryDirectory:
    temp = tempfile.TemporaryDirectory(prefix="team-asset-bench-")
    workspace = Path(temp.name)
    shutil.copytree(benchmark_root / "projects" / "feature_flag_service" / "base", workspace, dirs_exist_ok=True)
    shutil.copytree(
        benchmark_root / "task_bundles" / "cache_outage_001" / "hidden_tests",
        workspace / "hidden_tests",
        dirs_exist_ok=True,
    )
    return temp


def run_matrix(root: Optional[Path] = None) -> Dict[str, Any]:
    benchmark_root = root or project_root()
    write_catalog(benchmark_root)
    task = load_task(benchmark_root)
    assets = load_assets(benchmark_root)
    results_dir = benchmark_root / "results"
    results_dir.mkdir(parents=True, exist_ok=True)
    agent = ReferenceCodingAgent()
    runs: Dict[str, Dict[str, Any]] = {}
    packages: Dict[str, ContextPackage] = {}
    ledgers: Dict[str, EvidenceLedger] = {}
    evidences: Dict[str, RunEvidence] = {}

    for arm in ARMS:
        ledger = EvidenceLedger()
        orchestrator = TeamAssetOrchestrator(assets, ledger)
        package = orchestrator.select(task, strategy=arm.strategy, excluded_asset_ids=arm.excluded)
        EvidenceValidator(ledger).confirm_injected(
            package,
            actor_id="offline-evaluation-harness",
            evidence_ref=f"prompt-sha256:{hashlib.sha256(package.markdown.encode('utf-8')).hexdigest()}",
            detail={"injection_point": "reference-agent.system"},
        )
        temp = _workspace(benchmark_root)
        try:
            evidence = agent.execute(package, Path(temp.name), arm, results_dir)
        finally:
            temp.cleanup()
        validated = EvidenceValidator(ledger).validate(package, evidence)
        selected_types = sorted({item.asset.source_type.value for item in package.selected})
        agent_validation_count = len(evidence.tests) if SKILL_ASSET in {item.asset.asset_id for item in package.selected} else 3
        runs[arm.name] = {
            "arm": arm.name,
            "strategy": arm.strategy,
            "excluded_asset_ids": list(arm.excluded),
            "trace_id": package.trace_id,
            "recalled": len(package.recalled),
            "selected": len(package.selected),
            "selected_asset_ids": [item.asset.asset_id for item in package.selected],
            "selected_source_types": selected_types,
            "asset_token_cost": package.token_cost,
            "tests_total": len(evidence.tests),
            "tests_passed": sum(1 for test in evidence.tests if test.passed),
            "test_pass_rate": test_pass_rate(evidence.tests),
            "task_completed": evidence.passed,
            "agent_validation_coverage": round(agent_validation_count / max(1, len(evidence.tests)), 4),
            "tool_calls": len(evidence.tool_calls),
            "attempts": evidence.attempts,
            "duration_ms": evidence.duration_ms,
            "validated_asset_ids": validated,
        }
        packages[arm.name] = package
        ledgers[arm.name] = ledger
        evidences[arm.name] = evidence

    minimal = runs["minimal_team_assets"]
    comparisons = {
        "minimal_vs_no_assets": {
            "test_pass_rate_delta": round(minimal["test_pass_rate"] - runs["no_assets"]["test_pass_rate"], 4),
            "tool_call_delta": minimal["tool_calls"] - runs["no_assets"]["tool_calls"],
        },
        "minimal_vs_full_context": {
            "same_completion": minimal["task_completed"] == runs["full_context"]["task_completed"],
            "asset_token_saving": runs["full_context"]["asset_token_cost"] - minimal["asset_token_cost"],
        },
        "asset_ablations": {},
    }
    ablation_to_asset = {
        "without_key_wiki": WIKI_ASSET,
        "without_failure_memory": MEMORY_ASSET,
        "without_code_graph": GRAPH_ASSET,
        "without_validation_skill": SKILL_ASSET,
    }
    validator = EvidenceValidator(ledgers["minimal_team_assets"])
    for arm_name, asset_id in ablation_to_asset.items():
        ablated = runs[arm_name]
        effect = {
            "asset_id": asset_id,
            "test_pass_rate_delta": round(minimal["test_pass_rate"] - ablated["test_pass_rate"], 4),
            "tool_call_saving": ablated["tool_calls"] - minimal["tool_calls"],
            "validation_coverage_delta": round(
                minimal["agent_validation_coverage"] - ablated["agent_validation_coverage"], 4
            ),
            "attempt_reduction": ablated["attempts"] - minimal["attempts"],
        }
        effect["positive"] = any(
            effect[key] > 0
            for key in ("test_pass_rate_delta", "tool_call_saving", "validation_coverage_delta", "attempt_reduction")
        )
        comparisons["asset_ablations"][arm_name] = effect
        if effect["positive"]:
            validator.mark_contributed(
                packages["minimal_team_assets"],
                [asset_id],
                comparison_ref=f"results/evaluation-summary.json#asset_ablations.{arm_name}",
                delta=effect,
            )

    candidate = generate_candidate_asset(
        packages["minimal_team_assets"],
        evidences["minimal_team_assets"],
        runs["minimal_team_assets"]["validated_asset_ids"],
        results_dir / "candidates",
    )
    summary = {
        "schema_version": "team-asset-benchmark-result/v1",
        "benchmark": "python-feature-flag-team-assets",
        "mode": "deterministic-reference-policy",
        "limitations": [
            "本组结果用于验证评测集与证据协议本身，没有调用付费模型。",
            "真实模型结果必须通过 OpenAI 兼容接口单独多次运行并独立报告。",
        ],
        "runs": runs,
        "comparisons": comparisons,
        "feedback_candidate": {
            "candidate_id": candidate["candidate_id"],
            "publication_state": candidate["publication_state"],
            "authority": candidate["authority"],
            "review_required": candidate["review_required"],
            "path": str(Path(candidate["path"]).relative_to(benchmark_root)),
        },
    }
    live_integration = results_dir / "live-proxy-integration.json"
    if live_integration.is_file():
        summary["live_proxy_integration"] = json.loads(live_integration.read_text(encoding="utf-8"))
    automatic_evidence = results_dir / "new_asset_test_01-automatic-evidence.json"
    if automatic_evidence.is_file():
        summary["automatic_proxy_evidence"] = json.loads(
            automatic_evidence.read_text(encoding="utf-8")
        )
    real_model = results_dir / "real-model-evaluation-summary.json"
    if real_model.is_file():
        summary["real_model_evaluation"] = {
            "status": "completed",
            **json.loads(real_model.read_text(encoding="utf-8")),
        }
    else:
        summary["real_model_evaluation"] = {
            "status": "not_run",
            "reason": "尚未获得向外部 OpenAI 兼容模型发送团队资产的明确授权",
            "runner": "python3 -m team_asset_bench evaluate-live",
        }
    summary_path = results_dir / "evaluation-summary.json"
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    for arm in ARMS:
        comparison = comparisons if arm.name == "minimal_team_assets" else None
        receipt = build_receipt(
            packages[arm.name],
            ledgers[arm.name],
            evidences[arm.name],
            arm=arm.name,
            comparison=comparison,
        )
        write_receipt_json(receipt, results_dir / arm.name / "asset-receipt.json")
        write_receipt_html(receipt, results_dir / arm.name / "asset-receipt.html")
        if arm.name == "minimal_team_assets":
            (results_dir / arm.name / "injected-context.md").write_text(
                packages[arm.name].markdown + "\n", encoding="utf-8"
            )
    return summary
