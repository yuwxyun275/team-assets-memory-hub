/** Two-phase local Proxy-only deployment. Preserve the old container, config
 * and mounted volume snapshot; do not change Core, ranker, assets or model.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const docker = (...args) => execFileSync('docker', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const configPath = resolve(root, 'deploy/global-images/.proxy-config/config.yaml');
if (process.argv[2] === 'prepare') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = join(root, 'output/quality-deployment', `history-${stamp}`);
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  const info = JSON.parse(docker('inspect', 'tdai-proxy'))[0];
  const plan = { name: 'tdai-proxy', previous: `tdai-proxy-before-history-${stamp}`, image: `tdai-local/memory-proxy:history-${stamp.toLowerCase()}`, info, backup, configPath };
  copyFileSync(configPath, join(backup, 'config.previous.yaml')); chmodSync(join(backup, 'config.previous.yaml'), 0o600);
  writeFileSync(join(backup, 'plan.json'), JSON.stringify(plan), { mode: 0o600 });
  const build = `asset-history-build-${Date.now()}`;
  docker('create', '--name', build, info.Image);
  try {
    for (const file of ['assets/history.ts', 'assets/history-store.ts', 'assets/asset-bridge.ts', 'assets/disclosure.ts', 'assets/benchmark.ts',
      'assets/runtime-context.ts', 'assets/delivery.ts', 'assets/recover-quality-outbox.ts', 'common/codebuddy-summary.ts', 'common/user-query-extractor.ts',
      'identity.ts', 'handler.ts', 'anthropicHandler.ts', 'codexHandler.ts', 'workbuddyHandler.ts', 'injection/types.ts',
      'common/langfuse-debug.ts', 'memory/memory-bridge.ts', 'storage/factory.ts',
      'injection/injectors/quality-observer.ts', 'injection/injectors/quality-outbox.ts',
      'injection/pipeline.ts', 'injection/index.ts', 'injection/injectors/team-assets-orchestrator-injector.ts', 'config.ts', 'types.ts']) {
      docker('cp', `MemoryProxy/src/${file}`, `${build}:/app/src/${file}`);
    }
    docker('commit', build, plan.image);
  } finally { docker('rm', build); }
  console.log(JSON.stringify({ backup, prepared: true }));
} else if (process.argv[2] === 'activate') {
  const backup = resolve(process.argv[3]);
  if (!backup.startsWith(join(root, 'output/quality-deployment/history-'))) throw new Error('invalid deployment backup');
  const plan = JSON.parse(readFileSync(join(backup, 'plan.json'), 'utf8'));
  if (plan.configPath !== configPath || plan.name !== 'tdai-proxy') throw new Error('invalid deployment target');
  const info = plan.info;
  const manifestOverride = process.argv[4] ? resolve(process.argv[4]) : '';
  if (manifestOverride) {
    const manifest = JSON.parse(readFileSync(manifestOverride, 'utf8'));
    if (!manifestOverride.startsWith(join(root, 'output') + '/') || !Array.isArray(manifest.runs)) throw new Error('invalid manifest override');
  }
  let renamed = false, created = false;
  try {
    docker('stop', '--time', '20', plan.name);
    for (const mount of info.Mounts.filter(m => m.Type === 'volume' && m.RW)) {
      const name = `${mount.Name}.tgz`;
      docker('run', '--rm', '--user', '0', '--network', 'none', '--entrypoint', 'tar',
        '--mount', `type=volume,src=${mount.Name},dst=/source,readonly`,
        '--mount', `type=bind,src=${backup},dst=/backup`, info.Image, '-czf', `/backup/${name}`, '-C', '/source', '.');
      chmodSync(join(backup, name), 0o600);
    }
    docker('rename', plan.name, plan.previous); renamed = true;
    const envFile = join(backup, 'proxy.env');
    writeFileSync(envFile, info.Config.Env.join('\n') + '\n', { mode: 0o600 });
    const args = ['create', '--name', plan.name, '--restart', info.HostConfig.RestartPolicy?.Name || 'unless-stopped', '--env-file', envFile];
    const networks = Object.entries(info.NetworkSettings.Networks || {});
    if (networks[0]) {
      args.push('--network', networks[0][0]);
      for (const alias of networks[0][1].Aliases || []) if (alias !== info.Id && alias !== info.Id.slice(0, 12)) args.push('--network-alias', alias);
    }
    for (const [port, bindings] of Object.entries(info.HostConfig.PortBindings || {})) for (const b of bindings || []) args.push('-p', `${b.HostIp ? b.HostIp + ':' : ''}${b.HostPort}:${port}`);
    for (const m of info.Mounts) args.push('--mount', `type=${m.Type},src=${manifestOverride && m.Destination === '/data/asset-bench-manifest.json' ? manifestOverride : m.Type === 'volume' ? m.Name : m.Source.replace(/^\/host_mnt/, '')},dst=${m.Destination}${m.RW ? '' : ',readonly'}`);
    for (const host of info.HostConfig.ExtraHosts || []) args.push('--add-host', host);
    if (info.HostConfig.Memory) args.push('--memory', String(info.HostConfig.Memory));
    if (info.HostConfig.NanoCpus) args.push('--cpus', String(info.HostConfig.NanoCpus / 1e9));
    args.push(plan.image, ...(info.Config.Cmd || [])); docker(...args); created = true;
    for (const [network, detail] of networks.slice(1)) {
      const options = []; for (const alias of detail.Aliases || []) if (alias !== info.Id && alias !== info.Id.slice(0, 12)) options.push('--alias', alias);
      docker('network', 'connect', ...options, network, plan.name);
    }
    docker('start', plan.name);
    for (let i = 0; i < 50; i++) {
      const state = JSON.parse(docker('inspect', plan.name))[0].State;
      if (state.Running && (!state.Health || state.Health.Status === 'healthy')) break;
      if (i === 49) throw new Error('proxy health check timeout');
      await new Promise(r => setTimeout(r, 1000));
    }
    writeFileSync(join(backup, 'result.json'), JSON.stringify({ status: 'healthy', previous: plan.previous, image: plan.image }), { mode: 0o600 });
    console.log(JSON.stringify({ status: 'healthy', backup, previous: plan.previous }));
  } catch (error) {
    copyFileSync(join(backup, 'config.previous.yaml'), configPath);
    if (created) { try { docker('stop', '--time', '10', plan.name); docker('rename', plan.name, `${plan.name}-failed-${Date.now()}`); } catch {} }
    if (renamed) { try { docker('rename', plan.previous, plan.name); } catch {} }
    try { docker('start', plan.name); } catch {}
    throw error;
  }
} else throw new Error('Usage: node deploy-history.mjs prepare | activate <backup-directory>');
