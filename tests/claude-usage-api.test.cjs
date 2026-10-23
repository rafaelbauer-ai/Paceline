'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ClaudeUsageApi, readKeychainLogin, toRateLimits, retryAfterMs, REQUEST_INTERVAL_MS } = require('../src/providers/claude-usage-api.cjs');
const { ClaudeProvider } = require('../src/providers/claude.cjs');

const TOKEN = 'fixture-token-never-stored';
function fixture(t, { expiresAt = Date.now() + 3600000, token = TOKEN } = {}) {
  const root = path.resolve(__dirname, '../.local/tests'); fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'claude-api-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, '.credentials.json');
  const writeLogin = (value, expiry) => fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: value, refreshToken: 'fixture-refresh', expiresAt: expiry } }));
  if (token) writeLogin(token, expiresAt);
  return { dataDir: path.join(directory, 'data'), file, writeLogin };
}
function usageBody(fiveHour = 12.5, sevenDay = 40) {
  return JSON.stringify({ five_hour: { utilization: fiveHour, resets_at: '2099-01-01T05:00:00.123456+00:00' }, seven_day: { utilization: sevenDay, resets_at: '2099-01-05T00:00:00+00:00' }, seven_day_opus: null, account: 'private' });
}
function fakeFetch(responses) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, authorization: options.headers.Authorization, beta: options.headers['anthropic-beta'], redirect: options.redirect });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (next instanceof Error) throw next;
    return { status: next.status, ok: next.status >= 200 && next.status < 300, headers: { get: name => (next.headers || {})[name.toLowerCase()] ?? null }, text: async () => next.body ?? '' };
  };
  return { fetch, calls };
}
function storedText(dataDir) {
  return fs.readdirSync(dataDir).map(name => fs.readFileSync(path.join(dataDir, name), 'utf8')).join('\n');
}

test('usage response becomes an allowlisted snapshot and the token is never stored', async t => {
  const { dataDir, file } = fixture(t);
  let clock = Date.parse('2026-10-22T12:00:00Z');
  const { fetch, calls } = fakeFetch([{ status: 200, body: usageBody() }]);
  const api = new ClaudeUsageApi({ dataDir, file, fetch, now: () => clock, renew: async () => assert.fail('valid tokens are not renewed') });
  assert.deepEqual(await api.poll(), { reason: null });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(calls[0].authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].beta, 'oauth-2025-04-20');
  assert.equal(calls[0].redirect, 'error', 'the token must never follow a redirect');
  const snapshot = JSON.parse(fs.readFileSync(path.join(dataDir, 'claude-usage.json'), 'utf8'));
  assert.equal(snapshot.source, 'api');
  assert.deepEqual(snapshot.rate_limits.five_hour, { used_percentage: 12.5, resets_at: Date.parse('2099-01-01T05:00:00Z') / 1000 });
  assert.equal(snapshot.updatedAt, new Date(clock).toISOString());
  const stored = storedText(dataDir);
  assert.ok(!stored.includes(TOKEN) && !stored.includes('fixture-refresh') && !stored.includes('private'));

  // Within the interval the account is not queried again.
  clock += 60000;
  assert.deepEqual(await api.poll(), { reason: null });
  assert.equal(calls.length, 1);
  // An unchanged reading after the interval still renews the freshness timestamp.
  clock += REQUEST_INTERVAL_MS;
  await api.poll();
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'claude-usage.json'), 'utf8')).updatedAt, new Date(clock).toISOString());
});

test('Retry-After is honoured and survives a restart', async t => {
  const { dataDir, file } = fixture(t);
  const clock = Date.parse('2026-10-22T12:00:00Z');
  const first = fakeFetch([{ status: 429, headers: { 'retry-after': '900' } }]);
  const api = new ClaudeUsageApi({ dataDir, file, fetch: first.fetch, now: () => clock });
  assert.deepEqual(await api.poll(), { reason: 'RATE_LIMITED' });
  const second = fakeFetch([{ status: 200, body: usageBody() }]);
  const restarted = new ClaudeUsageApi({ dataDir, file, fetch: second.fetch, now: () => clock + 600000 });
  assert.deepEqual(await restarted.poll(), { reason: 'RATE_LIMITED' });
  assert.equal(second.calls.length, 0);
  const later = new ClaudeUsageApi({ dataDir, file, fetch: second.fetch, now: () => clock + 900000 });
  assert.deepEqual(await later.poll(), { reason: null });
  assert.equal(second.calls.length, 1);
});

test('an expired token is never sent; the official CLI renewal is used instead', async t => {
  const now = Date.parse('2026-10-22T12:00:00Z');
  const renewed = fixture(t, { expiresAt: now - 1000 });
  const ok = fakeFetch([{ status: 200, body: usageBody() }]);
  let renewals = 0;
  const api = new ClaudeUsageApi({ ...renewed, fetch: ok.fetch, now: () => now, renew: async () => { renewals += 1; renewed.writeLogin('renewed-token', now + 3600000); } });
  assert.deepEqual(await api.poll(), { reason: null });
  assert.equal(renewals, 1);
  assert.equal(ok.calls[0].authorization, 'Bearer renewed-token');

  const stale = fixture(t, { expiresAt: now - 1000 });
  const never = fakeFetch([{ status: 200, body: usageBody() }]);
  let attempts = 0;
  let clock = now;
  const blocked = new ClaudeUsageApi({ ...stale, fetch: never.fetch, now: () => clock, renew: async () => { attempts += 1; } });
  assert.deepEqual(await blocked.poll(), { reason: 'EXPIRED' });
  clock += 60000;
  assert.deepEqual(await blocked.poll(), { reason: 'EXPIRED' });
  assert.equal(never.calls.length, 0);
  assert.equal(attempts, 1, 'renewal is rate limited');
});

test('missing login, rejected login and network failures are reported without data', async t => {
  const missing = fixture(t, { token: null });
  const none = fakeFetch([{ status: 200, body: usageBody() }]);
  assert.deepEqual(await new ClaudeUsageApi({ ...missing, fetch: none.fetch }).poll(), { reason: 'NO_LOGIN' });
  assert.equal(none.calls.length, 0);

  const rejected = fixture(t);
  assert.deepEqual(await new ClaudeUsageApi({ ...rejected, fetch: fakeFetch([{ status: 401 }]).fetch }).poll(), { reason: 'AUTH' });
  const offline = fixture(t);
  assert.deepEqual(await new ClaudeUsageApi({ ...offline, fetch: fakeFetch([new Error('offline')]).fetch }).poll(), { reason: 'NETWORK' });
  const odd = fixture(t);
  assert.deepEqual(await new ClaudeUsageApi({ ...odd, fetch: fakeFetch([{ status: 200, body: '{"five_hour":null}' }]).fetch }).poll(), { reason: 'FORMAT' });
  assert.ok(!fs.existsSync(path.join(odd.dataDir, 'claude-usage.json')));
});

test('on macOS the Keychain login is read when the credentials file is absent', async t => {
  const missing = fixture(t, { token: null });
  const { fetch, calls } = fakeFetch([{ status: 200, body: usageBody() }]);
  const api = new ClaudeUsageApi({ ...missing, fetch, keychain: async () => ({ token: 'keychain-token', expiresAt: Date.now() + 3600000 }) });
  assert.deepEqual(await api.poll(), { reason: null });
  assert.equal(calls[0].authorization, 'Bearer keychain-token');
  assert.ok(!storedText(missing.dataDir).includes('keychain-token'));

  const present = fixture(t);
  const second = fakeFetch([{ status: 200, body: usageBody() }]);
  await new ClaudeUsageApi({ ...present, fetch: second.fetch, keychain: async () => assert.fail('the file takes precedence') }).poll();
  assert.equal(second.calls[0].authorization, `Bearer ${TOKEN}`);

  const runs = [];
  const run = (command, args, _options, callback) => { runs.push({ command, args }); callback(null, JSON.stringify({ claudeAiOauth: { accessToken: 'from-security', expiresAt: 5 } }) + '\n'); };
  assert.deepEqual(await readKeychainLogin({ run }), { token: 'from-security', expiresAt: 5 });
  assert.deepEqual(runs[0], { command: '/usr/bin/security', args: ['find-generic-password', '-s', 'Claude Code-credentials', '-w'] });
  assert.equal(await readKeychainLogin({ run: (_c, _a, _o, callback) => callback(new Error('item not found'), '') }), null);
  assert.equal(await readKeychainLogin({ run: (_c, _a, _o, callback) => callback(null, 'not json') }), null);
  // A custom credentials file never falls back to the real Keychain.
  assert.equal(new ClaudeUsageApi({ ...missing }).keychain, null);
});

test('response parsing clamps values and accepts the documented date formats', () => {
  assert.deepEqual(toRateLimits({ five_hour: { utilization: 130, resets_at: 'not a date' }, seven_day: { utilization: -2, resets_at: '2099-01-05T00:00:00Z' }, other: { utilization: 5 } }), {
    five_hour: { used_percentage: 100, resets_at: null },
    seven_day: { used_percentage: 0, resets_at: Date.parse('2099-01-05T00:00:00Z') / 1000 }
  });
  assert.deepEqual(toRateLimits({ five_hour: { utilization: '50' } }), {});
  assert.equal(retryAfterMs('120', 0), 120000);
  assert.equal(retryAfterMs(new Date(60000).toUTCString(), 0), 60000);
  assert.equal(retryAfterMs(null, 0), 0);
});

test('the provider shows API readings without the status-line bridge and explains a missing login', async t => {
  const { dataDir, file } = fixture(t);
  const api = new ClaudeUsageApi({ dataDir, file, fetch: fakeFetch([{ status: 200, body: usageBody(30, 55) }]).fetch });
  const provider = new ClaudeProvider({ dataDir, settingsPath: path.join(dataDir, 'missing-settings.json'), usageApi: api });
  const state = await provider.refresh();
  assert.equal(state.status, 'ready');
  assert.equal(state.source, 'API de uso do Claude');
  assert.equal(state.integration.login, 'ok');
  assert.equal(state.integration.installed, false);
  assert.deepEqual(state.windows.map(window => [window.id, window.usedPercent]), [['five_hour', 30], ['seven_day', 55]]);

  const missing = fixture(t, { token: null });
  const offline = new ClaudeProvider({ dataDir: missing.dataDir, settingsPath: path.join(missing.dataDir, 'missing-settings.json'), usageApi: new ClaudeUsageApi({ ...missing, fetch: fakeFetch([{ status: 200, body: usageBody() }]).fetch }) });
  const waiting = await offline.refresh();
  assert.equal(waiting.status, 'disconnected');
  assert.equal(waiting.integration.login, 'missing');
  assert.match(waiting.message, /terminal/);
});
