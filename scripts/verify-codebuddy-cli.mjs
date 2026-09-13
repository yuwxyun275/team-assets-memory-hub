#!/usr/bin/env node
/** Real installed CLI -> loopback fake model. Never use a real model/key. */
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { buildCliInvocation } from '../agents/codebuddy/cli.mjs';

const dir = mkdtempSync(join(tmpdir(), 'team-asset-cli-test-'));
const config = join(dir, 'config'); mkdirSync(config);
const requests = [];
const server = createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  let body; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { body = {}; }
  requests.push({ path: req.url, headers: req.headers, body });
  if (req.url.endsWith('/chat/completions')) {
    const completion = { id: 'local-fixture', object: 'chat.completion', created: 1, model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'LOCAL_CLI_PROTOCOL_OK' } }],
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } };
    if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(completion)); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ ...completion, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'LOCAL_CLI_PROTOCOL_OK' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...completion, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n'); return;
  }
  if (!req.url.includes('/messages')) { res.writeHead(404); res.end('{}'); return; }
  const message = { id: 'msg_local_fixture', type: 'message', role: 'assistant', model: body.model,
    content: [{ type: 'text', text: 'LOCAL_CLI_PROTOCOL_OK' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 5 } };
  if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event('message_start', { message: { ...message, content: [], stop_reason: null } });
  event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'LOCAL_CLI_PROTOCOL_OK' } });
  event('content_block_stop', { index: 0 });
  event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
  event('message_stop', {}); res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const url = `http://127.0.0.1:${server.address().port}/codebuddy/default`;
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ env: { CODEBUDDY_BASE_URL: `${url}/v1`, CODEBUDDY_API_KEY: 'local-fixture-no-real-key' }, skipDangerousModePermissionPrompt: false }));
  const env = { PATH: process.env.PATH, LANG: 'en_US.UTF-8', TMPDIR: tmpdir(), CODEBUDDY_CONFIG_DIR: config,
    TEAM_ASSET_USER_KEY: 'local-fixture-no-real-key', CODEBUDDY_TELEMETRY_DISABLED: '1', DISABLE_TELEMETRY: '1' };
  const run = buildCliInvocation({ team: 'team-fixture', agent: 'agent-fixture', task: 'task-fixture', proxy: url,
    workspace: dir, prompt: 'Reply with the protocol verification marker.', model: 'hy3', tools: '', turns: 1 }, env);
  let stdout = '', stderr = '';
  const exit = await new Promise((resolve, reject) => {
    const child = spawn(run.command, run.args, { cwd: dir, env: run.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('CLI local smoke timed out')); }, 40000);
    child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  const coding = requests.filter(r => r.path.includes('/messages') || r.path.endsWith('/chat/completions'));
  assert.equal(exit, 0, `CLI failed; local requests=${requests.length}; stderr=${stderr.slice(-1000)}`);
  assert.ok(stdout.includes('LOCAL_CLI_PROTOCOL_OK'), `CLI did not receive the local model response; requests=${JSON.stringify(requests.map(r => r.path))}; output=${stdout.slice(-1800)}; stderr=${stderr.slice(-1000)}`);
  assert.ok(coding.length > 0, 'No local model request');
  assert.equal(coding[0].headers['x-team-id'], 'team-fixture');
  assert.equal(coding[0].headers['x-task-id'], 'task-fixture');
  assert.equal(coding[0].headers['x-team-assets-cli'], '1');
  assert.equal(coding[0].headers['x-conversation-id'], run.session);
  assert.equal(decodeURIComponent(coding[0].headers['x-team-assets-workspace']), run.cwd);
  process.stdout.write(`${JSON.stringify({ passed: true, mode: 'installed-cli-with-loopback-fake-model', calls: coding.length,
    headers_and_protocol_verified: true, real_model_experiment: false, full_proxy_execution: false }, null, 2)}\n`);
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); }
