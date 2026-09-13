/** Deploy only the three previously resolved Memory containers. Keep originals for rollback. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
const root = resolve(import.meta.dirname, '../..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = join(root, 'output', 'quality-deployment', stamp);
mkdirSync(backup, { recursive: true, mode: 0o700 });
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const targets = [
  ['tdai-memory-core', 'core'], ['tdai-memory-hub', 'hub'], ['tdai-proxy', 'proxy'],
];
const state = targets.map(([name, component]) => ({ name, component, info: JSON.parse(docker('inspect', name))[0] }));
// These private files include runtime config/keys; never print them or put them in git.
writeFileSync(join(backup, 'containers.json'), JSON.stringify(state, null, 2), { mode: 0o600 });
for (const entry of state) {
  if (entry.info.State.Running) docker('stop', '--time', '30', entry.name);
}
const archives = [['tdai-memory-core-data', 'core-data.tgz'], ['tdai-panel-data', 'panel-data.tgz']];
const outboxMount = state.find(s => s.component === 'proxy').info.Mounts.find(m => m.Destination === '/data/quality-outbox');
if (outboxMount?.Type === 'volume') archives.push([outboxMount.Name, 'quality-outbox.tgz']);
for (const [volume, file] of archives) {
  docker('run', '--rm', '--network', 'none', '--entrypoint', 'tar',
    '--mount', `type=volume,src=${volume},dst=/source,readonly`, '--mount', `type=bind,src=${backup},dst=/backup`,
    state[0].info.Config.Image, '-czf', `/backup/${file}`, '-C', '/source', '.');
  if (!existsSync(join(backup, file))) throw new Error(`backup missing: ${file}`);
  chmodSync(join(backup, file), 0o600);
}
const manifest = [];
try {
  for (const { name, component, info } of state) {
    const previous = `${name}-before-quality-${stamp}`;
    const image = `tdai-local/memory-${component}:quality-v2`;
    docker('rename', name, previous);
    manifest.push({ name, previous, image });
    const args = ['create', '--name', name, '--restart', 'unless-stopped'];
    const envFile = join(backup, `${component}.env`);
    const environment = [...(info.Config.Env ?? [])];
    if (component === 'proxy') {
      if (!environment.some(x=>x.startsWith('TEAM_ASSET_SERVER_TOKEN='))) environment.push(`TEAM_ASSET_SERVER_TOKEN=${readFileSync(join(root,'evaluation/team_asset_bench/runtime/orchestrator.token'),'utf8').trim()}`);
      if (!environment.some(x=>x.startsWith('QUALITY_OUTBOX_DIR='))) environment.push('QUALITY_OUTBOX_DIR=/data/quality-outbox');
      if (!environment.some(x=>x.startsWith('QUALITY_OUTBOX_KEY='))) environment.push(`QUALITY_OUTBOX_KEY=${randomBytes(32).toString('hex')}`);
      if (!info.Mounts.some(m=>m.Destination==='/data/quality-outbox')) args.push('--mount', 'type=volume,src=tdai-quality-outbox,dst=/data/quality-outbox');
    }
    writeFileSync(envFile, environment.join('\n') + '\n', { mode: 0o600 });
    args.push('--env-file', envFile);
    const networks = Object.keys(info.NetworkSettings.Networks ?? {});
    if (networks[0]) args.push('--network', networks[0]);
    for (const alias of info.NetworkSettings.Networks?.[networks[0]]?.Aliases ?? []) args.push('--network-alias', alias);
    for (const [containerPort, bindings] of Object.entries(info.HostConfig.PortBindings ?? {})) {
      for (const binding of bindings ?? []) args.push('-p', `${binding.HostIp ? binding.HostIp + ':' : ''}${binding.HostPort}:${containerPort}`);
    }
    for (const m of info.Mounts) {
      const source = m.Type === 'volume' ? m.Name : m.Source.replace(/^\/host_mnt/, '');
      args.push('--mount', `type=${m.Type},src=${source},dst=${m.Destination}${m.RW ? '' : ',readonly'}`);
    }
    for (const host of info.HostConfig.ExtraHosts ?? []) args.push('--add-host', host);
    args.push(image, ...(info.Config.Cmd ?? []));
    docker(...args);
    for (const network of networks.slice(1)) docker('network', 'connect', network, name);
    docker('start', name);
    if (component === 'proxy') docker('exec','--user','0',name,'node','-e','const fs=require("fs");fs.chownSync("/data/quality-outbox",10001,999);fs.chmodSync("/data/quality-outbox",0o700)');
  }
} finally {
  writeFileSync(join(backup, 'manifest.json'), JSON.stringify({ backup, containers: manifest }, null, 2), { mode: 0o600 });
}
console.log(JSON.stringify({ backup, containers: manifest.map(x => ({ name: x.name, image: x.image })),
  rollback: 'Stop the quality containers, rename them aside, then restore original names from manifest.json. Restore data archives only with services stopped.' }, null, 2));
