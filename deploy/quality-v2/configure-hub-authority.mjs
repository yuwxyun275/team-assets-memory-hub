/** Repair the local demo publisher identity from the configured CodeBuddy key.
 * Credentials stay in private generated deployment files, never in logs.
 */
import {readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {codebuddyApi, actor} from '../../evaluation/cache_history_bench/codebuddy-live-api.mjs';

const root = resolve(import.meta.dirname, '../..');
const model = JSON.parse(readFileSync('/Users/xiaomo/.codebuddy/models.json', 'utf8')).models.find(m => m.id === 'deepseek-v4-flash');
if (model?.url !== 'http://127.0.0.1:8096/codebuddy/default' || !model.apiKey?.startsWith('sk-mem-')) throw Error('unexpected local CodeBuddy configuration');
const taskId = process.argv[2];
if (!taskId?.startsWith('task-')) throw Error('task id required');
const task = await codebuddyApi('task/get', {task_id: taskId});
if (task.creator_user_id !== actor) throw Error('publisher must own the verification task');
const path = resolve(root, 'evaluation/team_asset_bench/runtime/hub-demo.env');
const original = readFileSync(path, 'utf8');
const backup = resolve(root, 'output/quality-deployment', `publisher-${new Date().toISOString().replace(/[:.]/g,'-')}`);
mkdirSync(backup, {recursive:true, mode:0o700});
copyFileSync(path, resolve(backup,'private.previous.env')); chmodSync(resolve(backup,'private.previous.env'),0o600);
const rest = original.split('\n').filter(l => !/^(?:TEAM_ASSET_DEMO_|DEMO_)USER_(?:ID|KEY)=/.test(l));
// Generated local deployment credential file, not source code or model data.
writeFileSync(path, [...rest, `TEAM_ASSET_DEMO_USER_ID=${actor}`, `TEAM_ASSET_DEMO_USER_KEY=${model.apiKey}`, ''].join('\n'), {mode:0o600});
chmodSync(path,0o600);
try { execFileSync('docker',['restart','tdai-quality-orchestrator'],{stdio:'pipe'}); }
catch(e) {writeFileSync(path,original,{mode:0o600});throw e;}
console.log(JSON.stringify({publisher:actor,task_id:taskId,backup,restarted:true}));
