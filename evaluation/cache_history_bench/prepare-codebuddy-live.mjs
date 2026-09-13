import { mkdirSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { api } from '../../deploy/quality-v2/live-check.mjs';

const root = resolve(import.meta.dirname, '../..');
const id = `codebuddy-live-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const directory = join(root, 'output/cache-history-bench', id);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const workspace = join(directory, 'workspace');
cpSync(join(root, 'evaluation/team_asset_bench/projects/feature_flag_service/base'), workspace, { recursive: true, errorOnExist: true, force: false });
cpSync(join(root, 'evaluation/team_asset_bench/task_bundles/cache_outage_001/hidden_tests/test_fallback.py'), join(workspace, 'tests/test_fallback.py'), { errorOnExist: true, force: false });
execFileSync('git', ['init', '-q'], { cwd: workspace });
execFileSync('git', ['add', 'feature_flags', 'tests'], { cwd: workspace });
execFileSync('git', ['-c', 'user.name=CodeBuddy Live Experiment', '-c', 'user.email=experiment@example.invalid', 'commit', '-qm', 'Isolated Redis task baseline'], { cwd: workspace });
const previous = JSON.parse(readFileSync(join(root, 'output/quality-live/run.json'), 'utf8'));
const title = `CodeBuddy 真实链路 Redis 验收 ${id.slice(14)}`;
const description = '仅隔离样例 feature_flags v1：多租户功能开关读取接口在 Redis 异常时返回错误。定位根因、实施最小安全修复并给出正常、故障与恢复验证证据。通过真实 CodeBuddy 对话、工具执行及 Proxy 上游调用验收；不自动提交、部署或修改其他项目。';
const task = await api('task/create', { team_id: previous.team.team_id, creator_user_id: previous.team.owner_user_id,
  title, description, agent_id: previous.smoke_agent.agent_id });
const manifest = { id, directory, workspace, title, task, team: previous.team, agent: previous.smoke_agent,
  prepared_at: new Date().toISOString(), protocol: 'CodeBuddy desktop -> running Proxy HTTP -> configured DeepSeek',
  source_fixture: 'Existing repository feature_flag_service baseline with six additional acceptance tests',
  baseline_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim(),
  baseline_service_sha256: createHash('sha256').update(readFileSync(join(workspace, 'feature_flags/service.py'))).digest('hex'),
  settings_modified: false, result: 'not_started' };
writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ id, directory, workspace, task_id: task.task_id, title, team: previous.team.name, agent: previous.smoke_agent.name }));
