#!/usr/bin/env node
/** Serve an existing walkthrough using configured external models. No model fixture or prewritten answers. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const [releasePath, directory] = process.argv.slice(2);
const release = JSON.parse(readFileSync(resolve(releasePath), 'utf8'));
const dir = resolve(directory);
const info = JSON.parse(readFileSync(join(dir, 'walkthrough.json'), 'utf8'));
assert.equal(release.passed, true);
assert.equal(info.mode, 'guided-real-walkthrough');
assert.equal(resolve(info.directory), dir);
const gateway = JSON.parse(readFileSync(join(dir, 'gateway.json'), 'utf8'));
const proxy = JSON.parse(readFileSync(join(dir, 'proxy.json'), 'utf8'));
for (const endpoint of [gateway.llm.baseUrl, proxy.upstream.url]) {
  const url = new URL(endpoint);
  assert.equal(url.protocol, 'https:', 'Real walkthrough requires a configured HTTPS model endpoint');
  assert.ok(!['127.0.0.1', 'localhost', '::1'].includes(url.hostname), 'Never fall back to the local model fixture');
}
assert.ok(gateway.llm.apiKey && proxy.upstream.apiKey);
assert.equal(info.node, release.node);
const coreUrl = new URL(info.core), panelUrl = new URL(info.panel), proxyUrl = new URL(info.proxy), rankUrl = new URL(proxy.injection.teamAssets.endpoint);
for (const url of [coreUrl, panelUrl, proxyUrl, rankUrl]) assert.equal(url.hostname, '127.0.0.1');
const env = { PATH: `${dirname(release.node)}:${process.env.PATH}`, LANG: 'en_US.UTF-8', TMPDIR: tmpdir(), PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' };
const children = [];
let shuttingDown = false, stop;
const stopped = new Promise(r => { stop = r; });
process.once('SIGTERM', () => stop());
process.once('SIGINT', () => stop());
function start(name, command, args, cwd, extra) {
  const log = createWriteStream(join(dir, `${name}.log`), { mode: 0o600, flags: 'a' });
  const child = spawn(command, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log); child.stderr.pipe(log); children.push(child);
  child.on('error', () => { process.exitCode = 1; console.error(`${name} failed to start`); stop(); });
  child.on('exit', (code, signal) => {
    if (!shuttingDown) { process.exitCode = 1; console.error(`${name} stopped (code=${code}, signal=${signal})`); stop(); }
  });
}
async function healthy(url) {
  const until = Date.now() + 45000;
  while (Date.now() < until && !process.exitCode) {
    try { if ((await fetch(`${url.origin}/health`, { signal: AbortSignal.timeout(2000) })).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`Service not ready: ${url.origin}`);
}
try {
  start('core', release.node, ['--import', 'tsx', 'src/gateway/server.ts'], release.package_directory, { TDAI_GATEWAY_CONFIG: join(dir, 'gateway.json'), TDAI_METADATA_SQLITE_BASE_DIR: join(dir, 'metadata') });
  await healthy(coreUrl);
  start('panel', release.node, [join(root, 'MemoryPanel/dist/index.js')], dir, { HOST: '127.0.0.1', PORT: panelUrl.port, METADATA_INSTANCES_CONFIG: join(dir, 'instances.json'), UI_DIST_DIR: join(root, 'MemoryPanel/web/dist'), KNOWLEDGE_LLM_BINDING_SYNC: 'false', TDAI_AGENT_TEMPLATE_DIR: join(dir, 'templates') });
  start('orchestrator', 'python3', ['-m', 'team_asset_bench', 'serve', '--host', '127.0.0.1', '--port', rankUrl.port], join(root, 'evaluation/team_asset_bench'), { TEAM_ASSET_STATE_DB: join(dir, 'runtime.sqlite'), TEAM_ASSET_HUB_ENV: join(dir, 'hub.env'), TEAM_ASSET_BINDINGS_FILE: join(dir, 'bindings.json'), TEAM_ASSET_CORE_URL: coreUrl.origin, TEAM_ASSET_SERVER_TOKEN: proxy.injection.teamAssets.serviceToken });
  await Promise.all([healthy(panelUrl), healthy(rankUrl)]);
  start('proxy', release.node, ['--import', 'tsx/esm', 'src/index.ts', '--config', join(dir, 'proxy.json')], join(root, 'MemoryProxy'), { PROXY_DATA_DIR: join(dir, 'proxy-data'), QUALITY_OUTBOX_DIR: join(dir, 'outbox') });
  await healthy(proxyUrl);
  writeFileSync(join(dir, 'walkthrough.json'), JSON.stringify({ ...info, pid: process.pid }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ready: true, model_mode: 'real', model: info.model, provider: new URL(gateway.llm.baseUrl).hostname, panel: info.panel, no_fixture_server: true }));
  await stopped;
} catch (error) { process.exitCode = 1; console.error(error.message); }
finally {
  shuttingDown = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 1000));
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
}
