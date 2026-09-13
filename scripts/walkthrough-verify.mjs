#!/usr/bin/env node
/** Execute repository tests independently of the coding model and submit their actual results. */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function verifyRealTask(info, number, beforeWorkspace, expectedSession) {
  if (info.mode !== 'guided-real-walkthrough') throw new Error('只用于真实模型体验');
  const key = readFileSync(info.key_file, 'utf8').trim();
  const response = await fetch(`${info.core}/v3/meta/task/get`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-tdai-service-id': 'default', 'x-tdai-user-key': key },
    body: JSON.stringify({ task_id: info.tasks[number] }), signal: AbortSignal.timeout(10000),
  });
  const task = await response.json();
  if (!response.ok || task.code !== 0) throw new Error('无法读取真实任务的执行记录');
  const evidence = JSON.parse(task.data.metadata_json || '{}').asset_evidence;
  if (expectedSession && evidence?.session_id !== expectedSession) throw new Error('任务的最新会话已变化，停止验证，避免把结果归到其他会话');
  const trace = evidence?.latest_trace_id || evidence?.trace_id;
  if (!trace) throw new Error('任务尚无执行 Trace，不能提交验证结果');
  const proxy = JSON.parse(readFileSync(join(info.directory, 'proxy.json'), 'utf8'));
  const privateDir = mkdtempSync(join(info.directory, '.verification-'));
  const tokenFile = join(privateDir, 'token');
  const output = join(info.directory, `real-ci-${number}.json`);
  writeFileSync(tokenFile, proxy.injection.teamAssets.serviceToken, { mode: 0o600 });
  const args = ['-m', 'team_asset_bench.local_ci', '--workspace', info.workspace, '--discover', '--trace-id', trace,
    '--endpoint', new URL(proxy.injection.teamAssets.endpoint).origin, '--service-token-file', tokenFile, '--output', output];
  for (const path of evidence.completion?.changed_paths || []) args.push('--changed-path', path);
  for (const criterion of evidence.acceptance_contract?.criteria || []) args.push('--acceptance-criterion', criterion);
  if (beforeWorkspace) args.push('--before-workspace', resolve(beforeWorkspace));
  console.log('独立验证器开始运行仓库测试；结果将回传任务看板。');
  try {
    await new Promise((done, reject) => {
      const log = createWriteStream(join(info.directory, `real-ci-${number}.log`), { mode: 0o600 });
      const child = spawn('python3', args, { cwd: resolve(import.meta.dirname, '../evaluation/team_asset_bench'), stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.pipe(log); child.stderr.pipe(log);
      child.on('error', reject);
      child.on('close', code => { log.end(); code === 0 ? done() : reject(new Error(`独立验证未通过，请查看 ${info.directory}/real-ci-${number}.log`)); });
    });
    const run = JSON.parse(readFileSync(output, 'utf8'));
    console.log(`独立验证：${run.status}。真实结果：${output}`);
    return run;
  } finally { rmSync(privateDir, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [directory, number, before] = process.argv.slice(2);
    if (!directory || !['1', '2'].includes(number)) throw new Error('用法：node scripts/walkthrough-verify.mjs <体验目录> <1或2> [修复前工作区]');
    await verifyRealTask(JSON.parse(readFileSync(join(resolve(directory), 'walkthrough.json'), 'utf8')), number, before);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
