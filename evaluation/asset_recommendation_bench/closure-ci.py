"""Independent, networkless before/after verification -> existing CI receipt API.

Run only after the desktop author has stopped. Never edits its workspace or
posts a model's self-report as a passing test. Frozen acceptance and the
project's new regression tests are executed against both source snapshots.
"""
import ast
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "output/closure-live-20260910"

if len(sys.argv) > 1 and sys.argv[1] == "--check":
    cwd = Path.cwd().resolve()
    if cwd.parent != OUT or cwd.name not in {"ci-baseline", "ci-patched"}:
        raise RuntimeError("unapproved verification workspace")
    case = sys.argv[2]
    if case != "smoke" and not all(part.isidentifier() for part in case.split(".")):
        raise RuntimeError("invalid test selector")
    args = ["docker", "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges", "--memory", "128m", "--cpus", "0.5",
            "--mount", f"type=bind,src={cwd},dst=/evaluation,readonly", "-w", "/evaluation",
            "-e", "PYTHONDONTWRITEBYTECODE=1", "--entrypoint", "python3",
            "tdai-local/memory-hub:quality-v2", "-S"]
    args += ["smoke.py"] if case == "smoke" else ["-m", "unittest", "-v", case]
    raise SystemExit(subprocess.run(args, timeout=30).returncode)

sys.path.insert(0, str(ROOT / "evaluation/team_asset_bench"))
from team_asset_bench.ci_adapter import LocalCiRunner
from team_asset_bench.verification_discovery import discover_verification_plan

state = json.loads((OUT / "run.json").read_text())
turns = json.loads((OUT / "turns.json").read_text())["turns"]
turn = max(turns, key=lambda t: t["turn_seq"])
trace = turn["trace_id"]
workspace = Path(state["workspace"])
baseline = OUT / "ci-baseline"
patched = OUT / "ci-patched"
if (OUT / "ci-published.json").exists():
    raise RuntimeError("Do not overwrite a recorded CI publication")
for path, source in [(baseline, Path(state["source"]) / "workspace"), (patched, workspace)]:
    path.mkdir(exist_ok=True)
    shutil.copy2(source / "service.py", path / "service.py")
    shutil.copy2(source / "smoke.py", path / "smoke.py")
    shutil.copy2(workspace / "test_regression.py", path / "test_regression.py")
    shutil.copy2(ROOT / "evaluation/asset_recommendation_bench/acceptance/test_flags.py", path / "test_acceptance.py")

checks = []
for filename in ["test_acceptance.py", "test_regression.py"]:
    tree = ast.parse((patched / filename).read_text())
    for cls in [n for n in tree.body if isinstance(n, ast.ClassDef)]:
        for method in [n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name.startswith("test_")]:
            selector = f"{Path(filename).stem}.{cls.name}.{method.name}"
            checks.append({"id": selector, "name": selector, "source": "frozen-acceptance" if filename == "test_acceptance.py" else "project-regression",
                           "argv": [sys.executable, str(Path(__file__).resolve()), "--check", selector],
                           "test_ids": [method.name, f"{filename}::{cls.name}::{method.name}"]})
checks.append({"id": "public-smoke", "argv": [sys.executable, str(Path(__file__).resolve()), "--check", "smoke"], "test_ids": ["smoke.py"]})
manifest = {"checks": checks}
(OUT / "ci-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
run = LocalCiRunner(patched, timeout_seconds=40).run_before_after(manifest, before_workspace=baseline,
                 trace_id=trace, turn_id=turn["turn_id"], changed_paths=["service.py", "test_regression.py"])
contract = turn["receipt"]["acceptance_contract"]
plan = discover_verification_plan(patched, changed_paths=["service.py"], acceptance_criteria=contract["criteria"])
run["verification_discovery"] = plan.to_dict()
(OUT / "ci-result.json").write_text(json.dumps(run, ensure_ascii=False, indent=2))
token = (ROOT / "output/quality-deployment/orchestrator/service.token").read_text().strip()
request = Request("http://127.0.0.1:8765/v2/ci/runs", data=json.dumps(run).encode(),
                  headers={"authorization": f"Bearer {token}", "content-type": "application/json"}, method="POST")
with urlopen(request, timeout=30) as response:
    result = json.load(response)
(OUT / "ci-published.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
print(json.dumps({"trace": trace, "checks": len(checks), "status": run["status"], "regression_proof": run["regression_proof"],
                  "receipt_summary": result["receipt"]["summary"], "completion": result["receipt"]["completion"]}, ensure_ascii=False))
