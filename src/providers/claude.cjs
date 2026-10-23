'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { extractWindows } = require('../../scripts/claude-statusline.cjs');
const { getClaudeBridgeHealth } = require('../../scripts/install-claude-bridge.cjs');
const { ClaudeUsageApi } = require('./claude-usage-api.cjs');
const i18n = require('../renderer/i18n.js');

// i18n keys, resolved when the state is built so a language switch applies.
const API_MESSAGES = {
  NO_LOGIN: 'provider.claude.noLogin',
  EXPIRED: 'provider.claude.loginExpired',
  AUTH: 'provider.claude.loginRejected',
  RATE_LIMITED: 'provider.claude.rateLimited',
  NETWORK: 'provider.claude.network',
  FORMAT: 'provider.claude.format',
  STORAGE: 'provider.claude.storage'
};
const LOGIN_STATES = { NO_LOGIN: 'missing', EXPIRED: 'expired', AUTH: 'rejected' };
// The statusline source keeps its product name in every language.
const SOURCES = { api: 'provider.claude.sourceApi' };
const sourceLabel = source => SOURCES[source] ? i18n.t(SOURCES[source]) : 'Claude Code statusline';

class ClaudeProvider extends EventEmitter {
  constructor({ dataDir, settingsPath, usageApi } = {}) {
    super();
    if (!dataDir) throw new Error('ClaudeProvider requires a data directory.');
    this.file = path.join(dataDir, 'claude-usage.json');
    this.healthOptions = { dataDir, settingsPath };
    this.usageApi = usageApi || new ClaudeUsageApi({ dataDir });
    this.lastHealthAt = 0;
    this.health = getClaudeBridgeHealth(this.healthOptions);
    this.apiReason = null;
    this.sourceId = 'api';
    this.state = { id: 'claude', name: 'Claude Code', status: 'waiting', message: i18n.t('provider.claude.checking'), updatedAt: null, windows: [], source: sourceLabel(this.sourceId), integration: { ...this.health, login: 'ok' } };
  }
  getState() { return structuredClone(this.state); }
  // After an official sign-in starts, the next poll reads the new login right away.
  retrySoon() { this.usageApi.retrySoon?.(); }
  async refresh() {
    if (Date.now() - this.lastHealthAt > 3000) {
      this.health = getClaudeBridgeHealth(this.healthOptions);
      this.lastHealthAt = Date.now();
    }
    // The API client throttles itself; between requests this resolves from memory.
    try { this.apiReason = (await this.usageApi.poll()).reason || null; } catch { this.apiReason = 'NETWORK'; }
    const login = LOGIN_STATES[this.apiReason] || 'ok';
    const apiMessage = API_MESSAGES[this.apiReason] ? i18n.t(API_MESSAGES[this.apiReason]) : null;
    this.state.integration = { ...this.health, login };
    try {
      const stat = await fs.stat(this.file);
      if (stat.size > 32768) throw new Error('Invalid snapshot');
      const snapshot = JSON.parse((await fs.readFile(this.file, 'utf8')).replace(/^\uFEFF/, ''));
      const timestamp = Date.parse(snapshot.updatedAt);
      if (snapshot.version !== 1 || !Number.isFinite(timestamp) || timestamp > Date.now() + 60000) throw new Error('Invalid snapshot');
      const windows = extractWindows(snapshot.rate_limits);
      if (!windows.length) throw new Error('Invalid snapshot');
      const expired = windows.every(window => window.resetsAt !== null && window.resetsAt <= Date.now() / 1000);
      const source = this.sourceId = snapshot.source === 'api' ? 'api' : 'statusline';
      const message = apiMessage || i18n.t(expired ? 'provider.claude.staleReading' : source === 'api' ? 'provider.claude.apiReady' : 'provider.claude.statuslineReady');
      this.state = { ...this.state, status: expired ? 'waiting' : 'ready', message, source: sourceLabel(source), updatedAt: new Date(timestamp).toISOString(), windows };
    } catch (error) {
      const missing = error.code === 'ENOENT';
      this.state = { ...this.state, ...(missing ? { windows: [], updatedAt: null } : {}),
        status: !missing ? 'error' : login !== 'ok' ? 'disconnected' : 'waiting', source: sourceLabel(this.sourceId),
        message: !missing ? i18n.t('provider.claude.readError') : apiMessage || i18n.t('provider.claude.checking') };
    }
    this.emit('update', this.getState());
    return this.getState();
  }
  close() {}
}
module.exports = { ClaudeProvider };
