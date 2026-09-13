/** Local Core + Panel overlay. Does not alter Proxy, model configuration, or historical experiments. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const docker = (...args) => execFileSync('docker', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').toLowerCase();
const selected = process.argv.includes('--component') ? process.argv[process.argv.indexOf('--component') + 1] : undefined;
if (selected && !['core', 'hub'].includes(selected)) throw new Error('component must be core or hub');
const plans = [
  { name: 'tdai-memory-core', part: 'core', files: [
    ...['asset-quality/lifecycle.ts', 'asset-quality/usage-result.ts', 'asset-quality/usage-reviewer.ts',
      'metadata/service/metadata-service.ts', 'metadata/router/v3-meta-router.ts', 'gateway/server.ts'].map(file => [`MemoryCore/src/${file}`, `/app/src/${file}`]),
  ] },
  { name: 'tdai-memory-hub', part: 'hub', files: [
    ['MemoryPanel/dist/panel/api/meta-actions.js', '/app/panel/dist/panel/api/meta-actions.js'],
    ['MemoryPanel/web/dist/.', '/app/panel/web/dist/'],
  ] },
].filter(p => !selected || p.part === selected);
if (!process.argv.includes('--apply')) {
  console.log(JSON.stringify({ plan: plans, instruction: 'Build Panel/backend and run regressions before --apply.' }, null, 2));
} else {
  const backup = join(root, 'output/quality-deployment', `usage-feedback-${stamp}`);
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  for (const p of plans) {
    p.info = JSON.parse(docker('inspect', p.name))[0];
    p.previous = `${p.name}-before-usage-feedback-${stamp}`;
    p.image = `tdai-local/memory-${p.part}:usage-feedback-${stamp}`;
  }
  // Contains secrets: private backup only, never printed.
  writeFileSync(join(backup, 'private-containers.json'), JSON.stringify(plans), { mode: 0o600 });
  for (const p of plans) {
    const build = `usage-feedback-build-${p.part}-${Date.now()}`;
    docker('create', '--name', build, p.info.Image);
    try {
      for (const [from, to] of p.files) docker('cp', from, `${build}:${to}`);
      docker('commit', build, p.image);
    } finally { docker('rm', build); }
  }
  const changed = [];
  try {
    for (const p of plans) {
      docker('stop', '--time', '20', p.name);
      try {
        for (const m of p.info.Mounts.filter(m => m.Type === 'volume' && m.RW)) {
          const archive = `${p.part}-${m.Name}.tgz`;
          docker('run', '--rm', '--user', '0', '--network', 'none', '--entrypoint', 'tar',
            '--mount', `type=volume,src=${m.Name},dst=/source,readonly`, '--mount', `type=bind,src=${backup},dst=/backup`,
            p.info.Image, '-czf', `/backup/${archive}`, '-C', '/source', '.');
          chmodSync(join(backup, archive), 0o600);
        }
      } catch (e) { docker('start', p.name); throw e; }
      docker('rename', p.name, p.previous); changed.push(p);
      const envFile = join(backup, `private-${p.part}.env`);
      writeFileSync(envFile, p.info.Config.Env.join('\n') + '\n', { mode: 0o600 });
      const args = ['create', '--name', p.name, '--restart', p.info.HostConfig.RestartPolicy.Name || 'unless-stopped', '--env-file', envFile];
      const networks = Object.entries(p.info.NetworkSettings.Networks);
      args.push('--network', networks[0][0]);
      for (const alias of networks[0][1].Aliases || []) if (![p.info.Id, p.info.Id.slice(0, 12)].includes(alias)) args.push('--network-alias', alias);
      for (const [port, bindings] of Object.entries(p.info.HostConfig.PortBindings || {})) for (const b of bindings || []) args.push('-p', `${b.HostIp ? b.HostIp + ':' : ''}${b.HostPort}:${port}`);
      for (const m of p.info.Mounts) args.push('--mount', `type=${m.Type},src=${m.Type === 'volume' ? m.Name : m.Source.replace(/^\/host_mnt/, '')},dst=${m.Destination}${m.RW ? '' : ',readonly'}`);
      for (const host of p.info.HostConfig.ExtraHosts || []) args.push('--add-host', host);
      if (p.info.HostConfig.Memory) args.push('--memory', String(p.info.HostConfig.Memory));
      if (p.info.HostConfig.NanoCpus) args.push('--cpus', String(p.info.HostConfig.NanoCpus / 1e9));
      args.push(p.image, ...(p.info.Config.Cmd || [])); docker(...args); p.created = true;
      for (const [net, detail] of networks.slice(1)) {
        const aliases = (detail.Aliases || []).filter(a => ![p.info.Id, p.info.Id.slice(0, 12)].includes(a)).flatMap(a => ['--alias', a]);
        docker('network', 'connect', ...aliases, net, p.name);
      }
      docker('start', p.name);
      for (let i = 0; ; i++) {
        const state = JSON.parse(docker('inspect', p.name))[0].State;
        if (state.Running && (!state.Health || state.Health.Status === 'healthy')) break;
        if (i >= 50) throw new Error(`${p.name} health check failed`);
        await new Promise(r => setTimeout(r, 1000));
      }
      console.log(`${p.name}: healthy`);
    }
    const result = { status: 'healthy', backup, containers: plans.map(({ name, image, previous }) => ({ name, image, previous })) };
    writeFileSync(join(backup, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    for (const p of changed.reverse()) {
      if (p.created) { docker('stop', '--time', '10', p.name); docker('rename', p.name, `${p.name}-failed-${stamp}`); }
      docker('rename', p.previous, p.name); docker('start', p.name);
    }
    throw e;
  }
}
