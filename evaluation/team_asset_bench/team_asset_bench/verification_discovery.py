from __future__ import annotations

import ast
import hashlib
import json
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Sequence


IGNORED_PARTS = {
    ".git", ".hg", ".svn", ".tox", ".venv", "venv", "node_modules",
    "dist", "build", "__pycache__", ".pytest_cache",
    # Independent evaluator suites must never be exposed as CodeBuddy's
    # repository-owned test plan. They are executed by a separate validator.
    "hidden_tests", "evaluator_tests", "grader_tests",
}


@dataclass(frozen=True)
class DiscoveredTest:
    test_id: str
    path: str
    framework: str
    target_paths: List[str]
    confidence: float
    reason: str


@dataclass(frozen=True)
class VerificationPlan:
    schema_version: str
    workspace_fingerprint: str
    frameworks: List[str]
    ci_providers: List[str]
    config_files: List[str]
    tests: List[DiscoveredTest]
    checks: List[Dict[str, Any]]
    acceptance_coverage: List[Dict[str, Any]]
    discovery_warnings: List[str]

    def to_dict(self) -> Dict[str, Any]:
        value = asdict(self)
        value["tests"] = [asdict(item) for item in self.tests]
        return value

    def to_manifest(self) -> Dict[str, Any]:
        return {
            "schema_version": "team-asset-local-ci-manifest/v2",
            "discovered": True,
            "workspace_fingerprint": self.workspace_fingerprint,
            "checks": self.checks,
            "acceptance_coverage": self.acceptance_coverage,
        }


def discover_verification_plan(
    workspace: Path,
    *,
    changed_paths: Iterable[str] = (),
    acceptance_criteria: Iterable[str] = (),
) -> VerificationPlan:
    """Discover repository-owned tests and CI metadata without executing code.

    Discovery intentionally uses static files/AST only.  The returned command is
    still an argv array and must pass through ``LocalCiRunner`` before execution.
    This mirrors an enterprise runner: the repository defines its checks, while
    the asset service merely observes their signed/hash-addressed result.
    """
    root = workspace.expanduser().resolve()
    if not root.is_dir():
        raise ValueError("verification workspace must be an existing directory")
    targets = _clean_paths(changed_paths)
    configs, providers = _discover_ci(root)
    tests = _discover_pytest(root, targets)
    criteria = [str(item).strip() for item in acceptance_criteria if str(item).strip()]
    acceptance_coverage = map_acceptance_criteria(criteria, tests)
    frameworks: List[str] = []
    checks: List[Dict[str, Any]] = []
    warnings: List[str] = []
    if tests or _has_pytest_config(root):
        frameworks.append("pytest")
        test_paths = sorted({item.path for item in tests})
        argv = [sys.executable, "-m", "pytest", "-q", *(test_paths or ["tests"])]
        checks.append({
            "id": "repository-pytest",
            "name": "仓库自动发现的 pytest 测试",
            "argv": argv,
            "cwd": ".",
            "source": "repository-discovery",
            "test_ids": [item.test_id for item in tests],
            "target_paths": targets,
        })
    else:
        warnings.append("没有静态发现 pytest 配置或测试文件；未生成猜测性测试命令")
    canonical = json.dumps(
        {
            "configs": configs,
            "providers": providers,
            "tests": [asdict(item) for item in tests],
            "targets": targets,
            "acceptance_coverage": acceptance_coverage,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return VerificationPlan(
        schema_version="team-asset-verification-discovery/v1",
        workspace_fingerprint=f"sha256:{hashlib.sha256(canonical.encode('utf-8')).hexdigest()}",
        frameworks=frameworks,
        ci_providers=providers,
        config_files=configs,
        tests=tests,
        checks=checks,
        acceptance_coverage=acceptance_coverage,
        discovery_warnings=warnings,
    )


SEMANTIC_ALIASES: Dict[str, tuple[str, ...]] = {
    "cache": ("redis", "缓存", "cache"),
    "outage": ("故障", "不可用", "异常", "outage", "unavailable", "fallback", "回退", "降级"),
    "tenant": ("租户", "tenant", "隔离", "越权", "泄漏", "leak"),
    "draft": ("草稿", "draft", "published", "发布"),
    "retry": ("重试", "retry", "重复调用", "storm"),
    "recovery": ("恢复", "recovery", "recover"),
    "timeout": ("超时", "timeout", "5xx", "latency"),
    "write": ("写入", "更新记录", "保存", "write", "update", "insert", "delete", "事务"),
    "audit": ("审计", "audit", "留痕", "日志平台", "审计平台"),
    "regression": ("回归", "regression", "现有自动化测试", "existing tests"),
}

# 这些概念代表明确的安全/治理能力。若标准提出了它们，而测试文本完全没有对应语义，
# 不能因为同时出现“写入”“更新”等泛化词就误判为已覆盖。
STRICT_COVERAGE_CONCEPTS = {"audit", "tenant"}


def map_acceptance_criteria(
    criteria: Sequence[str],
    tests: Sequence[DiscoveredTest],
) -> List[Dict[str, Any]]:
    """Map candidate/confirmed criteria to repository tests without claiming a pass.

    The output is a *coverage plan*. A mapping only becomes validation evidence
    after the mapped test IDs are observed in a trusted tool/CI result.
    """
    result: List[Dict[str, Any]] = []
    for index, criterion in enumerate(criteria, start=1):
        criterion_terms = _semantic_terms(criterion)
        scored: List[tuple[float, DiscoveredTest, List[str]]] = []
        regression_wide = "regression" in criterion_terms
        for test in tests:
            test_terms = _semantic_terms(" ".join([
                test.test_id,
                test.path,
                *test.target_paths,
                test.reason,
            ]))
            shared = sorted(criterion_terms & test_terms)
            strict_terms = criterion_terms & STRICT_COVERAGE_CONCEPTS
            if strict_terms and not strict_terms.issubset(test_terms):
                continue
            score = float(len(shared))
            if regression_wide:
                score = max(score, 0.75)
            if score > 0:
                scored.append((score, test, shared))
        scored.sort(key=lambda item: (-item[0], -item[1].confidence, item[1].test_id))
        chosen = scored[:6]
        mapped_ids = list(dict.fromkeys(item[1].test_id for item in chosen))
        mapped_paths = list(dict.fromkeys(item[1].path for item in chosen))
        confidence = (
            min(0.95, 0.55 + 0.08 * chosen[0][0] + 0.12 * chosen[0][1].confidence)
            if chosen else 0.0
        )
        result.append({
            "criterion_id": f"criterion-{index}",
            "text": criterion,
            "status": "mapped_candidate" if mapped_ids else "coverage_gap",
            "mapped_test_ids": mapped_ids,
            "mapped_test_paths": mapped_paths,
            "confidence": round(confidence, 4),
            "reason": (
                "根据测试名称、路径、目标模块和中英文领域词完成静态候选映射；必须等待真实测试结果"
                if mapped_ids else
                "仓库中未发现足够相关的自动化测试，需要 CodeBuddy 补充测试或登记人工验收"
            ),
            "matched_terms": chosen[0][2] if chosen else [],
        })
    return result


def _discover_pytest(root: Path, targets: Sequence[str]) -> List[DiscoveredTest]:
    result: List[DiscoveredTest] = []
    for path in sorted(root.rglob("*.py")):
        relative = path.relative_to(root)
        if any(part in IGNORED_PARTS for part in relative.parts):
            continue
        if not (path.name.startswith("test_") or path.name.endswith("_test.py")):
            continue
        try:
            source = path.read_text(encoding="utf-8")
            tree = ast.parse(source)
        except (OSError, UnicodeDecodeError, SyntaxError):
            continue
        class_name = ""
        unittest_modules = {alias.asname or alias.name for node in tree.body if isinstance(node, ast.Import)
                            for alias in node.names if alias.name == "unittest"}
        testcase_names = {alias.asname or alias.name for node in tree.body if isinstance(node, ast.ImportFrom)
                          and node.module == "unittest" for alias in node.names if alias.name == "TestCase"}
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("test_"):
                result.append(_test_record(relative, node.name, source, targets))
            elif isinstance(node, ast.ClassDef) and (node.name.startswith("Test") or any(
                (isinstance(base, ast.Attribute) and base.attr == "TestCase" and isinstance(base.value, ast.Name) and base.value.id in unittest_modules)
                or (isinstance(base, ast.Name) and base.id in testcase_names) for base in node.bases
            )):
                class_name = node.name
                for child in node.body:
                    if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)) and child.name.startswith("test_"):
                        result.append(_test_record(relative, f"{class_name}::{child.name}", source, targets))
    return result


def _test_record(relative: Path, name: str, source: str, targets: Sequence[str]) -> DiscoveredTest:
    normalized = relative.as_posix()
    matched: List[str] = []
    test_terms = _terms(f"{normalized} {name} {source}")
    for target in targets:
        target_path = Path(target)
        target_terms = _terms(f"{target} {target_path.stem}")
        module = target.replace("/", ".").removesuffix(".py")
        if module in source or target_path.name in source or test_terms & target_terms:
            matched.append(target)
    confidence = 0.9 if matched else (0.68 if not targets else 0.45)
    reason = (
        "测试源码引用目标模块或共享语义词" if matched
        else "仓库测试已发现，但尚无足够静态证据绑定到本次修改路径"
    )
    return DiscoveredTest(
        test_id=name.split("::")[-1],
        path=normalized,
        framework="pytest",
        target_paths=matched,
        confidence=confidence,
        reason=reason,
    )


def _discover_ci(root: Path) -> tuple[List[str], List[str]]:
    configs: List[str] = []
    providers: List[str] = []
    candidates: List[tuple[Path, str]] = []
    workflows = root / ".github" / "workflows"
    if workflows.is_dir():
        candidates.extend((path, "github-actions") for path in sorted(workflows.glob("*.y*ml")))
    for name, provider in ((".gitlab-ci.yml", "gitlab-ci"), ("Jenkinsfile", "jenkins")):
        path = root / name
        if path.is_file():
            candidates.append((path, provider))
    for path, provider in candidates:
        configs.append(path.relative_to(root).as_posix())
        if provider not in providers:
            providers.append(provider)
    for name in ("pyproject.toml", "pytest.ini", "tox.ini", "setup.cfg"):
        path = root / name
        if path.is_file() and name not in configs:
            configs.append(name)
    return configs, providers


def _has_pytest_config(root: Path) -> bool:
    for name in ("pytest.ini", "tox.ini", "setup.cfg", "pyproject.toml"):
        path = root / name
        if not path.is_file():
            continue
        try:
            if "pytest" in path.read_text(encoding="utf-8").lower():
                return True
        except (OSError, UnicodeDecodeError):
            continue
    return (root / "tests").is_dir()


def _clean_paths(values: Iterable[str]) -> List[str]:
    result: List[str] = []
    for value in values:
        normalized = str(value).strip().replace("\\", "/").lstrip("./")
        if normalized and ".." not in Path(normalized).parts and normalized not in result:
            result.append(normalized[:600])
    return result[:100]


def _terms(text: str) -> set[str]:
    return {
        item.lower()
        for item in re.findall(r"[A-Za-z_][A-Za-z0-9_]{2,}|[\u4e00-\u9fff]{2,}", text)
    }


def _semantic_terms(text: str) -> set[str]:
    lowered = text.lower()
    terms = _terms(lowered)
    for canonical, aliases in SEMANTIC_ALIASES.items():
        if any(alias in lowered for alias in aliases):
            terms.add(canonical)
    return terms
