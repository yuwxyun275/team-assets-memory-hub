#!/usr/bin/env node
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Manifest contains source paths and scope only, never prewritten asset answers. */
export function prepareSources(manifestPath) {
  const file = realpathSync(manifestPath), manifest = JSON.parse(readFileSync(file, 'utf8'));
  const root = realpathSync(resolve(dirname(file), manifest.root ?? '.'));
  if (!Array.isArray(manifest.sources) || !manifest.sources.length || manifest.sources.length > 24) throw new Error('Select 1–24 source files');
  const sources = manifest.sources.map((entry, index) => {
    const path = realpathSync(resolve(root, entry.path));
    const rel = relative(root, path);
    if (rel.startsWith(`..${sep}`) || rel === '..' || resolve(root, rel) !== path) throw new Error('Source escapes the declared root');
    if (!/\.(md|txt|jsonl|py|ts|tsx|js|jsx|go|java|rs|sql|c|h|cpp|yaml|yml|json)$/i.test(path) || /(^|[/.])env([/.]|$)/i.test(rel)) throw new Error('Unsupported source file');
    const size = statSync(path).size;
    if (size > 240000) throw new Error('Source exceeds file limit; split it explicitly');
    let content = readFileSync(path, 'utf8');
    if (content.includes('\0')) throw new Error('Binary source is not supported');
    if (entry.lines) {
      const [start, end] = entry.lines;
      const lines = content.split('\n');
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length) throw new Error('Invalid source line range');
      content = lines.slice(start - 1, end).join('\n');
    }
    if (!content.length || content.length > 60000) throw new Error('Source must contain 1–60000 characters');
    if (path.endsWith('.jsonl')) for (const line of content.split('\n').filter(l => l.trim())) JSON.parse(line);
    return { id: `source-${index + 1}`, kind: entry.kind ?? (/\.jsonl$/.test(path) ? 'conversation' : /\.(md|txt)$/.test(path) ? 'document' : 'code'),
      locator: `${rel.replaceAll(sep, '/')}${entry.lines ? `#L${entry.lines[0]}-L${entry.lines[1]}` : ''}`,
      revision: createHash('sha256').update(content).digest('hex'), content,
      synthetic: entry.synthetic ?? manifest.synthetic ?? true, visibility: entry.visibility ?? manifest.visibility ?? 'private' };
  });
  const input = { mode: 'history', repository: manifest.repository, version: manifest.version, scope: manifest.scope, sources };
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 140000) throw new Error('Batch exceeds 140000 UTF-8 bytes; split the source batch');
  return input;
}
export async function meta(action, data, env = process.env) {
  if (!env.TEAM_ASSET_CORE_URL || !env.TEAM_ASSET_USER_KEY || !env.TEAM_ASSET_TEAM_ID || !env.TEAM_ASSET_SERVICE_ID) throw new Error('Set TEAM_ASSET_CORE_URL, TEAM_ASSET_USER_KEY, TEAM_ASSET_TEAM_ID and TEAM_ASSET_SERVICE_ID');
  const base = new URL(env.TEAM_ASSET_CORE_URL);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Invalid Core URL');
  const response = await fetch(`${base.href.replace(/\/$/, '')}/v3/meta/asset/quality/${action}`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tdai-user-key': env.TEAM_ASSET_USER_KEY, 'x-tdai-service-id': env.TEAM_ASSET_SERVICE_ID },
    body: JSON.stringify({ ...data, team_id: env.TEAM_ASSET_TEAM_ID }), signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Core request failed: HTTP ${response.status}`);
  const result = await response.json();
  if (result.code !== 0) throw new Error(`Core rejected request (${result.code})`);
  return result.data;
}
async function main() {
  const [command, arg, output] = process.argv.slice(2);
  if (command === 'prepare') {
    if (!arg || !output) throw new Error('prepare <source-manifest.json> <output.json>');
    writeFileSync(output, JSON.stringify(prepareSources(arg), null, 2), { flag: 'wx', mode: 0o600 });
    return;
  }
  const result = command === 'submit' ? await meta('learning-submit', { input: prepareSources(arg) })
    : command === 'learn-task' ? await meta('learning-from-task', { task_id: arg })
      : command === 'jobs' ? await meta('learning-list', { task_id: arg })
        : command === 'job' ? await meta('learning-details', { job_id: arg })
          : command === 'costs' ? await meta('costs', { task_id: arg }) : null;
  if (!result) throw new Error('Commands: prepare, submit, learn-task, jobs, job, costs');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(e => { process.stderr.write(`${e.message}\n`); process.exitCode = 1; });
