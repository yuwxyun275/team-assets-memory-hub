import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const run = JSON.parse(readFileSync(resolve(root, 'output/quality-live/run.json'), 'utf8'));
if (!run.smoke_agent) throw new Error('Authorized demo Agent required');
const env = Object.fromEntries(readFileSync(resolve(root, 'evaluation/team_asset_bench/runtime/hub-demo.env'), 'utf8').split('\n')
  .filter(x => /^[A-Z_]+=/.test(x)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]; }));
const directory = resolve(root, 'output/quality-deployment/history-smoke'); mkdirSync(directory, { recursive: true, mode: 0o700 });
const file = resolve(directory, 'context.json');
writeFileSync(file, JSON.stringify({ owner: run.team.owner_user_id, key: env.TEAM_ASSET_DEMO_USER_KEY, team: run.team.team_id,
  task: run.task.task_id, agent: run.smoke_agent.agent_id, session: `history-smoke-${Date.now()}` }), { mode: 0o600 });
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
try {
  docker('cp', file, 'tdai-proxy:/tmp/history-smoke-context.json');
  docker('exec', '--user', '0', 'tdai-proxy', 'node', '-e', 'require("node:fs").chownSync("/tmp/history-smoke-context.json",10001,999)');
  docker('cp', resolve(root, 'deploy/quality-v2/history-smoke.ts'), 'tdai-proxy:/app/history-smoke.ts');
  const result = docker('exec', 'tdai-proxy', 'node', '--import', 'tsx', '/app/history-smoke.ts');
  writeFileSync(resolve(root, 'output/quality-live/history-smoke.txt'), result, { mode: 0o600 });
  const summary = result.split('\n').findLast(line => line.startsWith('{"production_hook_registered"'));
  if (!summary) throw new Error('smoke summary missing');
  writeFileSync(resolve(root, 'output/quality-live/history-smoke.json'), summary + '\n', { mode: 0o600 });
  console.log(summary);
} finally {
  unlinkSync(file);
  docker('exec', '--user', '0', 'tdai-proxy', 'node', '-e', 'require("node:fs").unlinkSync("/tmp/history-smoke-context.json")');
}
