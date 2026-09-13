import { describe, expect, it, vi } from "vitest";
import { MetadataService } from "../metadata-service.js";
import type { IMetadataStore } from "../../store/interface.js";
import type { V3AuthContext } from "../../router/auth.js";
import { snapshot } from "../../../asset-quality/__tests__/fixtures.js";
import { usageWindowHash } from "../../../asset-quality/usage-result.js";

const owner: V3AuthContext = { userId: "owner", token: "test", isAdmin: false, isSystemAdmin: false };
function setup(role = "member", active = true) {
  const store = {
    getAssetById: vi.fn(async () => ({ asset_id: "asset-1", team_id: "team-1", owner_user_id: "owner", asset_type: "llm_wiki", version: 3, status: "candidate" })),
    getTeamMember: vi.fn(async () => active ? { role, status: "active" } : null),
    updateAsset: vi.fn(), createAsset: vi.fn(), updateTask: vi.fn(),
  };
  return { store, service: new MetadataService(store as unknown as IMetadataStore) };
}

describe('quality workflow caller identity', () => {
  it('authorizes task effect receipts, filters other users, and never overwrites native task metadata', async () => {
    const { store } = setup();
    const records = ['owner', 'other'].map(actor => ({ key: `exposure:${actor}`, kind: 'exposure', team: 'team-1', rev: 1, updated: Date.now(), data: {
      asset_id: 'asset-1', revision_id: 'revision-1', task_id: 'task-1', session_id: 'session', actor, expires: Date.now() + 100000,
      events: [], state: 'observing', assessment: { outcome: 'unobserved', reason: '不足以归因', citations: [], event_hash: usageWindowHash({ events: [] }) },
    } }));
    const backend = { ...store, getTaskById: vi.fn(async () => ({ task_id: 'task-1', team_id: 'team-1', metadata_json: '{"asset_evidence":{"summary":{"contributed":0}}}' })), qualityRecords: { get: vi.fn(), list: vi.fn(async () => records) } };
    const service = new MetadataService(backend as any);
    vi.spyOn(service, 'checkAssetPermission').mockResolvedValue({ allowed: true } as any);
    const result = await service.qualityForCaller('task-receipt', { team_id: 'team-1', task_id: 'task-1' }, owner);
    expect(result.items).toHaveLength(1); expect(result.items[0].actor).toBe('owner');
    expect(result.native_states_unchanged).toBe(true); expect(store.updateTask).not.toHaveBeenCalled();
    await expect(service.qualityForCaller('task-receipt', { team_id: 'team-1' }, owner)).rejects.toMatchObject({ code: 'invalid_param' });
    await expect(service.qualityForCaller('task-receipt', { team_id: 'other-team', task_id: 'task-1' }, owner)).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(service.qualityForCaller('failed-uses', { team_id: 'team-1' }, owner)).rejects.toMatchObject({ code: 'permission_denied' });
  });
  it('restricts usage retries to the original actor or a team reviewer', async () => {
    for (const role of ['member', 'reviewer']) {
      const { store } = setup(role);
      const service = new MetadataService({ ...store, qualityRecords: { get: vi.fn(async () => ({ kind: 'exposure', team: 'team-1', data: { actor: 'other', asset_id: 'asset-1' } })) } } as any);
      const retry = vi.spyOn(service.quality!, 'retryUsage').mockResolvedValue({} as any);
      const result = service.qualityForCaller('retry-use', { team_id: 'team-1', exposure_id: 'exposure:other', note: '服务已恢复' }, owner);
      if (role === 'member') { await expect(result).rejects.toMatchObject({ code: 'permission_denied' }); expect(retry).not.toHaveBeenCalled(); }
      else { await expect(result).resolves.toEqual({}); expect(retry).toHaveBeenCalledOnce(); }
    }
  });
  it('rejects impersonation in a client supplied user_id', async () => {
    const {service}=setup();
    const list=vi.spyOn(service,'listAccessibleAssets');
    await expect(service.listAccessibleAssetsForCaller({user_id:'somebody-else',action:'use'},owner)).rejects.toMatchObject({code:'permission_denied'});
    expect(list).not.toHaveBeenCalled();
  });
  it('checks active membership even for policy reads', async () => {
    const {store}=setup('member',false);
    const service=new MetadataService({...store,qualityRecords:{get:vi.fn(),list:vi.fn()}} as any);
    await expect(service.qualityForCaller('policy-get',{team_id:'team-1'},owner)).rejects.toMatchObject({code:'permission_denied'});
  });
  it('rejects another team before submitting a snapshot', async () => {
    const {store}=setup();
    const service=new MetadataService({...store,qualityRecords:{get:vi.fn(),list:vi.fn()}} as any);
    const submit=vi.spyOn(service.quality!,'submit');
    await expect(service.qualityForCaller('submit',{team_id:'another-team',snapshot:snapshot(),expected_asset_version:3},owner)).rejects.toMatchObject({code:'asset_not_found'});
    expect(submit).not.toHaveBeenCalled();
  });
  it('does not let a regular owner approve their own publication', async () => {
    const {store}=setup();
    const service=new MetadataService({...store,qualityRecords:{get:vi.fn(async()=>({team:'team-1',data:{asset_id:'asset-1'}})),list:vi.fn()}} as any);
    await expect(service.qualityForCaller('decide',{team_id:'team-1',revision_id:'r',decision:'approve',note:'我自己想直接批准'},owner)).rejects.toMatchObject({code:'permission_denied'});
    expect(store.updateAsset).not.toHaveBeenCalled();
  });
});

describe("authorized content-quality evaluation", () => {
  it("evaluates an owner's snapshot without writing asset or task state", async () => {
    const { store, service } = setup();
    const result = await service.evaluateAssetQualityForCaller({ snapshot: snapshot(), expected_asset_version: 3 }, owner);
    expect(result.decision).toBe("needs_evidence");
    expect(result.registration).toEqual({ team_id: "team-1", asset_version: 3, content_binding: "caller_supplied_unverified" });
    expect(store.updateAsset).not.toHaveBeenCalled();
    expect(store.createAsset).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
  });
  it("allows a team admin but rejects a non-owner member before any model call", async () => {
    const outsider = { ...owner, userId: "other" };
    const denied = setup(); const review = vi.fn(); denied.service.setAssetQualityReviewer({ id: "test", review });
    await expect(denied.service.evaluateAssetQualityForCaller({ snapshot: snapshot() }, outsider)).rejects.toMatchObject({ code: "permission_denied" });
    expect(review).not.toHaveBeenCalled();
    await expect(setup("admin").service.evaluateAssetQualityForCaller({ snapshot: snapshot() }, outsider)).resolves.toHaveProperty("decision", "needs_evidence");
  });
  it("rejects removed members even when they own the asset", async () => {
    await expect(setup("member", false).service.evaluateAssetQualityForCaller({ snapshot: snapshot() }, owner)).rejects.toMatchObject({ code: "permission_denied" });
  });
  it("rejects mismatched asset types and stale registration versions", async () => {
    const { service } = setup();
    await expect(service.evaluateAssetQualityForCaller({ snapshot: snapshot("skill") }, owner)).rejects.toMatchObject({ code: "invalid_quality_snapshot" });
    await expect(service.evaluateAssetQualityForCaller({ snapshot: snapshot(), expected_asset_version: 2 }, owner)).rejects.toMatchObject({ code: "quality_version_conflict" });
  });
  it("bounds concurrency per instance and releases slots after failed review", async () => {
    const { service } = setup();
    const pending: (() => void)[] = [];
    service.setAssetQualityReviewer({ id: "pending", review: () => new Promise((_, reject) => pending.push(() => reject(new Error("unavailable")))) });
    const first = service.evaluateAssetQualityForCaller({ snapshot: snapshot() }, owner);
    const second = service.evaluateAssetQualityForCaller({ snapshot: snapshot() }, owner);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    await expect(service.evaluateAssetQualityForCaller({ snapshot: snapshot() }, owner)).rejects.toMatchObject({ code: "quality_review_busy" });
    pending.forEach((finish) => finish());
    await Promise.all([first, second]);
    service.setAssetQualityReviewer({ id: "invalid", review: async () => ({}) });
    await expect(service.evaluateAssetQualityForCaller({ snapshot: snapshot() }, owner)).resolves.toHaveProperty("reviewer.status", "invalid_response");
  });
});
