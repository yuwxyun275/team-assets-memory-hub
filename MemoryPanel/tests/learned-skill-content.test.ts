import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isLearnedSkill, resolveLearnedSkill, type LearnedSkillSnapshot } from '../web/src/lib/learned-skill';
import { getLearnedSkill } from '../web/src/lib/api/learned-skills';
import { metaPost } from '../web/src/lib/api/base';

vi.mock('../web/src/lib/api/base', () => ({ metaPost: vi.fn() }));
const post = vi.mocked(metaPost);
const assetId = 'learned-workflow';
const snapshot = (body = '# Reviewed workflow'): LearnedSkillSnapshot => ({ asset_id: assetId, asset_type: 'skill', content_version: 'v1', declared_scope: 'single process', body, sources: [{ id: 'source-1', kind: 'document', locator: 'contract.md', content: 'Exact source' }] });
const revision = (id: string, state: string, updated: number, content = snapshot()) => ({ updated, data: { id, state, snapshot: content } });

beforeEach(() => vi.resetAllMocks());

describe('learning-managed Skill content', () => {
  it('routes by provenance, not an ID prefix or a native skill lacking an owner', () => {
    expect(isLearnedSkill({ source_type: 'asset_learning' })).toBe(true);
    expect(isLearnedSkill({ source_type: 'extracted' })).toBe(false);
    expect(isLearnedSkill({})).toBe(false);
  });

  it('shows the active published snapshot instead of a newer unapproved candidate', () => {
    const view = resolveLearnedSkill(assetId, { publication: { revision_id: 'published', snapshot: snapshot() }, revisions: [revision('new', 'awaiting_approval', 20, snapshot('# Unapproved changes')), revision('published', 'published', 10)] });
    expect(view).toMatchObject({ state: 'published', published: true, revisionId: 'published', snapshot: { body: '# Reviewed workflow' } });
  });

  it('does not label a historical published revision as currently published', () => {
    const view = resolveLearnedSkill(assetId, { publication: null, revisions: [revision('old', 'published', 10)] });
    expect(view).toMatchObject({ state: 'unpublished', published: false });
  });

  it('selects the latest candidate without mutating the API result order', () => {
    const revisions = [revision('old', 'rejected', 10), revision('new', 'awaiting_approval', 20)];
    expect(resolveLearnedSkill(assetId, { publication: null, revisions })?.revisionId).toBe('new');
    expect(revisions[0].data.id).toBe('old');
  });

  it('rejects a mismatched asset or type and never substitutes a draft for missing publication content', () => {
    for (const content of [{ ...snapshot(), asset_id: 'another-asset' }, { ...snapshot(), asset_type: 'llm_wiki' }, snapshot(' ')]) {
      expect(() => resolveLearnedSkill(assetId, { publication: { revision_id: 'published', snapshot: content }, revisions: [] })).toThrow();
    }
    expect(() => resolveLearnedSkill(assetId, { publication: { revision_id: 'missing' }, revisions: [revision('draft', 'awaiting_approval', 20)] })).toThrow();
  });

  it('reads the authenticated quality endpoint with the selected team and asset', async () => {
    post.mockResolvedValue({ publication: { revision_id: 'published', snapshot: snapshot() }, revisions: [] });
    expect((await getLearnedSkill('team-a', assetId)).snapshot.sources[0].locator).toBe('contract.md');
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('asset/quality/details', { team_id: 'team-a', asset_id: assetId });
  });

  it('reads a generated candidate only when no evaluation revision exists yet', async () => {
    post.mockResolvedValueOnce({ publication: null, revisions: [] }).mockResolvedValueOnce({ data: { snapshot: snapshot() } });
    expect(await getLearnedSkill('team-a', assetId)).toMatchObject({ state: 'candidate', published: false });
    expect(post).toHaveBeenLastCalledWith('asset/quality/learning-candidate', { team_id: 'team-a', asset_id: assetId });
  });

  it('propagates access or service errors without attempting another content endpoint', async () => {
    post.mockRejectedValueOnce(new Error('permission_denied'));
    await expect(getLearnedSkill('team-b', assetId)).rejects.toThrow('permission_denied');
    expect(post).toHaveBeenCalledTimes(1);
  });
});
