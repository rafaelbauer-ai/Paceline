'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { installClaudeBridge, uninstallClaudeBridge, getClaudeBridgeHealth } = require('../scripts/install-claude-bridge.cjs');
const { saveSnapshot, resetClaudeUsage } = require('../scripts/claude-statusline.cjs');

function fixture(t) {
  const root = path.resolve(__dirname, '../.local/tests'); fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'claude-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { dataDir: path.join(directory, 'data'), settingsPath: path.join(directory, 'settings.json') };
}
test('snapshot is an allowlist and an idle payload never fabricates a fresh timestamp', t => {
  const { dataDir } = fixture(t);
  const payload = { session_id: 'private', transcript_path: '/private', rate_limits: { five_hour: { used_percentage: 0, resets_at: 200 }, seven_day: { used_percentage: 42, resets_at: 300 }, secret: 'private' } };
  const first = saveSnapshot(payload, dataDir, () => 1000);
  assert.equal(first.updatedAt, new Date(1000).toISOString());
  assert.ok(!fs.readFileSync(path.join(dataDir, 'claude-usage.json'), 'utf8').includes('private'));
  assert.equal(saveSnapshot(payload, dataDir, () => 9000).updatedAt, first.updatedAt);
  assert.equal(saveSnapshot({ rate_limits: {} }, dataDir), null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'claude-usage.json'))).updatedAt, first.updatedAt);
});
test('install backs up, chains existing statusline with identical stdin/stdout, and uninstall preserves unrelated edits', async t => {
  const options = fixture(t);
  const original = { statusLine: { type: 'command', command: 'node -e "process.stdin.pipe(process.stdout)"', padding: 3 }, theme: 'dark' };
  fs.writeFileSync(options.settingsPath, JSON.stringify(original));
  const result = await installClaudeBridge(options);
  assert.equal(result.installed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(result.backupPath)), original);
  const settings = JSON.parse(fs.readFileSync(options.settingsPath));
  assert.equal(settings.statusLine.padding, 3);
  const input = JSON.stringify({ private: 'do not store this', rate_limits: { five_hour: { used_percentage: 25, resets_at: 10000 } } });
  const output = execFileSync(process.execPath, [path.join(options.dataDir, 'bridge/claude-statusline.cjs'), '--config-base64', Buffer.from(path.join(options.dataDir, 'claude-bridge.json')).toString('base64')], { input, encoding: 'utf8', windowsHide: true });
  assert.equal(output, input);
  assert.ok(!fs.readFileSync(path.join(options.dataDir, 'claude-usage.json'), 'utf8').includes('do not store this'));
  assert.equal((await installClaudeBridge(options)).alreadyInstalled, true);
  settings.theme = 'light'; fs.writeFileSync(options.settingsPath, JSON.stringify(settings));
  await uninstallClaudeBridge(options);
  assert.deepEqual(JSON.parse(fs.readFileSync(options.settingsPath)), { ...original, theme: 'light' });
});
test('uninstall refuses to overwrite a statusline edited after installation', async t => {
  const options = fixture(t);
  await installClaudeBridge(options);
  const changed = { statusLine: { type: 'command', command: 'echo mine' }, other: true };
  fs.writeFileSync(options.settingsPath, JSON.stringify(changed));
  await assert.rejects(uninstallClaudeBridge(options), /alterada/);
  assert.deepEqual(JSON.parse(fs.readFileSync(options.settingsPath)), changed);
});
test('invalid user configuration stays byte-for-byte untouched', async t => {
  const options = fixture(t);
  fs.writeFileSync(options.settingsPath, '{ broken json');
  await assert.rejects(installClaudeBridge(options));
  assert.equal(fs.readFileSync(options.settingsPath, 'utf8'), '{ broken json');
});
test('moving portable data rewrites owned bridge paths and preserves the original statusline', async t => {
  const options = fixture(t);
  const original = { statusLine: { type: 'command', command: 'echo original', padding: 2 }, theme: 'dark' };
  fs.writeFileSync(options.settingsPath, JSON.stringify(original));
  await installClaudeBridge(options);
  const movedDir = options.dataDir + '-moved';
  fs.renameSync(options.dataDir, movedDir);
  const result = await installClaudeBridge({ ...options, dataDir: movedDir });
  assert.equal(result.migrated, true);
  const manifest = JSON.parse(fs.readFileSync(path.join(movedDir, 'claude-bridge.json')));
  assert.equal(manifest.dataDir, movedDir);
  assert.deepEqual(manifest.originalStatusLine, original.statusLine);
  assert.ok(fs.existsSync(manifest.backupPath));
  const output = execFileSync(process.execPath, [path.join(movedDir, 'bridge/claude-statusline.cjs'), '--config-base64', Buffer.from(path.join(movedDir, 'claude-bridge.json')).toString('base64')], { input: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 12, resets_at: 2000000000 } } }), encoding: 'utf8', windowsHide: true });
  assert.match(output, /original/);
  assert.ok(fs.existsSync(path.join(movedDir, 'claude-usage.json')));
  assert.equal(fs.existsSync(options.dataDir), false);
  await uninstallClaudeBridge({ dataDir: movedDir });
  assert.deepEqual(JSON.parse(fs.readFileSync(options.settingsPath)), original);
});
test('installing from a second app directory adopts its own active bridge without nesting it', async t => {
  const options = fixture(t);
  const original = { type: 'command', command: 'echo my-status', padding: 4 };
  fs.writeFileSync(options.settingsPath, JSON.stringify({ statusLine: original }));
  await installClaudeBridge(options);
  const secondDir = options.dataDir + '-second';
  const result = await installClaudeBridge({ ...options, dataDir: secondDir });
  assert.equal(result.migrated, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(secondDir, 'claude-bridge.json'))).originalStatusLine, original);
  await assert.rejects(uninstallClaudeBridge(options), /alterada/);
  await uninstallClaudeBridge({ dataDir: secondDir });
  assert.deepEqual(JSON.parse(fs.readFileSync(options.settingsPath)).statusLine, original);
});
test('session replays and same-reset regressions retain newer metrics without refreshing timestamps', t => {
  const { dataDir } = fixture(t);
  const payload = (session, percentage, resetsAt = 2000000000) => ({ session_id: session, rate_limits: { five_hour: { used_percentage: percentage, resets_at: resetsAt } } });
  saveSnapshot(payload('private-session-A', 20), dataDir, () => 1000);
  const newer = saveSnapshot(payload('private-session-B', 30), dataDir, () => 2000);
  const replay = saveSnapshot(payload('private-session-A', 20), dataDir, () => 3000);
  assert.deepEqual(replay, newer);
  const regression = saveSnapshot(payload('private-session-A', 25), dataDir, () => 4000);
  assert.equal(regression.rate_limits.five_hour.used_percentage, 30);
  assert.equal(regression.updatedAt, newer.updatedAt);
  const observations = fs.readFileSync(path.join(dataDir, 'claude-observations.json'), 'utf8');
  assert.ok(!observations.includes('private-session'));
  const renewed = saveSnapshot(payload('private-session-A', 1, 2000018000), dataDir, () => 5000);
  assert.equal(renewed.rate_limits.five_hour.used_percentage, 1);
  assert.equal(renewed.updatedAt, new Date(5000).toISOString());
  resetClaudeUsage(dataDir);
  const switched = saveSnapshot(payload('private-session-C', 0, 2000018000), dataDir, () => 6000);
  assert.equal(switched.rate_limits.five_hour.used_percentage, 0);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(dataDir, 'claude-observations.json'))).sessions).length, 1);
});
test('same-reset regression is also rejected without an optional session identifier', t => {
  const { dataDir } = fixture(t);
  const make = percentage => ({ rate_limits: { five_hour: { used_percentage: percentage, resets_at: 2000000000 } } });
  const first = saveSnapshot(make(50), dataDir, () => 1000);
  assert.deepEqual(saveSnapshot(make(40), dataDir, () => 2000), first);
});
test('a missing prior bridge manifest is not wrapped as a new original statusline', async t => {
  const options = fixture(t);
  await installClaudeBridge(options);
  const installed = fs.readFileSync(options.settingsPath, 'utf8');
  fs.unlinkSync(path.join(options.dataDir, 'claude-bridge.json'));
  await assert.rejects(installClaudeBridge({ ...options, dataDir: options.dataDir + '-new' }), /dados ausentes/);
  assert.equal(fs.readFileSync(options.settingsPath, 'utf8'), installed);
});
test('an abandoned empty installer lock is recovered, while a live owner is preserved', async t => {
  const options = fixture(t);
  fs.mkdirSync(options.dataDir);
  const lock = path.join(options.dataDir, 'claude-bridge-install.lock');
  fs.writeFileSync(lock, '');
  fs.utimesSync(lock, new Date(0), new Date(0));
  assert.equal((await installClaudeBridge(options)).installed, true);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  await assert.rejects(installClaudeBridge(options), /andamento/);
  assert.ok(fs.existsSync(lock));
});
test('bridge health differentiates installed waiting, edited configuration and a moved portable location', async t => {
  const options = fixture(t);
  assert.equal(getClaudeBridgeHealth(options).installed, false);
  await installClaudeBridge(options);
  const healthy = getClaudeBridgeHealth(options);
  assert.equal(healthy.installed, true); assert.equal(healthy.configured, true); assert.equal(healthy.collectorAvailable, true);
  assert.ok(!JSON.stringify(healthy).includes(options.dataDir));
  const movedDir = options.dataDir + '-moved'; fs.renameSync(options.dataDir, movedDir);
  assert.equal(getClaudeBridgeHealth({ ...options, dataDir: movedDir }).configured, false);
});
test('a bridge installed by a TOKEN-VAULT build follows its data folder to the new name', async t => {
  const options = fixture(t);
  const legacy = path.join(path.dirname(options.dataDir), 'token-vault-data'), next = path.join(path.dirname(options.dataDir), 'paceline-data');
  const original = { statusLine: { type: 'command', command: 'echo original' }, theme: 'dark' };
  fs.writeFileSync(options.settingsPath, JSON.stringify(original));
  await installClaudeBridge({ dataDir: legacy, settingsPath: options.settingsPath });
  // Builds before the rename wrote their own owner name into the manifest.
  const manifestFile = path.join(legacy, 'claude-bridge.json');
  fs.writeFileSync(manifestFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifestFile, 'utf8')), owner: 'token-vault-claude-bridge' }));
  fs.renameSync(legacy, next);
  const result = await installClaudeBridge({ dataDir: next, settingsPath: options.settingsPath });
  assert.equal(result.migrated, true);
  const command = JSON.parse(fs.readFileSync(options.settingsPath, 'utf8')).statusLine.command;
  assert.ok(command.includes(Buffer.from(path.join(next, 'claude-bridge.json')).toString('base64')));
  assert.equal(getClaudeBridgeHealth({ dataDir: next, settingsPath: options.settingsPath }).configured, true);
  await uninstallClaudeBridge({ dataDir: next });
  assert.deepEqual(JSON.parse(fs.readFileSync(options.settingsPath, 'utf8')).statusLine, original.statusLine);
});
