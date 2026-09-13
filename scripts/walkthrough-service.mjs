#!/usr/bin/env node
/** Run an existing walkthrough under the macOS user service manager. */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, accessSync, constants } from 'node:fs';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';

const [action, directory, releaseFile] = process.argv.slice(2);
assert.equal(process.platform, 'darwin', 'This launcher uses macOS launchd');
assert.ok(['start', 'stop', 'status'].includes(action) && directory,
  'Usage: node scripts/walkthrough-service.mjs <start|stop|status> <walkthrough-directory> [release-report]');
const root = resolve(import.meta.dirname, '..');
const dir = resolve(directory);
const info = JSON.parse(readFileSync(join(dir, 'walkthrough.json'), 'utf8'));
assert.ok(['guided-synthetic-walkthrough', 'guided-real-walkthrough'].includes(info.mode));
assert.equal(resolve(info.directory), dir, 'Keep the walkthrough in its original directory');
const panel = new URL(info.panel);
assert.equal(panel.hostname, '127.0.0.1');
assert.ok(/^\d+$/.test(panel.port));
const label = `com.tencentdb-agent-memory.walkthrough.${panel.port}`;
const domain = `gui/${process.getuid()}`;
const target = `${domain}/${label}`;
const plist = join(dir, 'service.plist');
const log = join(dir, 'service.log');
const launchctl = (...args) => execFileSync('/bin/launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function status() {
  try {
    const text = launchctl('print', target);
    return { loaded: true, state: text.match(/\n\s*state = ([^\n]+)/)?.[1], pid: Number(text.match(/\n\s*pid = (\d+)/)?.[1]) || null };
  } catch { return { loaded: false }; }
}
if (action === 'stop') {
  if (status().loaded) launchctl('bootout', target);
  const deadline = Date.now() + 15000;
  while (status().loaded && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(status().loaded, false, 'Service did not unload');
} else if (action === 'start' && !status().loaded) {
  assert.ok(releaseFile, 'Starting requires the successful release report used for this walkthrough');
  const releasePath = resolve(releaseFile);
  const release = JSON.parse(readFileSync(releasePath, 'utf8'));
  assert.equal(release.passed, true);
  assert.equal(release.node, info.node, 'Use the same installed release as this walkthrough');
  accessSync(release.node, constants.X_OK);
  accessSync(join(release.package_directory, 'src/gateway/server.ts'));
  const xml = value => String(value).replace(/[<>&"']/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[ch]);
  const args = info.mode === 'guided-real-walkthrough'
    ? [release.node, join(root, 'scripts/real-walkthrough-runtime.mjs'), releasePath, dir]
    : [release.node, join(root, 'scripts/verify-deployment.mjs'), releasePath, '--walkthrough', '--resume', dir];
  // Outside ~/Library/LaunchAgents: loaded for this login only, no automatic login installation.
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin')}</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>5</integer>
<key>ProcessType</key><string>Background</string>
<key>ExitTimeOut</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>\n`, { mode: 0o600 });
  writeFileSync(log, '', { flag: 'a', mode: 0o600 });
  launchctl('bootstrap', domain, plist);
  assert.ok(status().loaded, 'Service failed to load');
} else if (action === 'start' && !status().pid) {
  launchctl('kickstart', target);
}
console.log(JSON.stringify({ ...status(), label, panel: info.panel, log, directory: dir }));
