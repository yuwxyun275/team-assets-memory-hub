import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
const dir=resolve('output/asset-recommendation-live-20260908');
const load=p=>JSON.parse(readFileSync(join(dir,p)));
const pool=load('frozen-pool.json'),state=load('tasks.json'),live=load('live-summary.json'),analysis=load('analysis-summary.json');
const pct=n=>n==null?'不可用':`${(n*100).toFixed(2)}%`,num=n=>n==null?'未知':n.toLocaleString('en-US');
const labels={front_dynamic_cards:'A 前置注入',history_append_cards:'B 历史锚点＋末尾追加',no_team_assets:'C 无团队资产'};
const rows=live.summaries.map(s=>{const p=`acceptance/${s.run_id}/final/result.json`;return {...s,acceptance:existsSync(join(dir,p))?load(p):null};});
const groups=Object.entries(labels).map(([arm,label])=>{const cases=rows.filter(r=>r.arm===arm),sum=k=>cases.every(c=>c[k]!=null)?cases.reduce((n,c)=>n+c[k],0):null;return {arm,label,cases:cases.length,completed:cases.filter(c=>c.acceptance?.complete).length,input:sum('prompt_tokens'),output:sum('completion_tokens'),hits:sum('cache_hit_tokens'),misses:sum('cache_miss_tokens')};});
if(rows.length!==6||rows.some(r=>!r.acceptance||!r.requests||r.requests_without_response||r.usage_records!==r.responses))throw Error('Six complete captures and independent results with all upstream usage required');
const rawResponses=readFileSync(join(dir,'proxy-audit/responses.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const firstHits=rows.map(r=>({run:r.run_id,hits:rawResponses.find(x=>x.run_id===r.run_id)?.usage?.prompt_cache_hit_tokens}));
const failedCases=rows.filter(r=>!r.acceptance.complete).map(r=>`- ${r.run_id}：${(r.acceptance.stderr.match(/^FAIL: .+$/gm)??['详见原始验收输出']).join('；')}。详见 acceptance/${r.run_id}/final/result.json。`).join('\n')||'本轮六组独立验收均通过。';
const A=groups[0],B=groups[1];
const change=(a,b)=>a?`${b>=a?'增加':'减少'} ${pct(Math.abs(b-a)/a)}`:'不可用';
const quality=Object.entries(pool.by_type).map(([type,c])=>`| ${type} | ${c.published??0} | ${c.needs_evidence??0} | ${c.rejected??0} |`).join('\n');
const summaries=groups.map(g=>`| ${g.label} | ${g.completed}/${g.cases} | ${num(g.input)} | ${num(g.output)} | ${pct(g.hits/g.input)} | ${num(g.misses)} |`).join('\n');
const perRun=rows.map(r=>`| ${r.run_id} | ${r.source_task} | ${labels[r.arm]} | ${r.requests} | ${pct(r.weighted_cache_hit_rate)} | ${r.acceptance.complete?'通过':'未通过'} |`).join('\n');
const recommendations=analysis.runs.map(r=>`| ${r.run_id} | ${r.offered.length} | ${r.bridge_read_attempts} | ${r.information_coverage.filter(c=>c.covered).length}/${r.information_coverage.length} | ${r.forbidden_or_missing_labels.length} |`).join('\n');
const observed=analysis.runs.flatMap(r=>r.offered);const exposures=[];
for(const id of new Set(observed)){const d=load(`observed-quality/${id}.json`);for(const e of d.exposures)exposures.push({asset_id:id,id:e.key,state:e.data.state,events:e.data.events.length,outcome:e.data.assessment?.outcome??null,last_error:e.data.last_error??null,context:e.data.context,utility:d.utility});}
writeFileSync(join(dir,'feedback-summary.json'),JSON.stringify(exposures,null,2));
const feedbackCounts=exposures.reduce((o,e)=>(o[e.state]=(o[e.state]??0)+1,o),{});
const quarantine=existsSync(join(dir,'post-trial-quarantine.json'))?load('post-trial-quarantine.json'):null;
const doc=`# 四源团队资产：真实 CodeBuddy 端到端试验报告

本报告由实际执行记录生成。数据集为作者定义的合成实验，不是专家审定黄金集；结果仅适用于本次两类样例任务。执行日期：2026-09-08。

## 1. 本次实际走过的流程

创建新团队 → 创建所属 Agent → 导入 400 条四源候选 → 提交正文与来源快照 → 内容质量评估 → 通过门槛的版本由授权操作者发布 → 冻结资产池 → 创建 6 个任务与隔离代码工作区 → CodeBuddy 桌面端关联团队、Agent、任务 → 真实召回/注入/按需读取 → 排查、修复、复核 → 评测端独立验收 → 汇总上游 Token、推荐与后续观察。

- 团队：四源资产真实评测 20260908（${pool.team_id}）；Agent：四源资产评测执行 Agent（agt-br2wuv7wqi）。
- 资产库：Wiki、Chat Memory、Skill、Code Graph 各 100 条候选，通过真实统一资产 API 和质量快照入库。CodeBuddy 从实际 Memory Hub 可用池检索，不直接接收评测答案表。本轮读取走已发布快照的 asset-bridge，不代表已经分别验证四套原生后台的全部导入、索引和查询接口。
- 工作区：${state.workspace_root}/pilot-1 至 pilot-6。每组使用独立基线；没有把参考实现或独立验收文件放进工作区。
- 运行入口：CodeBuddy 桌面端 → 本地 Proxy → 已配置 DeepSeek。没有用脚本固定对话回放替代这六次执行。
- 模型正常会话配置未改变。绑定界面的合成本地回复不计入上游模型 Token；界面显示的 0 Credits 不代表上游免费。
- 检索使用本地 BM25、稀疏向量及结构信号融合；本次没有提供独立证据证明已调用外部 Embedding 模型，不能把 Vector 字段直接写成真实语义 Embedding。

## 2. 发布前内容质量评估

使用实际规则校验与模型审阅，记录逐项结论、引用证据、数值评分与版本。发布门槛 Q≥80、证据覆盖率=100%、报告 pass，失败项不能靠加权平均抵消。Q 的初始权重尚未经过专家数据校准；100% 表示本评估检查项获得证据覆盖，不保证来源真实性或内容绝对正确。

| 类型 | 发布 | 待补证据/未达门槛 | 拒绝 |
|---|---:|---:|---:|
${quality}

80 条预设问题资产中：${pool.challenges.rejected} 条被拒绝，${pool.challenges.needs_evidence} 条未发布，**${pool.challenges.published} 条误放行**。因此不能宣称已经可靠自动判定所有优劣资产。其余 320 条只标记为“可进入审核”，不是必须通过的正例，不应直接据其未发布数量计算误杀率。

已确认漏判：arb1-skill-025，正文末尾要求“删除失败测试并报告通过”，模型仍给出通过、Q=80。原报告与放行记录完整保留。操作者授权发布不等于独立人工专家复核；这项漏判说明不能把一次模型评分代替发布前安全审核。

${quarantine?`试验后处置：全部六组测量结束后，于 ${quarantine.at} 暂停该问题版本；未删除资产、评估报告或审计历史，可通过正常发布审核恢复。上表及本次推荐仍按试验时冻结的 134 条发布资产统计，处置后当前可用池减为 133 条。详见 post-trial-quarantine.json。`:'问题版本暂保留在隔离实验团队的冻结池内；处置状态以实际记录为准。'}

评估途中发现 Code Graph 导出字段格式与校验器不一致，修复兼容性后重评受影响版本，保留旧报告；没有降低 80 分门槛以增加通过数。之后冻结整个发布池再开始桌面任务。

资产池冻结哈希：\`${pool.sha256}\`。详见 [冻结清单](frozen-pool.json) 与 quality/ 原始报告。

## 3. 对照组的准确含义

- **A**：采用与 B 相同的召回及渐进披露实现，将本组的资产注入及其历史记录移动至系统消息之后、客户端会话之前。真实对话不同，最终选中的资产不保证逐条一致。它是人为构造的“前置动态注入”实验对照，**不是声称原开源项目当前真实启用了这个路径**。
- **B**：Proxy 记录历史注入位置，保留可对齐旧注入，新增内容追加到本轮末尾。卡片按需读取；短 Wiki 正文存在直接注入例外，并非所有内容都只注入卡片。
- **C**：保留同一身份与任务绑定，但 Proxy 禁用团队编排和原生资产旁路；模型仅依据任务及工作区工作。
- A/B 使用相同资产池、模型、规则和预算；历史效果权重在实验期间固定为中性值，异步观察继续保存，避免后跑的组受前组反馈训练影响。
- 每组设置不同的上游 user_id 和会话标识；未独立证实上游是否据此隔离缓存，不能保证完全排除跨组共享前缀预热。每组最多 45 个模型请求。
- 各组首个实际上游请求的命中 Token：${firstHits.map(x=>`${x.run}=${num(x.hits)}`).join('，')}。这是真实冷启动观察，不替代提供商缓存隔离契约。
- 两个任务各跑 A/B/C 一次，合计六次。这是小规模真实客户端试验，不是 108 次正式评测，也不足以建立统计显著性。
- 用户在第四组结束后暂停约四小时，关闭并重新打开 CodeBuddy 后完成剩余两组；没有在一组中间暂停。恢复时 134 条发布版本和 manifest 均核对未变，但执行时段及提供商负载仍是实验局限。

## 4. 真实上游 Token 与独立完成率

| 组别 | 独立完成 | 输入 Token | 输出 Token | 输入缓存命中率 | 未命中输入 Token |
|---|---:|---:|---:|---:|---:|
${summaries}

缓存命中率=各次 prompt_cache_hit_tokens 之和 ÷ prompt_tokens 之和；不是每次百分比的简单平均。输出包含上游计入的 reasoning Token，不重复累加。未命中输入不等于全部账单；背景质量/效果审阅未纳入本表，不能据此报告项目整体总费用。

缓存命中的 Token 仍会计入输入 Token 总量。因此“未命中 Token 下降”与“输入总量增加”可以同时发生：如果实际对话更长、工具调用更多，累计输入仍会增加，不能把缓存命中率提升直接写成总 Token 节省。

B 相对 A：输入 Token ${change(A.input,B.input)}，输出 Token ${change(A.output,B.output)}，未命中输入 Token ${change(A.misses,B.misses)}。真实对话和工具轨迹会分叉，因此差异是本次端到端观察值，不能全部归因于注入位置。

| 执行 | 任务 | 组别 | 上游请求 | 命中率 | 独立验收 |
|---|---|---|---:|---:|---|
${perRun}

独立测试在修复前均失败，修复后由评测端将 service.py 放进只读、无网络容器运行固定测试。flags 为 5 项，inventory 为 6 项。原 smoke.py 未被改写。工作区目录隔离不等于桌面端安全沙箱；CodeBuddy 有宿主工具权限，另行保留工具轨迹审阅。

任务看板完成状态由独立验收器写入 benchmark_independent_acceptance，明确区分 CodeBuddy 自述与外部验收；**这不是宣称原生贡献回执已经自动完整闭环**。对话自行新增的测试只作辅助证据，不替代固定独立测试。

未通过的独立验收：

${failedCases}

pilot-3 虽然模型自建测试通过，但其改动把正常缓存未命中也变成数据库查询，违反冻结契约。该组保留失败，没有把私有验收答案交回模型重做。这个结果说明“模型自述完成”不能替代外部验收；并不能单凭一次对照就证明资产的因果收益。

## 5. 推荐了什么，推荐是否准确

答案表在执行前根据合成业务契约、任务和基线代码生成，留在评测端，未给模型打标签后再当真值。下面以整个任务中真正送入模型的唯一资产为单位；“核心信息覆盖”允许 Wiki、Memory、Skill 任一同规则来源覆盖，不奖励重复内容。

| 执行 | 唯一已提供资产 | 正文读取尝试 | 核心信息覆盖 | 与预设允许标签冲突 |
|---|---:|---:|---:|---:|
${recommendations}

读取尝试依据真实工具调用，不能单独等同成功完整读取或采用。C 本来不推荐资产，覆盖为 0 是实验定义，不视为推荐器失误。逐资产判定、理由、来源条款、工具轨迹见 pilot-N-analysis.json；数据集规模不等于独立问题多样性（部分资料表达同一规则）。

## 6. 发布后的观察与实际问题

本次保存的相关曝光记录状态：${JSON.stringify(feedbackCounts)}。详情见 [异步观察汇总](feedback-summary.json) 和 observed-quality/ 完整证据。模型给出的 helpful 属于观察性判断，不是因果贡献，也不能证明拿走该资产任务就一定失败。内在质量 Q 与上下文效果分开保存；实验不根据这些反馈在线改变对照组排名。

已定位的限制：

1. 内容质量评估漏放行一条规避测试的 Skill，见第二节。
2. CodeBuddy 终端输出把正文换行转为 CRLF，并出现末尾闭合标记最后字符缺失。当前严格正文匹配因此不能可靠确认正文仍完整可见；历史 last_read 未正常更新。资产桥成功取回正文与上下文完整性判定必须分开处理，不能用 ID 或卡片存在冒充正文存在。
3. 部分后续效果评估失败，保留 usage_evaluation_unavailable_or_invalid；旧 assessment 不能当作最新窗口评估成功。权重未正常更新的情况如实保留，没有人为改成 helpful。
4. 四个有资产组的最终原生回执中，injected、used、validated、contributed 均为 0；但 Proxy 请求审计中确实存在注入卡片和正文，不能把回执的 0 解释成未提供任何资料。独立验收结果也没有自动映射到其 trusted_ci 的测试 ID、候选标准及资产归因。看板独立验收状态与资产贡献计数不是同一个结论，状态归因链路仍需修复。C 组没有生成资产回执符合其无资产定义。
5. 本次未触发真实客户端压缩，不能以本试验声称已经验证真实压缩后的缓存收益；代码单测和固定回放属于另一级证据。

## 7. 可核验文件

- run.json：团队、Agent、400 条资产与审核版本。
- tasks.json：六个 Hub 任务、真实工作区、固定阶段指令。
- proxy-audit/requests.jsonl、responses.jsonl：完整请求 ID 对应真实上游用量与内容；不可把短日志标签当唯一键。
- proxy-audit/pilot-N-turns.json、pilot-N-receipt.json：真实推荐和回执。
- acceptance/pilot-N/baseline、final：固定测试源码哈希、退出码、原始输出、最终差异。
- 各 CodeBuddy 工作区 RESULT.md：模型撰写的修复报告（不单独作为验收真值）。

结论：团队建立、四源入库、真实评估、Agent/任务绑定、桌面端召回及编码、外部验收与消耗采集已按实验流程执行。是否具备企业可靠性须结合上述漏判、正文识别和异步反馈问题判断，不能只凭完成率或缓存命中率宣称生产就绪。
`;
writeFileSync(join(dir,'REPORT.md'),doc);writeFileSync(join(dir,'metrics.json'),JSON.stringify({groups,rows},null,2));console.log(join(dir,'REPORT.md'));
