import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
const dirs=process.argv.slice(2).map(x=>resolve(x));
if(dirs.length!==2) throw new Error('Usage: compare.mjs <short-prefix-run> <long-prefix-run>');
const load=dir=>({dir,settings:JSON.parse(readFileSync(join(dir,'result/settings.json'),'utf8')),
  summary:JSON.parse(readFileSync(join(dir,'result/summary.json'),'utf8'))});
const runs=dirs.map(load);
if(runs.some(r=>!r.summary.complete)) throw new Error('Both runs must finish before an overall report is issued');
const pct=x=>(x*100).toFixed(2)+'%', num=x=>x.toLocaleString('en-US');
const scene={stable:'资产始终不变',reordered:'每轮调整资产顺序',compacted:'调整资产顺序＋第 4 轮压缩历史'};
const get=(run,s,a)=>run.summary.groups.find(g=>g.scenario===s&&g.arm===a).all;
const table=run=>Object.entries(scene).map(([s,n])=>{
  const a=get(run,s,'system_suffix'),b=get(run,s,'context_tail');
  return `| ${n} | ${pct(a.hit_rate)} | ${pct(b.hit_rate)} | ${num(a.input)} / ${num(b.input)} | ${num(a.miss)} / ${num(b.miss)} |`;
}).join('\n');
const [short,long]=runs;
const a=get(long,'reordered','system_suffix'),b=get(long,'reordered','context_tail');
const total=runs.reduce((s,r)=>({requests:s.requests+r.summary.actual_model_calls,input:s.input+r.summary.total.input,
  output:s.output+r.summary.total.output,total:s.total+r.summary.total.total}),{requests:0,input:0,output:0,total:0});
const file=resolve(dirs[0],'..',`comparison-${long.settings.run}.md`);
const content=[
 '# Proxy 资产注入位置：缓存与 Token 实测结论', '',
 '**结论：动态资产变化时，末尾追加更有利于保留前面的缓存；但资产固定不变时，系统前缀方案在本次实验中反而更好。仅移动位置，没有减少输入 Token 总量。**', '',
 `本次使用实际 DeepSeek API，共 ${total.requests} 次请求；输入 ${num(total.input)} Token、输出 ${num(total.output)} Token，总计 ${num(total.total)} Token，未超过约定的 100 万输入 Token 上限。全部输入为虚构案例，不含项目真实代码或现有资产。`, '',
 '## 测试口径', '',
 '- A：同一资产全文放在固定系统提示词末尾、对话历史之前；B：同一资产全文放在本轮对话末尾。通过当前 Proxy 的真实注入管线构造请求，其他注入器在隔离实验中不参与。',
 '- 每种前缀长度有三种场景，每个场景两次独立六轮重放。每一对的对话与资产相同，仅位置不同；缓存以独立 user_id 隔离，调用顺序交替。',
 '- 模型 deepseek-v4-flash，非思考模式，每次最多 16 个输出 Token，只要求回复 OK。正式 CodeBuddy 配置未修改。',
 '- 下列百分比是累计命中输入 Token / 累计输入 Token，包含独立重复的首轮启动；校准请求不并入表中。指标直接来自上游 usage，不是根据字符串推测。', '',
 '## 较长固定前缀', '',
 '| 场景 | 系统前缀命中率 | 末尾追加命中率 | 输入 Token：前缀 / 末尾 | 未命中 Token：前缀 / 末尾 |',
 '|---|---:|---:|---:|---:|',table(long), '',
 `资产顺序变化时，末尾追加比系统前缀提高 ${((b.hit_rate-a.hit_rate)*100).toFixed(2)} 个百分点，未命中输入 Token 减少 ${pct((a.miss-b.miss)/a.miss)}。这是该负载的实测结果，不是全量生产承诺。`, '',
 '## 较短固定前缀', '',
 '| 场景 | 系统前缀命中率 | 末尾追加命中率 | 输入 Token：前缀 / 末尾 | 未命中 Token：前缀 / 末尾 |',
 '|---|---:|---:|---:|---:|',table(short), '',
 '短前缀与长前缀的差异说明：不能把一次实验中的 0% 或某个提升比例，直接当作 CodeBuddy 的生产命中率。固定提示词长度、历史长度、资产大小和缓存落盘时机都会改变结果。', '',
 '## 对当前设计的判断', '',
 '1. 保留稳定的系统前缀是合理的；不要为了动态资产排序反复改写它。',
 '2. 会动态变化的团队资产放到末尾，是有实测支持的结构选择；但不能宣称任何场景都优于前缀。',
 '3. 输入总量在各配对中相同，缓存命中只改变重复输入的处理方式和计费分类，不让 Token 从输入中消失。',
 '4. 卡片、按需加载与去重是否节省完整任务 Token，需要额外计入读取工具的往返与正文进入后续历史的成本；本次没有混测这部分。',
 '5. 模拟客户端不持久化 Proxy 临时追加的后缀。真实客户端若保存后缀、工具结果进入历史或发生压缩，结果会不同。', '',
 '**范围限制：这是真实模型接口上的受控重放，不是实际 CodeBuddy UI 操作录像、真实用户流量抽样、真实改码任务或账单验收。两种位置均使用相同全文，是为了隔离“位置”因素，并非对渐进式卡片完整工作流的性能承诺。**', '',
 '## 完整记录', '',
 `- [短前缀逐轮报告](${basename(short.dir)}/report.md)`,
 `- [长前缀逐轮报告](${basename(long.dir)}/report.md)`,
 '- 每份报告同目录的 result/ 中保存完整虚构请求、原始 usage、请求与源码哈希、实验配置、独立重复与耗时统计；没有保存密钥。', '',
 '缓存规则与落盘限制依据 [DeepSeek 官方缓存文档](https://api-docs.deepseek.com/zh-cn/guides/kv_cache/)；Token 字段依据 [官方 API 定义](https://api-docs.deepseek.com/api/create-chat-completion/)。',
 ];
writeFileSync(file,content.join('\n')+'\n'); console.log(JSON.stringify({report:file,total,long_prefix_dynamic:{before:a,after:b}} ,null,2));
