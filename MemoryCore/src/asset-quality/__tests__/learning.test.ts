import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteMetadataStore } from "../../metadata/store/sqlite-adapter.js";
import { MetadataService } from "../../metadata/service/metadata-service.js";
import { AssetLearning, validateLearningResult, type LearningInput } from "../learning.js";
import { createLearningGenerator } from "../learning-generator.js";
import { learningExcerpts } from "../learning-evidence.js";
import { measuredModelText, summarizeModelUsage, withModelUsage } from "../model-usage.js";
const stores: SqliteMetadataStore[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); });
const input: LearningInput = { mode: "history", repository: "synthetic/inventory", version: "v1", scope: "单进程库存预留，不证明并发安全",
  sources: [{ id: "doc", kind: "document", locator: "product.md", revision: "v1", synthetic: true, visibility: "team", content: "同一请求只扣一次库存；参数改变应返回冲突。" }] };
const result = () => ({ candidates: [{ kind: "project_experience", title: "库存预留去重", claim: "同一请求只扣一次库存。", action: "复用请求结果并核对原参数。", applicability: "单进程库存预留示例 v1；并发与重启未验证。", risk: "medium",
  evidence: [{ source_id: "doc", start: 0, end: input.sources[0].content.length, quote: input.sources[0].content }] }], reason: "来自合成产品规则，不代表真实模型效果" });
function db() { const db = new SqliteMetadataStore(":memory:"); db.init(); stores.push(db); return db; }
function serviceFixture() {
  const database = db(), assets = new Map<string, any>();
  const store = { qualityRecords: database.qualityRecords, getTeamById: vi.fn(async () => ({ team_id: 'team' })),
    getTeamMember: vi.fn(async () => ({ status: 'active', role: 'admin' })),
    getAssetById: vi.fn(async (id: string) => assets.get(id) ?? null),
    listAssetsByTeam: vi.fn(async () => ({ items: [...assets.values()], total: assets.size })),
    createAsset: vi.fn(async (i: any) => { const a = { ...i, version: 1 }; assets.set(i.asset_id, a); return a; }),
    updateAsset: vi.fn(async (id: string, p: any) => { const a = { ...assets.get(id), ...p }; assets.set(id, a); return a; }),
    listAclByAsset: vi.fn(async () => ({ items: [], total: 0 })),
    getTaskById: vi.fn(async () => ({ task_id: 'task', team_id: 'team', creator_user_id: 'owner', title: '库存问题', metadata_json: '{}' })),
  };
  return { service: new MetadataService(store as any), store, assets, records: database.qualityRecords };
}
const owner = { userId: "owner", token: "test", isAdmin: false, isSystemAdmin: false };

describe("source learning and task feedback share a guarded candidate pipeline", () => {
  it("uses the real SDK against a fake provider, creates reviewable candidates, and resumes idempotently", async () => {
    const { service, assets, records } = serviceFixture();
    const transport = vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      expect(request.tools).toBeUndefined();
      const sent = JSON.parse(request.messages[1].content);
      expect(sent.repository).toBe(input.repository);
      expect(sent.sources[0].excerpts.map((e: any) => e.quote).join('')).toBe(input.sources[0].content);
      return new Response(JSON.stringify({ id: 'fake-provider', object: 'chat.completion', created: 1, model: 'fixture',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(result()) } }],
        usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 } }), { headers: { 'content-type': 'application/json' } });
    });
    service.setAssetLearningGenerator(createLearningGenerator({ baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture', model: 'fixture' }, transport as any));
    const job = await service.qualityForCaller('learning-submit', { team_id: 'team', input }, owner);
    expect(assets.size).toBe(0);
    await service.learning!.queue.tick();
    const completed = await records.get(job.key);
    expect(completed?.data.state).toBe('completed');
    const asset = [...assets.values()][0];
    expect(asset).toMatchObject({ status: 'candidate', owner_user_id: 'owner', visibility: 'team' });
    expect(JSON.parse(asset.metadata_json)).toMatchObject({ repository: input.repository, project_version: input.version });
    const candidate = await service.qualityForCaller('learning-candidate', { team_id: 'team', asset_id: asset.asset_id }, owner);
    expect(candidate.data.source_manifest[0]).toMatchObject({ locator: 'product.md', synthetic: true });
    expect(candidate.data.verification.automatic_validation).toBe(false);
    expect(await service.quality!.publication('team', asset.asset_id)).toBeNull();
    expect((await service.quality!.details('team', asset.asset_id)).revisions[0].data.state).toBe('queued');
    await expect(service.checkAssetPermission({ user_id: 'owner', asset_id: asset.asset_id, action: 'use' })).resolves.toMatchObject({ allowed: false });
    expect((await service.qualityForCaller('learning-submit', { team_id: 'team', input }, owner)).key).toBe(job.key);
    await service.learning!.queue.tick(); expect(transport).toHaveBeenCalledTimes(1); expect(assets.size).toBe(1);
    const costs = await service.qualityForCaller('costs', { team_id: 'team' }, owner);
    expect(costs.summary).toMatchObject({ calls: 1, input_tokens: 120, output_tokens: 40 });
    service.setAssetQualityReviewer({ id: 'local-review-fixture', review: async (s, criteria) => ({ checks: criteria.map(c => ({
      id: c.id, status: 'pass', reason: '本地审核协议测试，不是真实质量结论', score: 4,
      evidence: [{ source_id: 'asset', quote: s.body }, ...(c.supportKinds ? [{ source_id: s.sources[0].id, quote: s.sources[0].content }] : [])],
    })) }) });
    await service.quality!.tick();
    const revision = (await service.quality!.details('team', asset.asset_id)).revisions[0];
    expect(revision.data.state).toBe('awaiting_approval');
    await service.qualityForCaller('decide', { team_id: 'team', revision_id: revision.data.id, decision: 'approve', note: '本地合成资料审核流程验证' }, owner);
    expect(await service.checkAssetPermission({ user_id: 'owner', asset_id: asset.asset_id, action: 'use' })).toMatchObject({ allowed: true });
    const publication = await service.quality!.publication('team', asset.asset_id);
    expect(publication?.snapshot.body).toContain('同一请求只扣一次库存');
    expect(publication?.snapshot.sources[0].content).toBe(input.sources[0].content);
    expect(publication?.snapshot.project_scope).toEqual({ repository: input.repository, version: 'v1', synthetic: true });
  });
  it('rejects a multibyte source batch before scheduling generation or creating assets', async () => {
    const { service, assets, records } = serviceFixture();
    const oversized = { ...input, sources: [{ ...input.sources[0], content: '证'.repeat(50000) }] };
    await expect(service.qualityForCaller('learning-submit', { team_id: 'team', input: oversized }, owner)).rejects.toThrow(/140000/);
    expect(assets.size).toBe(0);
    expect(await records.list('learning', 'team')).toEqual([]);
  });
  it("rejects fabricated quotes, absent revision targets and caller-authored task receipts", async () => {
    const bad = result(); bad.candidates[0].evidence[0].quote = '没有这条依据';
    expect(() => validateLearningResult(bad, input)).toThrow();
    expect(() => validateLearningResult({ ...result(), candidates: [{ ...result().candidates[0], kind: 'revision_suggestion', target_asset_id: 'invented' }] }, input)).toThrow();
    const { service } = serviceFixture();
    await expect(service.qualityForCaller('learning-submit', { team_id: 'team', input: { ...input, mode: 'task', task_id: 'task' } }, owner)).rejects.toMatchObject({ code: 'invalid_param' });
  });
  it('resolves unique quotes without model-computed offsets and rejects ambiguous ones', () => {
    const output: any = result(); delete output.candidates[0].evidence[0].start; delete output.candidates[0].evidence[0].end;
    expect(validateLearningResult(output, input).candidates[0].evidence[0].start).toBe(0);
    const duplicate = { ...input, sources: [{ ...input.sources[0], content: input.sources[0].content.repeat(2) }] };
    expect(() => validateLearningResult(output, duplicate)).toThrow();
  });
  it('resolves only catalogued source excerpts, including repeated JSON text, without trusting model offsets', () => {
    const source = { ...input.sources[0], content: ('{"value":"重复\\n引用"}\n').repeat(80) + '😀' };
    const nextInput = { ...input, sources: [source] }, spans = learningExcerpts(source);
    expect(spans.map(s => s.quote).join('')).toBe(source.content);
    const output: any = result(); output.candidates[0].evidence = [{ source_id: source.id, excerpt_id: spans[1].excerpt_id }];
    expect(validateLearningResult(output, nextInput).candidates[0].evidence[0]).toEqual({ source_id: source.id, start: spans[1].start, end: spans[1].end, quote: spans[1].quote });
    output.candidates[0].evidence[0].excerpt_id = 'span-1-20';
    expect(() => validateLearningResult(output, nextInput)).toThrow('片段编号');
    output.candidates[0].evidence[0] = { source_id: 'absent', excerpt_id: spans[0].excerpt_id };
    expect(() => validateLearningResult(output, nextInput)).toThrow('片段编号');
  });
  it("keeps source restrictions and never patches the target asset", async () => {
    const { service, store, assets } = serviceFixture();
    service.setAssetLearningGenerator({ id: 'fake', generate: async () => result() });
    await service.learning!.queue.enqueue('team', 'owner', { ...input, sources: input.sources.map(s => ({ ...s, visibility: 'private' })) });
    await service.learning!.queue.tick();
    expect([...assets.values()][0].visibility).toBe('private'); expect(store.updateAsset).not.toHaveBeenCalled();
  });
  it.each(['document', 'conversation'] as const)('preserves failure semantics with the appropriate %s evidence container', async kind => {
    const { service, assets } = serviceFixture();
    service.setAssetLearningGenerator({ id: 'fake', generate: async () => ({ ...result(), candidates: [{ ...result().candidates[0], kind: 'failure_pattern' }] }) });
    await service.learning!.queue.enqueue('team', 'owner', { ...input, sources: input.sources.map(s => ({ ...s, kind })) });
    await service.learning!.queue.tick();
    const asset = [...assets.values()][0];
    expect(asset.asset_type).toBe(kind === 'conversation' ? 'chat_memory' : 'llm_wiki');
    expect(JSON.parse(asset.metadata_json).semantic_asset_type).toBe('failure_experience');
    expect((await service.quality!.details('team', asset.asset_id)).revisions[0].data.state).toBe('queued');
  });
  it("allows no-candidate outcomes and rejects access revoked while queued", async () => {
    const records = db().qualityRecords, allowed = vi.fn(async () => {}), materialize = vi.fn();
    const q = new AssetLearning(records, allowed, materialize);
    q.generator = { id: 'fake', generate: vi.fn(async () => ({ candidates: [], reason: '没有可验证的新经验' })) };
    const first = await q.enqueue('team', 'owner', input); await q.tick();
    expect((await records.get(first.key))?.data.state).toBe('no_candidates'); expect(materialize).not.toHaveBeenCalled();
    await q.enqueue('team', 'owner', { ...input, version: 'v2' });
    allowed.mockRejectedValueOnce(new Error('revoked')); await q.tick();
    expect(q.generator.generate).toHaveBeenCalledTimes(1);
  });
  it("recovers a persisted model result without a second model call after materialization fails", async () => {
    const records = db().qualityRecords, write = vi.fn().mockRejectedValueOnce(new Error('store down')).mockResolvedValue(undefined);
    const q = new AssetLearning(records, async () => {}, write);
    q.generator = { id: 'fake', generate: vi.fn(async () => result()) };
    const job = await q.enqueue('team', 'owner', input); await q.tick();
    const r = (await records.get(job.key))!; await records.cas({ ...r, data: { ...r.data, due: 0 } }, r.rev);
    const recovered = new AssetLearning(records, async () => {}, write); recovered.generator = q.generator;
    await recovered.tick();
    expect(q.generator.generate).toHaveBeenCalledTimes(1); expect((await records.get(job.key))?.data.state).toBe('completed');
  });
  it('feeds citation validation diagnostics into the bounded retry without accepting invented evidence', async () => {
    const records = db().qualityRecords, materialize = vi.fn();
    const q = new AssetLearning(records, async () => {}, materialize);
    const invalid = result(); invalid.candidates[0].evidence[0].quote = 'invented quote';
    q.generator = { id: 'retry-fixture', generate: vi.fn().mockResolvedValueOnce(invalid).mockResolvedValueOnce(result()) };
    const job = await q.enqueue('team', 'owner', input); await q.tick();
    const failed = (await records.get(job.key))!;
    expect(failed.data).toMatchObject({ state: 'queued', attempts: 1, validation_error: '候选引用与原始资料不一致' });
    expect(materialize).not.toHaveBeenCalled();
    expect(JSON.stringify(failed)).not.toContain('invented quote');
    await records.cas({ ...failed, data: { ...failed.data, due: 0 } }, failed.rev);
    await q.tick();
    expect(q.generator.generate).toHaveBeenLastCalledWith(input, expect.any(AbortSignal), '候选引用与原始资料不一致');
    expect((await records.get(job.key))?.data.state).toBe('completed');
    expect(materialize).toHaveBeenCalledOnce();
  });
  it("queues task results automatically without invoking a model on task save", async () => {
    const { service, store, records } = serviceFixture();
    const task = { ...(await store.getTaskById()), metadata_json: JSON.stringify({ asset_evidence: { trace_id: 'trace', completion: { task_completed: true }, ci_runs: [] } }) };
    store.getTaskById.mockResolvedValue(task);
    await service.learning!.recordTask(task as any);
    expect((await records.list('learning-trigger', 'team'))[0].data.state).toBe('queued');
    const trigger = (await records.list('learning-trigger', 'team'))[0];
    expect(trigger.data.due).toBeGreaterThan(Date.now());
    await records.cas({ ...trigger, data: { ...trigger.data, due: 0 } }, trigger.rev);
    service.setAssetLearningGenerator({ id: 'fake', generate: async () => ({ candidates: [], reason: '结果中没有支持新经验的证据' }) });
    await service.learning!.queue.tick();
    expect((await records.list('learning-trigger', 'team'))[0].data.state).toBe('submitted');
    expect((await records.list('learning', 'team'))[0].data.state).toBe('no_candidates');
  });
});

describe('permission and usage accounting boundaries', () => {
  it('denies administrators private snapshots, feedback and source materials', async () => {
    const { service, assets } = serviceFixture();
    assets.set('private', { asset_id: 'private', team_id: 'team', owner_user_id: 'someone', visibility: 'private', status: 'candidate' });
    await expect(service.qualityForCaller('details', { team_id: 'team', asset_id: 'private' }, owner)).rejects.toMatchObject({ code: 'permission_denied' });
    expect((await service.qualityForCaller('list', { team_id: 'team' }, owner)).items).toEqual([]);
    await expect(service.evaluateAssetQualityForCaller({ snapshot: { asset_id: 'private', unit_id: 'x', asset_type: 'llm_wiki', content_version: 'v1', body: 'private', declared_scope: 'repo', sources: [] } }, owner)).rejects.toMatchObject({ code: 'permission_denied' });
  });
  it('loads explicit ACLs for restricted assets despite team role defaults', async () => {
    const { service, store, assets } = serviceFixture();
    store.getTeamMember.mockResolvedValue({ role: 'member', status: 'active' });
    assets.set('restricted', { asset_id: 'restricted', team_id: 'team', owner_user_id: 'someone', visibility: 'restricted', status: 'candidate' });
    store.listAclByAsset.mockResolvedValue({ items: [{ id: 'grant', subject_type: 'user', subject_id: 'owner', permission: 'read', effect: 'allow' }] as any, total: 1 });
    expect(await service.checkAssetPermission({ user_id: 'owner', asset_id: 'restricted', action: 'read' })).toMatchObject({ allowed: true });
    store.listAclByAsset.mockResolvedValue({ items: [], total: 0 });
    expect(await service.checkAssetPermission({ user_id: 'owner', asset_id: 'restricted', action: 'read' })).toMatchObject({ allowed: false });
  });
  it('rechecks source permissions for an already materialized derivative, including its owner', async () => {
    const { service, assets } = serviceFixture();
    assets.set('origin', { asset_id: 'origin', team_id: 'team', owner_user_id: 'someone', visibility: 'team', status: 'approved' });
    assets.set('child', { asset_id: 'child', team_id: 'team', owner_user_id: 'owner', visibility: 'team', status: 'candidate', source_type: 'asset_learning', metadata_json: JSON.stringify({ learning: { source_manifest: [{ asset_id: 'origin' }] } }) });
    expect((await service.checkAssetPermission({ user_id: 'owner', asset_id: 'child', action: 'read' })).allowed).toBe(true);
    assets.get('origin').visibility = 'private';
    expect(await service.checkAssetPermission({ user_id: 'owner', asset_id: 'child', action: 'read' })).toMatchObject({ allowed: false, reason: 'source_permission_revoked' });
  });
  it('preserves failed calls and unknown usage rather than treating them as zero cost', async () => {
    const records = db().qualityRecords;
    await expect(withModelUsage({ records, team: 't', actor: 'a', purpose: 'effect_review' }, () => measuredModelText('m', async () => { throw new Error('sensitive provider body'); }))).rejects.toThrow();
    const rows = await records.list('model-usage', 't');
    expect(summarizeModelUsage(rows)).toMatchObject({ failed_calls: 1, missing_usage_calls: 1, input_tokens: null, estimated_cost: null });
    expect(JSON.stringify(rows)).not.toContain('sensitive');
  });
  it('keeps concurrent usage attributed to the right task and calculates cache-aware estimates', async () => {
    const records = db().qualityRecords;
    await Promise.all(['a', 'b'].map(task_id => withModelUsage({ records, team: 't', actor: task_id, task_id, purpose: 'task_learning' }, () => measuredModelText('m', async () => ({ text: 'secret text', usage: { inputTokens: 100, outputTokens: 10, inputTokenDetails: { cacheReadTokens: 40, cacheWriteTokens: 0 } } })))));
    const rows = await records.list('model-usage', 't');
    expect(new Set(rows.map(r => r.data.task_id))).toEqual(new Set(['a', 'b']));
    const summary = summarizeModelUsage(rows, [{ model: 'm', version: 'test-price', currency: 'TEST', input_per_million: 2, output_per_million: 4, cache_read_per_million: .5 }]);
    expect(summary.estimated_cost?.amount).toBeCloseTo(.00036); expect(JSON.stringify(rows)).not.toContain('secret text');
  });
});
