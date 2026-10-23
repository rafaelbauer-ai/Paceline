'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { AgentActivity } = require('../src/main/agent-activity.cjs');
function fixture(t, options = {}) {
  const root = path.resolve(__dirname, '../.local/tests'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'agent-activity-'));
  const claude = path.join(dir, 'claude-projects'), codex = path.join(dir, 'codex-sessions');
  fs.mkdirSync(claude); fs.mkdirSync(codex);
  const clock = { now: Date.now() };
  const activity = new AgentActivity({ claudeProjectsDir: claude, codexSessionsDir: codex, now: () => clock.now, discoverMs: 0, ...options });
  const changes = []; activity.on('change', state => changes.push(state));
  t.after(() => { activity.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  // Appends records (or raw text) and stamps the file's mtime with the fake clock.
  const write = (file, records, mtime = clock.now) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, typeof records === 'string' ? records : records.map(record => JSON.stringify(record) + '\n').join(''));
    fs.utimesSync(file, new Date(mtime), new Date(mtime));
    return file;
  };
  return { dir, claude, codex, clock, activity, changes, write };
}
const iso = ms => new Date(ms).toISOString();
const prompt = ms => ({ type: 'user', timestamp: iso(ms), message: { role: 'user', content: 'PRIVATE PROMPT' } });
const toolUse = (ms, stop = 'tool_use') => ({ type: 'assistant', timestamp: iso(ms), message: { role: 'assistant', stop_reason: stop, content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'PRIVATE' } }] } });
const toolResult = (ms, output = 'PRIVATE OUTPUT') => ({ type: 'user', timestamp: iso(ms), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: output }] } });
const answer = (ms, stop = 'end_turn') => ({ type: 'assistant', timestamp: iso(ms), message: { role: 'assistant', stop_reason: stop, content: [{ type: 'text', text: 'PRIVATE ANSWER' }] } });
const bookkeeping = ms => [{ type: 'system', subtype: 'stop_hook_summary', timestamp: iso(ms) }, { type: 'last-prompt', lastPrompt: 'PRIVATE' }];
const side = record => ({ ...record, isSidechain: true, agentId: 'agent-1' });
const codexEvent = (ms, type, payload = {}) => ({ timestamp: iso(ms), type: 'event_msg', payload: { type, turn_id: 'turn-1', ...payload } });
const seconds = ms => Math.floor(ms / 1000);
const dayFolder = (root, ms) => { const day = new Date(ms); return path.join(root, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0')); };
const statuses = changes => changes.map(state => `${state.claude.status}/${state.codex.status}`);
const IDLE = { status: 'idle', turnStartedAt: null, finishedAt: null };

test('both providers are idle without transcripts, missing folders or with a provider disabled', async t => {
  const { dir, activity, changes } = fixture(t);
  assert.deepEqual(await activity.poll(), { claude: IDLE, codex: IDLE });
  assert.deepEqual(activity.getState(), { claude: IDLE, codex: IDLE });
  const missing = new AgentActivity({ claudeProjectsDir: path.join(dir, 'missing'), codexSessionsDir: null });
  assert.deepEqual(await missing.poll(), { claude: IDLE, codex: IDLE });
  assert.equal(changes.length, 0);
});

test('Claude is working while tool calls are appended, done after end_turn and idle after doneMs', async t => {
  const { claude, clock, activity, changes, write } = fixture(t);
  const file = path.join(claude, 'D--projetos-Example', 'session-1.jsonl');
  const begin = clock.now - 5000;
  write(file, [{ type: 'file-history-snapshot', snapshot: {} }, prompt(begin), toolUse(begin + 1000)]);
  let state = await activity.poll();
  assert.deepEqual(state.claude, { status: 'working', turnStartedAt: iso(begin), finishedAt: null });
  assert.deepEqual(state.codex, IDLE);
  clock.now += 2000; write(file, [toolResult(clock.now - 500), toolUse(clock.now, null), toolUse(clock.now)]);
  assert.equal((await activity.poll()).claude.status, 'working');
  // A long tool run or long thinking writes nothing for minutes: the open turn is still work.
  clock.now += 120000;
  assert.equal((await activity.poll()).claude.status, 'working');
  clock.now += 1000;
  const end = clock.now - 200;
  write(file, [toolResult(end - 300), answer(end - 100), answer(end), ...bookkeeping(clock.now)]);
  state = await activity.poll();
  assert.deepEqual(state.claude, { status: 'done', turnStartedAt: iso(begin), finishedAt: iso(end) });
  clock.now += 5000; assert.equal((await activity.poll()).claude.status, 'done');
  clock.now += 4000; state = await activity.poll();
  assert.deepEqual(state.claude, { status: 'idle', turnStartedAt: iso(begin), finishedAt: iso(end) });
  assert.deepEqual(statuses(changes), ['working/idle', 'done/idle', 'idle/idle']);
  assert.ok(!JSON.stringify(changes).includes('PRIVATE'));
  assert.deepEqual(Object.keys(state.claude).sort(), ['finishedAt', 'status', 'turnStartedAt']);
});

test('interrupted turns and local commands go back to idle without a done state', async t => {
  const { claude, clock, activity, changes, write } = fixture(t);
  const file = path.join(claude, 'p', 's.jsonl');
  write(file, [prompt(clock.now - 1000), toolUse(clock.now)]);
  assert.equal((await activity.poll()).claude.status, 'working');
  clock.now += 1000;
  write(file, [toolResult(clock.now), { type: 'user', timestamp: iso(clock.now), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }]);
  assert.equal((await activity.poll()).claude.status, 'idle');
  clock.now += 1000;
  write(file, [{ type: 'user', isMeta: true, timestamp: iso(clock.now), message: { role: 'user', content: '<local-command-caveat>x</local-command-caveat>' } }, { type: 'user', timestamp: iso(clock.now), message: { role: 'user', content: '<command-name>/model</command-name>' } }, { type: 'system', subtype: 'local_command', timestamp: iso(clock.now) }]);
  assert.equal((await activity.poll()).claude.status, 'idle');
  write(file, [prompt(clock.now), { type: 'assistant', isApiErrorMessage: true, timestamp: iso(clock.now), message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API Error' }] } }]);
  assert.equal((await activity.poll()).claude.status, 'idle');
  assert.deepEqual(statuses(changes), ['working/idle', 'idle/idle']);
  assert.equal(activity.getState().claude.finishedAt, null);
});

test('a turn that stops growing for longer than staleMs falls back to idle', async t => {
  const { claude, clock, activity, changes, write } = fixture(t, { staleMs: 60000 });
  write(path.join(claude, 'p', 's.jsonl'), [prompt(clock.now - 1000), toolUse(clock.now)]);
  assert.equal((await activity.poll()).claude.status, 'working');
  clock.now += 59000; assert.equal((await activity.poll()).claude.status, 'working');
  clock.now += 2000; assert.equal((await activity.poll()).claude.status, 'idle');
  assert.deepEqual(statuses(changes), ['working/idle', 'idle/idle']);
  // With the default staleMs (10 min) a session abandoned mid-turn 11 minutes ago is idle.
  const other = fixture(t);
  other.write(path.join(other.claude, 'p', 'abandoned.jsonl'), [prompt(other.clock.now - 700000), toolUse(other.clock.now - 660000)], other.clock.now - 660000);
  assert.equal((await other.activity.poll()).claude.status, 'idle');
});

test('subagent transcripts count as working while they grow; workflow journals are ignored', async t => {
  const { claude, clock, activity, write } = fixture(t);
  const project = path.join(claude, 'D--projetos-Example');
  // The parent turn ended 20 minutes ago while a background agent keeps working.
  write(path.join(project, 'parent.jsonl'), [prompt(clock.now - 1300000), answer(clock.now - 1200000)], clock.now - 1200000);
  const agent = write(path.join(project, 'parent', 'subagents', 'agent-a1.jsonl'), [side(prompt(clock.now - 3000)), side(toolUse(clock.now - 2000, null))]);
  const journal = write(path.join(project, 'parent', 'subagents', 'workflows', 'wf_1', 'journal.jsonl'), [prompt(clock.now - 1000), toolUse(clock.now)]);
  let state = await activity.poll();
  assert.equal(state.claude.status, 'working'); assert.equal(state.claude.turnStartedAt, iso(clock.now - 3000));
  clock.now += 10000; write(agent, [side(toolResult(clock.now))]);
  assert.equal((await activity.poll()).claude.status, 'working');
  // Subagent files never record their final answer: they are idle once quiet for activeMs.
  // The workflow journal keeps changing but is not a transcript.
  clock.now += 31000; write(journal, [toolResult(clock.now), toolUse(clock.now)]);
  state = await activity.poll();
  assert.equal(state.claude.status, 'idle');
  write(path.join(project, 'parent', 'subagents', 'workflows', 'wf_1', 'agent-w1.jsonl'), [side(prompt(clock.now)), side(toolUse(clock.now, null))]);
  assert.equal((await activity.poll()).claude.status, 'working');
});

test('Codex turns follow task_started, task_complete and turn_aborted events', async t => {
  const { codex, clock, activity, changes, write } = fixture(t);
  const file = path.join(dayFolder(codex, clock.now), 'rollout-2026-01-01T00-00-00-thread.jsonl');
  const begin = clock.now - 4000;
  write(file, [{ timestamp: iso(begin - 100), type: 'session_meta', payload: { id: 'thread', cwd: 'PRIVATE' } }, codexEvent(begin, 'task_started', { started_at: seconds(begin) }), { timestamp: iso(begin + 10), type: 'turn_context', payload: {} }, { timestamp: iso(begin + 900), type: 'response_item', payload: { type: 'reasoning' } }, codexEvent(begin + 1000, 'token_count')]);
  let state = await activity.poll();
  assert.deepEqual(state.codex, { status: 'working', turnStartedAt: iso(begin), finishedAt: null });
  assert.equal(state.claude.status, 'idle');
  clock.now += 2000;
  const completed = clock.now - 100;
  write(file, [{ timestamp: iso(completed - 50), type: 'response_item', payload: { type: 'message', role: 'assistant' } }, codexEvent(completed, 'task_complete', { started_at: seconds(begin), completed_at: seconds(completed), duration_ms: completed - begin, last_agent_message: 'PRIVATE' }), { timestamp: iso(clock.now), type: 'event_msg', payload: { type: 'thread_settings_applied' } }]);
  state = await activity.poll();
  assert.deepEqual(state.codex, { status: 'done', turnStartedAt: iso(begin), finishedAt: iso(completed) });
  clock.now += 9000; assert.equal((await activity.poll()).codex.status, 'idle');
  write(file, [codexEvent(clock.now - 1000, 'task_started', { turn_id: 'turn-2', started_at: seconds(clock.now - 1000) })]);
  assert.equal((await activity.poll()).codex.status, 'working');
  clock.now += 2000; write(file, [codexEvent(clock.now, 'turn_aborted', { turn_id: 'turn-2', reason: 'interrupted' })]);
  state = await activity.poll();
  assert.deepEqual(state.codex, { status: 'idle', turnStartedAt: iso(begin), finishedAt: iso(completed) });
  assert.deepEqual(statuses(changes), ['idle/working', 'idle/done', 'idle/idle', 'idle/working', 'idle/idle']);
  assert.ok(!JSON.stringify(changes).includes('PRIVATE'));
});

test('a resumed Codex thread in an old date folder is found and its reported start is used', async t => {
  const { codex, clock, activity, write } = fixture(t);
  const begin = clock.now - 90000, completed = clock.now - 1000;
  // Only the end of a long turn is in the file tail: started_at gives the real start.
  write(path.join(codex, '2020', '01', '01', 'rollout-2020-01-01T00-00-00-old.jsonl'), [codexEvent(completed - 500, 'token_count'), codexEvent(completed, 'task_complete', { started_at: seconds(begin), completed_at: seconds(completed) })]);
  assert.deepEqual((await activity.poll()).codex, { status: 'done', turnStartedAt: iso(seconds(begin) * 1000), finishedAt: iso(completed) });
});

test('change is emitted only on status transitions; done waits until every session is finished', async t => {
  const { claude, clock, activity, changes, write } = fixture(t);
  const first = path.join(claude, 'p', 'first.jsonl'), second = path.join(claude, 'q', 'second.jsonl');
  write(first, [prompt(clock.now - 30000), toolUse(clock.now)]);
  write(second, [prompt(clock.now - 1000), toolUse(clock.now)]);
  for (let index = 0; index < 4; index++) { clock.now += 2000; write(first, [toolResult(clock.now), toolUse(clock.now)]); await activity.poll(); }
  await activity.poll(); await activity.poll();
  assert.deepEqual(statuses(changes), ['working/idle']);
  clock.now += 1000; write(second, [toolResult(clock.now), answer(clock.now)]);
  assert.equal((await activity.poll()).claude.status, 'working');
  clock.now += 1000; write(first, [toolResult(clock.now), answer(clock.now)]);
  const state = await activity.poll();
  assert.deepEqual(state.claude, { status: 'done', turnStartedAt: iso(clock.now - 40000), finishedAt: iso(clock.now) });
  activity.on('change', () => { throw new Error('listener failure'); });
  clock.now += 9000;
  assert.equal((await activity.poll()).claude.status, 'idle');
  assert.deepEqual(statuses(changes), ['working/idle', 'done/idle', 'idle/idle']);
});

test('a partial last line is ignored until it is completed', async t => {
  const { claude, clock, activity, write } = fixture(t);
  const file = write(path.join(claude, 'p', 's.jsonl'), [prompt(clock.now - 2000), toolUse(clock.now - 1000)]);
  const final = JSON.stringify(answer(clock.now - 500));
  write(file, final.slice(0, 40));
  assert.equal((await activity.poll()).claude.status, 'working');
  clock.now += 1000; write(file, final.slice(40));
  assert.equal((await activity.poll()).claude.status, 'working');
  write(file, '\n');
  assert.equal((await activity.poll()).claude.status, 'done');
});

test('only a bounded tail is read and lines larger than the tail are skipped safely', async t => {
  const { claude, clock, activity, write } = fixture(t);
  const file = path.join(claude, 'p', 'large.jsonl'), begin = clock.now - 5000;
  const filler = Array.from({ length: 300 }, () => ({ type: 'attachment', timestamp: iso(begin - 60000), attachment: { content: 'x'.repeat(1000) } }));
  write(file, [...filler, prompt(begin), toolUse(begin + 100)]);
  assert.deepEqual((await activity.poll()).claude, { status: 'working', turnStartedAt: iso(begin), finishedAt: null });
  clock.now += 2000; write(file, [toolResult(clock.now - 100, 'y'.repeat(100000)), answer(clock.now)]);
  assert.equal((await activity.poll()).claude.status, 'done');
  // A huge new prompt still being written does not change the state; the turn shows up with
  // the first record after it.
  clock.now += 9000; write(file, JSON.stringify(prompt(clock.now)).replace('PRIVATE PROMPT', 'z'.repeat(80000)));
  assert.equal((await activity.poll()).claude.status, 'idle');
  clock.now += 1000; write(file, '\n' + JSON.stringify(toolUse(clock.now)) + '\n');
  assert.deepEqual((await activity.poll()).claude, { status: 'working', turnStartedAt: iso(clock.now), finishedAt: iso(clock.now - 10000) });
});

test('poll never throws on unreadable, vanished or failing files and folders', async t => {
  const { dir, claude, clock, write } = fixture(t);
  const project = path.join(claude, 'p');
  fs.mkdirSync(path.join(project, 'folder.jsonl'), { recursive: true });
  const locked = write(path.join(project, 'locked.jsonl'), [prompt(clock.now - 1000), answer(clock.now - 500)]);
  const gone = write(path.join(project, 'gone.jsonl'), [prompt(clock.now - 1000), toolUse(clock.now)]);
  const failing = { ...fsp, open: async file => { if (file === locked) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return fsp.open(file); } };
  const activity = new AgentActivity({ claudeProjectsDir: claude, codexSessionsDir: path.join(dir, 'none'), now: () => clock.now, discoverMs: 0, fs: failing });
  t.after(() => activity.close());
  // The unreadable session is unknown (recent writes count as activity until activeMs).
  assert.equal((await activity.poll()).claude.status, 'working');
  fs.rmSync(gone);
  clock.now += 31000;
  assert.deepEqual(await activity.poll(), { claude: IDLE, codex: IDLE });
  const boom = () => { throw new Error('boom'); };
  for (const broken of [{ stat: boom, lstat: boom, readdir: boom, open: boom }, { stat: async () => boom(), lstat: async () => boom(), readdir: async () => boom(), open: async () => boom() }]) {
    const instance = new AgentActivity({ claudeProjectsDir: claude, codexSessionsDir: claude, now: () => clock.now, fs: broken });
    assert.deepEqual(await instance.poll(), { claude: IDLE, codex: IDLE });
  }
});

test('links inside the transcript folders are not followed, a linked root is', async t => {
  const { dir, claude, clock, activity, write } = fixture(t);
  const elsewhere = path.join(dir, 'elsewhere'), project = path.join(elsewhere, 'D--projetos-Linked');
  write(path.join(project, 's.jsonl'), [prompt(clock.now - 1000), toolUse(clock.now)]);
  try { fs.symlinkSync(project, path.join(claude, 'linked'), 'junction'); } catch (error) { t.skip(`links unavailable: ${error.code}`); return; }
  assert.equal((await activity.poll()).claude.status, 'idle');
  // A relocated projects folder (e.g. a junction from C: to D:) is still watched.
  const relocated = path.join(dir, 'relocated-projects');
  fs.symlinkSync(elsewhere, relocated, 'junction');
  const viaRoot = new AgentActivity({ claudeProjectsDir: relocated, codexSessionsDir: null, now: () => clock.now });
  assert.equal((await viaRoot.poll()).claude.status, 'working');
});

test('start polls immediately, then on the injected interval; close stops it', async t => {
  const { claude, clock, write } = fixture(t);
  write(path.join(claude, 'p', 's.jsonl'), [prompt(clock.now - 1000), toolUse(clock.now)]);
  const timers = [];
  const activity = new AgentActivity({ claudeProjectsDir: claude, codexSessionsDir: null, now: () => clock.now, pollMs: 1500, setInterval: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; }, clearInterval: timer => { timer.cleared = true; } });
  const changed = new Promise(resolve => activity.once('change', resolve));
  activity.start(); activity.start();
  assert.equal(timers.length, 1); assert.equal(timers[0].ms, 1500);
  assert.equal((await changed).claude.status, 'working');
  activity.close();
  assert.equal(timers[0].cleared, true);
  assert.equal((await activity.poll()).claude.status, 'working');
});
