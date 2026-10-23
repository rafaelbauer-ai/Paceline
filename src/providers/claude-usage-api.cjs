'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { findCommand } = require('./codex.cjs');
const { saveSnapshot } = require('../../scripts/claude-statusline.cjs');
const { roundReset } = require('../renderer/quota-format.js');

const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
// Per-model weekly limits arrive only for plans that have them; absent or null ones are skipped.
const LIMITS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];
// One account request every 4 minutes keeps readings inside the overlay's 5-minute freshness window.
const REQUEST_INTERVAL_MS = 240000;
// Missing or expired logins only re-read a local file, so they can be checked more often.
const LOGIN_RECHECK_MS = 15000;
const RENEW_MARGIN_MS = 600000;
const RENEW_INTERVAL_MS = 1800000;
const MAX_BODY_BYTES = 65536;

const KEYCHAIN_SERVICE = 'Claude Code-credentials';

function credentialsFile(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
}
// The token stays in memory for a single request. It is never logged, stored or sent elsewhere.
function parseLogin(text) {
  let oauth;
  try { oauth = JSON.parse(String(text).replace(/^\uFEFF/, ''))?.claudeAiOauth; } catch { return null; }
  if (typeof oauth?.accessToken !== 'string' || !oauth.accessToken) return null;
  return { token: oauth.accessToken, expiresAt: Number.isFinite(oauth.expiresAt) ? oauth.expiresAt : null };
}
function readLogin(file) {
  try {
    if (fs.statSync(file).size > MAX_BODY_BYTES) return null;
    return parseLogin(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}
// On macOS the official CLI keeps the same login in the user's Keychain instead of a file.
function readKeychainLogin({ run = execFile } = {}) {
  return new Promise(resolve => {
    run('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { encoding: 'utf8', timeout: 10000, maxBuffer: MAX_BODY_BYTES }, (error, stdout) => resolve(error ? null : parseLogin(stdout)));
  });
}
function toRateLimits(body) {
  const limits = {};
  for (const id of LIMITS) {
    const value = body?.[id];
    if (!value || typeof value.utilization !== 'number' || !Number.isFinite(value.utilization)) continue;
    // Date.parse only guarantees millisecond precision; the API may send microseconds.
    const reset = typeof value.resets_at === 'string' ? Date.parse(value.resets_at.replace(/(\.\d{3})\d+/, '$1')) : NaN;
    limits[id] = { used_percentage: Math.min(100, Math.max(0, value.utilization)), resets_at: Number.isFinite(reset) ? roundReset(reset / 1000) : null };
  }
  return limits;
}
function retryAfterMs(header, now) {
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}
// The official CLI owns the OAuth refresh. Paceline never uses the refresh token itself.
function renewLogin({ command = findCommand('claude'), timeoutMs = 20000 } = {}) {
  return new Promise(resolve => {
    if (!command || /\.(cmd|ps1|bat)$/i.test(command)) return resolve(false);
    const child = spawn(command, ['auth', 'status'], { stdio: 'ignore', windowsHide: true, shell: false });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once('error', () => { clearTimeout(timer); resolve(false); });
    child.once('exit', code => { clearTimeout(timer); resolve(code === 0); });
  });
}

class ClaudeUsageApi {
  // The Keychain is a fallback for the default login location only, so a custom file stays isolated.
  constructor({ dataDir, fetch = globalThis.fetch, now = Date.now, file = credentialsFile(), keychain = process.platform === 'darwin' && file === credentialsFile() ? readKeychainLogin : null, renew = renewLogin, timeoutMs = 15000 } = {}) {
    if (!dataDir) throw new Error('ClaudeUsageApi requires a data directory.');
    Object.assign(this, { dataDir, fetch, now, file, keychain, renew, timeoutMs });
    this.stateFile = path.join(dataDir, 'claude-api-state.json');
    this.state = this.load();
    this.polling = null;
  }
  load() {
    try {
      const value = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      // Persisted deadlines keep restarts from bypassing the request interval or a Retry-After.
      if (value?.version === 1) return { nextAttemptAt: Number(value.nextAttemptAt) || 0, lastRenewAt: Number(value.lastRenewAt) || 0, reason: typeof value.reason === 'string' ? value.reason : null };
    } catch { /* First run or unreadable state. */ }
    return { nextAttemptAt: 0, lastRenewAt: 0, reason: null };
  }
  save(change) {
    this.state = { ...this.state, ...change };
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify({ version: 1, ...this.state }) + '\n', { mode: 0o600 });
    } catch { /* The in-memory deadline still applies. */ }
  }
  finish(reason, delayMs) {
    this.save({ reason, nextAttemptAt: this.now() + delayMs });
    return { reason };
  }
  // After the user signs in again, the next poll must not wait out the recheck delay.
  retrySoon() { if (this.state.reason) this.save({ nextAttemptAt: 0 }); }
  // Resolves to { reason }, where reason is null after a successful reading.
  poll() {
    if (this.polling) return this.polling;
    if (this.now() < this.state.nextAttemptAt) return Promise.resolve({ reason: this.state.reason });
    this.polling = this.read().catch(() => this.finish('NETWORK', REQUEST_INTERVAL_MS)).finally(() => { this.polling = null; });
    return this.polling;
  }
  async login() { return readLogin(this.file) || (this.keychain ? await this.keychain() : null); }
  async read() {
    let login = await this.login();
    if (!login) return this.finish('NO_LOGIN', LOGIN_RECHECK_MS);
    if (login.expiresAt !== null && login.expiresAt - this.now() < RENEW_MARGIN_MS && this.now() - this.state.lastRenewAt >= RENEW_INTERVAL_MS) {
      this.save({ lastRenewAt: this.now() });
      await this.renew();
      login = await this.login();
      if (!login) return this.finish('NO_LOGIN', LOGIN_RECHECK_MS);
    }
    // Never send a token that is already expired.
    if (login.expiresAt !== null && login.expiresAt <= this.now()) return this.finish('EXPIRED', LOGIN_RECHECK_MS);
    let response;
    try {
      // Redirects are refused so the token can never be forwarded to another URL.
      response = await this.fetch(ENDPOINT, { headers: { Authorization: `Bearer ${login.token}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' }, redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(this.timeoutMs) });
    } catch { return this.finish('NETWORK', REQUEST_INTERVAL_MS); }
    if (response.status === 429) return this.finish('RATE_LIMITED', Math.max(REQUEST_INTERVAL_MS, retryAfterMs(response.headers.get('retry-after'), this.now())));
    if (response.status === 401 || response.status === 403) return this.finish('AUTH', REQUEST_INTERVAL_MS);
    if (!response.ok) return this.finish('NETWORK', REQUEST_INTERVAL_MS);
    let limits = {};
    try {
      const text = await response.text();
      if (text.length <= MAX_BODY_BYTES) {
        const body = JSON.parse(text);
        limits = toRateLimits(body);
        // Field names only (never values) help diagnose a changed response format.
        if (body && typeof body === 'object') this.save({ fields: Object.keys(body).filter(key => /^[a-z0-9_]{1,40}$/.test(key)).slice(0, 30) });
      }
    } catch { /* Treated as an unexpected format below. */ }
    if (!Object.keys(limits).length) return this.finish('FORMAT', REQUEST_INTERVAL_MS);
    try { saveSnapshot({ rate_limits: limits }, this.dataDir, this.now, { confirmed: true, source: 'api' }); }
    catch { return this.finish('STORAGE', REQUEST_INTERVAL_MS); }
    return this.finish(null, REQUEST_INTERVAL_MS);
  }
}
module.exports = { ClaudeUsageApi, credentialsFile, readLogin, readKeychainLogin, toRateLimits, retryAfterMs, renewLogin, REQUEST_INTERVAL_MS };
