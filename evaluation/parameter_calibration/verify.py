"""Rebuild public evidence without model calls or access to private runtime data."""
from pathlib import Path
import hashlib
import json
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "evaluation/team_asset_bench"))
from team_asset_bench.decision_policy import DEFAULT_POLICY


def execute(*args):
    subprocess.run([sys.executable, *map(str, args)], cwd=ROOT, check=True,
                   stdout=subprocess.DEVNULL)


def main():
    evidence = HERE / "results"
    with tempfile.TemporaryDirectory(prefix="asset-parameter-check-") as directory:
        temp = Path(directory)
        dataset = temp / "dataset"
        execute(ROOT / "evaluation/asset_recommendation_bench/build.py", "--output", dataset)
        execute(HERE / "run.py", "--dataset", dataset, "--output", temp / "ranking.json")
        execute(HERE / "quality.py", "--output", temp / "quality.json")
        for name in ["ranking.json", "quality.json"]:
            actual = json.loads((temp / name).read_text())
            expected = json.loads((evidence / name).read_text())
            assert actual == expected, f"Evidence drift: {name}"
        ranking = json.loads((evidence / "ranking.json").read_text())
        assert ranking["selected_policy"] == DEFAULT_POLICY.to_dict(), "Runtime policy drift"
    live = json.loads((evidence / "live-confirmation.json").read_text())
    assert live["requests"] == len(live["records"]) == 12
    assert len({row["run_id"] for row in live["records"]}) == 12
    for row in live["records"]:
        verification = row.get("verification")
        if verification:
            code = evidence / "generated-code" / (row["run_id"] + ".py")
            assert hashlib.sha256(code.read_bytes()).hexdigest() == verification["code_sha256"]
            project = row["task_id"].split("-")[-1]
            test = ROOT / "evaluation/asset_recommendation_bench/acceptance" / f"test_{project}.py"
            assert hashlib.sha256(test.read_bytes()).hexdigest() == verification["test_sha256"]
    print("PASS: ranking and quality replay, runtime policy, 12 records and code/test hashes")


if __name__ == "__main__":
    main()
