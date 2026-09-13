import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const model = JSON.parse(readFileSync('/Users/xiaomo/.codebuddy/models.json', 'utf8')).models.find(m => m.id === 'deepseek-v4-flash');
if (model?.url !== 'http://127.0.0.1:8096/codebuddy/default' || !model.apiKey) throw Error('Expected configured local Proxy model');
const container = JSON.parse(execFileSync('docker', ['inspect', 'tdai-memory-hub'], { encoding: 'utf8' }))[0];
const env = Object.fromEntries(container.Config.Env.map(x => { const i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1)]; }));
export const actor = 'usr-pet78jlukw'; // Verified by real CodeBuddy request identity in Proxy logs.
export async function codebuddyApi(action, body) {
  const r = await fetch(`http://127.0.0.1:8420/v3/meta/${action}`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.REMOTE_INSTANCE_KEY}`,
      'x-tdai-service-id': env.REMOTE_INSTANCE_ID || 'default', 'x-tdai-user-key': model.apiKey },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const result = await r.json(); if (!r.ok || result.code) throw Error(`${action}: HTTP ${r.status} ${result.message}`);
  return result.data;
}
