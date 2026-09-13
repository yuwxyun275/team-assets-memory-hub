#!/usr/bin/env node
/** Install the actual npm tarball into an empty directory, then boot its gateway. */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
const root = resolve(import.meta.dirname, '..');
const runDir = mkdtempSync(join(tmpdir(), 'team-assets-release-'));
const report = { mode: 'fresh-npm-install', run_directory: runDir, real_model_calls: false, checks: [] };
mkdirSync(join(root, 'output'), { recursive: true });
const reportPath = join(root, 'output', `release-${Date.now()}.json`);
async function run(name, command, args, cwd) {
  const start = Date.now(); let log = '';
  const code = await new Promise((done, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', c => log += c); child.stderr.on('data', c => log += c);
    child.once('error', reject); child.once('exit', done);
  });
  writeFileSync(join(runDir, `${name}.log`), log, { mode: 0o600 });
  report.checks.push({ name, passed: code === 0, duration_ms: Date.now() - start });
  console.log(`${name}: ${code === 0 ? 'passed' : 'failed'}`);
  if (code !== 0) throw new Error(`${name} failed; inspect ${join(runDir, `${name}.log`)}`);
}
let gateway;
try {
  await run('pack', 'npm', ['pack', '--pack-destination', runDir, '--json'], join(root, 'MemoryCore'));
  const tarball = readdirSync(runDir).find(f => f.endsWith('.tgz'));
  if (!tarball) throw new Error('npm pack produced no tarball');
  writeFileSync(join(runDir, 'package.json'), JSON.stringify({ name: 'release-acceptance', private: true, type: 'module' }));
  await run('install', 'npm', ['install', '--no-audit', '--no-fund', '--prefer-online', join(runDir, tarball), 'node@22'], runDir);
  const node = join(runDir, 'node_modules/node/bin/node');
  const pkg = join(runDir, 'node_modules/@tencentdb-agent-memory/memory-tencentdb-v2');
  report.node = node; report.package_directory = pkg;
  const manifest = JSON.parse(readFileSync(join(pkg, 'package.json')));
  for (const [name, bin] of Object.entries(manifest.bin)) await run(name, node, [join(pkg, bin), '--help'], runDir);
  const port = await new Promise(resolvePort => {
    const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolvePort(p)); });
  });
  const config = join(runDir, 'gateway.json');
  writeFileSync(config, JSON.stringify({ deployMode: 'standalone', stateBackend: 'local', server: { host: '127.0.0.1', port, apiKey: 'release-local-token' }, data: { baseDir: join(runDir, 'data') }, llm: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fake', model: 'offline' }, memory: { embedding: { provider: 'none' }, extraction: { enabled: false } } }));
  const env = { PATH: process.env.PATH, TDAI_GATEWAY_CONFIG: config, TDAI_METADATA_SQLITE_BASE_DIR: join(runDir, 'metadata') };
  let log = '';
  gateway = spawn(node, ['--import', 'tsx', 'src/gateway/server.ts'], { cwd: pkg, env, stdio: ['ignore', 'pipe', 'pipe'] });
  gateway.stdout.on('data', c => log += c); gateway.stderr.on('data', c => log += c);
  let healthy = false;
  for (let i = 0; i < 100; i++) {
    if (gateway.exitCode !== null) break;
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { healthy = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  writeFileSync(join(runDir, 'gateway.log'), log, { mode: 0o600 });
  report.checks.push({ name: 'installed-gateway-health', passed: healthy });
  if (!healthy) throw new Error(`Installed gateway failed to start; inspect ${join(runDir, 'gateway.log')}`);
  const response = await fetch(`http://127.0.0.1:${port}/v3/internal/meta/user/init-admin`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tdai-service-id': 'default', authorization: 'Bearer release-local-token' }, body: JSON.stringify({ username: 'release-admin' }) });
  const body = await response.json();
  const initialized = response.ok && body.code === 0 && !!body.data?.user_id;
  report.checks.push({ name: 'installed-metadata-initialize', passed: initialized });
  if (!initialized) throw new Error(`Metadata initialization failed: HTTP ${response.status}, code ${body.code}`);
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.message; process.exitCode = 1; }
finally {
  if (gateway && gateway.exitCode === null) {
    gateway.kill('SIGTERM');
    await Promise.race([new Promise(r => gateway.once('exit', r)), new Promise(r => setTimeout(r, 3000))]);
    if (gateway.exitCode === null) gateway.kill('SIGKILL');
  }
  report.completed_at = new Date().toISOString();
  writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, report: reportPath, run_directory: runDir, error: report.error }));
}
