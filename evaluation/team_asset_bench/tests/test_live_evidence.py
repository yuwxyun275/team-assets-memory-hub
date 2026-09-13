import json
from pathlib import Path

from team_asset_bench.catalog import load_assets, load_task, project_root
from team_asset_bench.evidence import EvidenceValidator
from team_asset_bench.ledger import EvidenceLedger
from team_asset_bench.live_agent import OpenAIToolCodingAgent
from team_asset_bench.models import AssetState
from team_asset_bench.observer import CodeBuddyEvidenceObserver, TraceObservationState
from team_asset_bench.openai_provider import ChatCompletionResult
from team_asset_bench.orchestrator import TeamAssetOrchestrator
from team_asset_bench.server import TeamAssetApi
from team_asset_bench.runner import CORRECT_SERVICE, _workspace


def test_validation_without_asset_test_hints_still_matches_declared_action():
    state = TraceObservationState(tool_calls={
        "suite": {"id": "suite", "kind": "test", "command": "python -m pytest -v test_inventory.py", "test_ids": ["test_duplicate_request"]},
        "other": {"id": "other", "kind": "test", "command": "python -m pytest test_other.py", "test_ids": ["test_other"]},
    }, tool_results={
        "suite": {"success": True, "evidence_ref": "sha256:actual-suite"},
        "other": {"success": True, "evidence_ref": "sha256:unrelated"},
    })
    validation = CodeBuddyEvidenceObserver._successful_validation(state, [], "test:test_inventory.py")
    assert validation is not None and validation[0]["id"] == "suite"
    assert CodeBuddyEvidenceObserver._successful_validation(state, [], "test:missing.py") is None
    assert CodeBuddyEvidenceObserver._matching_action(state, "test:test_inventory.py/test_duplicate_request")["id"] == "suite"
    assert CodeBuddyEvidenceObserver._matching_action(state, "test:test_inventory.py/test_duplicate_request,test_unobserved") is None


def test_model_declaration_plus_tool_and_test_advances_to_validated():
    root = project_root()
    ledger = EvidenceLedger()
    package = TeamAssetOrchestrator(load_assets(root), ledger).select(
        load_task(root), strategy="minimal", trace_id="trace-observer-test"
    )
    wiki = next(item.asset for item in package.selected if item.asset.asset_id == "asset-wiki-tenant-fallback")
    observer = CodeBuddyEvidenceObserver(ledger)
    EvidenceValidator(ledger).confirm_injected(
        package,
        actor_id="memory-proxy",
        evidence_ref="sha256:injected-context",
    )

    events = observer.observe(
        package,
        {
            "actor_id": package.task.agent_id,
            "declarations": [
                {
                    "asset_id": wiki.asset_id,
                    "decision": "按同租户已发布数据执行数据库回退",
                    "target": "feature_flags/service.py:FeatureFlagService.get_flag",
                }
            ],
            "tool_calls": [
                {
                    "id": "edit-1",
                    "name": "apply_patch",
                    "kind": "edit",
                    "target": "feature_flags/service.py",
                    "arguments": '{"path":"feature_flags/service.py"}',
                },
                {
                    "id": "test-1",
                    "name": "shell",
                    "kind": "test",
                    "command": "python -m pytest -q hidden_tests/test_fallback.py::test_outage_never_leaks_another_tenant",
                    "test_ids": ["test_outage_never_leaks_another_tenant"],
                },
            ],
            "tool_results": [
                {
                    "tool_call_id": "test-1",
                    "success": True,
                    "summary": "test_outage_never_leaks_another_tenant PASSED",
                    "evidence_ref": "sha256:test-output",
                    "test_ids": ["test_outage_never_leaks_another_tenant"],
                }
            ],
        },
    )

    assert [event.state for event in events] == [AssetState.USED, AssetState.VALIDATED]
    assert ledger.latest_state(package.trace_id, package.task.task_id, wiki.asset_id) is AssetState.VALIDATED


def test_generic_suite_summary_does_not_claim_per_asset_validation():
    root = project_root()
    ledger = EvidenceLedger()
    package = TeamAssetOrchestrator(load_assets(root), ledger).select(
        load_task(root), strategy="minimal", trace_id="trace-generic-suite-test"
    )
    wiki = next(item.asset for item in package.selected if item.asset.asset_id == "asset-wiki-tenant-fallback")
    EvidenceValidator(ledger).confirm_injected(
        package,
        actor_id="memory-proxy",
        evidence_ref="sha256:injected-context",
    )
    events = CodeBuddyEvidenceObserver(ledger).observe(
        package,
        {
            "declarations": [{
                "asset_id": wiki.asset_id,
                "decision": "采用租户隔离约束",
                "target": "feature_flags/service.py:FeatureFlagService.get_flag",
            }],
            "tool_calls": [
                {"id": "edit", "name": "apply_patch", "kind": "edit", "target": "feature_flags/service.py"},
                {"id": "test", "name": "shell", "kind": "test", "command": "python -m pytest -q tests hidden_tests"},
            ],
            "tool_results": [{"tool_call_id": "test", "success": True, "summary": "9 passed"}],
        },
    )
    assert [event.state for event in events] == [AssetState.USED]


def test_hub_asset_payload_is_the_runtime_content_authority():
    source = load_assets(project_root())[0]
    payload = source.to_dict()
    payload["claim"] = "旧快照内容"
    item = {
        "asset_id": "wiki-runtime",
        "name": "Hub 中的中文资产名",
        "description": "Hub 中实时更新的正文",
        "source_ref": "hub://wiki/runtime",
        "version": 7,
        "updated_at": "2026-08-31T00:00:00Z",
        "metadata_json": json.dumps(
            {
                "team_asset_bench": {
                    "logical_asset_id": source.asset_id,
                    "version": source.version,
                    "asset_payload": payload,
                }
            },
            ensure_ascii=False,
        ),
    }
    api = TeamAssetApi.__new__(TeamAssetApi)
    assets = api._assets_from_hub([item])

    assert len(assets) == 1
    assert assets[0].title == "Hub 中的中文资产名"
    assert assets[0].claim == "Hub 中实时更新的正文"
    assert assets[0].source_ref == "hub://wiki/runtime"


def test_real_model_tool_loop_executes_code_and_independent_hidden_tests():
    root = project_root()
    package = TeamAssetOrchestrator(load_assets(root), EvidenceLedger()).select(
        load_task(root), strategy="minimal", trace_id="trace-live-agent-test"
    )

    class FakeProvider:
        def __init__(self):
            self.index = 0

        def chat(self, messages, *, tools=None):
            self.index += 1
            if self.index == 1:
                message = {
                    "role": "assistant",
                    "content": "先实施最小修复。",
                    "tool_calls": [
                        {
                            "id": "write-1",
                            "type": "function",
                            "function": {
                                "name": "write_file",
                                "arguments": json.dumps(
                                    {"path": "feature_flags/service.py", "content": CORRECT_SERVICE},
                                    ensure_ascii=False,
                                ),
                            },
                        }
                    ],
                }
            elif self.index == 2:
                message = {
                    "role": "assistant",
                    "content": "执行可见测试。",
                    "tool_calls": [
                        {
                            "id": "test-1",
                            "type": "function",
                            "function": {"name": "run_visible_tests", "arguments": "{}"},
                        }
                    ],
                }
            else:
                declarations = "\n".join(
                    f'<team_asset_use>{{"asset_id":"{item.asset.asset_id}","decision":"采用该团队资产完成安全修复","target":"feature_flags/service.py:FeatureFlagService.get_flag"}}</team_asset_use>'
                    for item in package.selected
                )
                message = {"role": "assistant", "content": declarations}
            return ChatCompletionResult(message=message, usage={"total_tokens": 10})

    temp = _workspace(root)
    try:
        result = OpenAIToolCodingAgent(FakeProvider()).execute(package, Path(temp.name))
    finally:
        temp.cleanup()

    assert result.evidence.passed is True
    assert "feature_flags/service.py" in result.evidence.changed_paths
    assert result.model_turns == 3
