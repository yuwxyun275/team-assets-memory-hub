import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { syntheticFixture } from '../cache_injection_bench/synthetic-fixture.mjs';
const root = resolve(import.meta.dirname, '../..');
const live = process.argv.includes('--live');
const run = `history-cache-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const output = resolve(root, 'output/cache-history-bench', run);
mkdirSync(output, { recursive: true, mode: 0o700 });
writeFileSync(join(output, 'fixture.json'), JSON.stringify(syntheticFixture(false), null, 2), { mode: 0o600 });
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const sourceFiles = ['assets/history.ts', 'assets/history-store.ts', 'assets/disclosure.ts', 'injection/pipeline.ts', 'injection/adapters/openai.ts'];
const sha = text => createHash('sha256').update(text).digest('hex');
for (const p of sourceFiles) {
  const deployed = docker('exec', 'tdai-proxy', 'node', '-e', 'process.stdout.write(require("node:fs").readFileSync(process.argv[1]))', `/app/src/${p}`);
  if (sha(deployed) !== sha(readFileSync(resolve(root, 'MemoryProxy/src', p)))) throw new Error(`Deployed source differs: ${p}`);
}
const stage = `/tmp/${run}`;
docker('exec', '--user', '0', 'tdai-proxy', 'node', '-e', 'require("node:fs").mkdirSync(process.argv[1],{recursive:true,mode:0o700})', stage);
for (const file of ['bench.ts', 'package.json']) docker('cp', join(import.meta.dirname, file), `tdai-proxy:${stage}/${file}`);
docker('cp', resolve(root, 'evaluation/cache_injection_bench/fixture.ts'), `tdai-proxy:${stage}/metrics.ts`);
docker('cp', join(output, 'fixture.json'), `tdai-proxy:${stage}/fixture.json`);
console.log(JSON.stringify({ run, output, live, comparison_requests: 108, calibration_requests: 3,
  input_limit: 1000000, output_limit_per_request: 16, deployed_source_matches_workspace: true,
  normal_proxy_settings_changed: false, comparison: 'placement ablation, NOT original vs fork' }));
const child = spawn('docker', ['exec', '--user', '0', '-e', `HISTORY_BENCH_RUN=${run}`, 'tdai-proxy',
  'node', '--import', 'tsx', `${stage}/bench.ts`, ...(live ? ['--live'] : [])], { stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', data => { log += data; process.stdout.write(data); });
child.stderr.on('data', data => { log += data; process.stderr.write(data); });
const code = await new Promise(done => child.on('close', done));
writeFileSync(join(output, 'run.log'), log, { mode: 0o600 });
let copied = false;
try { docker('cp', `tdai-proxy:${stage}/result`, output); copied = true; }
catch (error) { if (code === 0) throw error; }
finally {
  // Only disposable fixture files; preserve the stage if result copying failed.
  if (copied) docker('exec', '--user', '0', 'tdai-proxy', 'node', '-e',
    'const p=process.argv[1];if(!p.startsWith("/tmp/")||!/^history-cache-[0-9TZ-]+$/.test(p.slice(5)))throw Error("bad target");require("node:fs").rmSync(p,{recursive:true,force:true});', stage);
}
console.log(JSON.stringify({ exit_code: code, output, temporary_fixture_removed: copied }));
process.exitCode = Number(code) || 0;
