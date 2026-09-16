from dataclasses import replace
from team_asset_bench.catalog import load_assets, load_task, project_root
from team_asset_bench.decision_policy import DEFAULT_POLICY, DecisionPolicy
from team_asset_bench.orchestrator import TeamAssetOrchestrator
from team_asset_bench.models import EvidenceState


def test_invalid_policies_do_not_silently_widen_feedback_influence():
    import pytest
    with pytest.raises(ValueError): DecisionPolicy(feedback_max_adjustment=.5)
    with pytest.raises(ValueError): DecisionPolicy(retrieval='unknown')


def test_unpublished_corpus_cannot_poison_recall_or_idf():
    root=project_root();assets=load_assets(root);task=load_task(root)
    clean=TeamAssetOrchestrator(assets).select(task)
    bait=replace(assets[0],asset_id='poison',status='candidate',evidence_state=EvidenceState.CANDIDATE,
                 action=task.description*100)
    polluted=TeamAssetOrchestrator([*assets,*[replace(bait,asset_id=f'poison-{i}') for i in range(80)]]).select(task)
    assert [(x.asset.asset_id,x.score) for x in clean.selected]==[(x.asset.asset_id,x.score) for x in polluted.selected]
    assert all(not x.asset.asset_id.startswith('poison-') for x in polluted.recalled)


def test_recall_records_policy_identity_without_claiming_use():
    root=project_root();orchestrator=TeamAssetOrchestrator(load_assets(root));p=orchestrator.select(load_task(root))
    assert p.token_cost<=p.task.token_budget
    assert len(p.selected)<=p.task.max_assets
    assert DEFAULT_POLICY.fingerprint==DecisionPolicy().fingerprint
    assert DEFAULT_POLICY.to_dict()['rrf_k']==10


def test_progressive_disclosure_does_not_reintroduce_legacy_feedback():
    # Turning reviewed content into a card must not add the old local feedback
    # delta on top of Core's already deduplicated, evidence-bound utility.
    root = project_root()
    task = load_task(root)
    original = load_assets(root)[0]
    for mode in ["reviewed_snapshot", "reviewed_pointer"]:
        asset = replace(original, injection_mode=mode, historical_effect=6/11)
        positive = TeamAssetOrchestrator([asset], historical_effects={asset.asset_id: .35}).select(task)
        negative = TeamAssetOrchestrator([asset], historical_effects={asset.asset_id: -.35}).select(task)
        assert positive.recalled and negative.recalled
        assert positive.recalled[0].score == negative.recalled[0].score
        assert positive.recalled[0].features.historical_effect == 6/11
