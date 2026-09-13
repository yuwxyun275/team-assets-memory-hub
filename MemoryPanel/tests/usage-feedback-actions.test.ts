import { describe, expect, it, vi } from 'vitest';
import { META_LIST_ACTIONS, ALLOWED_PANEL_ACTIONS } from '../src/panel/api/meta-actions.js';
import { FetchMetaKernelAdapter } from '../src/panel/kernel/adapters/fetch-meta-kernel-adapter.js';

describe('usage feedback panel actions', () => {
  it('keeps quality asset pagination so the manual queue can select assets beyond page one', () => {
    expect(META_LIST_ACTIONS.has('asset/quality/list')).toBe(true);
  });
  it('forwards the actual second-page offset and limit', async () => {
    const postEnvelope = vi.fn(async () => ({ code: 0, message: 'ok', data: { items: [] }, request_id: 'test' }));
    const adapter = new FetchMetaKernelAdapter({ postEnvelope } as any, 1000);
    await adapter.invoke('asset/quality/list', { team_id: 'team', offset: 200, limit: 200 }, { instanceId: 'default', userKey: 'test', reqId: 'test' } as any);
    expect(postEnvelope.mock.calls[0][1]).toEqual({ team_id: 'team', offset: 200, limit: 200 });
  });
  it.each(['asset/quality/task-receipt', 'asset/quality/failed-uses', 'asset/quality/retry-use'])('allows %s through the authenticated panel proxy', action => {
    expect(ALLOWED_PANEL_ACTIONS.has(action)).toBe(true);
  });
});
