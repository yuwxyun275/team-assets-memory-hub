/** Real Core/ranker/HTTP bridge + synthetic client history. No model call. */
import fs from 'node:fs';
import { buildConfig } from '/app/src/config.ts';
import { getInjectionPipeline, ensureBindingRepoPersistent } from '/app/src/injection/index.ts';
import { getSessionStore } from '/app/src/session/store.ts';
import { configuredHistoryStore, historyScope } from '/app/src/assets/history-store.ts';
import { startQualityOutbox } from '/app/src/injection/injectors/quality-outbox.ts';
const d = JSON.parse(fs.readFileSync('/tmp/history-smoke-context.json', 'utf8'));
const config = buildConfig({ configFile: '/data/config.yaml' });
const check = (v: unknown, message: string) => { if (!v) throw new Error(message); };
check(config.injection.injectors.includes('team-assets'), 'production whitelist missing team-assets');
check(config.injection.teamAssets.historyEnabled, 'history disabled');
ensureBindingRepoPersistent(config); startQualityOutbox(config.coreSkill, false);
const store = getSessionStore();
store.bind(`codebuddy:${d.session}`, { userId: d.owner, spaceId: 'default', agentSource: 'codebuddy', sessionId: d.session });
await store.set(`codebuddy:${d.session}`, { status: 'initialized', keyId: `codebuddy:${d.session}`, startedAt: Date.now(), attemptCount: 0,
  sessionInfo: { session_id: d.session, space_id: 'default', user_id: d.owner, user_key: d.key, team_id: d.team, agent_id: d.agent, task_id: d.task } as any });
// Verify the live factory registration, then isolate team assets from unrelated
// injectors when measuring this component's exact prefix behavior.
const production = getInjectionPipeline(config);
check((production as any).registry.getAll().some((h: any) => h.id === 'team-assets-orchestrator-injector'), 'live registration missing');
const isolated = structuredClone(config);
isolated.injection.injectors = ['team-assets']; isolated.injection.teamAssets.inlineMaxChars = 0;
const pipeline = getInjectionPipeline(isolated);
const meta: any = { protocol: 'openai', traceId: d.session, keyId: 'history-smoke', modelId: 'synthetic-no-model', stream: false,
  spaceId: 'default', userId: d.owner, turnSeq: 1, agentSource: 'codebuddy', custom: {
    userKey: d.key, session: { session_id: d.session, team_id: d.team, agent_id: d.agent, task_id: d.task, user_id: d.owner },
    taskDetail: { id: d.task, name: 'Proxy 历史接口验收', description: '在隔离示例 feature_flags v1 中审查 Redis 安全回退、禁止请求内重试、租户隔离和缓存恢复。' },
  } };
const raw: any = { model: 'synthetic-no-model', messages: [{ role: 'system', content: '固定系统前缀。接口验收，不声称执行代码或完成任务。' },
  { role: 'user', content: '推荐 Redis 故障回退和恢复测试相关的团队资料。' }] };
const run = (body: any) => pipeline.process(body, structuredClone(meta)) as Promise<any>;
const cardKeys = (body: any) => [...JSON.stringify(body).matchAll(/team_asset_card key=\\"([^\\]+)\\"/g)].map(m => m[1]);
try {
  const first = await run(raw), keys = cardKeys(first);
  check(keys.length > 0, 'ranker returned no cards');
  const secondInput = structuredClone(raw);
  secondInput.messages.push({ role: 'assistant', content: '这是合成接口回复，不是工程修复证据。' }, { role: 'user', content: '继续审查 Redis 恢复和租户隔离' });
  const second = await run(secondInput);
  check(JSON.stringify(second.messages.slice(0, first.messages.length)) === JSON.stringify(first.messages), 'old augmented prefix moved');
  check(new Set(cardKeys(second)).size === cardKeys(second).length, 'duplicate cards on next turn');
  const compacted = { ...raw, messages: [raw.messages[0],
    { role: 'user', content: '<conversation_summary>正在审查 Redis 安全回退及恢复测试，尚无工程执行结果。</conversation_summary>' },
    { role: 'user', content: '继续审查 Redis 恢复路径' }] };
  const checkpoint = await run(compacted);
  check(String(checkpoint.messages[2]?.content).includes('team_asset_card'), 'cards not moved directly after summary');
  check(keys.every(key => cardKeys(checkpoint).includes(key)), 'lost previously offered cards');
  check(new Set(cardKeys(checkpoint)).size === cardKeys(checkpoint).length, 'duplicate checkpoint cards');
  const afterInput = structuredClone(compacted);
  afterInput.messages.push({ role: 'assistant', content: '合成检查继续。' }, { role: 'user', content: '继续 Redis 审查' });
  const after = await run(afterInput);
  check(JSON.stringify(after.messages.slice(0, checkpoint.messages.length)) === JSON.stringify(checkpoint.messages), 'checkpoint rewritten on next turn');
  const headers = { 'content-type': 'application/json', 'x-tdai-service-id': 'default', 'x-conversation-id': d.session };
  const response = await fetch('http://127.0.0.1:8096/asset-bridge/list', { method: 'POST', headers, body: '{"limit":10}' });
  check(response.ok, `live directory failed ${response.status}`);
  const listed: any = await response.json(); check(listed.items.length > 0, 'empty directory in separate running process');
  const ref = listed.items[0];
  const read = await fetch('http://127.0.0.1:8096/asset-bridge/read', { method: 'POST', headers, body: JSON.stringify({ asset_id: ref.asset_id, revision_id: ref.revision_id }) });
  check(read.ok && (await read.text()).includes('<team_asset_content'), 'live versioned read failed');
  const state = await configuredHistoryStore(config)!.read(historyScope({ space: 'default', user: d.owner, team: d.team, agent: d.agent,
    task: d.task, session: d.session, source: 'codebuddy' }));
  check(state.entries.some(e => e.retired_reason === 'compacted'), 'old anchors were not retained as retired audit');
  console.log(JSON.stringify({ production_hook_registered: true, initial_cards: keys.length, original_augmented_prefix_preserved: true,
    checkpoint_after_summary: true, checkpoint_next_request_stable: true, duplicate_cards: false,
    live_http_directory_count: listed.total, live_versioned_read: true, retired_anchors_preserved: true,
    client_history: 'synthetic', backend: 'real Core + ranker + running Proxy bridge', model_called: false,
    production_cache_hit_rate_measured: false }));
} finally { await store.getBindingRepo()?.deleteBinding('default', d.session); }
