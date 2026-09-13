import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { codebuddyApi, actor } from './codebuddy-live-api.mjs';
const directory = resolve(process.argv[2]);
const original = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
const file = join(directory, 'current-binding.json');
if (existsSync(file)) throw Error('Binding already prepared; do not duplicate');
const agent = await codebuddyApi('agent/create', { team_id: original.team.team_id, owner_user_id: actor,
  name: 'CodeBuddy 当前用户真实验收 Agent', description: '只用于隔离 feature_flags v1 实际对话验证', visibility: 'private' });
const task = await codebuddyApi('task/create', { team_id: original.team.team_id, creator_user_id: actor,
  title: 'CodeBuddy 真实缓存验收：当前用户 Redis 修复', description: original.task.description, agent_id: agent.agent_id });
const assets = await codebuddyApi('asset/list-accessible', { user_id: actor, team_id: original.team.team_id,
  agent_id: agent.agent_id, action: 'use', limit: 100, offset: 0 });
writeFileSync(file, JSON.stringify({ actor, team: original.team, agent, task, created_at: new Date().toISOString(),
  previous_attempt_session: '99ddad365f034e7e91b1aa548a67c2f0', previous_attempt_reason: 'Private Agent owned by another demo user caused disclosure-remember 403; no assets injected. Retained as failed integration attempt.',
  usable_assets: assets.items.filter(a => a.quality_publication).map(a => ({ id: a.asset_id, name: a.name, revision: a.quality_publication.revision_id })) }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ actor, agent: { id: agent.agent_id, name: agent.name }, task: { id: task.task_id, name: task.title },
  published_assets: assets.items.filter(a => a.quality_publication).length }));
