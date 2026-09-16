"""Replay stored model checks. Negatives are contract defects, positives unlabelled."""
import argparse, hashlib, json
from pathlib import Path
HERE=Path(__file__).resolve().parent

def export(reviews, annotations, output):
    labels=json.loads(annotations.read_text());rows=[]
    for path in sorted(reviews.glob('*.json')):
        record=json.loads(path.read_text());revisions=record.get('revisions',[])
        revision=max(revisions,key=lambda r:r.get('updated',0)) if revisions else None
        report=revision['data'].get('report') if revision else None
        if not report: raise ValueError(f'Missing report: {path.name}')
        card=report['scorecard'];label=labels[path.stem]
        rows.append({'asset_id':path.stem,'project':label['project'],'label':label['expected_quality'],
            'reviewer':report['reviewer']['id'],'decision':report['decision'],'dimensions':card['dimensions'],
            'evidence_coverage':card['evidence_coverage'],'all_checks_pass':all(c['status']=='pass' for c in report['checks']),
            'source_report_sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
    output.write_text(json.dumps({'provenance':'actual stored model reviews on developer-authored synthetic contracts',
        'labels':'reject is known defect; eligible_for_review is NOT an acceptable label','rows':rows},ensure_ascii=False,indent=2)+'\n')

def analyze(path, output):
    data=json.loads(path.read_text());rows=data['rows'];result=[]
    for name,weights in [('legacy',dict(correctness=.4,completeness=.25,boundaries=.2,usability=.15)),('equal',dict(correctness=.25,completeness=.25,boundaries=.25,usability=.25))]:
        for threshold in [75,80,85,90]:
            splits={}
            for split,projects in [('development',['flags','inventory','webhook']),('heldout',['billing'])]:
                selected=[r for r in rows if r['project'] in projects];negative=[r for r in selected if r['label']=='reject']
                def passed(r):
                    ds=r['dimensions'];return (r['decision']=='pass' and r['all_checks_pass'] and r['evidence_coverage']==100 and all(v is not None for v in ds.values()) and round(sum(ds[k]*w for k,w in weights.items()))>=threshold)
                splits[split]={'reports':len(selected),'known_defects':len(negative),'defects_passing':sum(passed(r) for r in negative),
                    'defects_passing_with_current_rules':sum(passed(r) and not r.get('current_rule_blockers') for r in negative),
                    'unlabelled_passing':sum(passed(r) for r in selected if r['label']!='reject')}
            result.append({'aggregation':name,'weights':weights,'threshold':threshold,**splits})
    output.write_text(json.dumps({'input_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'comparisons':result,
        'decision':{'aggregation':'equal','threshold':80,'basis':'Equal importance convention avoids unsupported precision. Threshold 80 remains existing governance policy, not fitted optimum.',
         'limitations':'No independently labelled acceptable set. False rejection rate and optimal threshold cannot be inferred. Defect pass counts audit the joint gate, not Q alone.'}},ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(result,ensure_ascii=False,indent=2))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--reviews',type=Path);p.add_argument('--annotations',type=Path);p.add_argument('--input',type=Path,default=HERE/'results/quality-input.json');p.add_argument('--output',type=Path,default=HERE/'results/quality.json');a=p.parse_args()
    if a.reviews: export(a.reviews,a.annotations,a.input)
    analyze(a.input,a.output)
