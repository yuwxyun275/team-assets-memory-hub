#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function buildCliInvocation(options, env = process.env) {
  for (const key of ['team', 'agent', 'task']) if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(options[key] ?? '')) throw new Error(`Missing or invalid --${key}`);
  if (!options.proxy || !options.model || !options.prompt) throw new Error('--proxy, --model and --prompt are required');
  const proxy = new URL(options.proxy);
  if (!['http:', 'https:'].includes(proxy.protocol) || proxy.username || proxy.password || proxy.search || proxy.hash) throw new Error('Invalid proxy URL');
  if (!/\/codebuddy\/[^/]+\/?$/.test(proxy.pathname)) throw new Error('--proxy must end with /codebuddy/<spaceId>');
  if (!env.TEAM_ASSET_USER_KEY) throw new Error('Set TEAM_ASSET_USER_KEY in the environment');
  const cwd = realpathSync(resolve(options.workspace ?? '.'));
  if (options.resume && options.session) throw new Error('Choose either --session or --resume');
  const turns = Number(options.turns ?? 30);
  if (!Number.isSafeInteger(turns) || turns < 1 || turns > 1000) throw new Error('--turns must be an integer from 1 to 1000');
  const session = options.resume || options.session || randomUUID();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,199}$/.test(session)) throw new Error('Invalid session id');
  const args = ['-p', options.prompt, '--model', options.model, '--output-format', 'json',
    ...(options.resume ? ['--resume', session] : ['--session-id', session]),
    '--max-turns', String(turns),
    '-H', 'x-team-assets-cli: 1', `x-conversation-id: ${session}`, `x-team-id: ${options.team}`,
    `x-agent-id: ${options.agent}`, `x-task-id: ${options.task}`, `x-team-assets-workspace: ${encodeURIComponent(cwd)}`];
  if (options.tools !== undefined) args.push('--tools', options.tools);
  return { command: 'codebuddy', args, cwd, session, env: { ...env,
    CODEBUDDY_BASE_URL: `${proxy.href.replace(/\/$/, '')}/v1`, CODEBUDDY_API_KEY: env.TEAM_ASSET_USER_KEY,
    CODEBUDDY_MODEL: options.model, CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: '1' } };
}
export function parseOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['proxy', 'model', 'team', 'agent', 'task', 'workspace', 'prompt', 'session', 'resume', 'turns', 'tools'].includes(args[i]?.slice(2)) || !args[i].startsWith('--') || args[i + 1] === undefined) throw new Error(`Unknown or incomplete option: ${args[i]}`);
    options[args[i].slice(2)] = args[i + 1];
  }
  return options;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const run = buildCliInvocation(parseOptions(process.argv.slice(2)));
    process.stderr.write(`Team asset CLI session: ${run.session}\n`);
    const child = spawn(run.command, run.args, { cwd: run.cwd, env: run.env, stdio: 'inherit' });
    child.on('error', () => { process.stderr.write('Unable to start CodeBuddy CLI\n'); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code ?? 1; });
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
