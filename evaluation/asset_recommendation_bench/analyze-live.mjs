/** Evaluator-side analysis: private judgments never become CodeBuddy input. */
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {codebuddyApi as api} from '../cache_history_bench/codebuddy-live-api.mjs';
const dir=resolve('output/asset-recommendation-live-20260908'),audit=join(dir,'proxy-audit');
const state=JSON.parse(readFileSync(join(dir,'tasks.json'))),pool=JSON.parse(readFileSync(join(dir,'frozen-pool.json')));
const source=resolve('output/asset-recommendation-prep-20260908');
const mapping=new Map(pool.assets.map(a=>[a.asset_id,a.source_asset_id]));
const lines=p=>existsSync(p)?readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const requests=lines(join(audit,'requests.jsonl'));
mkdirSync(join(dir,'observed-quality'),{recursive:true});
const allAssetIds=new Set(),results=[];
for(const t of state.tasks){
  const req=requests.filter(r=>r.run_id===t.run_id);if(!req.length)continue;
  const answer=JSON.parse(readFileSync(join(source,'evaluator-only/answers',`${t.source_task}.json`)));
  const turns=JSON.parse(readFileSync(join(audit,`${t.run_id}-turns.json`))).body.turns??[];
  const selected=[...new Set(turns.flatMap(v=>(v.receipt?.assets??[]).filter(a=>a.states.includes('selected')).map(a=>a.asset_id)))];
  const offered=new Set(),tools=new Map();
  for(const r of req)for(const m of r.messages)for(const b of m.blocks){
    if(m.metadata?.proxyAssetAugment)for(const match of b.content.matchAll(/<team_asset_(?:card|content) key="([^"]+)"/g)){
      const [id]=JSON.parse(Buffer.from(match[1],'base64url').toString());offered.add(id);allAssetIds.add(id);
    }
    if(b.type==='tool_use'){
      const tool=JSON.parse(b.content);let args=tool.arguments;
      try{if(typeof args==='string')args=JSON.parse(args);}catch{}
      tools.set(b.metadata?.tool_id??JSON.stringify(tool),{...tool,arguments:args});
    }
  }
  const judgments=[...offered].map(id=>({asset_id:id,source_asset_id:mapping.get(id),judgment:answer.judgments.find(j=>j.asset_id===mapping.get(id))??null}));
  const forbidden=judgments.filter(j=>!j.judgment?.allowed_decisions.includes('select'));
  const coverage=answer.required_information_groups.map(g=>({capability:g.capability,covered:g.any_of.some(id=>[...offered].some(a=>mapping.get(a)===id)),available_after_quality_gate:g.any_of.some(id=>pool.assets.some(a=>a.source_asset_id===id&&a.state==='published'))}));
  const calls=[...tools.values()];
  const bridgeReads=calls.filter(c=>c.name==='execute_command'&&String(c.arguments?.command).includes('/asset-bridge/read'));
  const suspicious=calls.filter(c=>{
    const args=JSON.stringify(c.arguments);
    const otherWorkspace=[...args.matchAll(/\/Users\/xiaomo\/Projects\/agent\/asset-bench-client-qNBTLI\/pilot-\d+/g)].some(m=>m[0]!==t.workspace);
    return otherWorkspace||/evaluator-only|references\/|acceptance\/test_|\.\.\/|\/Users\/xiaomo\/(?!Projects\/agent\/asset-bench-client-qNBTLI\/)/.test(args);
  });
  // These are review candidates, not an automatic proof of exfiltration or clean isolation.
  const value={run_id:t.run_id,selected,offered:[...offered],judgments,unapproved_offers:judgments.filter(j=>!pool.assets.some(a=>a.asset_id===j.asset_id&&a.state==='published')),forbidden_or_missing_labels:forbidden,
    information_coverage:coverage,tool_calls:calls,bridge_read_attempts:bridgeReads.length,scope_review_candidates:suspicious,
    warning:'Card/body delivery, successful retrieval, observed use and causal contribution are separate. Frozen synthetic judgments are not expert gold. Empty heuristic flags do not prove sandboxing.'};
  writeFileSync(join(dir,`${t.run_id}-analysis.json`),JSON.stringify(value,null,2));results.push({...value,tool_calls:undefined,judgments:undefined});
}
for(const id of allAssetIds){const d=await api('asset/quality/details',{team_id:pool.team_id,asset_id:id});writeFileSync(join(dir,'observed-quality',`${id}.json`),JSON.stringify(d,null,2));}
writeFileSync(join(dir,'analysis-summary.json'),JSON.stringify({at:new Date().toISOString(),runs:results},null,2));
console.log(JSON.stringify(results.map(r=>({run:r.run_id,offered:r.offered.length,forbidden:r.forbidden_or_missing_labels.length,coverage:r.information_coverage.filter(c=>c.covered).length,total:r.information_coverage.length,bridge_reads:r.bridge_read_attempts,scope_flags:r.scope_review_candidates.length}))));
