#!/usr/bin/env node
/** User-invoked coding step. Real mode uses ordinary task prompts and never requires a predetermined asset. */
import { readFileSync, mkdtempSync, readdirSync, existsSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { buildCliInvocation } from '../agents/codebuddy/cli.mjs';
import { verifyRealTask } from './walkthrough-verify.mjs';
try {
  const [directory, number] = process.argv.slice(2);
  if (!directory || !['1', '2'].includes(number)) throw new Error('用法：node scripts/walkthrough-task.mjs <体验目录> <1或2>');
  const info = JSON.parse(readFileSync(join(resolve(directory), 'walkthrough.json'), 'utf8'));
  if (!['guided-synthetic-walkthrough', 'guided-real-walkthrough'].includes(info.mode)) throw new Error('不是手动体验环境');
  const real = info.mode === 'guided-real-walkthrough';
  const proxyConfig = JSON.parse(readFileSync(join(info.directory, 'proxy.json'), 'utf8'));
  const services = [info.core, new URL(info.proxy).origin, new URL(proxyConfig.injection.teamAssets.endpoint).origin];
  const deadline = Date.now() + 15000;
  let ready = false;
  while (Date.now() < deadline) {
    try { ready = (await Promise.all(services.map(url => fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) })))).every(r => r.ok); } catch {}
    if (ready) break;
    await new Promise(r => setTimeout(r, 300));
  }
  if (!ready) throw new Error('体验服务尚未就绪，请先启动服务并查看 service.log；本次未启动 CLI。');
  const key = readFileSync(info.key_file, 'utf8').trim();
  const response = await fetch(`${info.core}/v3/meta/asset/list-accessible`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tdai-service-id': 'default', 'x-tdai-user-key': key }, body: JSON.stringify({ team_id: info.team, user_key: key, action: 'use', limit: 100 }), signal: AbortSignal.timeout(10000) });
  const assets = await response.json();
  const title = number === '1' ? 'Inventory idempotency repair workflow' : 'Inventory duplicate request regression workflow';
  if (!response.ok || assets.code !== 0) throw new Error('无法读取当前团队可用资产，请检查服务与登录权限。');
  if (!real && !assets.data?.items?.some(a => a.name === title)) throw new Error(`请先在资产质量中心审核并发布「${title}」，再执行任务 ${number}。`);
  if (real && !assets.data?.items?.length) console.log('当前团队暂无已发布资产。本次先执行真实任务、保留经验来源；不会宣称使用了团队资产。');
  let resume, configDirectory;
  if (real) {
    const taskResponse = await fetch(`${info.core}/v3/meta/task/get`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tdai-service-id': 'default', 'x-tdai-user-key': key }, body: JSON.stringify({ task_id: info.tasks[number] }), signal: AbortSignal.timeout(10000) });
    const task = await taskResponse.json();
    if (!taskResponse.ok || task.code !== 0) throw new Error('无法读取任务会话。');
    if (task.data.status === 'completed') {
      resume = JSON.parse(task.data.metadata_json || '{}').asset_evidence?.session_id;
      if (!resume || !/^[a-zA-Z0-9:_-]+$/.test(resume)) throw new Error('已完成任务缺少可续接的会话；请从看板创建下一任务。');
      for (const directory of readdirSync(info.directory, { withFileTypes: true }).filter(d => d.isDirectory() && d.name.startsWith(`cli-${number}-`))) {
        const config = join(info.directory, directory.name), projects = join(config, 'projects');
        if (existsSync(projects) && readdirSync(projects, { withFileTypes: true }).some(p => p.isDirectory() && existsSync(join(projects, p.name, `${resume}.jsonl`)))) { configDirectory = config; break; }
      }
      if (!configDirectory) throw new Error('原 CLI 会话文件不在体验目录内，不能用新会话冒充续接；请从看板创建下一任务。');
      const reopened = await fetch(`${info.core}/v3/meta/task/update`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tdai-service-id': 'default', 'x-tdai-user-key': key }, body: JSON.stringify({ task_id: info.tasks[number], status: 'running' }), signal: AbortSignal.timeout(10000) });
      if (!reopened.ok || (await reopened.json()).code !== 0) throw new Error('无权重新打开任务，未启动 CLI。');
      console.log('该任务已有完成记录，将续接原真实会话重新核验，历史记录会保留。');
    }
  }
  const env = { PATH: `${dirname(info.node)}:${process.env.PATH}`, LANG: 'en_US.UTF-8', TMPDIR: tmpdir(),
    CODEBUDDY_CONFIG_DIR: configDirectory || mkdtempSync(join(info.directory, `cli-${number}-`)), TEAM_ASSET_USER_KEY: key,
    CODEBUDDY_TELEMETRY_DISABLED: '1', DISABLE_TELEMETRY: '1' };
  const run = buildCliInvocation({ team: info.team, agent: info.agent, task: info.tasks[number], proxy: info.proxy, workspace: info.workspace, resume,
    prompt: real ? (number === '1' ? '请检查并修复 inventory.py 中的重复请求问题：同一 request_id 不应重复扣减库存，不同请求应正常扣减。先检查当前代码和测试，根据实际需要查阅团队资产，独立判断修复方法并运行测试。仅修改当前库存示例目录内的文件。不要在未实际采用或验证时声称使用资产或测试通过。' : '请回归检查 inventory.py 的请求幂等性：重复请求不能重复扣减，不同请求需正常扣减。按实际需要查阅已发布的团队经验，核对当前实现并运行测试，报告实际证据和未覆盖边界。仅在发现问题时修改代码。')
      : number === '1' ? 'FULL_FLOW_TASK_1: Fix inventory.py request idempotency using the reviewed team workflow, then run test_inventory.py.' : 'FULL_FLOW_TASK_2: Apply the Inventory duplicate request regression workflow to verify the previous inventory.py repair; run test_inventory.py for regression.',
    model: real ? info.model : 'hy3', tools: real ? 'Bash,Read,Write,Edit' : 'Bash,Read,Write', turns: real ? 20 : 8 }, env);
  console.log(`任务 ${number}：启动 CodeBuddy CLI。${real ? `真实模型：${info.model}；由模型自行选择资产、分析代码并执行。` : '模型为固定模拟响应。'}\n会话：${run.session}\n工作区：${run.cwd}`);
  if (real) writeFileSync(join(info.directory, 'walkthrough.json'), JSON.stringify({ ...info, cli_runs: [...(info.cli_runs || []), { task: info.tasks[number], session: run.session, config_directory: env.CODEBUDDY_CONFIG_DIR, resumed: Boolean(resume), started_at: new Date().toISOString() }] }, null, 2), { mode: 0o600 });
  // CLI may exit before draining a large JSON history into a pipe. A regular
  // file keeps the complete result, including the final success/error record.
  const outputPath = join(info.directory, `cli-output-${number}-${Date.now()}.json`);
  const outputFd = openSync(outputPath, 'wx', 0o600);
  const child = spawn(run.command, [...run.args, '--allowedTools', 'Bash', 'Read', 'Write', ...(real ? ['Edit'] : []), '--permission-mode', 'dontAsk'], { cwd: run.cwd, env: run.env, stdio: ['inherit', outputFd, 'inherit'] });
  child.on('error', e => { console.error(e.message); process.exitCode = 1; });
  child.on('close', async code => {
    closeSync(outputFd);
    const cliOutput = readFileSync(outputPath, 'utf8');
    process.stdout.write(cliOutput);
    process.exitCode = code ?? 1;
    if (code !== 0) return;
    try {
      if (real) {
        let result;
        try { const output = JSON.parse(cliOutput); result = Array.isArray(output) ? output.findLast(item => item.type === 'result') : output; } catch {}
        if (!result || result.subtype !== 'success' || result.is_error === true) throw new Error('CLI 未返回成功的真实模型执行结果；保留错误记录，本次不提交验证。');
      }
      if (real) await verifyRealTask(info, number, undefined, run.session);
      console.log(`请回到 ${info.panel} 的工作台，打开对应任务查看回执和任务经验提炼。`);
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  });
} catch (e) { console.error(e.message); process.exitCode = 1; }
