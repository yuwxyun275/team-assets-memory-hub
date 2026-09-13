from team_asset_bench.verification_discovery import discover_verification_plan


def test_unittest_case_without_test_prefix_is_discovered(tmp_path):
    (tmp_path / "service.py").write_text("# target\n")
    (tmp_path / "test_regression.py").write_text(
        "import unittest as ut\nfrom unittest import TestCase as BaseCase\n"
        "class Acceptance(ut.TestCase):\n    def test_failure_and_recovery(self): pass\n"
        "class Regression(BaseCase):\n    def test_tenant_isolation(self): pass\n"
        "class Ordinary:\n    def test_not_a_case(self): pass\n"
    )
    plan = discover_verification_plan(tmp_path, changed_paths=["service.py"])
    assert {t.test_id for t in plan.tests} == {"test_failure_and_recovery", "test_tenant_isolation"}
