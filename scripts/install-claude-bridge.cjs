#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { findCommand } = require('../src/providers/codex.cjs');
const i18n = require('../src/renderer/i18n.js');

function defaultSettingsPath() { return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json'); }
function readSettings(file) {
  let raw = null;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const data = raw === null ? {} : JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(i18n.t('bridge.settingsNotObject'));
  return { data, raw };
}
function atomicWrite(file, content) {
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.writeFileSync(temp, content, { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); }
  finally { try { fs.unlinkSync(temp); } catch { /* already renamed */ } }
}
function chainShell() {
  if (process.platform !== 'win32') return { command: '/bin/sh', args: ['-c'] };
  const git = findCommand('git');
  const candidates = [process.env.CLAUDE_CODE_GIT_BASH_PATH, ...(git ? [path.resolve(path.dirname(git), '../bin/bash.exe'), path.resolve(path.dirname(git), '../usr/bin/bash.exe')] : []), path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe')];
  for (const candidate of candidates.filter(Boolean)) {
    if (fs.existsSync(candidate)) return { command: candidate, args: ['-c'] };
  }
  return { command: findCommand('powershell') || 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command'] };
}
function bridgeCommand(scriptPath, manifestPath) {
  // Only constant code and base64 cross the shell boundary. Quoted Windows paths
  // behave differently under Git Bash and PowerShell, particularly with $ or `.
  const script = Buffer.from(scriptPath).toString('base64');
  const config = Buffer.from(manifestPath).toString('base64');
  return `node -e "require(Buffer.from('${script}','base64').toString()).runCLI()" -- --config-base64 ${config}`;
}
function isOwnedManifest(manifest, settingsPath) {
  if (manifest?.version !== 1 || !path.isAbsolute(manifest.dataDir || '') || manifest.settingsPath !== path.resolve(settingsPath)) return false;
  // Installations made before the rename carry the TOKEN-VAULT owner name.
  if (manifest.owner && !['paceline-claude-bridge', 'token-vault-claude-bridge'].includes(manifest.owner)) return false;
  const expected = bridgeCommand(path.join(manifest.dataDir, 'bridge', 'claude-statusline.cjs'), path.join(manifest.dataDir, 'claude-bridge.json'));
  return manifest.installedStatusLine?.type === 'command' && manifest.installedStatusLine.command === expected && Object.hasOwn(manifest, 'originalStatusLine');
}
function bridgeReference(statusLine) {
  if (statusLine?.type !== 'command' || typeof statusLine.command !== 'string') return null;
  const match = statusLine.command.match(/^node -e "require\(Buffer\.from\('([A-Za-z0-9+/=]+)','base64'\)\.toString\(\)\)\.runCLI\(\)" -- --config-base64 ([A-Za-z0-9+/=]+)$/);
  if (!match) return null;
  const file = Buffer.from(match[2], 'base64').toString('utf8');
  const script = Buffer.from(match[1], 'base64').toString('utf8');
  return path.isAbsolute(file) && script === path.join(path.dirname(file), 'bridge', 'claude-statusline.cjs') ? file : null;
}
function findActiveManifest(statusLine, settingsPath) {
  const file = bridgeReference(statusLine);
  if (!file) return null;
  try {
    if (fs.statSync(file).size > 1024 * 1024) return null;
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isOwnedManifest(manifest, settingsPath) && JSON.stringify(statusLine) === JSON.stringify(manifest.installedStatusLine) ? manifest : null;
  } catch { return null; }
}
function withLock(dataDir, operation) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'claude-bridge-install.lock');
  let descriptor;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { descriptor = fs.openSync(file, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Number.isInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); } catch (status) { stale = status.code === 'ESRCH'; }
        }
      } catch { try { stale = Date.now() - fs.statSync(file).mtimeMs > 30000; } catch {} }
      if (stale) { try { fs.unlinkSync(file); } catch {} continue; }
      throw new Error(i18n.t('bridge.installInProgress'));
    }
  }
  if (descriptor === undefined) throw new Error(i18n.t('bridge.installInProgress'));
  try { fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid })); return operation(); }
  finally { fs.closeSync(descriptor); fs.unlinkSync(file); }
}
async function installClaudeBridge({ dataDir, scriptPath = path.join(__dirname, 'claude-statusline.cjs'), settingsPath = defaultSettingsPath() } = {}) {
  if (!dataDir || !path.isAbsolute(dataDir)) throw new Error(i18n.t('bridge.dataDirRequired'));
  const node = findCommand('node');
  if (!node) throw new Error(i18n.t('bridge.nodeRequired'));
  return withLock(dataDir, () => {
    const manifestPath = path.join(dataDir, 'claude-bridge.json');
    const runtimePath = path.join(dataDir, 'bridge', 'claude-statusline.cjs');
    const current = readSettings(settingsPath);
    let previous;
    try { previous = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw new Error(i18n.t('bridge.invalidBackupPreserved')); }
    const sameInstallation = isOwnedManifest(previous, settingsPath) && JSON.stringify(current.data.statusLine) === JSON.stringify(previous.installedStatusLine);
    const owned = sameInstallation ? previous : findActiveManifest(current.data.statusLine, settingsPath);
    if (previous && !owned) throw new Error(i18n.t('bridge.statusLineChangedAfterInstall'));
    if (!owned && bridgeReference(current.data.statusLine)) throw new Error(i18n.t('bridge.previousConnectionMissing'));
    if (current.data.statusLine != null && (current.data.statusLine.type !== 'command' || typeof current.data.statusLine.command !== 'string')) throw new Error(i18n.t('bridge.unsupportedStatusLine'));
    const installedStatusLine = { ...(current.data.statusLine || {}), type: 'command', command: bridgeCommand(runtimePath, manifestPath) };
    const retainedBackup = owned?.backupPath && path.dirname(owned.backupPath) === path.resolve(dataDir) && fs.existsSync(owned.backupPath) ? owned.backupPath : null;
    const movedBackup = owned?.backupPath ? path.join(dataDir, path.basename(owned.backupPath)) : null;
    const backupPath = retainedBackup || (movedBackup && fs.existsSync(movedBackup) ? movedBackup : path.join(dataDir, `claude-settings-backup-${randomUUID()}.json`));
    const manifest = { version: 1, owner: 'paceline-claude-bridge', dataDir: path.resolve(dataDir), settingsPath: path.resolve(settingsPath), backupPath, originalStatusLine: owned ? owned.originalStatusLine : current.data.statusLine ?? null, installedStatusLine, chainShell: owned?.chainShell || chainShell() };
    atomicWrite(runtimePath, fs.readFileSync(scriptPath));
    if (!fs.existsSync(backupPath)) {
      let backup = current.raw === null ? '{}\n' : current.raw;
      if (owned?.backupPath) { try { backup = fs.readFileSync(owned.backupPath); } catch { /* The original folder may have moved. */ } }
      atomicWrite(backupPath, backup);
    }
    atomicWrite(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    try {
      if (readSettings(settingsPath).raw !== current.raw) throw new Error(i18n.t('bridge.settingsChangedDuringInstall'));
      atomicWrite(settingsPath, JSON.stringify({ ...current.data, statusLine: installedStatusLine }, null, 2) + '\n');
    } catch (error) {
      if (previous) atomicWrite(manifestPath, JSON.stringify(previous, null, 2) + '\n');
      else fs.unlinkSync(manifestPath);
      throw error;
    }
    return { installed: true, alreadyInstalled: Boolean(sameInstallation && previous.dataDir === path.resolve(dataDir)), migrated: Boolean(owned && owned.dataDir !== path.resolve(dataDir)), settingsPath, backupPath, message: i18n.t('bridge.connected') };
  });
}
async function uninstallClaudeBridge({ dataDir } = {}) {
  if (!dataDir || !path.isAbsolute(dataDir)) throw new Error(i18n.t('bridge.dataDirRequired'));
  return withLock(dataDir, () => {
    const manifestPath = path.join(dataDir, 'claude-bridge.json');
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return { installed: false, message: i18n.t('bridge.notInstalled') }; throw error; }
    if (manifest.version !== 1 || !path.isAbsolute(manifest.settingsPath)) throw new Error(i18n.t('bridge.invalidBackup'));
    const current = readSettings(manifest.settingsPath);
    if (JSON.stringify(current.data.statusLine) !== JSON.stringify(manifest.installedStatusLine)) throw new Error(i18n.t('bridge.statusLineChangedExternally'));
    const restored = { ...current.data };
    if (manifest.originalStatusLine === null) delete restored.statusLine;
    else restored.statusLine = manifest.originalStatusLine;
    if (readSettings(manifest.settingsPath).raw !== current.raw) throw new Error(i18n.t('bridge.settingsChanged'));
    atomicWrite(manifest.settingsPath, JSON.stringify(restored, null, 2) + '\n');
    fs.unlinkSync(manifestPath);
    return { installed: false, message: i18n.t('bridge.removed') };
  });
}
function getClaudeBridgeHealth({ dataDir, settingsPath = defaultSettingsPath() } = {}) {
  const nodeAvailable = Boolean(findCommand('node'));
  let installed = false, configured = false, collectorAvailable = false;
  try {
    const manifestPath = path.join(dataDir, 'claude-bridge.json');
    const stat = fs.lstatSync(manifestPath);
    if (stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Unsupported bridge metadata');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    installed = isOwnedManifest(manifest, settingsPath);
    if (installed) {
      configured = manifest.dataDir === path.resolve(dataDir) && JSON.stringify(readSettings(settingsPath).data.statusLine) === JSON.stringify(manifest.installedStatusLine);
      const runtime = path.join(dataDir, 'bridge', 'claude-statusline.cjs');
      const runtimeStat = fs.lstatSync(runtime);
      collectorAvailable = runtimeStat.isFile() && !runtimeStat.isSymbolicLink();
    }
  } catch { /* Health reports booleans, never configuration contents or paths. */ }
  return { installed, nodeAvailable, configured, collectorAvailable, message: i18n.t(!nodeAvailable ? 'bridge.health.nodeUnavailable' : !installed ? 'bridge.health.notInstalled' : !configured ? 'bridge.health.statusLineChanged' : !collectorAvailable ? 'bridge.health.collectorMissing' : 'bridge.health.ready') };
}
if (require.main === module) {
  const index = process.argv.indexOf('--data-dir');
  const dataDir = index >= 0 ? path.resolve(process.argv[index + 1]) : process.env.PACELINE_HOME;
  const action = process.argv.includes('--reset-usage') ? options => Promise.resolve(require('./claude-statusline.cjs').resetClaudeUsage(options.dataDir)) : process.argv.includes('--uninstall') ? uninstallClaudeBridge : installClaudeBridge;
  action({ dataDir }).then(result => console.log(result.message)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { installClaudeBridge, uninstallClaudeBridge, getClaudeBridgeHealth, defaultSettingsPath, bridgeCommand };
