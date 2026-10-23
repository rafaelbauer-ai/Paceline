'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { CodexProvider, normalizeRateLimits, nativeCodexBinary } = require('../src/providers/codex.cjs');
const { ClaudeProvider } = require('../src/providers/claude.cjs');
const { saveSnapshot } = require('../scripts/claude-statusline.cjs');

function fakeServer(handler) {
  const messages = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, encoding, callback) {
    const request = JSON.parse(chunk.toString()); messages.push(request);
    queueMicrotask(() => {
      const response = request.method === 'initialize' ? { result: {} } : handler(request);
      if (response) child.stdout.write(JSON.stringify({ id: request.id, ...response }) + '\n');
    });
    callback();
  } });
  child.kill = () => { child.killed = true; };
  return { child, messages };
}
function provider(server, options = {}) {
  return new CodexProvider({ spawn: () => server.child, resolveCommand: () => ({ command: 'fake', args: ['app-server'] }), ...options });
}
test('the npm Codex launcher resolves to the native binary on Windows and macOS', t => {
  const base = path.resolve(__dirname, '../.local/tests'); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'codex-layout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = path.join(root, 'lib', 'node_modules', '@openai', 'codex');
  const script = path.join(pkg, 'bin', 'codex.js');
  const touch = file => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, ''); return file; };
  touch(script);
  assert.equal(nativeCodexBinary(script, { platform: 'darwin', arch: 'arm64' }), null);
  const bundled = touch(path.join(pkg, 'vendor', 'aarch64-apple-darwin', 'codex', 'codex'));
  assert.equal(nativeCodexBinary(script, { platform: 'darwin', arch: 'arm64' }), bundled);
  // The per-platform package used by newer releases takes precedence over the bundled vendor folder.
  const platformPackage = path.join(pkg, 'node_modules', '@openai', 'codex-darwin-arm64');
  fs.mkdirSync(platformPackage, { recursive: true }); fs.writeFileSync(path.join(platformPackage, 'package.json'), '{"name":"@openai/codex-darwin-arm64"}');
  const preferred = touch(path.join(platformPackage, 'vendor', 'aarch64-apple-darwin', 'codex', 'codex'));
  assert.equal(nativeCodexBinary(script, { platform: 'darwin', arch: 'arm64' }), preferred);
  assert.equal(nativeCodexBinary(script, { platform: 'darwin', arch: 'x64' }), null, 'another architecture is never started');
  const windows = touch(path.join(pkg, 'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe'));
  assert.equal(nativeCodexBinary(script, { platform: 'win32', arch: 'x64' }), windows);
  assert.equal(nativeCodexBinary(script, { platform: 'linux', arch: 'x64' }), null);
});

test('Codex prefers all mapped buckets, preserves zero, validates missing values and dynamic windows', () => {
  const windows = normalizeRateLimits({ rateLimits: { primary: { usedPercent: 90 } }, rateLimitsByLimitId: {
    codex: { primary: { usedPercent: 0, windowDurationMins: 15, resetsAt: 100 }, secondary: { usedPercent: null } },
    review: { limitName: 'Review', primary: { usedPercent: 50, windowDurationMins: 10080 }, secondary: { usedPercent: -1 } }
  } });
  assert.equal(windows.length, 2);
  assert.equal(windows[0].usedPercent, 0);
  assert.equal(windows[0].windowMinutes, 15);
  assert.match(windows[0].label, /15min/);
  assert.equal(windows[1].resetsAt, null);
  assert.match(windows[1].label, /7d/);
  assert.deepEqual(normalizeRateLimits({ rateLimits: { primary: { usedPercent: '50' }, secondary: { usedPercent: 200 } } }), []);
});
test('Codex completes handshake then reads usage without initiating login or a model turn', async t => {
  const server = fakeServer(request => request.method === 'account/rateLimits/read' ? { result: { rateLimits: { primary: { usedPercent: 33, windowDurationMins: 300 } } } } : null);
  const client = provider(server); t.after(() => client.close());
  assert.equal(client.getState().integration.authenticated, null);
  const states = await Promise.all([client.refresh(), client.refresh()]);
  assert.equal(states[0].status, 'ready');
  assert.equal(states[0].windows[0].usedPercent, 33);
  assert.equal(states[0].integration.cliAvailable, true);
  assert.equal(states[0].integration.authenticated, true);
  assert.deepEqual(server.messages.map(message => message.method), ['initialize', 'initialized', 'account/rateLimits/read']);
  const copy = client.getState(); copy.windows[0].usedPercent = 0;
  assert.equal(client.getState().windows[0].usedPercent, 33);
});
test('Codex notifications update only the matching bucket', async t => {
  const server = fakeServer(request => request.method === 'account/rateLimits/read' ? { result: { rateLimitsByLimitId: { codex: { primary: { usedPercent: 10 } }, review: { primary: { usedPercent: 20 } } } } } : null);
  const client = provider(server); t.after(() => client.close());
  await client.refresh();
  server.child.stdout.write(JSON.stringify({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex', primary: { usedPercent: 40 } } } }) + '\n');
  assert.equal(client.getState().windows.find(window => window.id === 'codex:primary').usedPercent, 40);
  assert.equal(client.getState().windows.find(window => window.id === 'review:primary').usedPercent, 20);
});
test('Codex timeouts terminate a stalled server and apply reconnect backoff', async t => {
  const server = fakeServer(() => null);
  let starts = 0;
  const client = new CodexProvider({ spawn: () => { starts++; return server.child; }, resolveCommand: () => ({ command: 'fake', args: [] }), timeoutMs: 20 });
  t.after(() => client.close());
  await client.refresh();
  assert.equal(client.getState().status, 'error');
  assert.equal(server.child.killed, true);
  await client.refresh();
  assert.equal(starts, 1);
});
test('Codex account logout clears prior account usage and does not expose error strings', async t => {
  const server = fakeServer(request => request.method === 'account/rateLimits/read' ? { result: { rateLimits: { primary: { usedPercent: 30 } } } } : null);
  const client = provider(server); t.after(() => client.close());
  await client.refresh();
  server.child.stdout.write(JSON.stringify({ method: 'account/updated', params: { authMode: null } }) + '\n');
  assert.equal(client.getState().status, 'disconnected');
  assert.deepEqual(client.getState().windows, []);
  client.handleError({ code: 'RPC', message: 'https://secret.example/?access_token=hidden' });
  assert.ok(!JSON.stringify(client.getState()).includes('hidden'));
});
test('Codex recognizes official authentication-required errors', async t => {
  const server = fakeServer(request => request.method === 'account/rateLimits/read' ? { error: { code: -32600, message: 'codex account authentication required to read rate limits' } } : null);
  const client = provider(server); t.after(() => client.close());
  assert.equal((await client.refresh()).status, 'disconnected');
  assert.match(client.getState().message, /conta ChatGPT/);
});
test('Codex mock login opens only official HTTPS URLs and never places the URL in state', async t => {
  for (const authUrl of ['http://auth.openai.com/login', 'https://auth.openai.com.evil.example/login', 'file:///tmp/login', 'https://evil.example/login', 'https://auth.openai.com:444/login', 'https://user:password@auth.openai.com/login', 'https://auth.openai.com/login?state=secret-test-state']) {
    const server = fakeServer(request => request.method === 'account/login/start' ? { result: { authUrl } } : null);
    const client = provider(server); t.after(() => client.close());
    const opened = []; client.on('open-url', url => opened.push(url));
    await client.connect();
    const valid = authUrl === 'https://auth.openai.com/login?state=secret-test-state';
    assert.equal(opened.length, valid ? 1 : 0);
    assert.equal(client.getState().status, valid ? 'waiting' : 'error');
    assert.ok(!JSON.stringify(client.getState()).includes('secret-test-state'));
    client.close();
  }
});
test('Codex close rejects pending reads, kills only its child and clears request timers', async () => {
  const server = fakeServer(() => null);
  const client = provider(server);
  const reading = client.refresh();
  await new Promise(resolve => setImmediate(resolve));
  client.close();
  await reading;
  assert.equal(server.child.killed, true);
  assert.equal(client.pending.size, 0);
  assert.equal(client.child, null);
  assert.ok(server.messages.every(message => !['turn/start', 'account/login/start'].includes(message.method)));
});
test('Codex logout invalidates in-flight responses and subsequent stale notifications', async () => {
  const client = new CodexProvider();
  client.start = async () => {};
  let resolveRead;
  client.request = () => new Promise(resolve => { resolveRead = resolve; });
  const reading = client.refresh();
  await Promise.resolve();
  client.receive({ method: 'account/updated', params: { authMode: null } });
  resolveRead({ rateLimits: { primary: { usedPercent: 80 } } });
  await reading;
  client.receive({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 90 } } } });
  assert.equal(client.getState().status, 'disconnected');
  assert.deepEqual(client.getState().windows, []);
  assert.equal(client.getState().updatedAt, null);
  client.close();
});
test('Codex account switch discards the old request and schedules a fresh account read', async () => {
  const client = new CodexProvider();
  client.start = async () => {};
  let resolveOld;
  let reads = 0;
  client.request = () => ++reads === 1 ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve({ rateLimits: { primary: { usedPercent: 10 } } });
  const reading = client.refresh();
  await Promise.resolve();
  client.receive({ method: 'account/updated', params: { authMode: 'chatgpt' } });
  resolveOld({ rateLimits: { primary: { usedPercent: 90 } } });
  await reading;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 2);
  assert.equal(client.getState().windows[0].usedPercent, 10);
  client.close();
});
test('Claude reads only allowlisted metrics and retains the observation timestamp', async t => {
  const root = path.resolve(__dirname, '../.local/tests'); fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'provider-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const client = new ClaudeProvider({ dataDir: directory, usageApi: { poll: async () => ({ reason: null }) } });
  assert.equal((await client.refresh()).status, 'waiting');
  const observed = Date.now() - 60000;
  saveSnapshot({ transcript_path: 'sensitive', rate_limits: { five_hour: { used_percentage: 22, resets_at: Date.now() / 1000 + 100 } } }, directory, () => observed);
  const state = await client.refresh();
  assert.equal(state.windows[0].usedPercent, 22);
  assert.equal(state.updatedAt, new Date(observed).toISOString());
  assert.ok(!JSON.stringify(state).includes('sensitive'));
  assert.equal((await client.refresh()).updatedAt, state.updatedAt);
});
