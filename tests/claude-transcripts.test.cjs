'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ClaudeTranscriptScanner } = require('../src/main/claude-transcripts.cjs');
const { projectMetadata } = require('../scripts/claude-statusline.cjs');
function fixture(t) {
  const root = path.resolve(__dirname, '../.local/tests'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'claude-transcripts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const projectsDir = path.join(dir, 'projects'), project = path.join(projectsDir, 'D--projetos-Example');
  fs.mkdirSync(project, { recursive: true });
  return { dir, project, options: { dataDir: path.join(dir, 'data'), projectsDir } };
}
const CWD = 'D:\\projetos\\Example';
// One assistant line; Claude Code writes one per content block, repeating the same usage.
const reply = ({ id = 'msg_1', request = 'req_1', session = 'session-a', cwd = CWD, at = new Date().toISOString(), input = 10, output = 5, write = 20, read = 30, block = 'text', sidechain = false } = {}) => JSON.stringify({ parentUuid: null, isSidechain: sidechain, type: 'assistant', sessionId: session, cwd, timestamp: at, requestId: request, message: { id, model: 'claude-test', role: 'assistant', content: [{ type: block, text: 'NEVER-PERSIST-PROMPT' }], usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: write, cache_read_input_tokens: read, service_tier: 'standard' } } }) + '\n';
const prompt = (session = 'session-a') => JSON.stringify({ type: 'user', sessionId: session, cwd: CWD, timestamp: new Date().toISOString(), message: { role: 'user', content: 'NEVER-PERSIST-PROMPT with "usage" and "assistant" quoted' } }) + '\n';
const blocks = options => ['thinking', 'text', 'tool_use'].map(block => reply({ ...options, block })).join('');
const total = sessions => sessions.reduce((sum, item) => sum + item.totalTokens, 0);
async function drain(scanner, options) {
  let result, rounds = 0;
  do { result = await scanner.scan(options); rounds += 1; } while (!result.done && rounds < 500);
  return { result, rounds };
}
test('repeated content blocks count once, totals follow the shared session schema and nothing private is persisted', async t => {
  const { project, options } = fixture(t);
  fs.writeFileSync(path.join(project, 'session-a.jsonl'), prompt() + blocks({ id: 'msg_1' }) + prompt() + blocks({ id: 'msg_2', request: 'req_2', input: 1, output: 100, write: 0, read: 900 }));
  const scanner = new ClaudeTranscriptScanner(options);
  const result = await scanner.scan();
  assert.equal(result.done, true); assert.equal(result.pendingBytes, 0); assert.ok(result.readBytes > 0);
  assert.equal(result.sessions.length, 1);
  const [session] = result.sessions, { projectId, projectName } = projectMetadata(CWD);
  assert.deepEqual(session, { id: `claude:${createHash('sha256').update(`session-a\0${projectId}`).digest('hex')}`, provider: 'claude', projectId, projectName, inputTokens: 60 + 901, outputTokens: 105, cachedTokens: 930, totalTokens: 1066, lastActivity: session.lastActivity, measurement: 'transcript', partial: false });
  assert.equal(projectName, 'Example');
  assert.ok(Number.isFinite(Date.parse(session.lastActivity)));
  assert.deepEqual(scanner.getSessions(), result.sessions);
  const saved = fs.readFileSync(path.join(options.dataDir, 'claude-transcripts.json'), 'utf8');
  for (const secret of ['NEVER-PERSIST-PROMPT', 'session-a', 'msg_1', 'req_1', 'projetos', 'D--projetos', 'jsonl']) assert.ok(!saved.includes(secret), secret);
});
test('invalid usage, cwd, session id and timestamps are skipped', async t => {
  const { project, options } = fixture(t);
  const future = new Date(Date.now() + 5 * 60000).toISOString();
  fs.writeFileSync(path.join(project, 'invalid.jsonl'), [
    reply({ id: 'neg', input: -1 }), reply({ id: 'float', output: 1.5 }), reply({ id: 'text', read: '30' }),
    reply({ id: 'relative', cwd: 'projetos/Example' }), reply({ id: 'nocwd', cwd: null }), reply({ id: 'nosession', session: '' }),
    reply({ id: 'future', at: future }), reply({ id: 'bad-date', at: 'yesterday' }), '{"type":"assistant","usage":', reply({ id: 'valid' }),
  ].join('\n'));
  const result = await new ClaudeTranscriptScanner(options).scan();
  assert.equal(result.sessions.length, 1); assert.equal(total(result.sessions), 65);
});
test('a cwd below the launch folder stays in that project and an unrelated cwd keeps its own', async t => {
  const { project, options } = fixture(t);
  fs.writeFileSync(path.join(project, 'session-a.jsonl'), reply({ id: 'root' }) + reply({ id: 'sub', request: 'req_2', cwd: 'd:\\projetos\\Example\\src\\main' }) + reply({ id: 'tree', request: 'req_3', cwd: 'D:\\projetos\\Example\\.claude\\worktrees\\fix' }) + reply({ id: 'other', request: 'req_4', cwd: 'E:\\elsewhere\\tool' }));
  const result = await new ClaudeTranscriptScanner(options).scan();
  assert.deepEqual(result.sessions.map(item => [item.projectName, item.totalTokens, item.projectId]).sort(), [['Example', 195, projectMetadata(CWD).projectId], ['tool', 65, projectMetadata('E:\\elsewhere\\tool').projectId]]);
});
test('a response copied into another transcript is counted once and subagents merge into the parent session', async t => {
  const { project, options } = fixture(t);
  fs.writeFileSync(path.join(project, 'session-a.jsonl'), blocks({ id: 'msg_1' }));
  const agents = path.join(project, 'session-a', 'subagents'), workflow = path.join(agents, 'workflows', 'wf-1');
  fs.mkdirSync(workflow, { recursive: true });
  fs.writeFileSync(path.join(agents, 'agent-1.jsonl'), blocks({ id: 'msg_sub1', request: 'req_s1', sidechain: true }));
  fs.writeFileSync(path.join(workflow, 'agent-2.jsonl'), reply({ id: 'msg_sub2', request: 'req_s2', sidechain: true }));
  fs.writeFileSync(path.join(agents, 'journal.jsonl'), reply({ id: 'journal-only', request: 'journal' }));
  fs.writeFileSync(path.join(agents, 'notes.json'), reply({ id: 'not-jsonl', request: 'json' }));
  const scanner = new ClaudeTranscriptScanner(options);
  let result = await scanner.scan();
  const parentId = `claude:${createHash('sha256').update(`session-a\0${projectMetadata(CWD).projectId}`).digest('hex')}`;
  assert.equal(result.done, true);
  assert.deepEqual(result.sessions.map(item => [item.id, item.totalTokens]), [[parentId, 3 * 65]]);
  // A fork/resume later copies earlier responses into a new file with a new session id.
  fs.writeFileSync(path.join(project, 'session-b.jsonl'), blocks({ id: 'msg_1', session: 'session-b' }) + reply({ id: 'msg_3', request: 'req_3', session: 'session-b' }));
  result = await scanner.scan();
  assert.equal(result.sessions.length, 2);
  assert.equal(result.sessions.find(item => item.id === parentId).totalTokens, 3 * 65);
  assert.equal(total(result.sessions), 4 * 65);
});
test('appends are read incrementally and a partial trailing line waits until it is complete', async t => {
  const { project, options } = fixture(t);
  const file = path.join(project, 'live.jsonl');
  fs.writeFileSync(file, blocks({ id: 'msg_1' }));
  const scanner = new ClaudeTranscriptScanner(options);
  assert.equal(total((await scanner.scan()).sessions), 65);
  const unchanged = await scanner.scan();
  assert.equal(unchanged.readBytes, 0); assert.equal(unchanged.done, true);
  const second = reply({ id: 'msg_2', request: 'req_2' }), third = reply({ id: 'msg_3', request: 'req_3' });
  fs.appendFileSync(file, second + third.slice(0, 40));
  let result = await scanner.scan();
  assert.equal(result.readBytes, Buffer.byteLength(second) + 40);
  assert.equal(total(result.sessions), 130); assert.equal(result.done, true); assert.equal(result.pendingBytes, 0);
  assert.equal((await scanner.scan()).readBytes, 0);
  fs.appendFileSync(file, third.slice(40));
  result = await scanner.scan();
  assert.equal(result.readBytes, Buffer.byteLength(third));
  assert.equal(total(result.sessions), 195);
});
test('byte and file budgets leave a backlog that later scans finish without recounting', async t => {
  const { project, options } = fixture(t);
  let expected = 0;
  for (let file = 0; file < 4; file++) {
    let body = '';
    for (let index = 0; index < 20; index++) { body += prompt() + blocks({ id: `msg_${file}_${index}`, request: `req_${file}_${index}`, session: `session-${file}` }); expected += 65; }
    fs.writeFileSync(path.join(project, `session-${file}.jsonl`), body);
  }
  const scanner = new ClaudeTranscriptScanner(options);
  const first = await scanner.scan({ maxBytes: 4096 });
  assert.equal(first.done, false); assert.ok(first.pendingBytes > 0); assert.ok(first.readBytes > 0 && first.readBytes <= 4096);
  const { result, rounds } = await drain(scanner, { maxBytes: 4096 });
  assert.ok(rounds > 3); assert.equal(result.pendingBytes, 0);
  assert.equal(total(result.sessions), expected); assert.equal(result.sessions.length, 4);
  const fresh = new ClaudeTranscriptScanner({ ...options, dataDir: path.join(options.dataDir, 'files') });
  const limited = await fresh.scan({ maxFiles: 1 });
  assert.equal(limited.done, false); assert.equal(limited.sessions.length, 1);
  assert.equal(total((await drain(fresh, { maxFiles: 1 })).result.sessions), expected);
});
test('lines over 1 MB are skipped without stalling a small budget', async t => {
  const { project, options } = fixture(t);
  const huge = reply({ id: 'huge', request: 'huge' }).replace('NEVER-PERSIST-PROMPT', 'x'.repeat(1100 * 1024));
  fs.writeFileSync(path.join(project, 'large.jsonl'), reply({ id: 'before' }) + huge + reply({ id: 'after' }));
  const scanner = new ClaudeTranscriptScanner(options);
  const { result, rounds } = await drain(scanner, { maxBytes: 4096 });
  assert.ok(rounds > 1);
  assert.equal(total(result.sessions), 130);
});
test('truncated or replaced transcripts are rescanned without double counting', async t => {
  const { project, options } = fixture(t);
  const file = path.join(project, 'session-a.jsonl');
  fs.writeFileSync(file, blocks({ id: 'msg_1' }) + blocks({ id: 'msg_2', request: 'req_2' }));
  const scanner = new ClaudeTranscriptScanner(options);
  assert.equal(total((await scanner.scan()).sessions), 130);
  fs.writeFileSync(file, reply({ id: 'msg_1' }) + reply({ id: 'msg_3', request: 'req_3' }));
  assert.equal(total((await scanner.scan()).sessions), 195);
  // Replace via rename: a new file identity with the old responses plus a new one, larger than before.
  const temporary = path.join(project, 'replacement.tmp');
  fs.writeFileSync(temporary, blocks({ id: 'msg_1' }) + blocks({ id: 'msg_2', request: 'req_2' }) + blocks({ id: 'msg_3', request: 'req_3' }) + reply({ id: 'msg_4', request: 'req_4' }));
  fs.renameSync(temporary, file);
  const result = await scanner.scan();
  assert.equal(result.done, true); assert.equal(total(result.sessions), 260);
});
test('retention drops old responses, sessions and dedupe entries', async t => {
  const { project, options } = fixture(t);
  let now = Date.now();
  fs.writeFileSync(path.join(project, 'old.jsonl'), reply({ id: 'old', at: new Date(now - 31 * 86400000).toISOString() }) + reply({ id: 'recent', request: 'req_r', at: new Date(now - 86400000).toISOString() }));
  const scanner = new ClaudeTranscriptScanner({ ...options, now: () => now });
  assert.equal(total((await scanner.scan()).sessions), 65);
  const file = path.join(options.dataDir, 'claude-transcripts.json');
  assert.equal(Object.values(JSON.parse(fs.readFileSync(file, 'utf8')).seen).join('').length, 16);
  now += 31 * 86400000;
  assert.deepEqual(scanner.getSessions(), []);
  const result = await scanner.scan();
  assert.deepEqual(result.sessions, []); assert.equal(result.done, true);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved.sessions, []); assert.deepEqual(saved.seen, {}); assert.deepEqual(saved.cursors, {});
  assert.deepEqual(new ClaudeTranscriptScanner({ ...options, now: () => now }).getSessions(), []);
});
test('persisted state survives a restart and an invalid state starts fresh without throwing', async t => {
  const { project, options } = fixture(t);
  const file = path.join(project, 'session-a.jsonl');
  fs.writeFileSync(file, blocks({ id: 'msg_1' }));
  const before = (await new ClaudeTranscriptScanner(options).scan()).sessions;
  const restarted = new ClaudeTranscriptScanner(options);
  assert.deepEqual(restarted.getSessions(), before);
  const again = await restarted.scan();
  assert.equal(again.readBytes, 0); assert.deepEqual(again.sessions, before);
  fs.appendFileSync(file, reply({ id: 'msg_2', request: 'req_2' }));
  assert.equal(total((await new ClaudeTranscriptScanner(options).scan()).sessions), 130);
  const state = path.join(options.dataDir, 'claude-transcripts.json');
  for (const body of ['{ invalid', JSON.stringify({ version: 2, sessions: [], cursors: {}, seen: {} }), JSON.stringify({ version: 1, sessions: {}, cursors: [], seen: null })]) {
    fs.writeFileSync(state, body);
    let scanner;
    assert.doesNotThrow(() => { scanner = new ClaudeTranscriptScanner(options); });
    assert.deepEqual(scanner.getSessions(), []);
    assert.equal(total((await scanner.scan()).sessions), 130);
    assert.equal(JSON.parse(fs.readFileSync(state, 'utf8')).version, 1);
  }
});
test('a symlinked state file is neither read nor overwritten', async t => {
  const { dir, project, options } = fixture(t);
  fs.writeFileSync(path.join(project, 'session-a.jsonl'), blocks({ id: 'msg_1' }));
  const outside = path.join(dir, 'outside.json');
  const seeded = new ClaudeTranscriptScanner({ ...options, dataDir: path.join(dir, 'seed') });
  await seeded.scan();
  fs.copyFileSync(path.join(dir, 'seed', 'claude-transcripts.json'), outside);
  const original = fs.readFileSync(outside, 'utf8');
  fs.mkdirSync(options.dataDir, { recursive: true });
  const link = path.join(options.dataDir, 'claude-transcripts.json');
  try { fs.symlinkSync(outside, link, 'file'); } catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Host does not permit symlinks'); throw error; }
  const scanner = new ClaudeTranscriptScanner(options);
  assert.deepEqual(scanner.getSessions(), []);
  const result = await scanner.scan();
  assert.equal(total(result.sessions), 65);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readFileSync(outside, 'utf8'), original);
});
test('symlinked or junctioned transcripts and folders are skipped', async t => {
  const { dir, options } = fixture(t);
  const outside = path.join(dir, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'hidden.jsonl'), reply({ id: 'hidden' }));
  // Junctions need no privilege on Windows; elsewhere this is a directory symlink.
  fs.symlinkSync(outside, path.join(options.projectsDir, 'linked-project'), process.platform === 'win32' ? 'junction' : 'dir');
  try { fs.symlinkSync(path.join(outside, 'hidden.jsonl'), path.join(options.projectsDir, 'D--projetos-Example', 'linked.jsonl'), 'file'); } catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; }
  const result = await new ClaudeTranscriptScanner(options).scan();
  assert.deepEqual(result.sessions, []); assert.equal(result.done, true);
});

test('a transcript that cannot be read is set aside instead of holding the backlog open forever', async t => {
  const { project, options } = fixture(t);
  fs.writeFileSync(path.join(project, 'locked.jsonl'), blocks({ id: 'msg_locked' }));
  let now = Date.now();
  const scanner = new ClaudeTranscriptScanner({ ...options, now: () => now });
  scanner.read = async () => { throw Object.assign(new Error('locked'), { code: 'EBUSY' }); };
  assert.equal((await scanner.scan()).done, true);
  // Ten minutes later it is tried again, and read once it opens.
  delete scanner.read; now += 11 * 60000;
  const result = await scanner.scan();
  assert.equal(result.done, true); assert.equal(result.sessions.length, 1);
});
