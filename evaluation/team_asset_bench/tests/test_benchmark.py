from team_asset_bench.catalog import project_root
from team_asset_bench.runner import run_matrix


def test_counterfactual_matrix_proves_distinct_team_asset_effects():
    summary = run_matrix(project_root())
    runs = summary["runs"]
    assert not runs["no_assets"]["task_completed"]
    assert runs["minimal_team_assets"]["task_completed"]
    assert runs["minimal_team_assets"]["test_pass_rate"] == 1.0
    assert runs["minimal_team_assets"]["asset_token_cost"] < runs["full_context"]["asset_token_cost"]
    for effect in summary["comparisons"]["asset_ablations"].values():
        assert effect["positive"] is True
    candidate = summary["feedback_candidate"]
    assert candidate["publication_state"] == "candidate"
    assert candidate["authority"] is False
    assert candidate["review_required"] is True
