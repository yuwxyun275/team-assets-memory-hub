// Offline fallback for a damaged local BuildKit content lease. Equivalent file overlays to the Dockerfiles.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const run = (...args) => execFileSync('docker', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
for (const [part, base, copies] of [
  ['core', 'tdai-local/memory-core:2.0.1-best-practice-v8.4-fix', [['MemoryCore/src/asset-quality', '/app/src/asset-quality'], ['MemoryCore/src/metadata/.', '/app/src/metadata/'], ['MemoryCore/src/gateway/server.ts', '/app/src/gateway/server.ts']]],
  ['hub', 'tdai-local/memory-hub:2.0.1-best-practice-v8.3-fix', [['MemoryPanel/dist/.', '/app/panel/dist/'], ['MemoryPanel/web/dist/.', '/app/panel/web/dist/']]],
  ['proxy', 'tdai-local/memory-proxy:2.0.1-best-practice-v8.4-fix', [['MemoryProxy/src/.', '/app/src/']]],
]) {
  const name = `quality-build-${part}-${Date.now()}`;
  run('create', '--name', name, base);
  try {
    for (const [source, destination] of copies) run('cp', source, `${name}:${destination}`);
    run('commit', name, `tdai-local/memory-${part}:quality-v2`);
    console.log(`built memory-${part}:quality-v2`);
  } finally { run('rm', name); }
}
