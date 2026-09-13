/** Deployed API + real configured asynchronous evaluator. Scenario observations
 * are developer-authored replay fixtures, NOT a fresh CodeBuddy coding session.
 * No success labels are passed to the model and no old experiment is changed.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { codebuddyApi as api, actor } from '../cache_history_bench/codebuddy-live-api.mjs';
const out = resolve(process.argv[2] || 'output/scene-feedback-20260911');
mkdirSync(out, { recursive: true });
const path = join(out, 'run.json');
const previous = JSON.parse(readFileSync('output/closure-live-20260910/run.json', 'utf8'));
const team = previous.team_id, assetId = 'arb-4a0f42b7e7cf2f79f1e560d5';
const detail = await api('asset/quality/details', { team_id: team, asset_id: assetId });
const publication = detail.publication;
assert.ok(publication?.snapshot?.body);
const context = { repository: 'synthetic/flags', task_type: 'bug_fix', environment: 'contract-v1/scene-regression-only' };
const cases = [
  { id: 'applicable-helpful', title: '同步读取：适用与具体反馈', query: 'synthetic/flags contract-v1 同步配置 read 缓存故障，需要禁止请求内重试。',
    after: '构造回归反馈：我按照这条“同一次 read 只尝试一次缓存读取，不循环重试”的建议，将 read 异常分支改成一次 lookup，删除循环。核对后缓存失败只读取一次，不再放大请求。这是用户反馈层面的观察，尚未独立验证。',
    expected_fit: 'applicable', expected_effect: 'helpful' },
  { id: 'inapplicable', title: '支付写入：经验不适用', query: '当前仅处理支付写入的幂等和重试。没有同步配置读取，不修改 synthetic/flags 的 read 方法。',
    after: '构造回归反馈：核对后当前操作是支付写入，不是这份规则限定的同步配置读取。我没有采用这条规则。没有提供它帮助或损害代码的证据。',
    expected_fit: 'not_applicable', expected_effect: 'not_applicable' },
  { id: 'already-done', title: '注入前已修复：不能重复记功', query: 'synthetic/flags contract-v1 同步配置 read 缓存故障，需要核对禁止请求内重试。此前已经删除重试循环，一次 read 只有一次缓存读取，测试已通过。',
    after: '构造回归观察：本轮只重跑了相同测试，9 passed，没有任何新修改，也没有可指向本资料的新增复用行为。',
    expected_fit: 'applicable', expected_effect: 'unobserved' },
];
const run = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { started_at: new Date().toISOString(),
  mode: 'developer_authored_replay_with_real_deployed_async_model', fresh_codebuddy_session: false,
  team_id: team, asset_id: assetId, revision_id: publication.revision_id, context, cases: [], q_before: publication.report.scorecard.quality };
const save = () => writeFileSync(path, JSON.stringify(run, null, 2), { mode: 0o600 });
save();
for (const c of cases) {
  let record = run.cases.find(x => x.id === c.id);
  if (!record) {
    const task = await api('task/create', { team_id: team, creator_user_id: actor, title: `前后文反馈回归 0911 / ${c.title}`,
      description: `开发者构造场景，用于验证前后文分离，不是实际编码完成率实验。\n${c.query}`, linked_agents: [{ agent_id: previous.agent_id }] });
    record = { ...c, task_id: task.task_id, session_id: `scene-replay-${task.task_id}` }; run.cases.push(record); save();
  }
  const before = { schema_version: 'recommendation-scene/v1', request_id: `before-${record.task_id}`, turn: 1,
    query: c.query, task: c.query, active_paths: ['service.py'], errors: [], truncated: false,
    events: [{ id: `prior-${record.task_id}`, role: 'user', content: c.query }] };
  const scope = { team_id: team, agent_id: previous.agent_id, task_id: record.task_id, session_id: record.session_id };
  const catalogue = await api('asset/quality/disclosure-remember', { ...scope,
    references: [{ asset_id: assetId, revision_id: publication.revision_id }], before });
  assert.equal(catalogue.references[0].before.request_id, before.request_id);
  // This is an explicitly simulated delivery event, not desktop execution proof.
  const exposure = await api('asset/quality/expose', { team_id: team, exposure: {
    asset_id: assetId, revision_id: publication.revision_id, task_id: record.task_id, session_id: record.session_id,
    turn: 1, context, injected_text: publication.snapshot.body, request_id: `replay-${record.task_id}`,
    before, baseline_event_ids: before.events.map(e => e.id),
  } });
  await api('asset/quality/observe', { team_id: team, observation: { exposure_id: exposure.key,
    events: [...before.events, { id: `future-${record.task_id}`, role: 'user', content: c.after }] } });
  record.exposure_id = exposure.key; record.before = before; save();
}
const deadline = Date.now() + 12 * 60000;
while (Date.now() < deadline) {
  let complete = true;
  for (const c of run.cases) {
    const receipt = await api('asset/quality/task-receipt', { team_id: team, task_id: c.task_id });
    c.receipt = receipt.items.find(x => x.receipt_id === c.exposure_id);
    c.done = !!c.receipt?.applicability && (!!c.receipt?.assessment || c.receipt?.manual_review_required);
    complete &&= c.done;
  }
  save();
  console.log(JSON.stringify(run.cases.map(c => ({ id: c.id, status: c.receipt?.status,
    fit: c.receipt?.applicability?.verdict, effect: c.receipt?.assessment?.outcome, attempts: c.receipt?.total_attempts }))));
  if (complete) break;
  await new Promise(r => setTimeout(r, 10000));
}
for (const c of run.cases) {
  c.match = c.receipt?.applicability?.verdict === c.expected_fit && c.receipt?.assessment?.outcome === c.expected_effect;
  c.utility = await api('asset/quality/utility', { team_id: team, asset_id: assetId, revision_id: publication.revision_id, context, before: c.before });
}
const afterDetail = await api('asset/quality/details', { team_id: team, asset_id: assetId });
run.finished_at = new Date().toISOString(); run.matched = run.cases.filter(c => c.match).length;
run.q_unchanged = afterDetail.publication.report.scorecard.quality === run.q_before;
run.publication_unchanged = afterDetail.publication.revision_id === run.revision_id;
save();
console.log(JSON.stringify({ result: path, matched: run.matched, total: cases.length,
  q_unchanged: run.q_unchanged, publication_unchanged: run.publication_unchanged }));
assert.ok(run.q_unchanged && run.publication_unchanged);
assert.equal(run.matched, cases.length, 'Keep failed cases for inspection. Never overwrite their expected labels.');
