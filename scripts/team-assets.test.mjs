import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareSources } from './team-assets.mjs';
import { buildCliInvocation } from '../agents/codebuddy/cli.mjs';
import { account } from '../evaluation/asset_recommendation_bench/accounting.mjs';

test('prepares raw files without constructing asset answers; records synthetic provenance', () => {
  const input = prepareSources(resolve('evaluation/learning-fixture/source-manifest.json'));
  assert.equal(input.sources.length, 4);
  assert.equal(input.sources[1].kind, 'conversation');
  assert.ok(input.sources.every(s => s.synthetic && /^[a-f0-9]{64}$/.test(s.revision)));
  assert.equal(input.candidates, undefined);
});
test('rejects source traversal and symlink escapes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'source-paths-'));
  try {
    mkdirSync(join(dir, 'root')); writeFileSync(join(dir, 'outside.md'), 'private');
    symlinkSync(join(dir, 'outside.md'), join(dir, 'root/link.md'));
    for (const path of ['../outside.md', 'link.md']) {
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ root: 'root', sources: [{ path }] }));
      assert.throws(() => prepareSources(join(dir, 'manifest.json')), /escapes/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('CLI credentials stay in the child environment and resume keeps explicit binding', () => {
  const run = buildCliInvocation({ proxy: 'http://localhost:8096/codebuddy/default', model: 'hy3', team: 't', agent: 'a', task: 'k', prompt: 'inspect', resume: 'old-session', workspace: '.' }, { TEAM_ASSET_USER_KEY: 'fake-secret' });
  assert.equal(run.env.CODEBUDDY_BASE_URL, 'http://localhost:8096/codebuddy/default/v1');
  assert.ok(!JSON.stringify(run.args).includes('fake-secret')); assert.ok(run.args.includes('--resume'));
  assert.throws(() => buildCliInvocation({ team: 't', agent: 'a', task: 'k\nforged: true' }, {}));
});
test('merges main and background costs, counts setup once, deduplicates and preserves missing usage', () => {
  const main = { request_id: 'r', task_id: 'task', model: 'm', usage: { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 40 } };
  const bg = { data: { call_id: 'b', purpose: 'history_extraction', model: 'm', task_id: null, status: 'completed', input_tokens: 100, output_tokens: 10, cache_read_tokens: 40, cache_write_tokens: 0 } };
  const prices = [{ model: 'm', version: 'fixture', currency: 'TEST', input_per_million: 2, output_per_million: 4, cache_read_per_million: .5 }];
  const report = account([main, main], [bg], prices);
  assert.equal(report.total.calls, 2); assert.equal(report.asset_preparation.calls, 1); assert.equal(report.by_task.task.calls, 1);
  assert.ok(Math.abs(report.total.estimated_cost.amount - .00036) < 1e-8);
  const missing = account([{ request_id: 'missing' }], [], prices);
  assert.equal(missing.total.input_tokens, null); assert.equal(missing.total.estimated_cost, null);
});
