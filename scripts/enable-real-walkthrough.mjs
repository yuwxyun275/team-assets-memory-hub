#!/usr/bin/env node
/** Switch the local walkthrough to real models, preserving the earlier synthetic run for comparison. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const [directory, releaseFile, envFile] = process.argv.slice(2);
assert.ok(directory && releaseFile && envFile, 'Usage: enable-real-walkthrough.mjs <directory> <release-report> <model-env-file>');
const dir = resolve(directory), releasePath = resolve(releaseFile);
let info = JSON.parse(readFileSync(join(dir, 'walkthrough.json'), 'utf8'));
const modelEnv = createRequire(join(root, 'MemoryPanel/package.json'))('dotenv').parse(readFileSync(resolve(envFile)));
const baseUrl = modelEnv.MEMORY_LLM_BASE_URL?.replace(/\/$/, '');
const apiKey = modelEnv.MEMORY_LLM_API_KEY;
const model = modelEnv.MEMORY_LLM_MODEL;
assert.ok(baseUrl && apiKey && model, 'Missing MEMORY_LLM_BASE_URL, MEMORY_LLM_API_KEY or MEMORY_LLM_MODEL');
assert.equal(new URL(baseUrl).protocol, 'https:');
const key = readFileSync(info.key_file, 'utf8').trim();
const privateJson = (name, value) => { const path = join(dir, name); writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 }); chmodSync(path, 0o600); };
const service = action => execFileSync(info.node, [join(root, 'scripts/walkthrough-service.mjs'), action, dir, releasePath], { encoding: 'utf8' });
async function api(action, body) {
  const res = await fetch(`${info.core}/v3/meta/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tdai-service-id': 'default', 'x-tdai-user-key': key }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const value = await res.json();
  if (!res.ok || value.code !== 0) throw new Error(`${action}: HTTP ${res.status}, code=${value.code}, ${value.message}`);
  return value.data;
}
if (info.mode !== 'guided-real-walkthrough') {
  assert.equal(info.mode, 'guided-synthetic-walkthrough');
  const backup = `before-real-${Date.now()}`;
  mkdirSync(join(dir, backup), { mode: 0o700 });
  for (const file of ['walkthrough.json', 'gateway.json', 'proxy.json', 'service.plist']) { copyFileSync(join(dir, file), join(dir, backup, file)); chmodSync(join(dir, backup, file), 0o600); }
  const workspace = join(dir, 'inventory-real');
  mkdirSync(workspace, { mode: 0o700, recursive: true });
  for (const file of ['inventory.py', 'test_inventory.py']) if (!existsSync(join(workspace, file))) copyFileSync(join(info.workspace, file), join(workspace, file));
  mkdirSync(join(dir, 'real-sources'), { mode: 0o700, recursive: true });
  const source = join(dir, 'real-sources/inventory-contract.md');
  copyFileSync(info.source, source);
  const gateway = JSON.parse(readFileSync(join(dir, 'gateway.json'), 'utf8'));
  gateway.llm = { baseUrl, apiKey, model, stream: false };
  const proxy = JSON.parse(readFileSync(join(dir, 'proxy.json'), 'utf8'));
  proxy.upstream = { ...proxy.upstream, url: `${baseUrl}/chat/completions`, apiKey };
  // The installed Core uses its bundled Node; the repo's native SQLite addon
  // may target a different ABI. Use durable built-in filesystem storage here.
  proxy.storage = { ...proxy.storage, backend: 'fs', fs: { fsRoot: join(dir, 'proxy-storage') } };
  proxy.injection.teamAssets.repository = workspace;
  info = { ...info, mode: 'guided-real-walkthrough', model, provider: new URL(baseUrl).hostname, model_mode: 'real', workspace, source,
    synthetic_run: { team: info.team, agent: info.agent, tasks: info.tasks, workspace: info.workspace, backup: join(dir, backup) },
    limitations: ['Real model decisions and real CLI tool execution; no prewritten candidate or repair response.', 'Source material and project are explicitly marked examples.', 'Publication requires reviewer approval; one run does not establish statistical or causal gains.'] };
  // Prepare everything first; stop only while replacing the running configuration.
  service('stop');
  privateJson('gateway.json', gateway); privateJson('proxy.json', proxy); privateJson('walkthrough.json', info);
  service('start');
}
const deadline = Date.now() + 60000;
let ready = false;
while (Date.now() < deadline) {
  try { const results = await Promise.all([info.core, info.panel, new URL(info.proxy).origin].map(url => fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) }))); if (results.every(r => r.ok)) { ready = true; break; } } catch {}
  await new Promise(r => setTimeout(r, 500));
}
assert.ok(ready, 'Real services are not ready; inspect service.log. The earlier configuration is backed up.');
// Use an independent team so fixed-response candidates cannot be retrieved by the real run.
info = JSON.parse(readFileSync(join(dir, 'walkthrough.json'), 'utf8'));
if (!info.real_context_ready) {
  const user = (await api('auth/verify', { user_key: key })).user;
  const team = await api('team/create', { name: '真实模型体验 · 库存', owner_user_id: user.user_id });
  const agent = await api('agent/create', { team_id: team.team_id, owner_user_id: user.user_id, name: '库存真实体验 CLI', visibility: 'team' });
  const tasks = {};
  for (const number of ['1', '2']) {
    const task = await api('task/create', { team_id: team.team_id, creator_user_id: user.user_id,
      title: number === '1' ? '真实模型 · 库存幂等修复' : '真实模型 · 库存回归验证',
      description: number === '1' ? '修复 inventory.py 中重复请求重复扣减库存的问题；按实际需要使用团队资产，运行 test_inventory.py，并保留实际执行证据。' : '检查库存请求幂等性实现并运行回归测试，按实际需要复用前一任务回流的团队经验。',
      source_url: info.workspace, linked_agents: [{ agent_id: agent.agent_id }],
      metadata_json: JSON.stringify({ synthetic: true, model_mode: 'real', model, repository: info.workspace, version: info.version }) });
    tasks[number] = task.task_id;
  }
  info = { ...info, team: team.team_id, agent: agent.agent_id, tasks, real_context_ready: true };
  privateJson('walkthrough.json', info);
}
if (!info.real_learning_job) {
  const content = readFileSync(info.source, 'utf8');
  const job = await api('asset/quality/learning-submit', { team_id: info.team, input: { mode: 'history', repository: info.workspace, version: info.version,
    scope: '库存模块的请求幂等性修复与回归测试；仅适用于单进程示例，不覆盖并发或分布式场景。',
    sources: [{ id: 'source-1', kind: 'document', locator: 'inventory-contract.md', revision: createHash('sha256').update(content).digest('hex'), content, synthetic: true, visibility: 'team' }] } });
  info = { ...info, real_learning_job: job.key };
  privateJson('walkthrough.json', info);
}
console.log(JSON.stringify({ ready: true, mode: info.mode, model: info.model, team: info.team, panel: info.panel, workspace: info.workspace, job: info.real_learning_job, tasks: info.tasks, needs_candidate_review: true }));
