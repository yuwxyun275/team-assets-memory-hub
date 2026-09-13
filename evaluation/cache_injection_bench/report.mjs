import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const directory=resolve(process.argv[2]||'');
if(!process.argv[2]) throw new Error('Usage: node report.mjs <run output directory>');
const summary=JSON.parse(readFileSync(join(directory,'result/summary.json'),'utf8'));
const settings=JSON.parse(readFileSync(join(directory,'result/settings.json'),'utf8'));
const requests=JSON.parse(readFileSync(join(directory,'result/requests.json'),'utf8'));
const initialTail=requests.find(x=>x.arm==='context_tail'&&x.rep===1&&x.scenario==='stable'&&x.turn===1);
const fixedChars=initialTail?.body.messages[0].content.length;
const rows=readFileSync(join(directory,'result/responses.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const comparison=rows.filter(x=>x.phase==='comparison');
const name={stable:'资产不变',reordered:'每轮调整资产顺序',compacted:'调整顺序，第 4 轮压缩历史'};
const arm={system_suffix:'系统前缀内注入',context_tail:'对话末尾追加'};
const number=x=>Number(x).toLocaleString('en-US');
const percent=x=>x==null?'不可用':(x*100).toFixed(2)+'%';
const groups=summary.groups;
const table=groups.map(g=>`| ${name[g.scenario]} | ${arm[g.arm]} | ${g.all.requests} | ${percent(g.all.hit_rate)} | ${number(g.all.input)} | ${number(g.all.hit)} | ${number(g.all.miss)} | ${number(g.all.output)} |`).join('\n');
const differences=Object.keys(name).map(scenario=>{
  const a=groups.find(g=>g.scenario===scenario&&g.arm==='system_suffix').all;
  const b=groups.find(g=>g.scenario===scenario&&g.arm==='context_tail').all;
  return `| ${name[scenario]} | ${((b.hit_rate-a.hit_rate)*100).toFixed(2)} 个百分点 | ${percent((a.miss-b.miss)/a.miss)} | ${number(b.input-a.input)} |`;
}).join('\n');
const replica=groups.flatMap(g=>g.per_replica.map(r=>`| ${name[g.scenario]} | ${arm[g.arm]} | ${r.rep} | ${percent(r.hit_rate)} | ${number(r.input)} | ${number(r.miss)} |`)).join('\n');
const timing=groups.map(g=>`| ${name[g.scenario]} | ${arm[g.arm]} | ${g.all.mean_ms?.toFixed(0)} | ${g.all.p50_ms} | ${g.all.p95_ms} |`).join('\n');
const paired=new Map();
for(const r of comparison) {
  const key=`${r.rep}/${r.scenario}/${r.turn}`;
  const pair=paired.get(key)||{};pair[r.arm]=r;paired.set(key,pair);
}
const pairs=[...paired.values()].filter(x=>x.system_suffix&&x.context_tail);
const identicalInputs=pairs.every(x=>x.system_suffix.tokens.input===x.context_tail.tokens.input);
const identicalAssets=pairs.every(x=>x.system_suffix.asset_sha256===x.context_tail.asset_sha256);
const identicalHistories=pairs.every(x=>x.system_suffix.history_sha256===x.context_tail.history_sha256);
const cold=comparison.filter(r=>r.turn===1);
const lines=[
  '# 资产注入位置：DeepSeek 缓存与 Token 对照实测',
  '',`测试编号：${settings.run}。完成状态：${summary.complete?'全部预定请求完成':'未完成，仅有部分数据'}。负载：${settings.workload||'short_fixed_prefix'}；固定系统文本长度：${fixedChars} 字符（不是 Token 数）。`,
  '', '## 1. 测试回答的问题', '',
  '把相同的动态资产放在系统提示词内，或放到本轮对话末尾，对实际缓存命中与 Token 消耗有何影响？',
  '', '这是实际 DeepSeek API 调用，不是根据文本相同长度推算缓存；输入是完全虚构的数据，不包含真实项目代码、现有资产或私人会话。它是位置微基准，不是完整 CodeBuddy 任务验收。',
  '', '## 2. 对照方法与范围', '',
  '- 对照 A：使用现有 Proxy 的 `system.suffix`，将资产追加到固定系统提示词末尾、对话历史之前。它是“系统前缀内注入”的重建对照，并非旧版本二进制回放，也不是将资产放在所有固定系统内容之前。',
  '- 对照 B：使用现有 Proxy 的 `context.tail`，在本轮已有对话末尾追加相同资产。固定系统文本与原有历史不被该钩子改写。',
  '- 两组通过同一份正在运行的 InjectionPipeline 与 OpenAIAdapter 构造请求，仅注册隔离测试钩子；正常 Proxy 配置、资产、发布状态和用户会话均未修改。',
  '- 每组都是相同四份虚构资产全文、相同对话、相同模型与参数。刻意不混入“全文换卡片”带来的内容缩减，故该测试不评估渐进式读取的额外调用或净节省。',
  '- 三种场景各重复两次，每次六轮。资产排序使用六个不同排列，不改正文；压缩场景在第 4 轮使用固定合成摘要替换旧历史。',
  '- 历史是受控重放，不是模型自主生成的真实任务轨迹；模拟客户端不持久化 Proxy 私自添加的本轮后缀。若真实客户端保留了后缀，或工具读取正文进入历史，结果会不同。',
  '- 每个独立场景/重复/策略采用独立 `user_id` 隔离缓存，组间调用顺序交替；同一组相邻请求间隔至少 6 秒。缓存为上游尽力而为机制，没有强制清缓存接口。',
  '',`模型：${settings.model}；非思考模式；temperature=0；每次最多 ${settings.max_output_per_request} 个输出 Token，只要求回复 OK；非流式。此参数仅用于本实验，不修改正常 CodeBuddy 模型设置。`,
  '', '## 3. 上游实测结果', '',
  '**Token 加权缓存命中率 = 所有请求命中输入 Token 之和 ÷ 所有请求输入 Token 之和。** 不采用逐请求百分比的简单平均，不把字段缺失当成零。下表包含每次独立重复的首轮冷启动，校准请求另计。',
  '', '| 场景 | 注入方式 | 请求数 | 缓存命中率 | 输入 Token | 命中 Token | 未命中 Token | 输出 Token |',
  '|---|---|---:|---:|---:|---:|---:|---:|',table,
  '', '### 末尾追加相对系统前缀的差异', '',
  '| 场景 | 命中率变化 | 未命中输入减少比例（负数表示增加） | 输入总量变化 |',
  '|---|---:|---:|---:|',differences,
  '', '输入 Token 总量包含缓存命中部分。命中后只是复用计算，并不意味着那些输入 Token 从请求中消失；上游通常按缓存命中与未命中分别计费。本文不以 Token 差异冒充账单差异，也不套用过期单价计算费用。',
  '', '## 4. 验证与校准', '',
  `- 完整配对数：${pairs.length}；各对资产文本哈希一致：${identicalAssets}；原始对话哈希一致：${identicalHistories}；各对实测输入 Token 相等：${identicalInputs}。`,
  `- 各场景首轮中，命中为零的请求：${cold.filter(r=>r.tokens.hit===0).length}/${cold.length}。`,
  `- 相同请求重复校准：${summary.calibration.map(r=>`第 ${r.turn} 次 ${r.tokens.hit}/${r.tokens.input}，${percent(r.tokens.hit/r.tokens.input)}`).join('；')}。校准不并入对照结果。`,
  `- 总真实调用：${summary.actual_model_calls} 次（含校准）；输入 ${number(summary.total.input)} Token，输出 ${number(summary.total.output)} Token，合计 ${number(summary.total.total)} Token。`,
  '', '### 两次独立重复', '',
  '| 场景 | 方式 | 重复 | 加权命中率 | 输入 Token | 未命中 Token |',
  '|---|---|---:|---:|---:|---:|',replica,
  '', '## 5. 耗时（辅助观察）', '',
  '| 场景 | 方式 | 平均 ms | P50 ms | P95 ms |',
  '|---|---|---:|---:|---:|',timing,
  '', '以上为非流式请求从发出到收到完整 JSON 的耗时，包括网络和极短输出，不是首 Token 延迟。每组仅 12 个请求，不能据此声称真实编码任务更快。',
  '', '## 6. 如何理解这些结果', '',
  '- 固定的系统提示词应该保持稳定，适合缓存。问题不是“系统前缀不好”，而是把会变化的资产排序或正文放在对话历史前面，会改变后续可复用的前缀。',
  '- 固定系统文本与动态历史的长度比例会影响结果。较短固定前缀可能没有形成可复用的落盘单元；某组测得 0% 不代表真实 CodeBuddy 的固定提示词完全不能缓存。',
  '- 资产保持不变时，系统前缀方案也可能很好，甚至优于当前模拟的临时末尾注入。不能只挑资产变化时的数据，宣称尾部注入永远更优。',
  '- 追加方式保护的是它之前未变化的内容；历史压缩仍然会改变上下文，不能保证此前历史全部命中。其他钩子或客户端重写也会影响结果。',
  '- 单纯移动相同资产的位置，不应被宣传为输入 Token 大幅减少。卡片、按需读取与去重影响的是实际内容量，需要另做含工具往返的完整会话对照。',
  '- 本次数据支持对这组虚构负载的描述，不是全量生产命中率、真实用户成本节省或任务成功率的承诺。',
  '', '## 7. 复现与证据文件', '',
  '- `result/requests.json`：逐轮完整请求（只有虚构数据，不含密钥）。',
  '- `result/responses.jsonl`：逐轮上游原始 usage、请求哈希、模型标识、响应 ID 和耗时。',
  '- `result/settings.json`：参数、负载哈希、运行时源码哈希和实验口径。',
  '- `result/summary.json`：总计、分组和两次重复统计。',
  '', '复现：`node evaluation/cache_injection_bench/run.mjs` 只校验请求；`node evaluation/cache_injection_bench/run.mjs --live` 会真实调用已配置的 DeepSeek 上游并产生费用。',
  '', '## 8. 官方统计口径', '',
  '缓存匹配、公共前缀落盘与尽力而为限制见 [DeepSeek 上下文缓存](https://api-docs.deepseek.com/zh-cn/guides/kv_cache/)。`prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens` 及输出字段见 [Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/)。实验缓存隔离使用官方 [user_id 隔离机制](https://api-docs.deepseek.com/quick_start/rate_limit/)。',
];
writeFileSync(join(directory,'report.md'),lines.join('\n')+'\n');
console.log(JSON.stringify({report:join(directory,'report.md'),complete:summary.complete,groups:groups.map(g=>({scenario:g.scenario,arm:g.arm,...g.all})),total:summary.total},null,2));
