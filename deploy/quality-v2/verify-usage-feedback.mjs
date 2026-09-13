/** Read-only deployed API smoke. No evaluation retry, model call, or change to trial records. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { codebuddyApi } from '../../evaluation/cache_history_bench/codebuddy-live-api.mjs';
const root = resolve(import.meta.dirname, '../..');
const team = 'team-br2woxronz', task = 'task-bse1xi2aad';
const model = JSON.parse(readFileSync('/Users/xiaomo/.codebuddy/models.json', 'utf8')).models.find(m => m.id === 'deepseek-v4-flash');
const panel = async (action, data) => {
  const r = await fetch(`http://127.0.0.1:8125/api/v1/meta/${action}`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tdai-service-id': 'default', 'x-tdai-user-key': model.apiKey },
    body: JSON.stringify(data), signal: AbortSignal.timeout(15000) });
  const body = await r.json(); assert.equal(r.status, 200); assert.equal(body.code, 0); return body.data;
};
const before = await codebuddyApi('task/get', { task_id: task });
const receipt = await panel('asset/quality/task-receipt', { team_id: team, task_id: task });
assert.equal(receipt.native_states_unchanged, true);
assert.ok(receipt.items.every(r => r.task_id === task && r.team_id === team && r.revision_id));
const queue = await panel('asset/quality/failed-uses', { team_id: team });
assert.ok(queue.items.every(r => r.status === 'manual_review'));
const ids = []; let total;
for (let offset = 0; ; offset += 200) {
  const page = await panel('asset/quality/list', { team_id: team, offset, limit: 200 });
  total = page.total; ids.push(...page.items.map(a => a.asset_id));
  if (offset + 200 >= total) break;
}
assert.equal(new Set(ids).size, ids.length, 'Panel dropped pagination; repeated assets');
assert.equal(ids.length, total);
assert.ok(queue.items.every(r => ids.includes(r.asset_id)), 'A manual-review asset is missing from the selector');
const after = await codebuddyApi('task/get', { task_id: task });
assert.equal(after.metadata_json, before.metadata_json, 'Read-through effect receipt changed native task metadata');
const report = { at: new Date().toISOString(), mode: 'read_only_deployed_api_smoke', task, team,
  task_receipt: receipt.summary, failed_uses: queue.summary, listed_assets: ids.length, unique_assets: new Set(ids).size,
  native_task_metadata_unchanged: true,
  metadata_sha256: createHash('sha256').update(before.metadata_json || '').digest('hex'),
  evaluation_calls: 0, old_trials_replayed: false };
const directory = join(root, 'output/usage-feedback-20260910'); mkdirSync(directory, { recursive: true });
const path = join(directory, `live-smoke-${Date.now()}.json`);
writeFileSync(path, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ...report, path }, null, 2));
