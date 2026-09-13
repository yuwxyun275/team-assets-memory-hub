export interface LearnedSkillSnapshot {
  asset_id: string;
  asset_type: string;
  content_version: string;
  declared_scope: string;
  body: string;
  project_scope?: { repository: string; version: string; synthetic?: boolean };
  sources: Array<{ id: string; kind: string; locator: string; revision?: string; content: string }>;
}

export interface LearnedSkillDetails {
  publication: { revision_id: string; snapshot?: LearnedSkillSnapshot } | null;
  revisions: Array<{ updated: number; data: { id: string; state: string; snapshot: LearnedSkillSnapshot } }>;
}

export interface LearnedSkillView {
  snapshot: LearnedSkillSnapshot;
  state: string;
  published: boolean;
  revisionId?: string;
}

export function isLearnedSkill(skill: { source_type?: string } | null | undefined): boolean {
  return skill?.source_type === 'asset_learning';
}

export function validateLearnedSkillSnapshot(assetId: string, snapshot: LearnedSkillSnapshot): LearnedSkillSnapshot {
  if (snapshot.asset_id !== assetId || snapshot.asset_type !== 'skill' || !snapshot.body?.trim()) {
    throw new Error('这份 Skill 的内容与资产记录不匹配，请到资产质量中心检查。');
  }
  return snapshot;
}

/** Prefer the current publication, never infer publication from an asset label or an old revision. */
export function resolveLearnedSkill(assetId: string, details: LearnedSkillDetails): LearnedSkillView | null {
  const publication = details.publication;
  if (publication) {
    const snapshot = publication.snapshot ?? details.revisions.find(r => r.data.id === publication.revision_id)?.data.snapshot;
    if (!snapshot) throw new Error('已发布版本的内容暂不可用，请到资产质量中心检查。');
    return { snapshot: validateLearnedSkillSnapshot(assetId, snapshot), state: 'published', published: true, revisionId: publication.revision_id };
  }
  const latest = [...details.revisions].sort((a, b) => b.updated - a.updated)[0]?.data;
  if (!latest) return null;
  return { snapshot: validateLearnedSkillSnapshot(assetId, latest.snapshot), state: latest.state === 'published' ? 'unpublished' : latest.state, published: false, revisionId: latest.id };
}
