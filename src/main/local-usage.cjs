'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { projectMetadata } = require('../../scripts/claude-statusline.cjs');
const { ClaudeTranscriptScanner } = require('./claude-transcripts.cjs');
const i18n = require('../renderer/i18n.js');

const RETENTION = 30 * 86400000;
const MAX_LINE = 1024 * 1024;
const MAX_SESSIONS = 2000;
const number = value => Number.isSafeInteger(value) && value >= 0 && value <= 1e15 ? value : null;
// Only these records matter; matching bytes first spares JSON.parse on the large response lines.
const NEEDLES = [Buffer.from('"token_count"'), Buffer.from('"session_meta"')];
// Conversations started without a project folder: the Codex app keeps them under
// Documents\Codex\<date>\<slug>, the Claude app under scratch-YYYY-MM-DD-<hex> folders.
const CODEX_LOOSE = /[\\/]Documents[\\/]Codex[\\/]\d{4}-\d{2}-\d{2}[\\/][^\\/]+[\\/]?$/i;
const CLAUDE_LOOSE = /^scratch-\d{4}-\d{2}-\d{2}-[0-9a-f]{6}$/;
const slug = value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const duration = minutes => minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}min`;
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const cleanName = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100) : i18n.t('local.defaultProject');
function counts(raw) {
  const inputTokens = number(raw?.input_tokens);
  const outputTokens = number(raw?.output_tokens);
  const cachedTokens = number(raw?.cached_input_tokens) ?? 0;
  if (inputTokens === null || outputTokens === null || !Number.isSafeInteger(inputTokens + outputTokens)) return null;
  // Codex input already includes cached input; reasoning is already part of output.
  return { inputTokens, outputTokens, cachedTokens: Math.min(cachedTokens, inputTokens), totalTokens: inputTokens + outputTokens };
}
function cleanSession(raw, now) {
  if (raw?.provider !== 'codex' || typeof raw.id !== 'string' || !/^codex:[a-f0-9]{64}$/.test(raw.id) || !/^[a-f0-9]{64}$/.test(raw.projectId || '')) return null;
  if ([raw.inputTokens, raw.outputTokens, raw.cachedTokens].some(value => number(value) === null)) return null;
  const at = Date.parse(raw.lastActivity);
  if (!Number.isFinite(at) || at < now - RETENTION || at > now + 60000 || !Number.isSafeInteger(raw.inputTokens + raw.outputTokens)) return null;
  return { id: raw.id, provider: 'codex', projectId: raw.projectId, projectName: cleanName(raw.projectName), inputTokens: raw.inputTokens, outputTokens: raw.outputTokens, cachedTokens: Math.min(raw.cachedTokens, raw.inputTokens), totalTokens: raw.inputTokens + raw.outputTokens, lastActivity: new Date(at).toISOString(), measurement: 'cumulative_session', partial: Boolean(raw.partial), loose: raw.loose === true };
}
function cleanCursor(raw) {
  if (!raw || typeof raw.identity !== 'string' || !Number.isSafeInteger(raw.offset) || raw.offset < 0) return null;
  return { identity: raw.identity.slice(0, 120), offset: raw.offset, skipLine: Boolean(raw.skipLine), mtimeMs: Number.isFinite(raw.mtimeMs) ? raw.mtimeMs : 0, scannedAt: Number.isFinite(raw.scannedAt) ? raw.scannedAt : 0, sessionId: /^(codex):[a-f0-9]{64}$/.test(raw.sessionId || '') ? raw.sessionId : null, projectId: /^[a-f0-9]{64}$/.test(raw.projectId || '') ? raw.projectId : null, projectName: cleanName(raw.projectName), startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt : null, loose: raw.loose === true, baseline: raw.baseline && [raw.baseline.inputTokens, raw.baseline.outputTokens, raw.baseline.cachedTokens].every(value => number(value) !== null) ? { inputTokens: raw.baseline.inputTokens, outputTokens: raw.baseline.outputTokens, cachedTokens: raw.baseline.cachedTokens } : null, partial: Boolean(raw.partial) };
}
class LocalUsageCollector {
  constructor({ dataDir, codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), codexRoots, claudeProjectsDir, now = Date.now, maxBytesPerRefresh = 48 * 1024 * 1024 } = {}) {
    if (!dataDir || !path.isAbsolute(dataDir)) throw new Error('LocalUsageCollector requires an absolute data directory.');
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'local-usage.json');
    this.roots = codexRoots || [path.join(codexHome, 'sessions'), path.join(codexHome, 'archived_sessions')];
    this.now = now;
    this.maxBytes = Math.max(4096, Math.min(64 * 1024 * 1024, maxBytesPerRefresh));
    this.sessions = new Map(); this.cursors = new Map();
    // Official limit readings found in the logs, handed to the history by takeReadings().
    this.readings = []; this.backlog = false; this.rateBackfill = false;
    // Claude Code transcripts (terminal and desktop app alike) keep their own incremental state.
    this.claude = new ClaudeTranscriptScanner({ dataDir, projectsDir: claudeProjectsDir, now });
    this.status = 'waiting'; this.updatedAt = null; this.refreshing = null;
    // An i18n key; getSummary resolves it in the current language.
    this.messageKey = 'local.waiting';
    this.loadError = false;
    try {
      const stat = fs.lstatSync(this.file);
      if (stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error('Invalid local metadata');
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.sessions) || !data.cursors || typeof data.cursors !== 'object') throw new Error('Invalid local metadata schema');
      for (const item of data.sessions.slice(0, MAX_SESSIONS)) { const session = cleanSession(item, now()); if (session) this.sessions.set(session.id, session); }
      // Logs scanned before limit readings were collected are read once more; session totals
      // are cumulative maxima, so the second pass cannot double count them.
      this.rateBackfill = data.rateBackfill === true;
      if (this.rateBackfill) for (const [key, value] of Object.entries(data.cursors).slice(0, 2000)) { const cursor = cleanCursor(value); if (/^[a-f0-9]{64}$/.test(key) && cursor) this.cursors.set(key, cursor); }
      if (this.sessions.size) { this.status = 'partial'; this.messageKey = 'local.savedCounts'; }
      this.updatedAt = [...this.sessions.values()].reduce((last, item) => !last || item.lastActivity > last ? item.lastActivity : last, null);
    } catch (error) { if (error.code !== 'ENOENT') { this.loadError = true; this.messageKey = 'local.invalidMetadata'; } }
  }
  // A Codex conversation named after a real project folder (d-projetos-my-app) joins that
  // project; other folderless conversations share one group per app instead of one row each.
  groupFor(session, named) {
    if (session.provider === 'codex' && session.loose) {
      const name = slug(session.projectName);
      // The slug is the folder's full path (d-projetos-my-app), so a match must start at a drive letter.
      // The longest matching name wins: d-projetos-my-app belongs to my-app, not to app.
      const match = named.filter(project => project.slug.length >= 3 && (name === project.slug || (/^[a-z]-/.test(name) && name.endsWith(`-${project.slug}`)))).sort((a, b) => b.slug.length - a.slug.length)[0];
      return match ? { id: match.id, name: match.name } : { id: 'loose-codex', name: i18n.t('local.looseCodex') };
    }
    if (session.provider === 'claude' && CLAUDE_LOOSE.test(session.projectName)) return { id: 'loose-claude', name: i18n.t('local.looseClaude') };
    return { id: session.projectId, name: session.projectName };
  }
  getSummary() {
    const raw = [...this.sessions.values(), ...this.claude.getSessions()].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
    const named = [...new Map(raw.filter(item => !item.loose && !CLAUDE_LOOSE.test(item.projectName)).map(item => [item.projectId, { id: item.projectId, name: item.projectName, slug: slug(item.projectName) }])).values()];
    const sessions = raw.map(item => { const group = this.groupFor(item, named); return { ...item, projectId: group.id, projectName: group.name }; });
    const grouped = new Map();
    for (const session of sessions) {
      let project = grouped.get(session.projectId);
      if (!project) { project = { id: session.projectId, name: session.projectName, providers: [], sessionCount: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, lastActivity: session.lastActivity, partial: false, loose: session.projectId.startsWith('loose-') }; grouped.set(session.projectId, project); }
      if (!project.providers.includes(session.provider)) project.providers.push(session.provider);
      project.sessionCount += 1;
      for (const key of ['inputTokens', 'outputTokens', 'cachedTokens', 'totalTokens']) project[key] += session[key];
      project.partial ||= session.partial;
      if (session.lastActivity > project.lastActivity) project.lastActivity = session.lastActivity;
    }
    return structuredClone({ status: this.status, updatedAt: this.updatedAt, projects: [...grouped.values()].sort((a, b) => (b.totalTokens - b.cachedTokens) - (a.totalTokens - a.cachedTokens)), sessions, message: i18n.t(this.messageKey), measurement: 'local_tokens', retentionDays: 30 });
  }
  async discover() {
    const files = [];
    let directories = 0, entries = 0, incomplete = false;
    const visit = async (directory, root, depth = 0) => {
      if (depth > 5 || directories >= 500 || entries >= 15000 || files.length >= 1000) { incomplete = true; return; }
      let stat;
      try { stat = await fsp.lstat(directory); } catch (error) { if (error.code !== 'ENOENT') incomplete = true; return; }
      if (stat.isSymbolicLink() || !stat.isDirectory()) { incomplete = true; return; }
      directories += 1;
      const items = await fsp.readdir(directory, { withFileTypes: true });
      items.sort((a, b) => b.name.localeCompare(a.name));
      for (const item of items) {
        if (++entries > 15000 || files.length >= 1000) { incomplete = true; break; }
        if (item.isSymbolicLink()) continue;
        const filename = path.join(directory, item.name);
        if (item.isDirectory()) {
          // Folder dates indicate session creation, not last activity. A resumed
          // old session still belongs in the view; filter by file/activity timestamps.
          await visit(filename, root, depth + 1);
        } else if (item.isFile() && item.name.endsWith('.jsonl')) {
          try {
            const metadata = await fsp.lstat(filename);
            if (!metadata.isSymbolicLink() && metadata.isFile() && metadata.mtimeMs >= this.now() - RETENTION) files.push({ filename, root, stat: metadata, key: hash(path.resolve(filename)) });
          } catch { incomplete = true; }
        }
      }
    };
    for (const root of this.roots) { if (path.isAbsolute(root)) { try { await visit(root, root); } catch { incomplete = true; } } }
    files.sort((a, b) => (this.cursors.get(a.key)?.scannedAt || 0) - (this.cursors.get(b.key)?.scannedAt || 0) || b.stat.mtimeMs - a.stat.mtimeMs);
    return { files, incomplete };
  }
  consume(line, cursor) {
    let event;
    try { event = JSON.parse(line); } catch { cursor.partial = true; return; }
    const payload = event?.payload;
    if (event.type === 'session_meta') {
      // Desktop subagents can share session_id while id identifies each rollout/thread.
      // Prefer id so separate work is not collapsed into the parent's counter.
      const id = payload?.id || payload?.session_id;
      const project = projectMetadata(payload?.cwd);
      if (typeof id !== 'string' || !id || id.length > 4096 || !project) return;
      const sessionId = `codex:${hash(id)}`;
      if (cursor.sessionId !== sessionId) cursor.baseline = null;
      cursor.sessionId = sessionId; cursor.projectId = project.projectId; cursor.projectName = project.projectName; cursor.loose = CODEX_LOOSE.test(payload.cwd);
      const startedAt = Date.parse(payload.timestamp || event.timestamp);
      cursor.startedAt = Number.isFinite(startedAt) ? startedAt : null;
      return;
    }
    if (event.type !== 'event_msg' || payload?.type !== 'token_count') return;
    const timestamp = Date.parse(event.timestamp);
    this.readLimits(payload.rate_limits, timestamp);
    if (!cursor.sessionId || !cursor.projectId) return;
    const usage = counts(payload.info?.total_token_usage);
    if (!usage || !Number.isFinite(timestamp) || timestamp > this.now() + 60000) return;
    if (cursor.startedAt && timestamp < cursor.startedAt) {
      // Forked logs can contain inherited token_count records. Their cumulative
      // baseline is excluded from the new session instead of counting it twice.
      const old = cursor.baseline || { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
      cursor.baseline = Object.fromEntries(['inputTokens', 'outputTokens', 'cachedTokens'].map(key => [key, Math.max(old[key], usage[key])]));
      return;
    }
    if (timestamp < this.now() - RETENTION) return;
    if (cursor.baseline) {
      for (const key of ['inputTokens', 'outputTokens', 'cachedTokens']) usage[key] = Math.max(0, usage[key] - cursor.baseline[key]);
      usage.cachedTokens = Math.min(usage.cachedTokens, usage.inputTokens);
      usage.totalTokens = usage.inputTokens + usage.outputTokens;
    }
    const old = this.sessions.get(cursor.sessionId);
    const merged = old ? Object.fromEntries(['inputTokens', 'outputTokens', 'cachedTokens'].map(key => [key, Math.max(old[key], usage[key])])) : usage;
    merged.cachedTokens = Math.min(merged.cachedTokens, merged.inputTokens);
    merged.totalTokens = merged.inputTokens + merged.outputTokens;
    const lastActivity = new Date(timestamp).toISOString();
    this.sessions.set(cursor.sessionId, { id: cursor.sessionId, provider: 'codex', projectId: cursor.projectId, projectName: cursor.projectName, ...merged, lastActivity: old && old.lastActivity > lastActivity ? old.lastActivity : lastActivity, measurement: 'cumulative_session', partial: Boolean(cursor.partial || old?.partial), loose: Boolean(cursor.loose) });
  }
  readLimits(limits, timestamp) {
    if (!limits || typeof limits !== 'object' || !Number.isFinite(timestamp) || timestamp < this.now() - RETENTION || timestamp > this.now() + 60000) return;
    const bucket = typeof limits.limit_id === 'string' && /^[\w.-]{1,60}$/.test(limits.limit_id) ? limits.limit_id : 'codex';
    for (const slot of ['primary', 'secondary']) {
      const value = limits[slot];
      if (!value || typeof value.used_percent !== 'number' || !Number.isFinite(value.used_percent) || value.used_percent < 0 || value.used_percent > 100) continue;
      const minutes = Number.isFinite(value.window_minutes) && value.window_minutes > 0 ? value.window_minutes : null;
      if (this.readings.length < 20000) this.readings.push({ providerId: 'codex', providerName: 'Codex', windowId: `${bucket}:${slot}`, label: minutes ? duration(minutes) : slot, windowMinutes: minutes, at: new Date(timestamp).toISOString(), usedPercent: value.used_percent, resetsAt: Number.isFinite(value.resets_at) ? value.resets_at : null });
    }
  }
  takeReadings() { const readings = this.readings; this.readings = []; return readings; }
  async scan(source, budget) {
    // Check every descendant before open; Windows junctions and symlinks are skipped.
    const relative = path.relative(source.root, source.filename);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return { read: 0, incomplete: true };
    let current = source.root;
    for (const component of ['', ...relative.split(path.sep)]) {
      if (component) current = path.join(current, component);
      if ((await fsp.lstat(current)).isSymbolicLink()) return { read: 0, incomplete: true };
    }
    const handle = await fsp.open(source.filename, fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW || 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.ino !== source.stat.ino || stat.dev !== source.stat.dev) return { read: 0, incomplete: true };
      const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      let cursor = this.cursors.get(source.key);
      if (!cursor || cursor.identity !== identity || cursor.offset > stat.size || (cursor.offset === stat.size && cursor.mtimeMs !== stat.mtimeMs)) cursor = { identity, offset: 0, skipLine: false, mtimeMs: 0, scannedAt: 0, sessionId: null, projectId: null, projectName: i18n.t('local.defaultProject'), startedAt: null, baseline: null, partial: false };
      let position = cursor.offset, read = 0, pending = Buffer.alloc(0);
      const buffer = Buffer.alloc(Math.min(128 * 1024, budget));
      while (position < stat.size && read < budget) {
        const length = Math.min(buffer.length, budget - read, stat.size - position);
        const result = await handle.read(buffer, 0, length, position);
        if (!result.bytesRead) break;
        const startPosition = position - pending.length;
        position += result.bytesRead; read += result.bytesRead;
        const chunk = pending.length ? Buffer.concat([pending, buffer.subarray(0, result.bytesRead)]) : buffer.subarray(0, result.bytesRead);
        let start = 0, end;
        while ((end = chunk.indexOf(10, start)) !== -1) {
          // Oversized lines are response content, never the small counter records.
          const line = chunk.subarray(start, end);
          if (!cursor.skipLine && end - start <= MAX_LINE && NEEDLES.some(needle => line.indexOf(needle) !== -1)) this.consume(line.toString('utf8'), cursor);
          cursor.skipLine = false;
          start = end + 1; cursor.offset = startPosition + start;
        }
        pending = Buffer.from(chunk.subarray(start));
        if (pending.length > MAX_LINE || cursor.skipLine) { pending = Buffer.alloc(0); cursor.skipLine = true; cursor.offset = position; }
      }
      // A single record larger than this scan budget must not pin the cursor
      // forever. Skip its remainder explicitly and report partial coverage.
      if (position < stat.size && read >= budget && pending.length === read) { cursor.skipLine = true; cursor.offset = position; }
      cursor.mtimeMs = stat.mtimeMs; cursor.scannedAt = this.now();
      this.cursors.set(source.key, cursor);
      return { read, incomplete: cursor.partial, pending: position < stat.size };
    } finally { await handle.close(); }
  }
  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.collect().catch(() => { this.status = this.sessions.size ? 'partial' : 'error'; this.messageKey = 'local.refreshFailed'; return this.getSummary(); });
    try { return await this.refreshing; } finally { this.refreshing = null; }
  }
  async collect() {
    if (this.loadError) { this.status = 'error'; return this.getSummary(); }
    const discovered = await this.discover();
    let incomplete = discovered.incomplete || (!discovered.files.length && [...this.sessions.values()].some(item => item.provider === 'codex')), remaining = this.maxBytes, scanned = 0, backlog = false;
    for (const source of discovered.files) {
      // Past the budget, only files with unread bytes count as backlog; unchanged ones never do.
      if (remaining <= 0 || scanned >= 200) {
        const cursor = this.cursors.get(source.key);
        backlog ||= !cursor || cursor.offset < source.stat.size;
        continue;
      }
      try { const result = await this.scan(source, Math.min(remaining, 8 * 1024 * 1024)); remaining -= result.read; incomplete ||= result.incomplete; backlog ||= result.pending; if (result.read) scanned += 1; }
      catch { incomplete = true; }
    }
    if (!backlog) this.rateBackfill = true;
    try {
      const claude = await this.claude.scan({ maxBytes: 32 * 1024 * 1024 });
      backlog ||= !claude.done;
    } catch { incomplete = true; }
    this.backlog = backlog;
    this.sessions = new Map([...this.sessions.entries()].filter(([_id, item]) => Date.parse(item.lastActivity) >= this.now() - RETENTION).sort((a, b) => b[1].lastActivity.localeCompare(a[1].lastActivity)).slice(0, MAX_SESSIONS));
    this.cursors = new Map([...this.cursors.entries()].sort((a, b) => b[1].scannedAt - a[1].scannedAt).slice(0, 2000));
    this.updatedAt = [...this.sessions.values(), ...this.claude.getSessions()].reduce((latest, item) => !latest || item.lastActivity > latest ? item.lastActivity : latest, this.updatedAt);
    const counted = this.sessions.size + this.claude.getSessions().length;
    this.status = counted ? incomplete || backlog ? 'partial' : 'ready' : incomplete ? 'partial' : 'waiting';
    this.messageKey = counted ? backlog ? 'local.catchingUp' : incomplete ? 'local.observedPartial' : 'local.observed' : 'local.waitingRecords';
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await fsp.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      try { if ((await fsp.lstat(this.file)).isSymbolicLink()) throw new Error('Symlink state'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await fsp.writeFile(temporary, JSON.stringify({ version: 1, rateBackfill: this.rateBackfill, sessions: [...this.sessions.values()], cursors: Object.fromEntries(this.cursors) }) + '\n', { mode: 0o600, flag: 'wx' });
      await fsp.rename(temporary, this.file);
    } catch { this.status = 'partial'; this.messageKey = 'local.saveFailed'; }
    finally { try { await fsp.unlink(temporary); } catch {} }
    return this.getSummary();
  }
}
module.exports = { LocalUsageCollector, counts };
