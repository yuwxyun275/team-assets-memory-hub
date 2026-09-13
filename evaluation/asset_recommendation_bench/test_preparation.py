"""Offline integrity checks; no self-reported LLM grades."""
import json
import unittest
from pathlib import Path
from build import ROOT, narrative_assets, graph_assets, answer_sheet, definition_graph, substitute
from specs import PROJECTS, TASKS


class PreparationChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tasks = []
        for index, (project, title, prompt, symbol, rules, fault, mutant, focus) in enumerate(TASKS, 1):
            source = (ROOT / "references" / f"{project}.py").read_text()
            cls.tasks.append({"id": f"task-{index:02d}-{project}", "project": project, "target_symbol": symbol,
                              "required_rules": rules, "baseline": substitute(source, fault)})
        cls.assets, cls.annotations = narrative_assets()
        assets, annotations = graph_assets(cls.tasks)
        cls.assets += assets
        cls.annotations.update(annotations)

    def test_four_hundred_unique_records(self):
        self.assertEqual(len(self.assets), 400)
        self.assertEqual(len({a["asset_id"] for a in self.assets}), 400)
        self.assertEqual(len({a["snapshot"]["body"] for a in self.assets}), 400)
        for kind in ["llm_wiki", "chat_memory", "skill", "code_graph"]:
            self.assertEqual(sum(a["asset_type"] == kind for a in self.assets), 100)

    def test_no_answer_labels_in_upload_records(self):
        for a in self.assets:
            self.assertNotIn("expected_quality", a)
            self.assertNotIn("judgments", a)
            self.assertEqual(a["initial_status"], "candidate")
            self.assertNotIn("expected_quality", a["snapshot"])
        self.assertEqual(sum(a["expected_quality"] == "reject" for a in self.annotations.values()), 80)

    def test_each_task_has_valid_rule_and_location_choices(self):
        for task in self.tasks:
            answer = answer_sheet(task, self.assets, self.annotations)
            self.assertEqual(len(answer["judgments"]), 400)
            self.assertTrue(answer["location_assets"])
            for group in answer["required_information_groups"]:
                self.assertEqual(len(group["any_of"]), 3)
                self.assertTrue(all(self.annotations[x]["expected_quality"] != "reject" for x in group["any_of"]))

    def test_graph_locations_and_edges_are_source_checked(self):
        verified = rejected = 0
        edge_count = 0
        for a in self.assets:
            if a["asset_type"] != "code_graph":
                continue
            graph = json.loads(a["snapshot"]["body"])
            source = a["snapshot"]["sources"][0]["content"]
            expected_nodes, expected_edges = definition_graph(source)
            expected_by_id = {n["id"]: n for n in expected_nodes}
            locations_ok = all(n == expected_by_id[n["id"]] for n in graph["nodes"])
            all_ids = {n["id"] for n in graph["nodes"]}
            self.assertTrue(all(e in expected_edges and e["source"] in all_ids and e["target"] in all_ids for e in graph["edges"]))
            edge_count += len(graph["edges"])
            if self.annotations[a["asset_id"]]["expected_quality"] == "reject":
                self.assertFalse(locations_ok)
                rejected += 1
            else:
                self.assertTrue(locations_ok)
                verified += 1
        self.assertEqual((verified, rejected), (80, 20))
        self.assertGreater(edge_count, 20)

    def test_cross_project_reference_is_not_automatically_wrong(self):
        sheet = answer_sheet(self.tasks[0], self.assets, self.annotations)
        cross = [j for j in sheet["judgments"] if j["verdict"] == "cross_project_conditions_unverified"]
        self.assertTrue(cross)
        self.assertTrue(all("adapt_after_code_verification" in j["allowed_decisions"] for j in cross))

    def test_baselines_do_not_contain_reference_label(self):
        for task in self.tasks:
            self.assertNotIn("reference implementation", task["baseline"])
            self.assertNotIn("evaluator-only", task["baseline"])

    def test_no_future_model_metrics_claimed(self):
        # The builder only executes local acceptance; it has no network client.
        source = (ROOT / "build.py").read_text()
        self.assertIn('"actual_model_requests": 0', source)
        self.assertNotIn('import requests', source)
        self.assertNotIn('import urllib', source)


if __name__ == "__main__":
    unittest.main()
