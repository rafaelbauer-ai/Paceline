'use strict';
const { EventEmitter } = require('node:events');
const nodeFs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

// Timing calibrated on real local transcripts (Oct 2026: ~28k Claude and ~34k Codex write gaps
// inside turns). Claude main sessions go quiet for >30 s in 3.4% of in-turn gaps (long tools,
// long thinking, permission prompts; p99 81 s) and for >10 min 39 times in a week; Codex p99 is
// 19 s (p99.9 74 s) and >10 min 4 times in a month. So an explicitly open turn stays 'working'
// until staleMs; activeMs only applies where the transcript cannot say whether a turn is open:
// subagent files (their final message is never written to them) and tails without any
// recognisable record.
const DEFAULTS = { pollMs: 2000, activeMs: 30000, doneMs: 8000, staleMs: 600000, discoverMs: 10000, fullDiscoverMs: 60000 };
const TAIL = 64 * 1024;          // bytes read per changed file per poll (complete lines only)
const MAX_FILES = 64;            // tracked candidate files
const MAX_READS = 16;            // changed files read per poll, newest first
const MAX_ENTRIES = 20000;       // directory entries examined per discovery
const SUBAGENT_WINDOW = 3600000; // subagent folders are listed only for sessions written within an hour
const PROVIDERS = ['claude', 'codex'];
const QUIET = /^<(?:local-command-(?:stdout|stderr)|bash-(?:stdout|stderr))>/;
const CODEX_HINT = /^(?:reasoning|function_call|function_call_output|custom_tool_call|custom_tool_call_output)$/;
const iso = ms => ms == null ? null : new Date(ms).toISOString();
const epoch = value => !Number.isFinite(value) || value <= 1e8 ? null : value > 1e11 ? value : value * 1000;
const textOf = content => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) for (const block of content) if (block?.type === 'text' && typeof block.text === 'string') return block.text;
  return '';
};
// Claude Code writes one 'assistant' record per content block; the turn is over when the last
// block carries a final stop_reason (end_turn, stop_sequence, refusal, max_tokens). Interrupts,
// API errors and local slash/shell commands end it without a completed answer.
function claudeKind(record, sidechain) {
  if (record.isSidechain === true && !sidechain) return null;
  if (record.type === 'assistant') {
    if (record.isApiErrorMessage === true) return 'abort';
    const reason = record.message?.stop_reason;
    return reason == null || reason === 'tool_use' || reason === 'pause_turn' ? 'turn' : 'end';
  }
  if (record.type === 'system') return record.subtype === 'local_command' ? 'quiet' : null;
  if (record.type !== 'user') return null;
  const content = record.message?.content;
  if (Array.isArray(content) && content.some(block => block?.type === 'tool_result')) return 'turn';
  if (record.isMeta === true || record.isCompactSummary === true || record.isVisibleInTranscriptOnly === true) return 'meta';
  const text = textOf(content).trimStart();
  if (text.startsWith('[Request interrupted')) return 'abort';
  return QUIET.test(text) ? 'quiet' : 'start';
}
// Codex rollouts bracket every turn with event_msg task_started / task_complete | turn_aborted.
function codexKind(record) {
  const type = record.payload?.type;
  if (record.type === 'event_msg') return type === 'task_started' ? 'start' : type === 'task_complete' ? 'end' : type === 'turn_aborted' ? 'abort' : type === 'token_count' || type === 'item_completed' ? 'hint' : null;
  return record.type === 'response_item' && CODEX_HINT.test(type) ? 'hint' : null;
}
function recentFolders(at) {
  const folders = new Map();
  for (const offset of [0, 86400000]) {
    const day = new Date(at - offset);
    for (const parts of [[day.getFullYear(), day.getMonth() + 1, day.getDate()], [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()]]) {
      const names = parts.map((value, index) => String(value).padStart(index ? 2 : 4, '0'));
      folders.set(names.join('/'), names);
    }
  }
  return [...folders.values()];
}
// Polls local Claude Code / Codex transcripts and reports, per provider, whether the agent is
// working, has just finished a turn, or is idle. Only statuses and timestamps are kept; no
// transcript content is stored and nothing is persisted.
class AgentActivity extends EventEmitter {
  constructor({ claudeProjectsDir, codexSessionsDir, now = Date.now, pollMs, activeMs, doneMs, staleMs, discoverMs, fullDiscoverMs, setInterval: setTimer = setInterval, clearInterval: clearTimer = clearInterval, fs = nodeFs } = {}) {
    super();
    const ms = (value, key) => Number.isFinite(value) && value >= 0 ? value : DEFAULTS[key];
    const dir = (value, fallback) => value === undefined ? fallback() : value ? path.resolve(value) : null;
    this.dirs = {
      claude: dir(claudeProjectsDir, () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects')),
      codex: dir(codexSessionsDir, () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'))
    };
    this.now = now; this.fs = fs; this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.pollMs = Math.max(100, ms(pollMs, 'pollMs'));
    this.activeMs = ms(activeMs, 'activeMs'); this.doneMs = ms(doneMs, 'doneMs'); this.staleMs = ms(staleMs, 'staleMs');
    this.discoverMs = ms(discoverMs, 'discoverMs'); this.fullDiscoverMs = ms(fullDiscoverMs, 'fullDiscoverMs');
    this.window = Math.max(this.activeMs, this.doneMs, this.staleMs);
    this.files = new Map(); this.timer = null; this.polling = null; this.closed = false;
    this.discoveredAt = -Infinity; this.fullAt = -Infinity;
    this.last = Object.fromEntries(PROVIDERS.map(provider => [provider, { turnStartedAt: null, finishedAt: null }]));
    this.state = Object.fromEntries(PROVIDERS.map(provider => [provider, { status: 'idle', turnStartedAt: null, finishedAt: null }]));
  }
  getState() { return Object.fromEntries(PROVIDERS.map(provider => [provider, { ...this.state[provider] }])); }
  start() {
    if (this.timer || this.closed) return;
    void this.poll();
    this.timer = this.setTimer(() => { void this.poll(); }, this.pollMs);
    this.timer?.unref?.();
  }
  close() { this.closed = true; if (this.timer) this.clearTimer(this.timer); this.timer = null; }
  poll() {
    if (this.closed) return Promise.resolve(this.getState());
    if (!this.polling) this.polling = this.run().finally(() => { this.polling = null; });
    return this.polling;
  }
  async run() {
    // Each step is isolated: a failing directory or file never rejects the poll.
    try {
      const at = this.now();
      if (at - this.discoveredAt >= this.discoverMs) {
        const full = at - this.fullAt >= this.fullDiscoverMs;
        this.discoveredAt = at; if (full) this.fullAt = at;
        await this.discover(full, at);
      }
    } catch { /* Discovery is retried on the next interval. */ }
    try { await this.refresh(this.now()); } catch { /* Per-file failures are handled in refresh. */ }
    try { if (!this.closed) this.update(this.now()); } catch { /* A throwing 'change' listener must not break polling. */ }
    return this.getState();
  }
  async discover(full, at) {
    const fs = this.fs, found = new Map();
    let budget = MAX_ENTRIES;
    const list = async directory => {
      if (budget <= 0) return [];
      try { const items = await fs.readdir(directory, { withFileTypes: true }); budget -= items.length; return items.filter(item => !item.isSymbolicLink()); } catch { return []; }
    };
    // The configured roots are followed (they may be relocated with a junction); every link
    // found below them is skipped.
    const isRoot = async directory => { try { return (await fs.stat(directory)).isDirectory(); } catch { return false; } };
    const isDirectory = async directory => { try { const stat = await fs.lstat(directory); return !stat.isSymbolicLink() && stat.isDirectory(); } catch { return false; } };
    const consider = async (file, provider, sidechain) => {
      try {
        const stat = await fs.lstat(file);
        if (stat.isSymbolicLink() || !stat.isFile()) return null;
        if (at - stat.mtimeMs <= this.window) found.set(file, { provider, sidechain, mtimeMs: stat.mtimeMs });
        return stat;
      } catch { return null; }
    };
    // <project>/<session>/subagents/**/agent-*.jsonl; workflow journals are not transcripts.
    const agents = async (directory, depth) => {
      const items = await list(directory);
      await Promise.all(items.map(item => item.isDirectory() ? depth < 3 && agents(path.join(directory, item.name), depth + 1) : item.isFile() && /^agent-.+\.jsonl$/.test(item.name) && consider(path.join(directory, item.name), 'claude', true)));
    };
    const claude = this.dirs.claude;
    if (claude && await isRoot(claude)) {
      const projects = (await list(claude)).filter(item => item.isDirectory());
      await Promise.all(projects.map(async project => {
        const directory = path.join(claude, project.name), items = await list(directory), written = new Map();
        await Promise.all(items.filter(item => item.isFile() && item.name.endsWith('.jsonl')).map(async item => {
          const stat = await consider(path.join(directory, item.name), 'claude', false);
          if (stat) written.set(item.name.slice(0, -6), stat.mtimeMs);
        }));
        await Promise.all(items.filter(item => item.isDirectory() && at - (written.get(item.name) ?? -Infinity) <= SUBAGENT_WINDOW).map(item => agents(path.join(directory, item.name, 'subagents'), 0)));
      }));
    }
    // Codex folders are named after the session's creation day; resumed threads append to old
    // folders, so the whole YYYY/MM/DD tree is walked on full discoveries only.
    const codex = this.dirs.codex;
    if (codex && await isRoot(codex)) {
      const days = async (directory, depth) => {
        const items = await list(directory);
        await Promise.all(items.map(item => item.isDirectory() ? depth < 3 && /^\d+$/.test(item.name) && days(path.join(directory, item.name), depth + 1) : depth === 3 && item.isFile() && /^rollout-.+\.jsonl$/.test(item.name) && consider(path.join(directory, item.name), 'codex', false)));
      };
      if (full) await days(codex, 0);
      else await Promise.all(recentFolders(at).map(async names => { const folder = path.join(codex, ...names); if (await isDirectory(folder)) await days(folder, 3); }));
    }
    for (const [file, info] of found) {
      if (!this.files.has(file)) this.files.set(file, { path: file, provider: info.provider, sidechain: info.sidechain, size: -1, mtimeMs: info.mtimeMs, offset: 0, skip: false, phase: 'unknown', started: null, finished: null, doneAt: null, pending: null, prompt: false, lastAt: null });
    }
    if (this.files.size > MAX_FILES) {
      for (const file of [...this.files.values()].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(MAX_FILES)) this.files.delete(file.path);
    }
  }
  async refresh(at) {
    const checks = await Promise.all([...this.files.values()].map(async file => { try { return [file, await this.fs.lstat(file.path)]; } catch { return [file, null]; } }));
    const changed = [];
    for (const [file, stat] of checks) {
      if (!stat || stat.isSymbolicLink() || !stat.isFile() || at - stat.mtimeMs > this.window) this.files.delete(file.path);
      else if (stat.size !== file.size || stat.mtimeMs !== file.mtimeMs) changed.push([file, stat]);
    }
    changed.sort((a, b) => b[1].mtimeMs - a[1].mtimeMs);
    await Promise.all(changed.slice(0, MAX_READS).map(async ([file, stat]) => {
      // An unreadable file keeps its last known phase (unknown if never read) and is retried.
      try { await this.read(file, stat, at); file.size = stat.size; } catch { /* Locked, vanished or unreadable. */ }
      file.mtimeMs = stat.mtimeMs;
    }));
  }
  async read(file, stat, at) {
    let live = file.size >= 0;
    if (stat.size < file.offset) {
      // Truncated or replaced: start over from the tail.
      Object.assign(file, { offset: 0, skip: false, phase: 'unknown', started: null, finished: null, doneAt: null, pending: null, prompt: false, lastAt: null });
      live = false;
    }
    let start = file.offset, skip = file.skip;
    if (stat.size - start > TAIL) { start = stat.size - TAIL; skip = true; }
    if (stat.size <= start) return;
    const buffer = Buffer.allocUnsafe(stat.size - start);
    const handle = await this.fs.open(file.path, 'r');
    let length;
    try { ({ bytesRead: length } = await handle.read(buffer, 0, buffer.length, start)); } finally { await handle.close(); }
    let from = 0;
    if (skip) {
      // Reading starts inside a line: drop up to the first newline.
      const first = buffer.indexOf(10);
      if (first === -1 || first >= length) { file.offset = start + length; file.skip = true; return; }
      from = first + 1;
    }
    const end = length ? buffer.lastIndexOf(10, length - 1) : -1;
    // A trailing partial line is left for the next poll.
    if (end < from) { file.offset = start + from; file.skip = false; return; }
    file.offset = start + end + 1; file.skip = false;
    for (const line of buffer.toString('utf8', from, end).split('\n')) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record && typeof record === 'object') this.apply(file, record, live, at);
    }
  }
  apply(file, record, live, at) {
    const kind = file.provider === 'claude' ? claudeKind(record, file.sidechain) : codexKind(record);
    if (!kind) return;
    const parsed = Date.parse(record.timestamp), ts = Number.isFinite(parsed) ? parsed : null;
    const codex = file.provider === 'codex', payload = record.payload;
    if (kind === 'meta') { if (file.phase !== 'turn' && file.pending == null) file.pending = ts; return; }
    if (kind === 'hint') { if (file.phase === 'unknown') { file.phase = 'turn'; file.started = ts ?? at; } if (ts != null) file.lastAt = ts; return; }
    if (kind === 'start') {
      // A prompt queued while Claude works continues the same turn; a Codex task_started is always new.
      if (codex || file.phase !== 'turn' || (ts != null && file.lastAt != null && ts - file.lastAt > this.staleMs)) file.started = ts ?? (codex ? epoch(payload?.started_at) : null) ?? at;
      file.phase = 'turn'; file.prompt = true;
    } else if (kind === 'turn') {
      if (file.phase !== 'turn') file.started = file.pending ?? ts ?? at;
      file.phase = 'turn'; file.prompt = false;
    } else if (kind === 'quiet') {
      if (file.phase === 'turn' && file.prompt) file.phase = 'aborted';
    } else if (kind === 'abort') {
      file.phase = 'aborted';
    } else {
      // Several end records can belong to one answer; a new turn whose start was not seen gets
      // its first known timestamp so durations are never inflated by an older turn.
      // Codex reports the turn's own start, which covers a task_started outside the read tail.
      const reported = codex ? epoch(payload?.started_at) : null;
      if (file.phase !== 'turn' && (file.phase !== 'ended' || file.pending != null)) file.started = reported ?? file.pending ?? ts;
      else if (reported != null && (file.started == null || reported < file.started - 1000)) file.started = reported;
      const finished = ts ?? ((codex && epoch(payload?.completed_at)) || at);
      file.finished = file.phase === 'ended' && file.finished != null ? Math.max(file.finished, finished) : finished;
      file.phase = 'ended';
      file.doneAt = live ? at : file.finished;
      const last = this.last[file.provider];
      if (!file.sidechain && (last.finishedAt == null || file.finished >= last.finishedAt)) { last.finishedAt = file.finished; last.turnStartedAt = file.started; }
    }
    file.pending = null;
    if (ts != null) file.lastAt = ts;
  }
  status(file, at) {
    const age = at - file.mtimeMs;
    if (file.phase === 'turn') return age <= (file.sidechain ? this.activeMs : this.staleMs) ? 'working' : 'idle';
    if (file.phase === 'unknown') return age <= this.activeMs ? 'working' : 'idle';
    return file.phase === 'ended' && !file.sidechain && at - file.doneAt <= this.doneMs ? 'done' : 'idle';
  }
  update(at) {
    let changed = false;
    for (const provider of PROVIDERS) {
      let status = 'idle', started = null;
      for (const file of this.files.values()) {
        if (file.provider !== provider) continue;
        const value = this.status(file, at);
        if (value === 'working') { status = 'working'; if (file.started != null && (started == null || file.started < started)) started = file.started; }
        else if (value === 'done' && status === 'idle') status = 'done';
      }
      const last = this.last[provider];
      if (this.state[provider].status !== status) changed = true;
      this.state[provider] = { status, turnStartedAt: iso(status === 'working' ? started : last.turnStartedAt), finishedAt: iso(last.finishedAt) };
    }
    if (changed) this.emit('change', this.getState());
  }
}
module.exports = { AgentActivity };
