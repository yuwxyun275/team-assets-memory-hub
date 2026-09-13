#!/usr/bin/env node
/** Submit actual CLI tool records and files as learning sources; never constructs an asset answer. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const [directory, number = '1'] = process.argv.slice(2);
if (!directory || !['1', '2'].includes(number)) throw new Error('用法：node scripts/walkthrough-learn-session.mjs <体验目录> <1或2>');
const dir = resolve(directory), info = JSON.parse(readFileSync(join(dir, 'walkthrough.json'), 'utf8'));
if (info.mode !== 'guided-real-walkthrough') throw new Error('需要真实模型体验环境');
const logPath = join(dir, `real-cli-${number}.log`), raw = readFileSync(logPath, 'utf8');
const start = raw.indexOf('\n['), end = raw.lastIndexOf('\n]');
if (start < 0 || end <= start) throw new Error('CLI 日志尚未完整，不能提炼');
const records = JSON.parse(raw.slice(start + 1, end + 2));
const calls = records.filter(r => r.type === 'function_call' && (['Read', 'Write', 'Edit'].includes(r.name) || (r.name === 'Bash' && /pytest/.test(r.arguments))));
const ids = new Set(calls.map(r => r.callId));
const trajectory = records.filter(r => ids.has(r.callId) && ['function_call', 'function_call_result'].includes(r.type));
const source = (id, kind, locator, content, synthetic) => ({ id, kind, locator, content, synthetic, visibility: 'team', revision: createHash('sha256').update(content).digest('hex') });
const sources = [
  source('session-tools', 'conversation', `${logPath}#coding-and-test-tool-records`, trajectory.map(r => JSON.stringify(r)).join('\n'), false),
  ...['inventory.py', 'test_inventory.py'].map((file, index) => source(`code-${index}`, 'code', join(info.workspace, file), readFileSync(join(info.workspace, file), 'utf8'), true)),
  source('independent-ci', 'test_output', join(dir, `real-ci-${number}.json`), readFileSync(join(dir, `real-ci-${number}.json`), 'utf8'), false),
  source('project-contract', 'document', info.source, readFileSync(info.source, 'utf8'), true),
];
const input = { mode: 'history', repository: info.workspace, version: info.version,
  scope: '库存示例工程的单进程请求去重与回归验证。工程和约定为合成示例；会话来自真实 CodeBuddy 与外部模型，独立 CI 输出为实际本地执行。会话仅选取代码读写及测试工具原始记录，不是完整 Session；不包含生产并发或分布式验证。', sources };
if (sources.some(s => s.content.length > 60000) || Buffer.byteLength(JSON.stringify(input)) > 140000) throw new Error('原始记录超出学习接口预算，需要分批');
writeFileSync(join(dir, `real-session-learning-input-${number}.json`), JSON.stringify(input, null, 2), { mode: 0o600 });
const key = readFileSync(info.key_file, 'utf8').trim();
const response = await fetch(`${info.core}/v3/meta/asset/quality/learning-submit`, { method: 'POST',
  headers: { 'content-type': 'application/json', 'x-tdai-service-id': 'default', 'x-tdai-user-key': key },
  body: JSON.stringify({ team_id: info.team, input }), signal: AbortSignal.timeout(15000) });
const result = await response.json();
if (!response.ok || result.code !== 0) throw new Error(`学习提交失败：${result.message}`);
writeFileSync(join(dir, `real-session-learning-${number}.json`), JSON.stringify(result, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ job: result.data.key, state: result.data.data.state, actual_tool_records: trajectory.length, sources: sources.length }));
