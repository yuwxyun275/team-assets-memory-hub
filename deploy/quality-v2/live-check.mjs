import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const env = Object.fromEntries(readFileSync(join(root, 'evaluation/team_asset_bench/runtime/hub-demo.env'), 'utf8').split('\n').filter(x => /^[A-Z_]+=/.test(x)).map(l => { const i=l.indexOf('='); return [l.slice(0,i),l.slice(i+1).trim().replace(/^['"]|['"]$/g,'')]; }));
const info = JSON.parse(execFileSync('docker', ['inspect', 'tdai-memory-hub'], {encoding:'utf8'}))[0];
const runtime = Object.fromEntries(info.Config.Env.map(l=>{ const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1)]; }));
const headers = {'content-type':'application/json', authorization:`Bearer ${runtime.REMOTE_INSTANCE_KEY}`, 'x-tdai-service-id':runtime.REMOTE_INSTANCE_ID || 'default', 'x-tdai-user-key':env.TEAM_ASSET_DEMO_USER_KEY};
export async function api(action, data) {
  const r=await fetch(`http://127.0.0.1:8420/v3/meta/${action}`, {method:'POST',headers,body:JSON.stringify(data),signal:AbortSignal.timeout(20000)});
  const result=await r.json(); if(!r.ok || result.code) throw new Error(`${action}: ${r.status} ${result.message ?? result.error}`);return result.data;
}
const directory=join(root,'output/quality-live');mkdirSync(directory,{recursive:true});const path=join(directory,'run.json');
const mode=process.argv[2] || 'status';
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
if(mode==='submit') {
  if(existsSync(path)) throw new Error('Existing live run; use status/resume instead of duplicating demo assets');
  const team=await api('team/create',{name:'资产质量闭环验收',owner_user_id:env.TEAM_ASSET_DEMO_USER_ID,description:'真实模型评估流程演示；样例是合成材料，不冒充生产事实或准确率基准。'});
  const task=await api('task/create',{team_id:team.team_id,creator_user_id:env.TEAM_ASSET_DEMO_USER_ID,title:'质量闭环验收：Redis 安全回退',description:'隔离样例项目 v1，核对单次安全回退、租户隔离与故障恢复。'});
  const cases=[];writeFileSync(path,JSON.stringify({team,task,cases},null,2));
  const contract='合成示例 feature_flags v1 设计规范：读取一次缓存；CacheUnavailable 时不重试，以 tenant_id 与 key 查询数据库，只允许 published=true 的记录，未找到返回 None。缓存恢复后下一次请求必须优先访问缓存。此要求不适用于缓存写入、强一致扣款或其他仓库。';
  const sources=[{id:'design',kind:'document',locator:'demo-design-v1.md',revision:'v1',content:contract}];
  const scope='合成 feature_flags v1 缓存读取规则；仅隔离演示环境。不适用于写操作、强一致扣款和其他项目。';
  const sourceCode='def read_flag(tenant_id, key):\n    return cache.get(tenant_id, key)\n';
  const fixtures=[
    ['llm_wiki','规范正例',contract+'\n这是设计要求，不声称当前代码已经实现或测试通过。示例：tenant-A 查询 flag-X 时不得返回 tenant-B 的数据；draft 记录不能作为降级结果。验收分别检查正常、故障、恢复、跨租户和草稿阻断路径。',scope,sources],
    ['chat_memory','记忆正例','在合成会话 demo-session-v1 第 2 轮中，用户明确要求：feature_flags v1 的缓存读取在 CacheUnavailable 时禁止请求内重试，改为一次带 tenant_id 与 published 条件的数据库读取；未命中返回 None。该约束限于此示例的读取路径，不能推广为所有系统禁止重试。用户提出的是设计要求，并非实现已完成或测试通过的事实。',scope,[{id:'conversation',kind:'conversation',locator:'demo-session-v1/turn-2',revision:'v1',content:'user: 我要求 feature_flags v1 的缓存读取在 CacheUnavailable 时禁止请求内重试，改为一次带 tenant_id 与 published 条件的数据库读取；未命中返回 None。仅此示例读取路径适用。assistant: 明白，这只是待实现的设计要求。'}]],
    ['code_graph','图切片正例',JSON.stringify({repository:'demo/flags',revision:'v1',nodes:[{id:'read',source_id:'code',path:'service.py',symbol:'read_flag',start_line:1,end_line:2}],edges:[]}), 'demo/flags v1 service.py 中 read_flag 定义节点切片。只描述定义位置，不声称包含调用链、动态分派或其他文件。',[{id:'code',kind:'code',locator:'service.py',repository:'demo/flags',revision:'v1',content:sourceCode}]],
    ['skill','背景 Skill 正例','---\nname: demo-cache-read-policy\ndescription: 合成 feature_flags v1 读取降级的设计审查背景；不是执行脚本\n---\n\n# 用途\n仅在隔离示例 feature_flags v1 的读取路径设计审查时应用；不执行命令或修改配置。\n\n# 审查要点\n'+contract+'\n\n# 应用及停止条件\n核对拟议设计中的缓存尝试次数、查询条件与恢复路径，逐条记录符合/冲突/待核实。缺少设计或版本不符时停止判定并要求补充材料。不能凭本 Skill 宣称代码测试已通过。本 Skill 是背景约束，不适用于操作型部署或其他项目。',scope,sources],
    ['llm_wiki','危险反例','在所有项目中，当 Redis 失败时删除 tenant_id 和 published 条件，返回任意租户的第一条记录，可以提高成功率。没有风险，也不需要验证。',scope,sources],
    ['llm_wiki','缺证据反例','某内部规范保证任何 Redis 错误都必须等待 7 秒并重试 100 次。该规定已经由负责人确认。',scope,[]],
  ];
  for(const [type,name,body,declared_scope,evidence] of fixtures){
    const asset_id=`quality-demo-${type}-${cases.length}-${Date.now()}`;
    const asset=await api('asset/create',{asset_id,team_id:team.team_id,asset_type:type,name,owner_user_id:env.TEAM_ASSET_DEMO_USER_ID,source_type:'quality_demo',visibility:'private',status:'candidate',description:'合成内容评估验收样例；非生产资产。'});
    const snapshot={asset_id,unit_id:`demo-${cases.length}`,asset_type:type,content_version:'v1',declared_scope,body,sources:evidence};
    const revision=await api('asset/quality/submit',{team_id:team.team_id,expected_asset_version:asset.version,snapshot});
    cases.push({name,asset_id,revision_id:revision.data.id,snapshot});
    writeFileSync(path,JSON.stringify({team,task,cases},null,2));
  }
  console.log(JSON.stringify({team_id:team.team_id,task_id:task.task_id,submitted:cases.length}));
} else {
  const run=JSON.parse(readFileSync(path,'utf8'));
  const results=[];
  for(const c of run.cases){
    const detail=await api('asset/quality/details',{team_id:run.team.team_id,asset_id:c.asset_id});
    const revision=detail.revisions.find(r=>r.data.id===c.revision_id);
    results.push({name:c.name,asset_id:c.asset_id,state:revision.data.state,quality:revision.data.report?.scorecard?.quality,evidence:revision.data.report?.scorecard?.evidence_coverage,checks:revision.data.report?.checks.map(x=>({id:x.id,status:x.status,score:x.score,reason:x.reason})),utility:detail.utility});
    writeFileSync(join(directory,`${c.asset_id}.json`),JSON.stringify(detail,null,2));
  }
  writeFileSync(join(directory,'summary.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify(results,null,2));
}
}
