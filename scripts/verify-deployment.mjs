#!/usr/bin/env node
/** Isolated deployment: installed Core, current Proxy, real CodeBuddy, deterministic HTTP model fixture.
 * This verifies integration contracts and real local tool execution, not model intelligence or gains.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import assert from 'node:assert/strict';
import { buildCliInvocation } from '../agents/codebuddy/cli.mjs';
const root = resolve(import.meta.dirname, '..');
const walkthrough = process.argv.includes('--walkthrough');
const resumeIndex = process.argv.indexOf('--resume');
const resumeDir = resumeIndex < 0 ? null : process.argv[resumeIndex + 1];
assert.ok(resumeIndex < 0 || (walkthrough && resumeDir && !resumeDir.startsWith('--')), '--resume requires --walkthrough and an existing directory');
const resume = resumeDir ? JSON.parse(readFileSync(join(resolve(resumeDir), 'walkthrough.json'), 'utf8')) : null;
assert.ok(!resume || resume.mode === 'guided-synthetic-walkthrough', 'Only a guided walkthrough can be resumed');
const resumeGateway = resume ? JSON.parse(readFileSync(join(resolve(resumeDir), 'gateway.json'), 'utf8')) : null;
const resumeProxy = resume ? JSON.parse(readFileSync(join(resolve(resumeDir), 'proxy.json'), 'utf8')) : null;
const release = JSON.parse(readFileSync(process.argv[2], 'utf8'));
assert.equal(release.passed, true, 'Pass verify-release.mjs first');
const dir = resume ? resolve(resumeDir) : mkdtempSync(join(walkthrough ? join(root, 'output') : tmpdir(), walkthrough ? 'walkthrough-' : 'team-assets-deployment-'));
assert.ok(!resume || resolve(resume.directory) === dir, 'Walkthrough directory has moved; restore its original path before resuming');
const workspace = join(dir, 'inventory'); if (!resume) mkdirSync(workspace);
const node = release.node, pkg = release.package_directory;
const env = { PATH: `${dirname(node)}:${process.env.PATH}`, LANG: 'en_US.UTF-8', TMPDIR: tmpdir(), PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' };
const report = { mode: 'isolated-deployment-with-deterministic-model', real_model_experiment: false, synthetic_sources: true, directory: dir, checks: [], model_requests: [], tasks: [] };
const children = []; let team, user, key, proxyUrl, activeAsset;
let shuttingDown = false;
let stopRequested;
const stopped = new Promise(r => { stopRequested = r; });
process.once('SIGTERM', () => stopRequested());
process.once('SIGINT', () => stopRequested());
const record = (name, detail = {}) => { report.checks.push({ name, passed: true, ...detail }); console.log(`${name}: passed`); };
const privateJson = (name, data) => writeFileSync(join(dir, name), JSON.stringify(data, null, 2), { mode: 0o600 });
function start(name, command, args, cwd, extra = {}) {
  const log = createWriteStream(join(dir, `${name}.log`), { mode: 0o600, flags: resume ? 'a' : 'w' });
  const child = spawn(command, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log); child.stderr.pipe(log); children.push(child);
  child.on('error', e => { report.error = `${name}: ${e.message}`; });
  child.on('exit', (code, signal) => {
    if (walkthrough && !shuttingDown && !name.startsWith('cli-')) {
      report.error = `${name} stopped (code=${code}, signal=${signal})`;
      process.exitCode = 1;
      stopRequested();
    }
  });
  return child;
}
async function until(label, fn, timeout = 45000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (e) { last = e; }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`${label} timed out${last ? `: ${last.message}` : ''}; logs: ${dir}`);
}
async function port() {
  const s = createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port; await new Promise(r => s.close(r)); return p;
}
const source = 'Inventory idempotency in inventory.py: reserve(stock, request_id, seen) must subtract stock only once for a repeated request ID. Track processed request IDs in seen and return unchanged stock on retries. Run python3 -m pytest -q test_inventory.py; test_duplicate_request must pass. This only covers one process, not concurrent production requests.';
if (!resume) writeFileSync(join(dir, 'inventory-contract.md'), '<!-- team-asset-source: synthetic -->\n' + source + '\n');
const fixedCode = 'def reserve(stock, request_id, seen):\n    if request_id in seen:\n        return stock\n    seen.add(request_id)\n    return stock - 1\n';
if (!resume) writeFileSync(join(workspace, 'inventory.py'), 'def reserve(stock, request_id, seen):\n    return stock - 1\n');
if (!resume) writeFileSync(join(workspace, 'test_inventory.py'), 'from inventory import reserve\n\ndef test_duplicate_request():\n    seen = set()\n    stock = reserve(10, "r1", seen)\n    assert reserve(stock, "r1", seen) == 9\n\ndef test_distinct_request():\n    seen = set()\n    stock = reserve(10, "r1", seen)\n    assert reserve(stock, "r2", seen) == 8\n');
function proposal(input) {
  const task = input.mode === 'task';
  const evidence = input.sources.find(s => s.id === (task ? 'execution' : 'history')) ?? input.sources.find(s => !s.asset_id);
  return { candidates: [{ kind: 'workflow_candidate', title: task ? 'Inventory duplicate request regression workflow' : 'Inventory idempotency repair workflow',
    claim: task ? 'The observed task receipt contains the inventory regression result; preserve its limits.' : 'A repeated request must not subtract stock twice in this process.',
    action: 'Inspect inventory.py and run python3 -m pytest -q test_inventory.py.', applicability: 'Inventory request ID deduplication within one process; concurrency is not verified.', risk: 'medium',
    evidence: [{ source_id: evidence.id, quote: evidence.content.slice(0, 1500) }],
    workflow: { purpose: 'Check inventory request idempotency', inputs: [{ name: 'project_root', description: 'Inventory repository', required: true }],
      preconditions: ['The project uses request IDs and a per-process seen set.'],
      steps: [{ id: 'inspect', instruction: 'Inspect inventory.py and the request ID check.', expected_result: 'Duplicates do not change stock.', on_failure: 'Fix the request ID guard, then rerun checks.', evidence_indices: [0] }],
      verification: [{ instruction: 'Run python3 -m pytest -q test_inventory.py.', success_criteria: 'test_duplicate_request and test_distinct_request pass.', evidence_indices: [0] }],
      stop_conditions: ['Concurrent or distributed semantics are required.'], recovery: ['Keep the failing test output and request the missing concurrency contract.'], non_goals: ['No proof for production concurrency.'],
      portability: { level: 'project', rationale: 'Specific to this inventory fixture.', requirements: ['Check the request ID API before executing.'], parameter_names: ['project_root'] } } }],
    reason: 'Deterministic synthetic fixture for the generation protocol; not an assessment of model quality.' };
}
const model = createServer(async (req, res) => {
  try {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (!Array.isArray(body.messages)) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
    const messages = body.messages ?? [], system = messages.filter(m => m.role === 'system').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
    const inputText = messages.filter(m => m.role === 'user').at(-1)?.content;
    let content = '', toolCalls, kind;
    if (system.includes('团队工程经验提炼决策器')) {
      const input = JSON.parse(inputText); kind = `learning-${input.mode}`; content = JSON.stringify(proposal(input)); privateJson(`model-learning-${input.mode}.json`, input);
    } else if (system.includes('发布前资产内容审阅员')) {
      kind = 'quality-review'; const input = JSON.parse(inputText);
      content = JSON.stringify({ checks: input.criteria.map(c => ({ id: c.id, status: 'pass', score: 4,
        reason: 'Synthetic protocol fixture: exact submitted evidence references; not a real quality judgment.',
        evidence: input.evidence_catalog.filter(e => e.source_id === 'asset' || !['asset', 'scope'].includes(e.source_id)).slice(0, 10).map(e => ({ evidence_id: e.id })) })) });
    } else if (system.includes('资产场景适用性审阅员')) {
      kind = 'applicability'; content = JSON.stringify({ verdict: 'unknown', reason: 'Deterministic fixture does not judge semantic applicability.', citations: [] });
    } else if (system.includes('资产使用证据审阅员')) {
      kind = 'usage'; content = JSON.stringify({ verdict: 'unobserved', reason: 'Deterministic fixture makes no gain claim.', citations: [] });
    } else {
      kind = 'coding'; const text = JSON.stringify(messages); const task = text.includes('FULL_FLOW_TASK_2') ? '2' : '1';
      // Derive progress from the CLI transcript, so fresh sessions can be retried.
      const step = messages.filter(m => m.role === 'assistant' && m.tool_calls?.length).length;
      if (walkthrough && step === 0) {
        const flat = messages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
        const cards = flat.match(/<team_asset_card[\s\S]*?<\/team_asset_card>/g) ?? [];
        const title = task === '2' ? 'Inventory duplicate request regression workflow' : 'Inventory idempotency repair workflow';
        const card = cards.find(c => c.includes(title));
        activeAsset = card?.match(/"asset_id":"([^"]+)"/)?.[1];
        assert.ok(activeAsset, '请先在资产质量中心审核并发布当前步骤要求的候选，再运行此任务。');
      }
      privateJson(`coding-${task}-${step}.json`, body);
      const names = (body.tools ?? []).map(t => t.function?.name ?? t.name);
      const tool = (name, args) => {
        const actual = names.find(n => n?.toLowerCase() === name.toLowerCase());
        assert.ok(actual, `CLI tool ${name} unavailable: ${names}`);
        toolCalls = [{ id: `call_${task}_${step}`, type: 'function', function: { name: actual, arguments: JSON.stringify(args) } }];
      };
      if (step === 0) {
        assert.ok(text.includes(activeAsset), 'Expected reviewed asset was not recommended');
        const flat = messages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
        const commands = flat.match(/curl --fail-with-body[^\n]+/g) ?? [];
        const command = commands.find(c => c.includes(activeAsset));
        assert.ok(command, 'No authenticated disclosure command for selected asset');
        tool('Bash', { command, description: 'Read the reviewed inventory workflow', timeout: 20000 });
      } else if (step === 1) {
        assert.ok(text.includes('team_asset_content'), 'CLI did not receive the asset body');
        tool('Read', { file_path: join(workspace, 'inventory.py') });
      } else if (step === 2) {
        content = `<team_asset_use>${JSON.stringify({ asset_id: activeAsset, decision: 'Check the request ID guard in inventory.py to avoid repeated subtraction.', target: 'inventory.py' })}</team_asset_use>`;
        content += `<acceptance_plan>${JSON.stringify({ criteria: [{ text: 'Repeated inventory requests must not subtract stock twice.', category: 'business', rationale: 'Synthetic product requirement', source_asset_ids: [activeAsset], target_paths: ['inventory.py'], candidate_test_ids: ['test_duplicate_request'] }] })}</acceptance_plan>`;
        tool('Write', { file_path: join(workspace, 'inventory.py'), content: fixedCode });
      } else if (step === 3) {
        tool('Bash', { command: 'python3 -m pytest -q test_inventory.py', description: 'Run inventory idempotency regression tests', timeout: 20000 });
      } else {
        assert.ok(text.includes('2 passed'), 'CLI did not observe successful real pytest output');
        content = `FULL_FLOW_OK_${task}. The local inventory tests passed. This synthetic run does not establish model quality or asset gains.`;
      }
    }
    report.model_requests.push({ kind, path: req.url });
    const base = { id: `fixture-${report.model_requests.length}`, object: 'chat.completion', created: 1, model: body.model,
      usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } };
    const finish = toolCalls ? 'tool_calls' : 'stop';
    if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ...base, choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }] })); }
    else {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (delta, finish_reason) => res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      send({ role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls.map((t, index) => ({ index, ...t })) } : {}) }, null);
      send({}, finish); res.end('data: [DONE]\n\n');
    }
  } catch (e) { report.model_error = e.message; res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: e.message } })); }
});
await new Promise((resolve, reject) => { model.once('error', reject); model.listen(resume ? Number(new URL(resumeGateway.llm.baseUrl).port) : 0, '127.0.0.1', resolve); });
const modelUrl = `http://127.0.0.1:${model.address().port}/v1`;
const corePort = resume ? Number(new URL(resume.core).port) : await port(), rankPort = resume ? Number(new URL(resumeProxy.injection.teamAssets.endpoint).port) : await port(), proxyPort = resume ? Number(new URL(resume.proxy).port) : await port(), panelPort = resume ? Number(new URL(resume.panel).port) : await port();
const coreUrl = `http://127.0.0.1:${corePort}`, rankUrl = `http://127.0.0.1:${rankPort}`; proxyUrl = `http://127.0.0.1:${proxyPort}`;
const panelUrl = `http://127.0.0.1:${panelPort}`;
const serviceToken = 'synthetic-local-service-token';
async function api(action, body, internal = false) {
  const response = await fetch(`${coreUrl}/v3/${internal ? 'internal/' : ''}meta/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tdai-service-id': 'default', ...(internal ? { authorization: `Bearer ${serviceToken}` } : { 'x-tdai-user-key': key }) }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const value = await response.json();
  assert.ok(response.ok && value.code === 0, `${action}: HTTP ${response.status}, ${value.message ?? JSON.stringify(value)}`); return value.data;
}
const quality = (action, data) => api(`asset/quality/${action}`, { team_id: team.team_id, ...data });
async function approve(id) {
  const before = await api('asset/list-accessible', { team_id: team.team_id, user_id: user.user_id, action: 'use', limit: 100 });
  assert.ok(!before.items.some(a => a.asset_id === id), 'Unreviewed candidate is usable');
  const details = await until('quality review', async () => {
    const d = await quality('details', { asset_id: id }); privateJson(`quality-${id}.json`, d);
    return d.revisions.find(r => r.data.state === 'awaiting_approval') ? d : null;
  });
  assert.ok(!details.publication, 'Candidate published before approval');
  const rev = details.revisions.find(r => r.data.state === 'awaiting_approval');
  await quality('decide', { revision_id: rev.data.id, decision: 'approve', note: 'Explicit synthetic acceptance-run publication; not team production authority.' });
  const after = await api('asset/list-accessible', { team_id: team.team_id, user_id: user.user_id, action: 'use', limit: 100 });
  assert.ok(after.items.some(a => a.asset_id === id), 'Approved asset is unavailable');
  record('candidate-review-and-approval', { asset_id: id });
}
async function cli(task, number, asset) {
  activeAsset = asset;
  const cfg = join(dir, `cli-${number}`); mkdirSync(cfg);
  const run = buildCliInvocation({ team: team.team_id, agent: task.agent_id, task: task.task_id, proxy: `${proxyUrl}/codebuddy/default`, workspace,
    prompt: number === 1 ? 'FULL_FLOW_TASK_1: Fix inventory.py request idempotency using the reviewed team workflow, then run test_inventory.py.' : 'FULL_FLOW_TASK_2: Apply the Inventory duplicate request regression workflow to verify the previous inventory.py repair; run test_inventory.py for regression.', model: 'hy3', tools: 'Bash,Read,Write', turns: 8 },
    { ...env, CODEBUDDY_CONFIG_DIR: cfg, TEAM_ASSET_USER_KEY: key, CODEBUDDY_TELEMETRY_DISABLED: '1', DISABLE_TELEMETRY: '1' });
  const child = start(`cli-${number}`, run.command, [...run.args, '--allowedTools', 'Bash', 'Read', 'Write', '--permission-mode', 'dontAsk'], run.cwd, run.env);
  await until('CLI completion', () => child.exitCode !== null, 65000);
  const output = readFileSync(join(dir, `cli-${number}.log`), 'utf8');
  assert.equal(child.exitCode, 0, `CLI failed: ${output.slice(-1200)}; ${report.model_error ?? ''}`);
  assert.ok(output.includes(`FULL_FLOW_OK_${number}`), `CLI marker missing; ${report.model_error ?? ''}`);
  assert.equal(readFileSync(join(workspace, 'inventory.py'), 'utf8'), fixedCode);
  const response = await fetch(`${rankUrl}/v2/sessions/receipt?session_id=${run.session}`, { headers: { authorization: `Bearer ${serviceToken}` } });
  const receipt = await response.json(); privateJson(`receipt-${number}.json`, receipt);
  assert.ok(response.ok, 'Receipt API failed');
  const used = receipt.assets?.find(a => (a.runtime_asset_id ?? a.asset_id) === asset);
  assert.ok(used, 'Selected asset absent from receipt');
  for (const state of ['recalled', 'selected', 'injected', 'used', 'validated']) assert.ok(used.states.includes(state), `Missing ${state} evidence`);
  assert.ok(!used.states.includes('contributed') && !used.contribution_ref, 'Synthetic run must not claim causal contribution');
  assert.ok(used.validation_ref && used.attribution?.observed_action?.change_hash, 'Missing test or change evidence');
  const coreTask = await api('task/get', { task_id: task.task_id }); privateJson(`task-${number}.json`, coreTask);
  const shown = await fetch(`${panelUrl}/api/v1/meta/task/get`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tdai-service-id': 'default', 'x-tdai-user-key': key }, body: JSON.stringify({ task_id: task.task_id }) });
  const panelTask = await shown.json();
  assert.ok(shown.ok && panelTask.code === 0, 'Panel task receipt API failed');
  const displayed = JSON.parse(panelTask.data.metadata_json).asset_evidence;
  assert.ok(displayed.assets.some(a => (a.runtime_asset_id ?? a.asset_id) === asset && a.states.includes('validated')), 'Panel did not expose the validated receipt');
  report.tasks.push({ task_id: task.task_id, session_id: run.session, asset_id: asset, receipt: join(dir, `receipt-${number}.json`) });
  record(`cli-task-${number}-tools-and-tests`, { session_id: run.session });
  return coreTask;
}
try {
  // Match the documented loopback standalone setup. Business APIs still enforce user keys.
  // The optional second gateway Bearer gate is exercised by verify-release.mjs.
  // The Panel exposes native Skill management as well as the quality-learning pipeline.
  // Enable its local store; legacy conversation extraction is outside this fixture.
  if (!resume) privateJson('gateway.json', { deployMode: 'standalone', stateBackend: 'local', server: { host: '127.0.0.1', port: corePort }, data: { baseDir: join(dir, 'core-data') }, llm: { baseUrl: modelUrl, apiKey: 'fixture', model: 'fixture', stream: false }, memory: { embedding: { provider: 'none' }, extraction: { enabled: false } }, skill: { enabled: true, storeBackend: 'sqlite', contentBackend: 'local', routing: { mode: 'bm25' }, extraction: { enabled: false } } });
  start('core', node, ['--import', 'tsx', 'src/gateway/server.ts'], pkg, { TDAI_GATEWAY_CONFIG: join(dir, 'gateway.json'), TDAI_METADATA_SQLITE_BASE_DIR: join(dir, 'metadata') });
  await until('Core health', async () => (await fetch(`${coreUrl}/health`)).ok);
  if (resume) {
    key = readFileSync(resume.key_file, 'utf8').trim();
    user = (await api('auth/verify', { user_key: key })).user;
    assert.ok(user?.user_id, 'Existing walkthrough login is no longer valid');
  } else {
    user = await api('user/init-admin', { username: 'synthetic-acceptance-owner' }, true); key = user.user_key ?? user.default_user_key;
  }
  assert.ok(key?.startsWith('sk-mem-'));
  team = resume ? await api('team/get', { team_id: resume.team }) : await api('team/create', { name: 'Synthetic deployment acceptance', owner_user_id: user.user_id });
  if (!resume) privateJson('instances.json', { instances: [{ id: 'default', name: 'Synthetic acceptance', gateway_endpoint: coreUrl, proxy_endpoint: proxyUrl, api_key: serviceToken }] });
  start('panel', node, [join(root, 'MemoryPanel/dist/index.js')], dir, { HOST: '127.0.0.1', PORT: String(panelPort), METADATA_INSTANCES_CONFIG: join(dir, 'instances.json'), UI_DIST_DIR: join(root, 'MemoryPanel/web/dist'), KNOWLEDGE_LLM_BINDING_SYNC: 'false', TDAI_AGENT_TEMPLATE_DIR: join(dir, 'templates') });
  await until('Panel health', async () => (await fetch(`${panelUrl}/health`)).ok);
  const page = await fetch(panelUrl); assert.ok(page.ok && (await page.text()).includes('<html'), 'Panel web page missing');
  record('panel-started-and-web-served', { url: panelUrl });
  const agent = resume ? await api('agent/get', { agent_id: resume.agent }) : await api('agent/create', { team_id: team.team_id, owner_user_id: user.user_id, name: 'Inventory CLI', visibility: 'team' });
  for (const scope of ['team', 'agent']) {
    const response = await fetch(`${panelUrl}/api/v1/skill/list`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-tdai-service-id': 'default', 'x-tdai-user-key': key },
      body: JSON.stringify({ user_id: user.user_id, team_id: team.team_id, filters: { status: ['active'], ...(scope === 'agent' ? { owner_agent_id: agent.agent_id } : {}) }, pagination: { limit: 100, offset: 0 } }),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    assert.ok(response.ok && result.code === 0 && Array.isArray(result.data?.items), `Panel ${scope} Skill list failed: HTTP ${response.status}, ${result.message}`);
    if (!resume) assert.equal(result.data.total, 0, 'Fresh deployment should have an empty native Skill store');
    record(`panel-${scope}-skill-list`);
  }
  const createTask = async number => resume ? { ...await api('task/get', { task_id: resume.tasks[String(number)] }), agent_id: agent.agent_id } : ({ ...await api('task/create', { team_id: team.team_id, creator_user_id: user.user_id, title: number === 1 ? 'Inventory idempotency repair' : 'Inventory duplicate request regression workflow', description: number === 1 ? 'Fix inventory.py so repeated request IDs do not subtract stock twice. Verify test_duplicate_request with pytest.' : 'Use the observed task receipt and Inventory duplicate request regression workflow to verify the previous inventory.py repair with test_inventory.py.', source_url: workspace, linked_agents: [{ agent_id: agent.agent_id }], metadata_json: JSON.stringify({ synthetic: true, repository: workspace, version: 'v1' }) }), agent_id: agent.agent_id });
  const first = await createTask(1);
  if (!resume) writeFileSync(join(dir, 'hub.env'), `TEAM_ASSET_DEMO_USER_KEY=${key}\nTEAM_ASSET_DEMO_USER_ID=${user.user_id}\n`, { mode: 0o600 }); if (!resume) privateJson('bindings.json', {});
  start('orchestrator', 'python3', ['-m', 'team_asset_bench', 'serve', '--host', '127.0.0.1', '--port', String(rankPort)], join(root, 'evaluation/team_asset_bench'), {
    TEAM_ASSET_STATE_DB: join(dir, 'runtime.sqlite'), TEAM_ASSET_HUB_ENV: join(dir, 'hub.env'), TEAM_ASSET_BINDINGS_FILE: join(dir, 'bindings.json'), TEAM_ASSET_CORE_URL: coreUrl, TEAM_ASSET_SERVER_TOKEN: serviceToken });
  await until('Orchestrator health', async () => (await fetch(`${rankUrl}/health`)).ok);
  if (!resume) privateJson('proxy.json', { server: { host: '127.0.0.1', port: proxyPort }, upstream: { url: `${modelUrl}/chat/completions`, apiKey: 'fixture' }, auth: { enabled: true, url: coreUrl }, skill: { endpoint: coreUrl, serviceToken, serviceId: 'default', timeoutMs: 15000 }, storage: { enabled: true, backend: 'sqlite', sqlite: { dbPath: join(dir, 'proxy.sqlite') } }, sessionInit: { enabled: true }, extraction: { enabled: false }, injection: { enabled: true, injectors: ['team-assets'], externalGatewayUrl: proxyUrl, teamAssets: { enabled: true, endpoint: rankUrl, externalUrl: rankUrl, serviceToken, timeoutMs: 15000, tokenBudget: 4000, maxAssets: 4, repository: workspace, version: 'v1', targetPaths: ['inventory.py'], progressiveDisclosure: true, inlineMaxChars: 0, historyDirectory: join(dir, 'history') } } });
  start('proxy', node, ['--import', 'tsx/esm', 'src/index.ts', '--config', join(dir, 'proxy.json')], join(root, 'MemoryProxy'), { PROXY_DATA_DIR: join(dir, 'proxy-data'), QUALITY_OUTBOX_DIR: join(dir, 'outbox') });
  await until('Proxy health', async () => (await fetch(`${proxyUrl}/health`)).ok);
  record('isolated-services-started', { core: coreUrl, proxy: proxyUrl, orchestrator: rankUrl });
  const denied = await fetch(`${proxyUrl}/codebuddy/default/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer invalid-synthetic-key' }, body: JSON.stringify({ model: 'hy3', messages: [{ role: 'user', content: 'unauthorized request' }] }) });
  assert.equal(denied.status, 401, 'Proxy accepted an invalid business key'); record('invalid-user-key-denied');
  if (walkthrough) {
    const second = await createTask(2);
    writeFileSync(join(dir, 'login-key.txt'), key + '\n', { mode: 0o600 });
    const info = { mode: 'guided-synthetic-walkthrough', pid: process.pid, directory: dir, node, workspace,
      panel: panelUrl, core: coreUrl, proxy: `${proxyUrl}/codebuddy/default`, team: team.team_id, agent: agent.agent_id,
      tasks: { '1': first.task_id, '2': second.task_id }, source: join(dir, 'inventory-contract.md'),
      key_file: join(dir, 'login-key.txt'), version: 'v1', scope: 'Inventory request idempotency repair and regression in inventory.py',
      limitations: ['Deterministic model responses for two specified example tasks only.', 'Manual publication approval is required.', 'No real model quality or causal gain is established.'] };
    privateJson('walkthrough.json', info);
    console.log(JSON.stringify({ walkthrough_ready: true, panel: panelUrl, directory: dir, credentials: info.key_file, tasks: info.tasks }));
    await stopped;
    report.mode = info.mode; report.ready = true; report.passed = report.error ? false : null;
  } else {
  const job = await quality('learning-submit', { input: { mode: 'history', repository: workspace, version: 'v1', scope: 'Inventory request idempotency repair and regression in inventory.py', sources: [{ id: 'history', kind: 'document', locator: 'synthetic:inventory-contract.md', revision: 'v1', content: source, synthetic: true, visibility: 'team' }] } });
  const complete = await until('historical extraction', async () => { const d = await quality('learning-details', { job_id: job.key }); privateJson('history-job.json', d); return d.data.state === 'completed' ? d : null; });
  const asset = complete.data.candidate_ids[0]; assert.ok(asset);
  record('raw-source-to-workflow-candidate', { asset_id: asset }); await approve(asset);
  await cli(first, 1, asset);
  const feedback = await until('automatic task learning', async () => {
    const list = await quality('learning-list', {}); privateJson('learning-jobs.json', list);
    return list.items?.find(r => r.data.task_id === first.task_id && r.data.state === 'completed');
  }, 85000);
  const returned = feedback.data.candidate_ids[0]; assert.ok(returned && returned !== asset);
  record('automatic-evidence-backed-task-return', { asset_id: returned }); await approve(returned);
  const second = await createTask(2); await cli(second, 2, returned);
  report.passed = true;
  }
} catch (error) { report.passed = false; report.error = error.message; process.exitCode = 1; }
finally {
  shuttingDown = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 1000));
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  model.closeAllConnections(); await new Promise(r => model.close(r));
  const output = join(root, 'output', `deployment-${Date.now()}.json`); report.completed_at = new Date().toISOString();
  writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, report: output, directory: dir, error: report.error, model_error: report.model_error }));
}
