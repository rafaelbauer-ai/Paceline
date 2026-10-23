#!/usr/bin/env node
'use strict';
// This bridge is self-contained: the installer copies it outside Electron's asar.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');

const WINDOWS = { five_hour: { label: '5h', minutes: 300 }, seven_day: { label: '7d', minutes: 10080 }, seven_day_opus: { label: 'Opus · 7d', minutes: 10080 }, seven_day_sonnet: { label: 'Sonnet · 7d', minutes: 10080 }, spend_limit: { label: 'Limite de gasto', minutes: null } };
function extractWindows(limits) {
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) return [];
  return Object.entries(WINDOWS).flatMap(([id, spec]) => {
    const value = limits[id];
    if (!value || typeof value.used_percentage !== 'number' || !Number.isFinite(value.used_percentage) || value.used_percentage < 0 || value.used_percentage > 100) return [];
    return [{ id, label: spec.label, usedPercent: value.used_percentage, resetsAt: Number.isFinite(value.resets_at) && value.resets_at > 0 ? value.resets_at : null, windowMinutes: spec.minutes }];
  });
}
function writeJSON(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch { /* Renamed or not created. */ } }
}
function readJSON(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function projectMetadata(directory) {
  if (typeof directory !== 'string' || directory.length > 4096) return null;
  const paths = /^[A-Za-z]:[\\/]|^\\\\/.test(directory) ? path.win32 : path.posix;
  if (!paths.isAbsolute(directory)) return null;
  const normalized = paths.normalize(directory).replace(/[\\/]+$/, '');
  return { projectId: createHash('sha256').update(paths === path.win32 ? normalized.toLowerCase() : normalized).digest('hex'), projectName: paths.basename(normalized).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100) || 'Projeto local' };
}
function withSnapshotLock(dataDir, action) {
  fs.mkdirSync(dataDir, { recursive: true });
  const lock = path.join(dataDir, 'claude-usage.lock');
  let descriptor;
  for (let attempt = 0; attempt < 12; attempt++) {
    try { descriptor = fs.openSync(lock, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Recover only a known dead writer; never steal a live writer's lock.
      const owner = readJSON(lock);
      if (Number.isInteger(owner?.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); }
        catch (status) { if (status.code === 'ESRCH') { try { fs.unlinkSync(lock); } catch {} continue; } }
      } else if (!owner) {
        try { if (Date.now() - fs.statSync(lock).mtimeMs > 30000) { fs.unlinkSync(lock); continue; } } catch {}
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  if (descriptor === undefined) throw new Error('Claude usage collector is busy.');
  try { fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid })); return action(); }
  finally { fs.closeSync(descriptor); fs.unlinkSync(lock); }
}
// `confirmed` marks a direct account reading: an unchanged value is still a fresh observation.
function saveSnapshot(data, dataDir, now = Date.now, { confirmed = false, source = null } = {}) {
  const windows = extractWindows(data?.rate_limits);
  // Claude omits rate_limits before the first API response. Preserve the last known reading.
  if (!windows.length) return null;
  return withSnapshotLock(dataDir, () => {
    const file = path.join(dataDir, 'claude-usage.json');
    const rawPrevious = readJSON(file);
    const previous = rawPrevious?.version === 1 && Number.isFinite(Date.parse(rawPrevious.updatedAt)) ? rawPrevious : null;
    const incoming = Object.fromEntries(windows.map(window => [window.id, { used_percentage: window.usedPercent, resets_at: window.resetsAt }]));
    const observationsFile = path.join(dataDir, 'claude-observations.json');
    const priorObservations = readJSON(observationsFile);
    const sessions = priorObservations?.version === 1 && priorObservations.sessions && typeof priorObservations.sessions === 'object' ? priorObservations.sessions : {};
    // Only one-way hashes of an opaque session ID and allowlisted metrics are stored.
    // This lets an idle session replay its payload without replacing another session's newer reading.
    const sessionHash = typeof data.session_id === 'string' && data.session_id.length > 0 ? createHash('sha256').update(data.session_id).digest('hex') : null;
    const digest = createHash('sha256').update(JSON.stringify(incoming)).digest('hex');
    if (sessionHash && sessions[sessionHash]?.digest === digest && previous) return previous;
    const observedAt = now();
    if (sessionHash) {
      sessions[sessionHash] = { digest, observedAt };
      const bounded = Object.fromEntries(Object.entries(sessions).sort((a, b) => b[1].observedAt - a[1].observedAt).slice(0, 256));
      writeJSON(observationsFile, { version: 1, sessions: bounded });
    }
    const previousWindows = Object.fromEntries(extractWindows(previous?.rate_limits).map(window => [window.id, { used_percentage: window.usedPercent, resets_at: window.resetsAt }]));
    const merged = {};
    let rejectedRegression = false;
    for (const id of Object.keys(WINDOWS)) {
      const old = previousWindows[id];
      const next = incoming[id];
      if (!next) {
        // Preserve independently absent windows while their reported reset is still in the future.
        if (old && old.resets_at > observedAt / 1000) merged[id] = old;
        continue;
      }
      if (old && old.resets_at !== null && old.resets_at === next.resets_at && next.used_percentage < old.used_percentage) {
        merged[id] = old; rejectedRegression = true;
      } else if (old && old.resets_at > observedAt / 1000 && next.resets_at !== null && next.resets_at <= observedAt / 1000) {
        merged[id] = old; rejectedRegression = true;
      } else merged[id] = next;
    }
    // Equal payloads (including other sessions and idle timers) do not prove a new API observation.
    if (!confirmed && previous && JSON.stringify(previousWindows) === JSON.stringify(merged)) return previous;
    const timestamp = rejectedRegression && previous && !confirmed ? previous.updatedAt : new Date(Math.max(observedAt, previous ? Date.parse(previous.updatedAt) : 0)).toISOString();
    const snapshot = { version: 1, updatedAt: timestamp, rate_limits: merged, ...(source ? { source } : {}) };
    writeJSON(file, snapshot);
    return snapshot;
  });
}
function resetClaudeUsage(dataDir) {
  if (!dataDir || !path.isAbsolute(dataDir)) throw new Error('Informe um diretório de dados absoluto.');
  return withSnapshotLock(dataDir, () => {
    for (const name of ['claude-usage.json', 'claude-observations.json', 'claude-api-state.json']) {
      try { fs.unlinkSync(path.join(dataDir, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return { message: 'Leitura local limpa. Feche sessões da conta anterior e use o Claude Code com a conta desejada.' };
  });
}
function forwardOriginal(input, config) {
  const command = config.originalStatusLine?.command;
  if (typeof command !== 'string' || !command.trim()) return false;
  const shell = config.chainShell;
  if (!shell || typeof shell.command !== 'string' || !Array.isArray(shell.args)) return false;
  const result = spawnSync(shell.command, [...shell.args, command], { input, encoding: 'utf8', windowsHide: true, timeout: 2500, maxBuffer: 1024 * 1024, shell: false });
  if (result.stdout) process.stdout.write(result.stdout);
  return true;
}
async function runCLI() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 8 * 1024 * 1024) return;
  }
  let config;
  try {
    const index = process.argv.indexOf('--config-base64');
    const configPath = index >= 0 ? Buffer.from(process.argv[index + 1] || '', 'base64').toString('utf8') : null;
    if (!configPath || !path.isAbsolute(configPath)) return;
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config.version !== 1 || !path.isAbsolute(config.dataDir)) return;
  } catch { return; }
  let snapshot;
  let data;
  try { data = JSON.parse(input); } catch {}
  try { snapshot = saveSnapshot(data, config.dataDir); } catch { /* Do not expose session contents or disrupt Claude Code. */ }
  if (forwardOriginal(input, config)) return;
  const windows = snapshot ? extractWindows(snapshot.rate_limits) : [];
  if (windows.length) process.stdout.write(`Paceline · ${windows.map(window => `${window.label}: ${Math.round(window.usedPercent)}%`).join(' · ')}\n`);
}
if (require.main === module) void runCLI().catch(() => {});
module.exports = { extractWindows, saveSnapshot, projectMetadata, resetClaudeUsage, forwardOriginal, runCLI };
