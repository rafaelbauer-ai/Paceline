'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LocalUsageCollector } = require('../src/main/local-usage.cjs');
function fixture(t) {
  const root = path.resolve(__dirname, '../.local/tests'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'local-usage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source'); fs.mkdirSync(source);
  const claudeProjectsDir = path.join(dir, 'claude-projects'); fs.mkdirSync(claudeProjectsDir);
  return { dir, source, dataDir: path.join(dir, 'data'), claudeProjectsDir };
}
const line = data => JSON.stringify(data) + '\n';
const meta = (id, timestamp, cwd = 'D:/projetos/Example') => ({ type: 'session_meta', timestamp, payload: { id, timestamp, cwd, base_instructions: 'NEVER-PERSIST-PROMPT' } });
const usage = (timestamp, input, output, cached = 0) => ({ type: 'event_msg', timestamp, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cached, reasoning_output_tokens: 50, total_tokens: input + output } } } });
test('incremental Codex scans deduplicate cumulative events, duplicate session files and persisted restarts', async t => {
  const options = fixture(t), now = Date.now();
  const at = new Date(now - 10000).toISOString();
  const file = path.join(options.source, 'a.jsonl');
  const source = line(meta('private-id', at)) + line({ type: 'response_item', payload: { text: 'NEVER-PERSIST-PROMPT' } }) + line(usage(at, 100, 20, 60)) + line(usage(at, 100, 20, 60));
  fs.writeFileSync(file, source); fs.writeFileSync(path.join(options.source, 'copy.jsonl'), source);
  let collector = new LocalUsageCollector({ ...options, codexRoots: [options.source] });
  let result = await collector.refresh();
  assert.equal(result.sessions.length, 1); assert.equal(result.projects[0].totalTokens, 120); assert.equal(result.projects[0].cachedTokens, 60);
  collector = new LocalUsageCollector({ ...options, codexRoots: [options.source] });
  fs.appendFileSync(file, line(usage(new Date(now).toISOString(), 200, 40, 120)));
  result = await collector.refresh();
  assert.equal(result.projects[0].totalTokens, 240);
  const saved = fs.readFileSync(path.join(options.dataDir, 'local-usage.json'), 'utf8');
  assert.ok(!saved.includes('NEVER-PERSIST-PROMPT')); assert.ok(!saved.includes('private-id')); assert.ok(!saved.includes('D:/projetos'));
});
test('incomplete lines, truncation and inherited fork baselines do not duplicate usage', async t => {
  const options = fixture(t), now = Date.now();
  const start = new Date(now - 1000).toISOString(), earlier = new Date(now - 10000).toISOString(), at = new Date(now).toISOString();
  const file = path.join(options.source, 'fork.jsonl');
  fs.writeFileSync(file, line(meta('fork', start)) + line(usage(earlier, 100, 20, 50)) + JSON.stringify(usage(at, 160, 30, 80)));
  const collector = new LocalUsageCollector({ ...options, codexRoots: [options.source] });
  assert.equal((await collector.refresh()).sessions.length, 0);
  fs.appendFileSync(file, '\n');
  let result = await collector.refresh();
  assert.equal(result.sessions[0].totalTokens, 70); assert.equal(result.sessions[0].cachedTokens, 30);
  fs.writeFileSync(file, line(meta('fork', start)) + line(usage(earlier, 100, 20, 50)) + line(usage(at, 170, 40, 90)));
  result = await collector.refresh();
  assert.equal(result.sessions[0].totalTokens, 90);
});
test('Codex sibling threads sharing a desktop session are counted separately by rollout id', async t => {
  const options = fixture(t), at = new Date().toISOString();
  for (const id of ['child-a', 'child-b']) {
    const metadata = meta(id, at); metadata.payload.session_id = 'shared-parent-session';
    fs.writeFileSync(path.join(options.source, `${id}.jsonl`), line(metadata) + line(usage(at, 100, 20)));
  }
  const collector = new LocalUsageCollector({ ...options, codexRoots: [options.source] });
  const summary = await collector.refresh();
  assert.equal(summary.sessions.length, 2); assert.equal(summary.projects[0].totalTokens, 240);
});
test('an old session folder with recent activity is scanned and retained', async t => {
  const options = fixture(t), now = Date.now();
  const folder = path.join(options.source, '2020', '01', '01'); fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'resumed.jsonl'), line(meta('resumed', new Date(now - 1000).toISOString())) + line(usage(new Date(now).toISOString(), 100, 20)));
  const collector = new LocalUsageCollector({ ...options, codexRoots: [options.source] });
  assert.equal((await collector.refresh()).sessions[0].totalTokens, 120);
});
test('bounded scans progress beyond huge conversation lines and preserve previous totals on source failure', async t => {
  const options = fixture(t), at = new Date().toISOString();
  const file = path.join(options.source, 'large.jsonl');
  fs.writeFileSync(file, line(meta('large', at)) + line({ type: 'response_item', payload: { text: 'x'.repeat(20000) } }) + line(usage(at, 200, 50, 100)));
  const collector = new LocalUsageCollector({ ...options, codexRoots: [options.source], maxBytesPerRefresh: 4096 });
  let result;
  for (let i = 0; i < 10; i++) result = await collector.refresh();
  assert.equal(result.sessions[0].totalTokens, 250);
  // The oversized line is conversation content; skipping it loses no counter record.
  assert.equal(result.status, 'ready');
  fs.unlinkSync(file);
  result = await collector.refresh(); assert.equal(result.sessions[0].totalTokens, 250);
});
test('Claude transcripts join Codex sessions in the summary, each message counted once', async t => {
  const options = fixture(t), at = new Date().toISOString();
  fs.writeFileSync(path.join(options.source, 'codex.jsonl'), line(meta('codex-session', at)) + line(usage(at, 100, 20, 60)));
  const project = path.join(options.claudeProjectsDir, 'D--projetos-Example'); fs.mkdirSync(project);
  const reply = { type: 'assistant', sessionId: 'claude-session', cwd: 'D:\\projetos\\Example', timestamp: at, requestId: 'req_1', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'NEVER-PERSIST-PROMPT' }], usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 } } };
  // The same message is written once per content block; it still counts once.
  fs.writeFileSync(path.join(project, 'claude-session.jsonl'), line(reply) + line(reply));
  const collector = new LocalUsageCollector({ ...options, codexRoots: [options.source] });
  const result = await collector.refresh();
  const claude = result.sessions.find(item => item.provider === 'claude');
  assert.equal(claude.inputTokens, 60); assert.equal(claude.cachedTokens, 30); assert.equal(claude.totalTokens, 65); assert.equal(claude.partial, false);
  assert.equal(result.projects.length, 1); assert.deepEqual(result.projects[0].providers.sort(), ['claude', 'codex']);
  assert.equal(result.status, 'ready');
  const saved = fs.readdirSync(options.dataDir).map(name => fs.readFileSync(path.join(options.dataDir, name), 'utf8')).join('\n');
  assert.ok(!saved.includes('NEVER-PERSIST-PROMPT')); assert.ok(!saved.includes('claude-session'));
});
test('Claude entries saved by the old status-line counter are dropped in favour of transcripts', async t => {
  const options = fixture(t); fs.mkdirSync(options.dataDir);
  const old = { id: `claude:${'a'.repeat(64)}`, provider: 'claude', projectId: 'b'.repeat(64), projectName: 'Example', inputTokens: 5, outputTokens: 5, cachedTokens: 0, totalTokens: 10, lastActivity: new Date().toISOString(), measurement: 'observed_responses', partial: true };
  fs.writeFileSync(path.join(options.dataDir, 'local-usage.json'), JSON.stringify({ version: 1, sessions: [old], cursors: {} }));
  const collector = new LocalUsageCollector({ ...options, codexRoots: [options.source] });
  assert.equal(collector.getSummary().sessions.length, 0);
});
test('symlinked source logs are skipped', async t => {
  const options = fixture(t), at = new Date().toISOString();
  const target = path.join(options.dir, 'outside.jsonl');
  fs.writeFileSync(target, line(meta('hidden', at)) + line(usage(at, 100, 20)));
  try { fs.symlinkSync(target, path.join(options.source, 'linked.jsonl')); } catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Host does not permit symlinks'); throw error; }
  const collector = new LocalUsageCollector({ ...options, codexRoots: [options.source] });
  assert.equal((await collector.refresh()).sessions.length, 0);
});
test('folderless conversations are grouped, and a Codex chat named after a project joins that project', async t => {
  const options = fixture(t), at = new Date().toISOString();
  fs.writeFileSync(path.join(options.source, 'a.jsonl'), line(meta('on-project', at, 'C:/Users/me/Documents/Codex/2026-10-22/d-projetos-example')) + line(usage(at, 100, 10)));
  fs.writeFileSync(path.join(options.source, 'b.jsonl'), line(meta('loose-chat', at, 'C:/Users/me/Documents/Codex/2026-10-22/new-chat')) + line(usage(at, 50, 5)));
  const reply = (folder, cwd, id) => ({ type: 'assistant', sessionId: id, cwd, timestamp: at, requestId: `req_${id}`, message: { id: `msg_${id}`, role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
  const write = (folder, cwd, id) => { const dir = path.join(options.claudeProjectsDir, folder); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `${id}.jsonl`), line(reply(folder, cwd, id))); };
  write('D--projetos-Example', 'D:/projetos/Example', 'project-session');
  write('C--scratch-scratch-2026-10-22-79d326', 'C:/scratch/scratch-2026-10-22-79d326', 'scratch-session');
  const collector = new LocalUsageCollector({ ...options, codexRoots: [options.source] });
  const result = await collector.refresh();
  const names = Object.fromEntries(result.projects.map(project => [project.name, project.providers.sort().join('+')]));
  assert.deepEqual(names, { Example: 'claude+codex', 'Conversas avulsas do Codex': 'codex', 'Conversas sem pasta do Claude': 'claude' });
});

test('more than 200 Codex logs still finish the backlog, and the one-time limit backfill is recorded', async t => {
  const options = fixture(t), at = new Date().toISOString();
  for (let index = 0; index < 205; index++) fs.writeFileSync(path.join(options.source, `${index}.jsonl`), line(meta(`session-${index}`, at)) + line(usage(at, 10, 1)));
  const collector = new LocalUsageCollector({ ...options, codexRoots: [options.source] });
  let rounds = 0;
  do { await collector.refresh(); rounds += 1; } while (collector.backlog && rounds < 10);
  assert.equal(collector.backlog, false); assert.ok(rounds <= 3);
  assert.equal(collector.getSummary().sessions.length, 205);
  assert.equal(JSON.parse(fs.readFileSync(path.join(options.dataDir, 'local-usage.json'), 'utf8')).rateBackfill, true);
  await collector.refresh(); assert.equal(collector.backlog, false);
});
test('a Codex chat goes to the longest project name it ends with', async t => {
  const options = fixture(t), at = new Date().toISOString();
  const write = (file, id, cwd) => fs.writeFileSync(path.join(options.source, file), line(meta(id, at, cwd)) + line(usage(at, 10, 1)));
  write('vault.jsonl', 'vault', 'D:/projetos/vault');
  write('token-vault.jsonl', 'token-vault', 'D:/projetos/TOKEN-VAULT');
  write('chat.jsonl', 'chat', 'C:/Users/me/Documents/Codex/2026-10-22/d-projetos-token-vault');
  const collector = new LocalUsageCollector({ ...options, codexRoots: [options.source] });
  const projects = (await collector.refresh()).projects;
  assert.equal(projects.find(project => project.name === 'TOKEN-VAULT').sessionCount, 2);
  assert.equal(projects.find(project => project.name === 'vault').sessionCount, 1);
});
