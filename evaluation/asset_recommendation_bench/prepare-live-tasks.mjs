import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,cpSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {codebuddyApi as api,actor} from '../cache_history_bench/codebuddy-live-api.mjs';
const root=resolve(import.meta.dirname,'../..'),directory=join(root,'output/asset-recommendation-live-20260908');
const path=join(directory,'tasks.json'),run=JSON.parse(readFileSync(join(directory,'run.json')));
const state=existsSync(path)?JSON.parse(readFileSync(path)):{workspace_root:mkdtempSync('/Users/xiaomo/Projects/agent/asset-bench-client-'),tasks:[]};
const save=()=>writeFileSync(path,JSON.stringify(state,null,2));save();
const order=[['task-01-flags','history_append_cards'],['task-05-inventory','front_dynamic_cards'],['task-01-flags','no_team_assets'],['task-05-inventory','history_append_cards'],['task-01-flags','front_dynamic_cards'],['task-05-inventory','no_team_assets']];
for(const [index,[source,arm]]of order.entries()){
  const run_id=`pilot-${index+1}`;if(state.tasks.some(t=>t.run_id===run_id))continue;
  const spec=JSON.parse(readFileSync(join(run.source,'client/tasks',source,'task.json'))),workspace=join(state.workspace_root,run_id);
  if(!existsSync(workspace)){
    cpSync(join(run.source,'client/tasks',source,'workspace'),workspace,{recursive:true,errorOnExist:true});
    for(const args of [['init','--quiet'],['add','.'],['-c','user.name=Asset Benchmark','-c','user.email=benchmark@example.invalid','commit','--quiet','-m','Frozen synthetic task baseline']])execFileSync('git',args,{cwd:workspace});
  }
  const description=`${spec.description}\n仓库：${spec.repository}；基线版本：${spec.version}；目标文件：service.py。\n范围：${spec.scope}。\n只修改当前工作区，自行重现并补充项目测试，不允许读取工作区外的评测材料。独立验收由评测端运行；不提交或部署。`;
  const task=await api('task/create',{team_id:run.team.team_id,creator_user_id:actor,title:`四源评测 ${index+1}：${spec.title}`,description,source_type:'other',source_url:workspace,linked_agents:[{agent_id:run.agents[0].agent_id,role_in_task:'implementer'}],metadata_json:JSON.stringify({synthetic_benchmark:true,source_task:source,repository:spec.repository,version:spec.version,target_paths:['service.py']})});
  const prompts=[
    `本次是独立工程验收。绑定团队“四源资产真实评测 20260908”、Agent“四源资产评测执行 Agent”、看板任务“${task.title}”。当前工作区为 ${workspace}。绑定完成后等待下一条指令，不立即修改。`,
    `请开始当前看板任务的排查阶段：${description}\n先阅读当前代码，使用正常路径冒烟检查并自行构造故障复现；可以新增复现测试，但暂不修改 service.py。若上下文提供团队资料，可按需读取并核对当前代码适用性；不要虚构资料、工具或执行结果。仅使用当前工作区与已提供的授权资料入口，不查找其他目录中的实现或答案。完成排查后简要报告并停下。`,
    '现在进行最小安全修复，并执行你新增的复现测试与项目原有冒烟检查。测试发现的新问题应继续修复。只修改当前工作区，不读取外部评测材料，不删除或放宽既有测试，不提交、不部署。简要列出实际改动、执行结果和仍未验证的条件；完成后停下。',
    '最后独立复核一次当前实现：重新运行项目检查与新增测试，核对当前任务的边界及回归风险，不因模型自述就宣布通过。将真实修复前后结果、使用过的资料及其适用或不适用理由、修改范围与局限写入 RESULT.md；不继续扩展功能，不提交或部署，完成后停止。',
  ];
  state.tasks.push({run_id,arm,source_task:source,task_id:task.task_id,title:task.title,workspace,repository:spec.repository,version:spec.version,baseline_commit:execFileSync('git',['rev-parse','HEAD'],{cwd:workspace,encoding:'utf8'}).trim(),prompts,status:'not_started'});save();
}
writeFileSync(join(directory,'proxy-manifest.json'),JSON.stringify({team_id:run.team.team_id,agent_id:run.agents[0].agent_id,user_id:actor,run_id:'arb-live-20260908',max_calls_per_run:45,runs:state.tasks.map(({run_id,arm,task_id,workspace,repository,version})=>({run_id,arm,task_id,workspace,repository,version}))},null,2));
console.log(JSON.stringify({workspace_root:state.workspace_root,tasks:state.tasks.map(({run_id,task_id,arm})=>({run_id,task_id,arm}))}));
