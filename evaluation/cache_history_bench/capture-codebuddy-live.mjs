// Capture actual desktop -> Proxy -> upstream evidence. This does not send model requests.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const directory = resolve(process.argv[2]);
const final = process.argv.includes('--final');
const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
const binding = JSON.parse(readFileSync(join(directory, 'current-binding.json'), 'utf8'));
const sessions = new Set(['99ddad365f034e7e91b1aa548a67c2f0', 'bc9a25fe9bb8452488ec5dff267f17a3']);
if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(manifest.prepared_at)) throw Error('Invalid log start');
const logs = execFileSync('/bin/sh', ['-c', `docker logs --since '${manifest.prepared_at}' tdai-proxy 2>&1`], { encoding: 'utf8', maxBuffer: 30_000_000 });
const records = [], pending = [], events = [];
let currentSession = '';
for (const line of logs.split('\n')) {
  const identity = line.match(/\[injection-debug\] conversationId=(\S+)/);
  if (identity) currentSession = identity[1];
  const start = line.match(/(\d\d-\d\d \d\d:\d\d:\d\d\.\d+) \[([^\]]+)\] → REQ model=(\S+) msgs=(\d+)/);
  if (start) {
    const record = { session: currentSession, started_utc: `2026-${start[1].replace(' ', 'T')}Z`, tag: start[2], model: start[3], message_count: Number(start[4]), request_log: line };
    pending.push(record);
    if (sessions.has(currentSession)) records.push(record);
  }
  const usage = line.match(/(\d\d-\d\d \d\d:\d\d:\d\d\.\d+) \[([^\]]+)\].*✓ STREAM usage: (\{.*\})/);
  if (usage) {
    const candidates = pending.filter(r => r.tag === usage[2] && !r.usage);
    // A short logger tag is not globally unique. Refuse ambiguous attribution.
    if (candidates.length !== 1) throw Error(`Ambiguous request usage: ${line}`);
    const r = candidates[0]; r.finished_utc = `2026-${usage[1].replace(' ', 'T')}Z`; r.usage = JSON.parse(usage[3]); r.usage_log = line;
    if (r.usage.prompt_cache_hit_tokens + r.usage.prompt_cache_miss_tokens !== r.usage.prompt_tokens) throw Error('Invalid cache accounting');
  }
  if (sessions.has(currentSession) && /\[asset-history\]|disclosure-remember.*403|hook.done.*team-assets-orchestrator-injector|CREDIT_REPORT|\[skill-injector\] execute result/.test(line)) events.push({ session: currentSession, line });
}
const summaries = [...sessions].map(session => {
  const rows = records.filter(r => r.session === session && r.usage);
  const sum = key => rows.reduce((n, r) => n + (r.usage[key] || 0), 0);
  const prompt = sum('prompt_tokens');
  return { session, calls: rows.length, input_tokens: prompt, output_tokens: sum('completion_tokens'),
    cache_hit_tokens: sum('prompt_cache_hit_tokens'), cache_miss_tokens: sum('prompt_cache_miss_tokens'),
    weighted_input_cache_hit_rate: prompt ? sum('prompt_cache_hit_tokens') / prompt : null,
    status: session === binding.previous_attempt_session ? 'invalid_asset_binding_attempt' : final ? 'real_codebuddy_task_completed' : 'partial_capture' };
});
const scope = createHash('sha256').update(JSON.stringify(['asset-history-v1', 'default', binding.actor, binding.team.team_id, binding.agent.agent_id, binding.task.task_id, 'bc9a25fe9bb8452488ec5dff267f17a3', 'codebuddy'])).digest('hex');
const history = JSON.parse(execFileSync('docker', ['exec', '--user', '0', 'tdai-proxy', 'cat', `/data/quality-outbox/session-bindings/asset-history/${scope}.json`], { encoding: 'utf8' }));
const diff = execFileSync('git', ['diff', '--', 'feature_flags', 'tests'], { cwd: manifest.workspace, encoding: 'utf8' });
const changedTests = execFileSync('git', ['diff', '--name-only', '--', 'tests'], { cwd: manifest.workspace, encoding: 'utf8' });
const currentCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: manifest.workspace, encoding: 'utf8' }).trim();
let independentVerification;
if (final) {
  if (records.some(r => !r.usage)) throw Error('Model requests remain incomplete');
  if (changedTests || currentCommit !== manifest.baseline_commit) throw Error('Tests or baseline commit unexpectedly changed');
  const { spawnSync } = await import('node:child_process');
  const test = spawnSync('python3', ['-m', 'pytest', '-q'], { cwd: manifest.workspace, encoding: 'utf8' });
  if (test.status !== 0 || !/9 passed/.test(test.stdout)) throw Error('Independent verification failed');
  independentVerification = { runner: 'Codex independent post-CodeBuddy check; NOT a CodeBuddy model request',
    command: 'python3 -m pytest -q', exit_code: test.status, stdout: test.stdout, stderr: test.stderr,
    tests_unchanged: true, baseline_commit_unchanged: true,
    codebuddy_report_sha256: createHash('sha256').update(readFileSync(join(manifest.workspace, 'LIVE_VERIFICATION.md'))).digest('hex') };
}
const result = { captured_at: new Date().toISOString(), method: 'Actual CodeBuddy desktop requests, Docker Proxy STREAM usage returned by DeepSeek; no replay or extra paid requests',
  limitations: [final ? 'One isolated sample, three human task turns; no actual client compaction occurred.' : 'Partial capture; not a completed-task result.',
    'No real-client front-injection control arm; no controlled improvement claim.', 'Prior failed Agent ownership attempt kept separate.',
    'Short logger request tags are correlated only when one pending request exists.', 'Only main CodeBuddy upstream STREAM usage counted; separate background evaluators/extractors are not included.'],
  summaries, requests: records, events, source_diff_empty: diff === '', independent_verification: independentVerification };
const suffix = final ? '' : '.partial';
writeFileSync(join(directory, `live-evidence${suffix}.json`), JSON.stringify(result, null, 2), { mode: 0o600 });
writeFileSync(join(directory, `asset-history${suffix}.json`), JSON.stringify(history, null, 2), { mode: 0o600 });
if (final) writeFileSync(join(directory, 'codebuddy-source.diff'), diff, { mode: 0o600 });
console.log(JSON.stringify({ file: join(directory, `live-evidence${suffix}.json`), summaries, source_diff_empty: result.source_diff_empty }, null, 2));
