/** Read-only checks after deploying scene feedback. Does not create tasks,
 * expose assets, observe events, change labels, or make model requests.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { codebuddyApi as api } from '../cache_history_bench/codebuddy-live-api.mjs';
const root = 'output/scene-feedback-20260911';
const run = JSON.parse(readFileSync(`${root}/run.json`, 'utf8'));
const result = { checked_at: new Date().toISOString(), mode: 'read_only_deployed_state', model_requests: 0, cases: [] };
for (const c of run.cases) {
  const receipt = await api('asset/quality/task-receipt', { team_id: run.team_id, task_id: c.task_id });
  const item = receipt.items.find(r => r.receipt_id === c.exposure_id);
  assert.ok(item?.recommendation_scene?.hash);
  assert.equal(item.applicability.verdict, c.expected_fit);
  assert.equal(item.assessment.outcome, c.expected_effect);
  assert.equal(item.scene_feedback.applicability_adjustment, 0);
  assert.equal(item.scene_feedback.scene_learning.fit_tasks, 1);
  assert.equal(item.scene_feedback.scene_learning.minimum_fit_tasks, 3);
  assert.equal(item.scene_feedback.scene_learning.calibrated, false);
  assert.ok(!('before' in item.scene_feedback), 'Aggregates must not reveal other actors\' raw scene snapshots');
  assert.equal(item.scene_feedback.score === null, c.expected_effect !== 'helpful');
  result.cases.push({ id: c.id, task_id: c.task_id, receipt: item });
}
const detail = await api('asset/quality/details', { team_id: run.team_id, asset_id: run.asset_id });
result.quality_unchanged = detail.publication.report.scorecard.quality === run.q_before;
result.publication_unchanged = detail.publication.revision_id === run.revision_id;
assert.ok(result.quality_unchanged && result.publication_unchanged);
result.services = ['tdai-memory-core', 'tdai-proxy', 'tdai-memory-hub', 'tdai-quality-orchestrator'].map(name => {
  const s = JSON.parse(execFileSync('docker', ['inspect', '--format', '{{json .State}}', name], { encoding: 'utf8' }));
  assert.equal(s.Running, true, name);
  if (s.Health) assert.equal(s.Health.Status, 'healthy', name);
  return { name, running: s.Running, health: s.Health?.Status ?? 'not_configured' };
});
const files = ['MemoryCore/src/asset-quality/scene.ts', 'MemoryCore/src/asset-quality/lifecycle.ts',
  'MemoryCore/src/asset-quality/usage-reviewer.ts', 'MemoryCore/src/asset-quality/usage-result.ts',
  'MemoryCore/src/asset-quality/disclosure.ts', 'MemoryCore/src/gateway/server.ts',
  'MemoryCore/src/metadata/service/metadata-service.ts',
  'MemoryProxy/src/injection/injectors/quality-observer.ts',
  'MemoryProxy/src/injection/injectors/team-assets-orchestrator-injector.ts',
  'MemoryPanel/web/src/pages/WorkbenchPage/components/UsageEffectReceipts.tsx',
  'evaluation/team_asset_bench/team_asset_bench/native_assets.py'];
result.source_sha256 = Object.fromEntries(files.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
const path = `${root}/deployed-state-check.json`;
writeFileSync(path, JSON.stringify(result, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ path, cases: result.cases.length, quality_unchanged: result.quality_unchanged,
  publication_unchanged: result.publication_unchanged, services: result.services }));
