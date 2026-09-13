/** Offline acceptance analysis. Never mutates weights or automatically applies a threshold. */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
const file = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: node scripts/calibrate-quality.mjs <held-out-labels.json>');
const input = JSON.parse(readFileSync(file, 'utf8'));
if (!Array.isArray(input) || !input.length) throw new Error('Expected non-empty held-out labels array');
const rows = input.map(x => {
  if (!['acceptable','defective','insufficient_evidence'].includes(x.label)) throw new Error('Invalid expert label');
  const report = JSON.parse(readFileSync(resolve(dirname(file), x.report), 'utf8'));
  if (!report.scorecard || !Array.isArray(report.checks)) throw new Error('Expected QualityReport, not a lifecycle wrapper');
  return { label:x.label, type:report.asset_type, report };
});
function evaluate(subset, minimum) {
  let falseAccept=0, falseReject=0, pending=0, accepted=0;
  for(const {label,report:r} of subset) {
    const pass=r.decision==='pass' && r.checks.every(c=>c.status==='pass') && r.scorecard.quality!=null && r.scorecard.quality>=minimum && r.scorecard.evidence_coverage===100;
    if(pass) accepted++; if(pass && label!=='acceptable') falseAccept++;
    if(!pass && label==='acceptable') falseReject++;
    if(r.scorecard.quality==null) pending++;
  }
  const acceptable=subset.filter(x=>x.label==='acceptable').length, notAcceptable=subset.length-acceptable;
  return {minimum,n:subset.length,accepted,false_accept:falseAccept,false_reject:falseReject,pending,
    false_accept_rate:notAcceptable?falseAccept/notAcceptable:null,false_reject_rate:acceptable?falseReject/acceptable:null};
}
console.log(JSON.stringify({purpose:'held_out_validation_not_automatic_tuning',limitations:'Requires independent expert labels; small samples do not establish production accuracy. Keep tuning and held-out sets separate.',
  all:[60,70,75,80,85,90,95].map(t=>evaluate(rows,t)),
  by_type:Object.fromEntries(['llm_wiki','chat_memory','code_graph','skill'].map(type=>[type,evaluate(rows.filter(r=>r.type===type),80)]))},null,2));
