"""Reproducible, offline grouped policy comparison. No model or Hub writes."""
from __future__ import annotations
import argparse
from dataclasses import replace
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'evaluation/team_asset_bench'))
from team_asset_bench.models import Asset, AssetType, EvidenceState, SourceType, Task
from team_asset_bench.decision_policy import DecisionPolicy, LEGACY_POLICY
from team_asset_bench.orchestrator import TeamAssetOrchestrator
from team_asset_bench.hybrid_retrieval import HybridAssetRetriever

HERE = Path(__file__).resolve().parent

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()

def load_dataset(directory):
    raw = json.loads((directory / 'assets/candidates.json').read_text())
    annotations_path = directory / 'evaluator-only/asset-annotations.json'
    if not annotations_path.exists():
        candidates = list((directory / 'evaluator-only').glob('*annotation*'))
        if not candidates:
            raise ValueError('Missing evaluator annotations')
        annotations_path = candidates[0]
    annotations = json.loads(annotations_path.read_text())
    assets = []
    kinds = {'llm_wiki': (SourceType.WIKI, AssetType.PROJECT_CONSTRAINT), 'chat_memory': (SourceType.CHAT_MEMORY, AssetType.FAILURE_EXPERIENCE), 'skill': (SourceType.SKILL, AssetType.VALIDATION_WORKFLOW), 'code_graph': (SourceType.CODE_GRAPH, AssetType.CODE_KNOWLEDGE)}
    for item in raw:
        snap = item['snapshot']; source, kind = kinds[item['asset_type']]
        project = re.search(r'synthetic/(flags|inventory|webhook|billing)', snap['declared_scope']).group(1)
        graph = json.loads(snap['body']) if source == SourceType.CODE_GRAPH else {}
        # This projection uses public content, not relevance labels. Only the
        # fixed eligibility simulation uses author-defined defect annotations.
        locator = snap['sources'][0]['locator']
        assets.append(Asset(asset_id=item['asset_id'], team_id='calibration', title=item['name'],
            source_type=source, asset_type=kind, contributor='synthetic-contract', source_ref=locator,
            claim=snap['declared_scope'], action=snap['body'], evidence_state=EvidenceState.REVIEWED,
            version=graph.get('revision', '*'), updated_at='2026-09-08T00:00:00Z',
            token_cost=len(snap['body'].encode()) // 2 + 100, keywords=[project], task_types=['bug_fix'],
            paths=['service.py'] if graph else [], status='candidate' if annotations[item['asset_id']]['expected_quality']=='reject' else 'approved',
            retrieval_handle={'bound_repository': 'synthetic/' + project, 'knowledge_key': locator + '@' + snap['content_version']},
            injection_mode='reviewed_snapshot', native_signals={'intrinsic_quality': 1.0}))
    rows = []
    for path in sorted((directory / 'client/tasks').glob('*/task.json')):
        public = json.loads(path.read_text())
        task = Task(task_id=public['task_id'], team_id='calibration', agent_id='calibration',
                    title=public['title'], description=public['description'], repository=public['repository'],
                    version=public['version'], task_type='bug_fix', target_paths=['service.py'], token_budget=6000, max_assets=8)
        answers = json.loads((directory / 'evaluator-only/answers' / (task.task_id + '.json')).read_text())
        rows.append((task, answers))
    return assets, rows, {'assets': digest(raw), 'tasks': digest([t.to_dict() for t,_ in rows]), 'annotations': digest(annotations)}

class CachedRetriever(HybridAssetRetriever):
    cache = {}
    def rank(self, task, assets):
        key = (task.task_id, self.policy.retrieval, self.policy.rrf_k, tuple(a.asset_id for a in assets))
        if key not in self.cache:
            self.cache[key] = super().rank(task, assets)
        return self.cache[key]

def evaluate(policy, assets, tasks):
    rows = []
    for task, answer in tasks:
        package = TeamAssetOrchestrator(assets, policy=policy, retriever=CachedRetriever(policy), as_of=datetime(2026,9,16,tzinfo=timezone.utc)).select(task)
        ids = {s.asset.asset_id for s in package.selected}
        groups = answer['required_information_groups']
        covered = sum(bool(ids & set(g['any_of'])) for g in groups)
        relevant = set(answer['location_assets']) | {a for g in groups for a in g['any_of']}
        violations = [s.asset.asset_id for s in package.selected if TeamAssetOrchestrator._hard_gate(task, s.asset)]
        rows.append({'task_id': task.task_id, 'repository': task.repository, 'selected': sorted(ids),
            'coverage': covered / len(groups), 'covered_groups': covered, 'required_groups': len(groups),
            'location_covered': bool(ids & set(answer['location_assets'])),
            # A conservative task-scope metric, not a claim all remaining assets are useless.
            'outside_required_fraction': len(ids - relevant) / max(1, len(ids)),
            'estimated_tokens': package.token_cost, 'violations': violations})
    return rows

def summary(rows):
    n = len(rows)
    return {'tasks': n, 'coverage': sum(r['coverage'] for r in rows)/n,
            'outside_required_fraction': sum(r['outside_required_fraction'] for r in rows)/n,
            'estimated_tokens': sum(r['estimated_tokens'] for r in rows)/n,
            'location_coverage': sum(r['location_covered'] for r in rows)/n,
            'violations': sum(len(r['violations']) for r in rows)}

def objective(row):
    s=row['development']; p=row['policy']
    complexity = {'bm25': 0, 'rrf': 1, 'legacy': 2}[p['retrieval']]
    return (s['violations'], -round(s['coverage'], 8), round(s['outside_required_fraction'],8), s['estimated_tokens'], complexity,
            abs(p['rrf_k']-60), p['candidate_limit'], p['minimum_relative_score'])

def run(directory, output):
    protocol = json.loads((HERE/'protocol.json').read_text())
    assets, tasks, hashes = load_dataset(directory)
    develop = [(t,a) for t,a in tasks if t.repository.split('/')[-1] in protocol['split']['development']]
    heldout = [(t,a) for t,a in tasks if t.repository.split('/')[-1] in protocol['split']['locked_test']]
    policies = [LEGACY_POLICY]
    for method in ['bm25','rrf']:
        for k in ([60] if method=='bm25' else protocol['candidates']['rrf_k']):
            for threshold in protocol['candidates']['minimum_relative_score']:
                for limit in protocol['candidates']['candidate_limit']:
                    policies.append(DecisionPolicy(retrieval=method, rrf_k=k, minimum_relative_score=threshold, candidate_limit=limit))
    candidates=[]
    for policy in policies:
        rows=evaluate(policy, assets, develop)
        candidates.append({'policy':policy.to_dict(),'development':summary(rows),'rows':rows})
    candidates.sort(key=objective)
    chosen=DecisionPolicy(**candidates[0]['policy'])
    # Selection is frozen here. No search reads held-out results.
    heldout_rows=evaluate(chosen,assets,heldout)
    comparisons=[]
    for policy in [LEGACY_POLICY, DecisionPolicy(retrieval='bm25', rrf_k=60, minimum_relative_score=.4), DecisionPolicy(retrieval='rrf', rrf_k=60, minimum_relative_score=.4),chosen]:
        comparisons.append({'policy':policy.to_dict(),'development':summary(evaluate(policy,assets,develop)),
                            'heldout':summary(evaluate(policy,assets,heldout))})
    result={'schema':'parameter-validation-result/v1','protocol_sha256':digest(protocol),'dataset_hashes':hashes,
        'scope':'conditional ranking after synthetic-contract eligibility simulation, not production quality accuracy',
        'selected_policy':chosen.to_dict(),'selected_policy_sha256':chosen.fingerprint,'candidates':candidates,
        'heldout':summary(heldout_rows),'heldout_rows':heldout_rows,'comparisons':comparisons,
        'limitations':['Three held-out tasks share one repository; no population confidence interval is justified.',
          'TF-IDF fallback, no dense embedding comparison.', 'Labels are developer-defined, not independently expert adjudicated.',
          'Token counts are UTF-8/2 estimates including fixed framing, not provider billing.']}
    output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({k:result[k] for k in ['selected_policy','heldout','comparisons']},ensure_ascii=False,indent=2))

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--dataset',type=Path,required=True);parser.add_argument('--output',type=Path,default=HERE/'results/ranking.json');args=parser.parse_args();run(args.dataset,args.output)
