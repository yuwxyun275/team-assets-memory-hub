import { metaPost } from './base';
import { resolveLearnedSkill, validateLearnedSkillSnapshot, type LearnedSkillDetails, type LearnedSkillSnapshot, type LearnedSkillView } from '../learned-skill';

/** Use the same authenticated, team-scoped content source as the quality center. */
export async function getLearnedSkill(teamId: string, assetId: string): Promise<LearnedSkillView> {
  const details = await metaPost<LearnedSkillDetails>('asset/quality/details', { team_id: teamId, asset_id: assetId });
  const view = resolveLearnedSkill(assetId, details);
  if (view) return view;
  // A newly generated candidate may not yet have an evaluation revision.
  const candidate = await metaPost<{ data: { snapshot: LearnedSkillSnapshot } }>('asset/quality/learning-candidate', { team_id: teamId, asset_id: assetId });
  return { snapshot: validateLearnedSkillSnapshot(assetId, candidate.data.snapshot), state: 'candidate', published: false };
}
