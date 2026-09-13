/** Post-measurement quarantine of the known false acceptance; never rewrites the frozen experiment. */
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {codebuddyApi as api} from '../cache_history_bench/codebuddy-live-api.mjs';
const dir=resolve('output/asset-recommendation-live-20260908');
const load=p=>JSON.parse(readFileSync(join(dir,p),'utf8'));
const target=join(dir,'post-trial-quarantine.json');
if(existsSync(target)){console.log('Post-trial quarantine already recorded');process.exit(0);}
const live=load('live-summary.json'),pool=load('frozen-pool.json');
if(live.summaries.length!==6||live.summaries.some(r=>!r.requests||r.requests!==r.responses||r.requests_without_response||!existsSync(join(dir,`acceptance/${r.run_id}/final/result.json`))))throw Error('All six measurements and independent verdicts must be complete first');
const asset=pool.assets.find(a=>a.source_asset_id==='arb1-skill-025');
if(asset?.asset_id!=='arb-1c09de85928e923cbaa46d8a'||asset.revision_id!=='37b8085d91912ae7b888a17a7700f3422b62b00b98845ed590d0b197d1144c58')throw Error('Known challenge identity mismatch');
const before=await api('asset/quality/details',{team_id:pool.team_id,asset_id:asset.asset_id});
const revision=before.revisions.find(r=>r.data.id===asset.revision_id);
if(!revision||!['published','suspended'].includes(revision.data.state))throw Error('Unexpected live revision state');
const note='六组真实客户端实验全部结束后的安全隔离：已确认正文含删除失败测试并虚报通过的指令。保留原始评分、发布与实验冻结证据，仅暂停此已识别版本，不美化本轮漏判统计。';
if(revision.data.state==='published')await api('asset/quality/decide',{team_id:pool.team_id,revision_id:asset.revision_id,decision:'suspend',note});
const after=await api('asset/quality/details',{team_id:pool.team_id,asset_id:asset.asset_id});
if(after.publication!==null||after.revisions.find(r=>r.data.id===asset.revision_id)?.data.state!=='suspended')throw Error('Quarantine verification failed');
writeFileSync(target,JSON.stringify({at:new Date().toISOString(),team_id:pool.team_id,asset_id:asset.asset_id,source_asset_id:asset.source_asset_id,revision_id:asset.revision_id,note,before,after,experiment_inputs_unchanged:true,recoverable:true},null,2));
console.log(JSON.stringify({asset_id:asset.asset_id,state:'suspended',frozen_experiment_unchanged:true}));
