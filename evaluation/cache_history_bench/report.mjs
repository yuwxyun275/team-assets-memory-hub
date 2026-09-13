import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const directory = resolve(process.argv[2]);
const result = join(directory, 'result');
const read = name => JSON.parse(readFileSync(join(result, name), 'utf8'));
const summary = read('summary.json'), settings = read('settings.json'), plans = read('requests.json'), checks = read('validation.json');
const rows = readFileSync(join(result, 'responses.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
assert.ok(summary.complete, 'Do not present partial data as a complete experiment');
assert.equal(rows.length, 111);
const comparison = rows.filter(r => r.phase === 'comparison');
const hash = s => createHash('sha256').update(s).digest('hex');
const key = x => `${x.rep}/${x.scenario}/${x.turn}/${x.arm}`;
const byKey = new Map(plans.map(p => [key(p), p]));
for (const row of comparison) {
  const plan = byKey.get(key(row)); assert.ok(plan);
  assert.equal(row.request_sha256, hash(JSON.stringify(plan.body)));
  assert.equal(row.tokens.input, row.tokens.hit + row.tokens.miss);
  assert.equal(row.tokens.total, row.tokens.input + row.tokens.output);
}
assert.equal(new Set(comparison.map(key)).size, 108);
assert.equal(checks.length, 54);
assert.ok(checks.every(c => c.same_cards && c.same_reference_text && c.client_history_preserved));
const fmt = n => Number(n).toLocaleString('en-US');
const pct = n => `${(100 * n).toFixed(2)}%`;
const pp = n => `${(100 * n).toFixed(2)} 个百分点`;
const names = { stable: '已有资产不变', growing: '随任务推进新增资产', compacted: '新增资产＋第 5 轮压缩历史' };
const armNames = { front_dynamic: 'A 前置动态注入', history_tail: 'B 历史补齐＋末尾追加' };
const control = summary.arms.find(a => a.arm === 'front_dynamic');
const treatment = summary.arms.find(a => a.arm === 'history_tail');
const group = (s, a) => summary.groups.find(g => g.scenario === s && g.arm === a);
const aggregate = values => {
  const sum = k => values.reduce((s, x) => s + x.tokens[k], 0);
  return { input: sum('input'), hit: sum('hit'), miss: sum('miss'), output: sum('output'), rate: sum('hit') / sum('input') };
};
const text = [
  '# Proxy 卡片注入策略：真实上游缓存与 Token 对照实验',
  '', `运行标识：${settings.run}`, '',
  '## 结论', '',
  `本次受控实验中，A 的整体输入缓存命中率为 **${pct(control.hit_rate)}**，B 为 **${pct(treatment.hit_rate)}**，差值为 **${pp(treatment.hit_rate - control.hit_rate)}**。`, '',
  `A 未命中输入 ${fmt(control.miss)} Token，B 为 ${fmt(treatment.miss)} Token，变化为 **${pct((treatment.miss - control.miss) / control.miss)}**。输入总量 A 为 ${fmt(control.input)}、B 为 ${fmt(treatment.input)}，变化为 **${pct((treatment.input - control.input) / control.input)}**。缓存命中 Token 仍属于输入 Token，不能把未命中减少说成总输入减少。`, '',
  '**对照组不是原版开源项目。** A 是为隔离变量构建的前置动态注入策略；原版包含 session_init 稳定注入和按需读取，不能宣称原版一定发生相同的缓存损失。', '',
  '## 实验口径', '',
  '- 111 次实际 DeepSeek 请求：108 次主对照（3 场景 × 3 独立重复 × 6 轮 × 2 组）和 3 次独立的相同请求校准。主结果不混入校准。',
  `- 模型 ${settings.model}；非思考、temperature=0、最多输出 16 Token，只回复 OK。正式 CodeBuddy 模型配置未修改。`,
  '- B 调用部署容器里的 AssetHistoryCoordinator、磁盘台账、渐进式披露渲染器、InjectionPipeline 和 OpenAIAdapter；运行前核实这些文件与工作区版本的 SHA-256 一致。',
  '- ACL 服务与推荐选择固定为合成数据。工具读取结果、历史和压缩摘要为脚本预置；未运行真实改码、真实 CodeBuddy 压缩、自主资产检索或异步质量评估。',
  '- 每轮先通过 B 得到实际资产补充块，再将同样的块放入 A 的系统提示词末尾、用户历史之前。两边资产版本、卡片文字、顺序、正文工具结果、索引入口和提示文字相同。角色/消息边界开销不同，保留并如实统计。',
  '- 不打乱资产排序，不修改资产版本。A 也保留已经提供的卡片，避免因资料缺失制造比较偏差。',
  '- 稳定场景从第一轮提供 4 张卡片。新增场景逐轮提供 1、1、2、3、4、4 张卡片。压缩场景同样推进，并在第 5 轮以摘要代替早期历史；B 将旧卡片汇为摘要后的索引。第 5 轮同时新增第 4 张卡，因此这一场景衡量组合流程，不单独估计压缩的因果贡献。',
  '- 每个“组别/重复/场景”使用独立 user_id，两组同一配对的消息正文相同；配对先后交替、按轮次穿插。相同缓存分组的请求至少间隔 10 秒，减少缓存尚未落盘带来的干扰。',
  '- 主对照不预热，不丢弃第一轮。三次校准使用独立 user_id，不用于给对照预热。没有服务端清缓存权限，因此不声称保证冷启动；这是一次小样本受控实验，不是生产平均收益。', '',
  '## 按场景结果（包含首轮）', '',
  '| 场景 | 注入策略 | 请求数 | 输入 Token | 命中率 | 未命中 Token | 输出 Token |',
  '|---|---|---:|---:|---:|---:|---:|',
  ...summary.groups.map(g => `| ${names[g.scenario]} | ${armNames[g.arm]} | ${g.all.requests} | ${fmt(g.all.input)} | ${pct(g.all.hit_rate)} | ${fmt(g.all.miss)} | ${fmt(g.all.output)} |`), '',
  '## 两组总体统计（不含校准）', '',
  '| 指标 | A 前置动态注入 | B 当前历史追加 |', '|---|---:|---:|',
  `| 输入总 Token | ${fmt(control.input)} | ${fmt(treatment.input)} |`,
  `| 命中输入 Token | ${fmt(control.hit)} | ${fmt(treatment.hit)} |`,
  `| 未命中输入 Token | ${fmt(control.miss)} | ${fmt(treatment.miss)} |`,
  `| Token 加权命中率 | ${pct(control.hit_rate)} | ${pct(treatment.hit_rate)} |`,
  `| 输出 Token | ${fmt(control.output)} | ${fmt(treatment.output)} |`,
  `| 输入＋输出 Token | ${fmt(control.total)} | ${fmt(treatment.total)} |`,
  `| 请求耗时中位数（毫秒，非首 Token 延迟） | ${fmt(control.p50_ms)} | ${fmt(treatment.p50_ms)} |`, '',
  '## 各轮缓存命中率（三次重复按 Token 加权）', '',
  '| 场景 | 轮次 | A 命中率 | B 命中率 | A 未命中 | B 未命中 |', '|---|---:|---:|---:|---:|---:|',
  ...settings.scenarios.flatMap(s => Array.from({ length: 6 }, (_, i) => {
    const a = aggregate(comparison.filter(r => r.scenario === s && r.turn === i + 1 && r.arm === 'front_dynamic'));
    const b = aggregate(comparison.filter(r => r.scenario === s && r.turn === i + 1 && r.arm === 'history_tail'));
    return `| ${names[s]} | ${i + 1} | ${pct(a.rate)} | ${pct(b.rate)} | ${fmt(a.miss)} | ${fmt(b.miss)} |`;
  })), '',
  '## 重复实验的波动', '',
  '| 场景 | 重复 | A 命中率 | B 命中率 |', '|---|---:|---:|---:|',
  ...settings.scenarios.flatMap(s => Array.from({ length: 3 }, (_, i) => `| ${names[s]} | ${i + 1} | ${pct(group(s, 'front_dynamic').per_replica[i].hit_rate)} | ${pct(group(s, 'history_tail').per_replica[i].hit_rate)} |`)), '',
  '## 校验与实验总用量', '',
  `- ${checks.length} 组配对通过卡片一致、无重复、原始历史不改写检查；${checks.filter(c => c.prefix_preserved).length} 次未压缩后续请求通过旧增强前缀精确保持检查；3 次压缩均保留失效锚点审计。`,
  '- 前缀检查只是结构校验，不用于估算缓存命中；上表全部来自实际 usage。每条返回均验证 input = hit + miss，total = input + output，并与保存的请求哈希对应。',
  `- 相同请求校准命中率依次为：${summary.calibration.map(r => pct(r.tokens.hit / r.tokens.input)).join('、')}。`,
  `- 非 OK 回答：${summary.non_acknowledgements} 次；固定历史不会把模型不同回答传播到下一轮，因此这是可比的请求回放，不是自由生成的完整对话。`,
  `- 本次全部 111 次请求合计：输入 **${fmt(summary.total_including_calibration.input)}**，输出 **${fmt(summary.total_including_calibration.output)}**，总计 **${fmt(summary.total_including_calibration.total)} Token**。无自动重试、无正式配置变更。`, '',
  '## 如何理解与不能得出的结论', '',
  '1. 已有资产不变时，前置区域也可以保持稳定，不应声称前置注入必然无缓存。新增资产或历史重组时，两种组织方式可复用的前缀不同；本实验保留所有有利和不利场景。',
  '2. B 保留旧卡片原位置，新增资料在后面，不代表无需再次发送旧卡片；输入计数仍包含它们。命中意味着更多输入可使用缓存，并非这些 Token 从请求里消失。',
  '3. 压缩替换了历史内容，旧的完整前缀无法原样继续匹配；重建索引不是恢复旧 KV。新摘要与索引稳定后，后续请求才有机会复用新的前缀。',
  '4. 这是注入组织方式的性能实验，不证明某资产提高了修复质量，也不评测 BM25、Embedding、Graph 推荐质量和未来会话贡献。',
  '5. 不将本次命中率推广为企业生产命中率，不估算未核实的货币账单，不声称输出 Token、端到端速度或质量必然改善。', '',
  '## 证据与复现', '',
  '- `result/requests.json`：完整合成上游请求。', '- `result/responses.jsonl`：实际响应 ID、原始 usage、请求哈希和耗时。',
  '- `result/settings.json`：实验定义与部署源码哈希。', '- `result/validation.json`：每轮公平性、去重与前缀校验。',
  '- `result/ledger/`：隔离实验台账，包含压缩前后的有效/退役锚点。', '- `result/summary.json`：机器可读汇总。', '',
  '仅构造与检查：`node evaluation/cache_history_bench/run.mjs`。真实上游（需授权）：`node evaluation/cache_history_bench/run.mjs --live`。报告：`node evaluation/cache_history_bench/report.mjs <运行目录>`。', '',
  'DeepSeek 官方说明缓存按共享前缀匹配、落盘存在时延且为尽力而为机制；API 返回命中与未命中字段，参见 [Context Caching](https://api-docs.deepseek.com/guides/kv_cache/) 和 [Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/)。', '',
].join('\n');
writeFileSync(join(directory, 'report.md'), text);
writeFileSync(join(directory, 'verified.json'), JSON.stringify({ rows_verified: rows.length, paired_requests_verified: checks.length,
  overall: { front: control, current: treatment }, total: summary.total_including_calibration }, null, 2));
console.log(JSON.stringify({ report: join(directory, 'report.md'), requests_verified: comparison.length,
  front_hit_rate: control.hit_rate, current_hit_rate: treatment.hit_rate, input_change: (treatment.input - control.input) / control.input,
  miss_change: (treatment.miss - control.miss) / control.miss, total: summary.total_including_calibration }));
