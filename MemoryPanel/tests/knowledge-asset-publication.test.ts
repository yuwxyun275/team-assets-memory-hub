import { describe, expect, it, vi } from 'vitest';
import type { PanelDeps } from '../src/panel/panel-deps.js';
import type { MetaCallContext } from '../src/panel/kernel/types.js';
import {
  ensureKnowledgeAsset,
  ASSET_TYPE_WIKI,
} from '../src/panel/http/routes/knowledge/common.js';

const ctx = {
  instanceId: 'instance-1',
  userKey: 'user-key',
  reqId: 'req-1',
} as MetaCallContext;

function depsFor(invoke: ReturnType<typeof vi.fn>): PanelDeps {
  return {
    metaKernel: { invoke },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as PanelDeps;
}

const params = {
  assetId: 'wiki-1',
  teamId: 'team-1',
  assetType: ASSET_TYPE_WIKI,
  name: 'Wiki 1',
  ownerUserId: 'user-1',
};

describe('ensureKnowledgeAsset publication lifecycle', () => {
  it('creates an in-flight knowledge asset as draft', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce({ code: 40401, message: 'not found', data: null })
      .mockResolvedValueOnce({ code: 0, message: 'ok', data: {} });

    await expect(ensureKnowledgeAsset(depsFor(invoke), ctx, {
      ...params,
      status: 'draft',
    })).resolves.toEqual({ ok: true });

    expect(invoke).toHaveBeenLastCalledWith(
      'asset/create',
      expect.objectContaining({ asset_id: 'wiki-1', status: 'draft' }),
      ctx,
    );
  });

  it('publishes an existing draft after the knowledge service reports ready', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce({ code: 0, message: 'ok', data: { status: 'draft' } })
      .mockResolvedValueOnce({ code: 0, message: 'ok', data: { status: 'approved' } });

    await expect(ensureKnowledgeAsset(depsFor(invoke), ctx, {
      ...params,
      status: 'approved',
    })).resolves.toEqual({ ok: true });

    expect(invoke).toHaveBeenNthCalledWith(
      2,
      'asset/update',
      { asset_id: 'wiki-1', status: 'approved' },
      ctx,
    );
  });
});
