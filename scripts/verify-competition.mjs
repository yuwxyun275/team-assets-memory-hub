#!/usr/bin/env node
/** Local regression runner. Does not install dependencies, deploy, or call real models. */
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = process.argv.includes('--cli');
const outputIndex = process.argv.indexOf('--output');
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
const checks = [
  ['core-tests', 'MemoryCore', './node_modules/.bin/vitest', ['run', 'src/asset-quality', 'src/metadata/service/__tests__']],
  ['learning-types', 'MemoryCore', './node_modules/.bin/tsc', ['--noEmit', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'es2022', '--types', 'node', '--skipLibCheck', 'src/asset-quality/learning-service.ts', 'src/asset-quality/learning-generator.ts', 'src/asset-quality/model-usage.ts']],
  ['proxy-tests', 'MemoryProxy', './node_modules/.bin/vitest', ['run']],
  ['proxy-types', 'MemoryProxy', './node_modules/.bin/tsc', ['--noEmit']],
  ['panel-tests', 'MemoryPanel', './node_modules/.bin/vitest', ['run']],
  ['panel-types', 'MemoryPanel', './node_modules/.bin/tsc', ['--noEmit']],
  ['panel-web-build', 'MemoryPanel/web', 'npm', ['run', 'build']],
  ['benchmark-tests', 'evaluation/team_asset_bench', 'python3', ['-m', 'pytest', '-q']],
  ['source-cli-accounting-tests', '.', process.execPath, ['--test', 'scripts/team-assets.test.mjs']],
  ['synthetic-project-tests', 'evaluation/learning-fixture', 'python3', ['-m', 'unittest', '-v']],
  ...(cli ? [['installed-cli-local-protocol', '.', process.execPath, ['scripts/verify-codebuddy-cli.mjs']]] : []),
];
const results = [];
for (const [name, dir, bin, args] of checks) {
  const cwd = resolve(root, dir);
  if (bin.startsWith('./') && !existsSync(resolve(cwd, bin))) { results.push({ name, status: 'missing_dependency' }); process.stderr.write(`${name}: install declared project dependencies first\n`); continue; }
  const start = Date.now();
  process.stdout.write(`Running ${name}\n`);
  const result = await new Promise(resolveResult => {
    const child = spawn(bin, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    const append = c => { log = (log + c).slice(-12000); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    child.once('error', () => resolveResult({ name, status: 'failed_to_start' }));
    child.once('exit', code => resolveResult({ name, status: code === 0 ? 'passed' : 'failed', exit_code: code, duration_ms: Date.now() - start, log }));
  });
  results.push(result); process.stdout.write(`${name}: ${result.status}\n`);
  if (result.status !== 'passed' && result.log) process.stderr.write(result.log);
}
const report = { schema_version: 'competition-local-verification/v1', generated_at: new Date().toISOString(),
  real_model_experiments: 'not_run', official_data: 'unavailable', cli_included: cli, results,
  passed: results.every(r => r.status === 'passed') };
if (output) writeFileSync(resolve(output), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
if (!report.passed) process.exitCode = 1;
