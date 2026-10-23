'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  pinned: false, edge: 'top', launchAtLogin: false, notifications: true, displayId: null,
  scale: 1, opacity: 1, hideDelayMs: 450, metricMode: 'remaining',
  visibleProviders: Object.freeze(['codex', 'claude']), theme: 'auto', followActiveApp: true,
  alertThresholds: Object.freeze([80, 95]), notifyOnReset: true, notifyOnDone: true,
  historyRange: 'day', position: null, updateRepository: '',
  language: 'auto'
});

const ALERT_LEVELS = Object.freeze([70, 80, 90, 95]);

function dataDirectory({ packaged, appPath, executable, env = process.env, platform = process.platform, home = os.homedir() }) {
  if (env.PACELINE_HOME) {
    if (!path.isAbsolute(env.PACELINE_HOME)) throw new Error('PACELINE_HOME must be an absolute path.');
    return path.normalize(env.PACELINE_HOME);
  }
  if (!packaged) return path.join(appPath, '.local', 'data');
  // A macOS app bundle is replaced on every update and must stay unmodified to keep its signature.
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Paceline');
  // Portable distributions keep all their state alongside the executable.
  if (env.PORTABLE_EXECUTABLE_DIR) return path.join(env.PORTABLE_EXECUTABLE_DIR, 'paceline-data');
  return path.join(path.dirname(executable), 'paceline-data');
}

// Builds before the rename were called TOKEN-VAULT and kept their data in token-vault-data beside
// the app. That folder moves to the new name once; while it cannot (another copy still running),
// it keeps being used so nothing is lost.
function adoptLegacyData(dataDir) {
  const legacy = path.join(path.dirname(dataDir), 'token-vault-data');
  if (path.basename(dataDir) !== 'paceline-data' || fs.existsSync(dataDir) || !fs.existsSync(legacy)) return { dataDir, migrated: false };
  try { fs.renameSync(legacy, dataDir); return { dataDir, migrated: true }; }
  catch { return { dataDir: legacy, migrated: false }; }
}

function safeSettings(value = {}, base = DEFAULTS) {
  const next = { ...base };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return next;
  for (const key of ['pinned', 'launchAtLogin', 'notifications', 'notifyOnReset', 'notifyOnDone', 'followActiveApp']) {
    if (typeof value[key] === 'boolean') next[key] = value[key];
  }
  if (['top', 'right', 'bottom', 'left'].includes(value.edge)) next.edge = value.edge;
  if (value.displayId === null || Number.isInteger(value.displayId)) next.displayId = value.displayId;
  for (const [key, min, max] of [['scale', 0.8, 1.3], ['opacity', 0.5, 1], ['hideDelayMs', 200, 5000]]) {
    if (typeof value[key] === 'number' && Number.isFinite(value[key])) next[key] = Math.max(min, Math.min(max, value[key]));
  }
  // Older installations may have inverted the metric; quota now always means remaining.
  next.metricMode = 'remaining';
  if (['auto', 'paceline', 'codex', 'claude'].includes(value.theme)) next.theme = value.theme;
  // The app's own theme was called 'vault' before the rename.
  if (value.theme === 'vault') next.theme = 'paceline';
  if (['day', 'week'].includes(value.historyRange)) next.historyRange = value.historyRange;
  if (['auto', 'pt', 'en', 'es'].includes(value.language)) next.language = value.language;
  if (Array.isArray(value.visibleProviders)) {
    const ids = [...new Set(value.visibleProviders.filter(id => ['codex', 'claude'].includes(id)))];
    if (ids.length) next.visibleProviders = ids;
  }
  if (Array.isArray(value.alertThresholds)) {
    // The settings offer "% left" levels 30/20/10/5 (used 70/80/90/95). Older free-form values move
    // to the nearest level, ties to the earlier alert, so every saved threshold is visible and editable.
    const nearest = n => ALERT_LEVELS.reduce((best, level) => Math.abs(level - n) < Math.abs(best - n) ? level : best);
    next.alertThresholds = [...new Set(value.alertThresholds.filter(n => Number.isInteger(n) && n >= 1 && n <= 100).map(nearest))].sort((a, b) => a - b);
  }
  if (value.position === null) next.position = null;
  else if (value.position && ['x', 'y'].every(k => Number.isFinite(value.position[k]) && Math.abs(value.position[k]) <= 100000)) {
    next.position = { x: Math.round(value.position.x), y: Math.round(value.position.y) };
  }
  if (typeof value.updateRepository === 'string' && (value.updateRepository === '' || /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value.updateRepository))) next.updateRepository = value.updateRepository;
  return next;
}

function atomicJSON(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temp = `${filename}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, filename);
}

function readSettings(dataDir) {
  try { return safeSettings(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'))); }
  catch { return { ...DEFAULTS }; }
}

function writeSettings(dataDir, settings) { atomicJSON(path.join(dataDir, 'settings.json'), safeSettings(settings)); }

function permittedExternalURL(input, login = false) {
  try {
    const u = new URL(input);
    const hosts = login ? ['auth.openai.com', 'auth0.openai.com', 'chatgpt.com'] : ['chatgpt.com', 'claude.ai'];
    return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443') && hosts.includes(u.hostname);
  } catch { return false; }
}

module.exports = { DEFAULTS, dataDirectory, adoptLegacyData, safeSettings, atomicJSON, readSettings, writeSettings, permittedExternalURL };
