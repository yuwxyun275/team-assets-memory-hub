/** Explicit operator recovery, narrowly scoped to this closure's optional-field bug. */
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {codebuddyApi as api} from '../cache_history_bench/codebuddy-live-api.mjs';
const root=resolve(import.meta.dirname,'../..'),output=resolve(process.argv[2]||'');
if(!process.argv[2]||existsSync(output))throw Error('provide a new recovery audit filename');
const run=JSON.parse(readFileSync(join(root,'output/closure-live-20260910/run.json'),'utf8'));
const receipt=await api('asset/quality/task-receipt',{team_id:run.team_id,task_id:run.task.task_id});
const operations=[];
for(const asset_id of new Set(receipt.items.map(i=>i.asset_id))){
  const detail=await api('asset/quality/details',{team_id:run.team_id,asset_id});
  for(const row of detail.exposures){
    const d=row.data;
    if(d.task_id!==run.task.task_id||d.session_id!==run.session_id||d.state!=='failed'||d.last_error!=='invalid_format'
      ||!d.error_details?.issues?.every(i=>i.startsWith('asset_quote: too_small'))||!d.error_details.issues.length
      ||(d.total_attempts??0)>=20||d.expires<=Date.now())continue;
    const result=await api('asset/quality/retry-use',{team_id:run.team_id,exposure_id:row.key,
      note:'已修复 unobserved 结果的空可选 asset_quote 格式兼容问题；重新评估原始证据，不预设正面结论，保留原始失败记录。'});
    operations.push({exposure_id:row.key,asset_id,state:result.data?.state??result.state??'submitted',previous_attempts:d.total_attempts});
  }
}
writeFileSync(output,JSON.stringify({at:new Date().toISOString(),task:run.task.task_id,operations},null,2),{mode:0o600});
console.log(JSON.stringify({retried:operations.length,task:run.task.task_id}));
