'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const i18n = require('../renderer/i18n.js');
const { roundReset } = require('../renderer/quota-format.js');

const SOURCE = 'Codex app-server';
function durationLabel(minutes, fallback) {
  if (!Number.isFinite(minutes) || minutes <= 0) return fallback;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}min`;
}
function normalizeRateLimits(payload) {
  const mapped = payload?.rateLimitsByLimitId;
  const buckets = mapped && typeof mapped === 'object' && !Array.isArray(mapped)
    ? Object.entries(mapped)
    : payload?.rateLimits ? [[payload.rateLimits.limitId || 'codex', payload.rateLimits]] : [];
  const windows = [];
  for (const [bucketId, bucket] of buckets) {
    if (!bucket || typeof bucket !== 'object') continue;
    for (const slot of ['primary', 'secondary']) {
      const value = bucket[slot];
      if (!value || typeof value.usedPercent !== 'number' || !Number.isFinite(value.usedPercent) || value.usedPercent < 0 || value.usedPercent > 100) continue;
      const minutes = Number.isFinite(value.windowDurationMins) && value.windowDurationMins > 0 ? value.windowDurationMins : null;
      const duration = durationLabel(minutes, i18n.t(slot === 'primary' ? 'provider.codex.primary' : 'provider.codex.secondary'));
      const title = typeof bucket.limitName === 'string' ? bucket.limitName.slice(0, 60) : bucketId;
      windows.push({ id: `${bucketId}:${slot}`, label: buckets.length > 1 ? `${title} · ${duration}` : duration,
        usedPercent: value.usedPercent, windowMinutes: minutes,
        resetsAt: roundReset(value.resetsAt) });
    }
  }
  return windows;
}
function findCommand(name, { env = process.env, platform = process.platform } = {}) {
  const windows = platform === 'win32';
  const candidates = path.isAbsolute(name) || /[\\/]/.test(name) ? [name] :
    (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir.replace(/^"|"$/g, ''), name));
  for (const candidate of candidates) {
    for (const suffix of windows && !path.extname(candidate) ? ['.exe', '.cmd', '.ps1', ''] : ['']) {
      try { if (fs.statSync(candidate + suffix).isFile()) return candidate + suffix; } catch { /* next PATH entry */ }
    }
  }
  return null;
}
// The native binary the official npm launcher (bin/codex.js) would start on this platform.
function nativeCodexBinary(script, { platform = process.platform, arch = process.arch } = {}) {
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : null;
  const target = { win32: { pkg: `@openai/codex-win32-${arch}`, triple: `${cpu}-pc-windows-msvc`, file: 'codex.exe' }, darwin: { pkg: `@openai/codex-darwin-${arch}`, triple: `${cpu}-apple-darwin`, file: 'codex' } }[platform];
  if (!cpu || !target) return null;
  const roots = [path.resolve(path.dirname(script), '../vendor')];
  try { roots.unshift(path.join(path.dirname(require.resolve(`${target.pkg}/package.json`, { paths: [path.dirname(script)] })), 'vendor')); } catch { /* Older npm bundle. */ }
  for (const root of roots) {
    for (const directory of ['bin', 'codex']) {
      const binary = path.join(root, target.triple, directory, target.file);
      if (fs.existsSync(binary)) return binary;
    }
  }
  return null;
}
function resolveCodexCommand(command = process.env.PACELINE_CODEX_COMMAND || 'codex') {
  const executable = findCommand(command);
  if (!executable) throw Object.assign(new Error('Install the official Codex CLI and add it to PATH.'), { code: 'ENOENT' });
  if (process.platform !== 'win32') {
    // npm links `codex` to its JavaScript launcher; start the native binary behind it instead.
    let real = '';
    try { real = fs.realpathSync(executable); } catch { /* Use the executable as found. */ }
    const binary = /\/@openai\/codex\/bin\/codex\.js$/.test(real) ? nativeCodexBinary(real) : null;
    return { command: binary || executable, args: ['app-server'] };
  }
  if (/\.(cmd|ps1|bat)$/i.test(executable)) {
    // Do not execute or parse a shell shim. Resolve the known official npm layout.
    const script = path.join(path.dirname(executable), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (!fs.existsSync(script)) throw Object.assign(new Error('Unsupported Codex shim; configure the official executable.'), { code: 'ENOENT' });
    // Spawn the official native binary directly when available, so closing the
    // overlay cannot leave a child app-server running behind an npm launcher.
    const binary = nativeCodexBinary(script);
    if (binary) return { command: binary, args: ['app-server'] };
    const node = findCommand('node');
    if (!node || /\.(cmd|ps1|bat)$/i.test(node)) throw Object.assign(new Error('Node.js is required for the npm Codex installation.'), { code: 'ENOENT' });
    return { command: node, args: [script, 'app-server'] };
  }
  return { command: executable, args: ['app-server'] };
}

class CodexProvider extends EventEmitter {
  constructor(options = {}) {
    super();
    this.command = options.codexCommand;
    this.spawn = options.spawn || spawn;
    this.resolveCommand = options.resolveCommand || resolveCodexCommand;
    this.timeoutMs = options.timeoutMs || 15000;
    this.now = options.now || Date.now;
    this.state = { id: 'codex', name: 'Codex', status: 'disconnected', messageKey: 'provider.codex.connectPrompt', updatedAt: null, windows: [], source: SOURCE, integration: { cliAvailable: null, authenticated: null } };
    this.child = null;
    this.pending = new Map();
    this.sequence = 0;
    this.starting = null;
    this.refreshing = null;
    this.loginPromise = null;
    this.loginPending = false;
    this.failures = 0;
    this.nextAttemptAt = 0;
    this.closed = false;
    this.authEpoch = 0;
    this.authAvailable = null;
  }
  // Messages are stored as keys and translated on read, so a language switch applies at once.
  getState() {
    const { messageKey, ...state } = structuredClone(this.state);
    return { ...state, message: i18n.t(messageKey) };
  }
  setState(change) { this.state = { ...this.state, ...change }; this.emit('update', this.getState()); return this.getState(); }
  async start() {
    if (this.closed) throw Object.assign(new Error('closed'), { code: 'CLOSED' });
    if (this.starting) return this.starting;
    if (this.child) return;
    if (this.now() < this.nextAttemptAt) throw Object.assign(new Error('retry later'), { code: 'BACKOFF' });
    this.starting = (async () => {
      const resolved = this.resolveCommand(this.command);
      this.state.integration = { ...this.state.integration, cliAvailable: true };
      const child = this.spawn(resolved.command, resolved.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
      this.child = child;
      let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        if (this.child !== child) return;
        buffer += chunk;
        if (buffer.length > 1024 * 1024) { this.disconnect(child, 'PROTOCOL'); return; }
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try { this.receive(JSON.parse(line)); } catch { /* Never log provider data or arbitrary server output. */ }
        }
      });
      // Drain diagnostics without retaining account data, paths, or credentials.
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => this.disconnect(child, 'PIPE'));
      child.on('error', error => this.disconnect(child, error.code === 'ENOENT' ? 'ENOENT' : 'PROCESS'));
      child.on('exit', () => this.disconnect(child, 'EXIT'));
      try {
        await this.request('initialize', { clientInfo: { name: 'paceline', title: 'Paceline', version: '0.2.0' } });
        if (this.child !== child) throw Object.assign(new Error('disconnected'), { code: 'EXIT' });
        this.write({ method: 'initialized', params: {} });
      } catch (error) { this.disconnect(child, error.code); throw error; }
    })();
    try { await this.starting; } finally { this.starting = null; }
  }
  write(message) {
    if (!this.child || this.child.stdin.destroyed) throw Object.assign(new Error('disconnected'), { code: 'EXIT' });
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error('request timed out'), { code: 'TIMEOUT' }));
        if (this.child) this.disconnect(this.child, 'TIMEOUT');
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, ...(params === undefined ? {} : { params }) }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  receive(message) {
    if (!message || typeof message !== 'object') return;
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) {
          const text = String(message.error.message || '');
          const code = /unauthori|not authenticated|not logged|requires.*auth|authentication required|chatgpt.*auth/i.test(text) ? 'AUTH' : 'RPC';
          pending.reject(Object.assign(new Error('Codex request failed'), { code }));
        } else pending.resolve(message.result);
      } else if (message.method) {
        // A metrics client never supplies external auth tokens or executes server requests.
        this.write({ id: message.id, error: { code: -32601, message: 'Unsupported method' } });
      }
      return;
    }
    if (message.method === 'account/rateLimits/updated' && this.authAvailable !== false) this.applyLimits(message.params, true);
    if (message.method === 'account/login/completed') {
      this.loginPending = false;
      if (message.params?.success) {
        this.authEpoch += 1;
        this.authAvailable = true;
        this.queueRefresh();
      }
      else this.setState({ status: 'disconnected', messageKey: 'provider.codex.loginIncomplete' });
    }
    if (message.method === 'account/updated') {
      this.authEpoch += 1;
      this.authAvailable = message.params?.authMode !== null;
      if (message.params?.authMode === null) {
        this.setState({ status: 'disconnected', messageKey: 'provider.codex.signIn', windows: [], updatedAt: null, integration: { ...this.state.integration, authenticated: false } });
      } else {
        this.setState({ status: 'waiting', messageKey: 'provider.codex.updating', windows: [], updatedAt: null, integration: { ...this.state.integration, authenticated: true } });
        if (!this.loginPending) this.queueRefresh();
      }
    }
  }
  queueRefresh() {
    if (this.refreshing) {
      const epoch = this.authEpoch;
      void this.refreshing.then(() => { if (!this.closed && this.authAvailable !== false && epoch === this.authEpoch) void this.refresh(); });
    } else if (!this.closed) void this.refresh();
  }
  applyLimits(payload, partial = false) {
    let windows = normalizeRateLimits(payload);
    if (partial && payload?.rateLimits && !payload?.rateLimitsByLimitId) {
      const prefix = `${payload.rateLimits.limitId || 'codex'}:`;
      windows = [...this.state.windows.filter(window => !window.id.startsWith(prefix)), ...windows];
    }
    this.failures = 0; this.nextAttemptAt = 0;
    return this.setState({ status: windows.length ? 'ready' : 'waiting', messageKey: windows.length ? 'provider.codex.ready' : 'provider.codex.noLimits', windows, updatedAt: new Date(this.now()).toISOString(), integration: { cliAvailable: true, authenticated: true } });
  }
  disconnect(child, code = 'EXIT') {
    if (this.child !== child) return;
    this.child = null;
    this.loginPending = false;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(Object.assign(new Error('disconnected'), { code })); }
    this.pending.clear();
    child.kill();
    if (!this.closed) {
      this.failures += 1;
      this.nextAttemptAt = this.now() + Math.min(60000, 1000 * (2 ** Math.min(this.failures, 6)));
      this.setState({ status: 'disconnected', messageKey: 'provider.codex.connectionLost' });
    }
  }
  handleError(error) {
    if (this.closed || error.code === 'BACKOFF') return this.getState();
    if (error.code === 'AUTH') {
      this.authEpoch += 1;
      this.authAvailable = false;
      return this.setState({ status: 'disconnected', messageKey: 'provider.codex.signIn', windows: [], updatedAt: null, integration: { ...this.state.integration, authenticated: false } });
    }
    if (error.code === 'ENOENT') return this.setState({ status: 'disconnected', messageKey: 'provider.codex.cliMissing', integration: { cliAvailable: false, authenticated: null } });
    return this.setState({ status: 'error', messageKey: error.code === 'TIMEOUT' ? 'provider.codex.timeout' : 'provider.codex.queryFailed' });
  }
  async refresh() {
    if (this.closed) return this.getState();
    if (this.refreshing) return this.refreshing;
    const epoch = this.authEpoch;
    this.refreshing = (async () => {
      try {
        await this.start();
        const payload = await this.request('account/rateLimits/read');
        if (this.closed || epoch !== this.authEpoch) return this.getState();
        this.authAvailable = true;
        return this.applyLimits(payload);
      }
      catch (error) { return epoch === this.authEpoch ? this.handleError(error) : this.getState(); }
    })();
    try { return await this.refreshing; } finally { this.refreshing = null; }
  }
  async connect() {
    if (this.loginPromise) return this.loginPromise;
    if (this.loginPending) return this.getState();
    this.loginPromise = (async () => {
      try {
        this.nextAttemptAt = 0;
        this.authEpoch += 1;
        this.authAvailable = null;
        await this.start();
        const result = await this.request('account/login/start', { type: 'chatgpt' });
        if (typeof result?.authUrl !== 'string') throw Object.assign(new Error('No login URL'), { code: 'RPC' });
        const url = new URL(result.authUrl);
        if (url.protocol !== 'https:' || !['auth.openai.com', 'auth0.openai.com', 'chatgpt.com'].includes(url.hostname) || url.username || url.password || url.port) throw Object.assign(new Error('Invalid login URL'), { code: 'RPC' });
        this.loginPending = true;
        this.setState({ status: 'waiting', messageKey: 'provider.codex.finishLogin', windows: [], updatedAt: null, integration: { ...this.state.integration, authenticated: null } });
        this.emit('open-url', url.href);
        return this.getState();
      } catch (error) { return this.handleError(error); }
    })();
    try { return await this.loginPromise; } finally { this.loginPromise = null; }
  }
  close() { this.closed = true; if (this.child) this.disconnect(this.child, 'CLOSED'); }
}
module.exports = { CodexProvider, normalizeRateLimits, resolveCodexCommand, nativeCodexBinary, findCommand };
