'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { projectMetadata } = require('../../scripts/claude-statusline.cjs');

const DAY = 86400000;
const CHUNK = 128 * 1024;
const MAX_LINE = 1024 * 1024;
const MAX_SESSIONS = 2000;
const MAX_FILES = 20000;
// A file that cannot be read (locked, replaced mid-scan) is not backlog until it changes or this passes.
const RETRY_MS = 10 * 60000;
const MAX_SEEN = 400000;
const MAX_STATE = 16 * 1024 * 1024;
const USAGE = Buffer.from('"usage"');
const ASSISTANT = Buffer.from('"assistant"');
const number = value => Number.isSafeInteger(value) && value >= 0 && value <= 1e15 ? value : null;
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const identityOf = stat => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const pause = () => new Promise(resolve => setImmediate(resolve));
// Claude Code keeps transcripts in a folder named after the launch directory with every
// non-alphanumeric character replaced by '-'. Attribute a message to the ancestor of its
// cwd that matches that folder (the statusline's workspace.project_dir), so `cd src` does
// not split a project; otherwise fall back to the cwd itself.
function projectFor(cwd, folder) {
  const own = projectMetadata(cwd);
  if (!own || !folder) return own;
  const paths = /^[A-Za-z]:[\\/]|^\\\\/.test(cwd) ? path.win32 : path.posix;
  const fold = value => paths === path.win32 ? value.toLowerCase() : value, target = fold(folder);
  for (let current = paths.normalize(cwd).replace(/[\\/]+$/, ''), depth = 0; depth < 64; depth++) {
    if (fold(current.replace(/[^A-Za-z0-9]/g, '-')) === target) return projectMetadata(current) || own;
    const parent = paths.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return own;
}
function cleanSession(raw, cutoff, limit) {
  if (!raw || typeof raw.id !== 'string' || !/^claude:[a-f0-9]{64}$/.test(raw.id) || !/^[a-f0-9]{64}$/.test(raw.projectId || '') || typeof raw.projectName !== 'string') return null;
  if ([raw.inputTokens, raw.outputTokens, raw.cachedTokens].some(value => number(value) === null) || !Number.isSafeInteger(raw.inputTokens + raw.outputTokens)) return null;
  const at = Date.parse(raw.lastActivity);
  if (!Number.isFinite(at) || at < cutoff || at > limit) return null;
  return { id: raw.id, provider: 'claude', projectId: raw.projectId, projectName: raw.projectName.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100), inputTokens: raw.inputTokens, outputTokens: raw.outputTokens, cachedTokens: Math.min(raw.cachedTokens, raw.inputTokens), totalTokens: raw.inputTokens + raw.outputTokens, lastActivity: new Date(at).toISOString(), measurement: 'transcript', partial: false };
}
function cleanCursor(raw) {
  if (!raw || typeof raw.identity !== 'string' || raw.identity.length > 120 || !Number.isSafeInteger(raw.offset) || !Number.isSafeInteger(raw.end) || raw.offset < 0 || raw.end < raw.offset) return null;
  return { identity: raw.identity, offset: raw.offset, end: raw.end, mtimeMs: Number.isFinite(raw.mtimeMs) ? raw.mtimeMs : 0, skipLine: raw.skipLine === true };
}
// Counts Claude Code usage from local transcripts (~/.claude/projects/**/*.jsonl).
// Each assistant response is repeated once per content block and may be copied into
// forks, so responses are deduplicated globally by message id + request id. Only
// counts, one-way hashes, project folder names and timestamps are persisted.
class ClaudeTranscriptScanner {
  constructor({ dataDir, projectsDir, now = Date.now, retentionMs = 30 * DAY } = {}) {
    if (!dataDir || !path.isAbsolute(dataDir)) throw new Error('ClaudeTranscriptScanner requires an absolute data directory.');
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'claude-transcripts.json');
    this.root = path.resolve(projectsDir || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects'));
    this.now = now;
    this.retention = Number.isFinite(retentionMs) && retentionMs > 0 ? retentionMs : 30 * DAY;
    this.sessions = new Map(); this.cursors = new Map(); this.seen = new Map();
    this.scanning = null; this.dirty = false; this.loadError = false; this.saveError = false;
    this.failed = new Map();
    try { this.load(); } catch (error) {
      this.sessions.clear(); this.cursors.clear(); this.seen.clear();
      // Invalid state is rebuilt from the transcripts; a symlinked file is never written.
      if (error.code !== 'ENOENT') { this.loadError = true; this.dirty = true; }
    }
  }
  load() {
    const stat = fs.lstatSync(this.file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_STATE) throw new Error('Unsupported transcript state');
    const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (data?.version !== 1 || !Array.isArray(data.sessions) || !isObject(data.cursors) || !isObject(data.seen)) throw new Error('Invalid transcript state');
    const now = this.now(), cutoff = now - this.retention, firstDay = Math.floor(cutoff / DAY);
    for (const item of data.sessions.slice(0, MAX_SESSIONS)) { const session = cleanSession(item, cutoff, now + 60000); if (session) this.sessions.set(session.id, session); }
    for (const [key, value] of Object.entries(data.cursors).slice(0, MAX_FILES)) { const cursor = cleanCursor(value); if (/^[a-f0-9]{64}$/.test(key) && cursor) this.cursors.set(key, cursor); }
    for (const [key, keys] of Object.entries(data.seen)) {
      const day = Number(key);
      if (!Number.isSafeInteger(day) || day < firstDay || typeof keys !== 'string' || keys.length % 16 || !/^[a-f0-9]*$/.test(keys)) continue;
      for (let index = 0; index < keys.length; index += 16) this.seen.set(keys.slice(index, index + 16), day);
    }
  }
  getSessions() {
    const cutoff = this.now() - this.retention;
    return [...this.sessions.values()].filter(item => Date.parse(item.lastActivity) >= cutoff).sort((a, b) => b.lastActivity.localeCompare(a.lastActivity)).slice(0, MAX_SESSIONS).map(item => ({ ...item }));
  }
  scan(options) {
    // Overlapping callers share one pass; cursors and totals are never updated concurrently.
    if (!this.scanning) this.scanning = this.run(options ?? {}).finally(() => { this.scanning = null; });
    return this.scanning;
  }
  async run({ maxBytes = 32 * 1024 * 1024, maxFiles = 200 } = {}) {
    const budget = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : 32 * 1024 * 1024;
    const fileLimit = Number.isSafeInteger(maxFiles) && maxFiles > 0 ? maxFiles : 200;
    const now = this.now(), window = { cutoff: now - this.retention, limit: now + 60000 };
    const { files, complete } = await this.discover(window.cutoff);
    const buffer = Buffer.allocUnsafe(CHUNK);
    let readBytes = 0, opened = 0;
    for (const source of files) {
      if (!this.unread(source)) {
        const cursor = this.cursors.get(source.key);
        if (cursor && cursor.mtimeMs !== source.stat.mtimeMs) { cursor.mtimeMs = source.stat.mtimeMs; this.dirty = true; }
        continue;
      }
      if (readBytes >= budget || opened >= fileLimit) continue;
      opened += 1;
      let got = 0;
      try { got = await this.read(source, budget - readBytes, buffer, window); }
      catch { /* Vanished, locked or replaced: set aside below and retried later. */ }
      readBytes += got;
      if (got) this.failed.delete(source.key);
      else this.failed.set(source.key, { size: source.stat.size, at: now });
    }
    if (complete) {
      const live = new Set(files.map(source => source.key));
      for (const key of this.cursors.keys()) if (!live.has(key)) { this.cursors.delete(key); this.dirty = true; }
    }
    this.prune(window.cutoff);
    if (this.dirty) await this.save();
    const pendingBytes = files.reduce((sum, source) => sum + this.unread(source), 0);
    return { done: pendingBytes === 0, readBytes, pendingBytes, sessions: this.getSessions() };
  }
  async discover(cutoff) {
    const files = [];
    let directories = 0, entries = 0, complete = true;
    const visit = async (directory, depth) => {
      if (depth > 8 || directories >= 20000 || entries >= 500000) { complete = false; return; }
      let stat;
      try { stat = await fsp.lstat(directory); } catch (error) { if (error.code !== 'ENOENT') complete = false; return; }
      if (stat.isSymbolicLink() || !stat.isDirectory()) return;
      directories += 1;
      let items;
      try { items = await fsp.readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') complete = false; return; }
      const folders = [], candidates = [];
      for (const item of items) {
        entries += 1;
        if (item.isSymbolicLink()) continue;
        const filename = path.join(directory, item.name);
        if (item.isDirectory()) folders.push(filename);
        else if (item.isFile() && item.name.endsWith('.jsonl') && item.name !== 'journal.jsonl') candidates.push(filename);
      }
      await Promise.all([...folders.map(folder => visit(folder, depth + 1)), ...candidates.map(async filename => {
        try {
          const metadata = await fsp.lstat(filename);
          if (!metadata.isSymbolicLink() && metadata.isFile() && metadata.mtimeMs >= cutoff) files.push({ filename, key: hash(filename), stat: metadata, identity: identityOf(metadata), folder: depth > 0 ? path.relative(this.root, filename).split(path.sep)[0] : null });
        } catch (error) { if (error.code !== 'ENOENT') complete = false; }
      })]);
    };
    try { await visit(this.root, 0); } catch { complete = false; }
    // Newest first, so the projects in use right now appear before the backlog.
    files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    if (files.length > MAX_FILES) { files.length = MAX_FILES; complete = false; }
    return { files, complete };
  }
  unread(source) {
    const cursor = this.cursors.get(source.key), { size } = source.stat;
    const failed = this.failed.get(source.key);
    if (failed && failed.size === size && this.now() - failed.at < RETRY_MS) return 0;
    if (!cursor || cursor.identity !== source.identity || size < cursor.end) return size;
    // A trailing partial line already examined is not backlog until the file grows.
    return size === cursor.end ? 0 : size - cursor.offset;
  }
  async read(source, budget, buffer, window) {
    // Re-check every component right before open; Windows junctions and symlinks are skipped.
    const relative = path.relative(this.root, source.filename);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return 0;
    let current = this.root;
    for (const component of relative.split(path.sep)) {
      current = path.join(current, component);
      if ((await fsp.lstat(current)).isSymbolicLink()) return 0;
    }
    const handle = await fsp.open(source.filename, fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW || 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.ino !== source.stat.ino || stat.dev !== source.stat.dev) return 0;
      source.stat = stat; source.identity = identityOf(stat);
      let cursor = this.cursors.get(source.key);
      // Replaced or truncated: restart. The global response set prevents double counting.
      if (!cursor || cursor.identity !== source.identity || stat.size < cursor.end) cursor = { identity: source.identity, offset: 0, end: 0, mtimeMs: 0, skipLine: false };
      const first = cursor.offset;
      let position = cursor.offset, read = 0, pending = null;
      // The budget is checked only after at least one record boundary, so one long
      // line cannot pin the cursor (overshoot is bounded by MAX_LINE + CHUNK).
      while (position < stat.size && (read < budget || cursor.offset === first)) {
        const length = Math.min(read < budget ? Math.min(CHUNK, budget - read) : CHUNK, stat.size - position);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        if (!bytesRead) break;
        const base = position - (pending ? pending.length : 0);
        position += bytesRead; read += bytesRead;
        const chunk = pending ? Buffer.concat([pending, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
        let start = 0, next = chunk.indexOf(USAGE);
        for (;;) {
          if (!cursor.skipLine) {
            // Jump straight to the line holding the next usage marker; other lines are never decoded.
            const before = next === -1 ? chunk.lastIndexOf(10) : chunk.lastIndexOf(10, next);
            if (before >= start) start = before + 1;
            if (next === -1) break;
          }
          const end = chunk.indexOf(10, start);
          if (end === -1) break;
          if (cursor.skipLine) cursor.skipLine = false;
          else if (end - start <= MAX_LINE) this.consume(chunk.subarray(start, end), window, source.folder);
          start = end + 1;
          if (next !== -1 && next < start) next = chunk.indexOf(USAGE, start);
        }
        cursor.offset = base + start;
        pending = null;
        if (start < chunk.length) {
          if (cursor.skipLine || chunk.length - start > MAX_LINE) { cursor.skipLine = true; cursor.offset = position; }
          else pending = Buffer.from(chunk.subarray(start));
        }
        await pause();
      }
      cursor.end = position; cursor.mtimeMs = stat.mtimeMs;
      this.cursors.set(source.key, cursor); this.dirty = true;
      return read;
    } finally { await handle.close(); }
  }
  consume(line, { cutoff, limit }, folder) {
    if (line.indexOf(ASSISTANT) === -1) return;
    let event;
    try { event = JSON.parse(line.toString('utf8')); } catch { return; }
    const message = event?.message, usage = message?.usage;
    if (event.type !== 'assistant' || !isObject(usage) || typeof message.id !== 'string' || !message.id || message.id.length > 512) return;
    const fresh = number(usage.input_tokens), outputTokens = number(usage.output_tokens), written = number(usage.cache_creation_input_tokens ?? 0), cachedTokens = number(usage.cache_read_input_tokens ?? 0);
    if ([fresh, outputTokens, written, cachedTokens].some(value => value === null)) return;
    // Total input processed, like Codex input which already includes cached input.
    const inputTokens = fresh + written + cachedTokens;
    if (!Number.isSafeInteger(inputTokens + outputTokens) || inputTokens + outputTokens === 0) return;
    const at = Date.parse(event.timestamp);
    if (!Number.isFinite(at) || at < cutoff || at > limit) return;
    if (typeof event.sessionId !== 'string' || !event.sessionId || event.sessionId.length > 4096) return;
    const project = projectFor(event.cwd, folder);
    if (!project) return;
    const requestId = typeof event.requestId === 'string' ? event.requestId.slice(0, 512) : '';
    const key = hash(`${message.id}:${requestId}`).slice(0, 16), day = Math.floor(at / DAY);
    const known = this.seen.get(key);
    this.dirty = true;
    if (known !== undefined) { if (day > known) this.seen.set(key, day); return; }
    this.seen.set(key, day);
    // Subagent transcripts carry the parent's session id and merge into the parent.
    const id = `claude:${hash(`${event.sessionId}\0${project.projectId}`)}`;
    const lastActivity = new Date(at).toISOString();
    const session = this.sessions.get(id);
    if (!session) {
      this.sessions.set(id, { id, provider: 'claude', projectId: project.projectId, projectName: project.projectName, inputTokens, outputTokens, cachedTokens: Math.min(cachedTokens, inputTokens), totalTokens: inputTokens + outputTokens, lastActivity, measurement: 'transcript', partial: false });
      return;
    }
    if (!Number.isSafeInteger(session.totalTokens + inputTokens + outputTokens)) return;
    session.inputTokens += inputTokens; session.outputTokens += outputTokens;
    session.cachedTokens = Math.min(session.cachedTokens + cachedTokens, session.inputTokens);
    session.totalTokens = session.inputTokens + session.outputTokens;
    if (lastActivity > session.lastActivity) session.lastActivity = lastActivity;
  }
  prune(cutoff) {
    const firstDay = Math.floor(cutoff / DAY);
    for (const [id, session] of this.sessions) if (Date.parse(session.lastActivity) < cutoff) { this.sessions.delete(id); this.dirty = true; }
    if (this.sessions.size > MAX_SESSIONS) { this.sessions = new Map([...this.sessions].sort((a, b) => b[1].lastActivity.localeCompare(a[1].lastActivity)).slice(0, MAX_SESSIONS)); this.dirty = true; }
    for (const [key, day] of this.seen) if (day < firstDay) { this.seen.delete(key); this.dirty = true; }
    if (this.seen.size > MAX_SEEN) { this.seen = new Map([...this.seen].sort((a, b) => b[1] - a[1]).slice(0, MAX_SEEN)); this.dirty = true; }
  }
  async save() {
    const seen = {};
    for (const [key, day] of this.seen) (seen[day] ||= []).push(key);
    for (const day of Object.keys(seen)) seen[day] = seen[day].join('');
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const body = JSON.stringify({ version: 1, sessions: [...this.sessions.values()], cursors: Object.fromEntries(this.cursors), seen }) + '\n';
      if (Buffer.byteLength(body) > MAX_STATE) throw new Error('Transcript state too large');
      await fsp.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      try { if ((await fsp.lstat(this.file)).isSymbolicLink()) throw new Error('Symlink state'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await fsp.writeFile(temporary, body, { mode: 0o600, flag: 'wx' });
      await fsp.rename(temporary, this.file);
      this.dirty = false; this.saveError = false;
    } catch { this.saveError = true; }
    finally { try { await fsp.unlink(temporary); } catch {} }
  }
}
module.exports = { ClaudeTranscriptScanner };
