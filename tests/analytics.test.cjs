'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { AnalyticsStore, forecast } = require('../src/main/analytics.cjs');
const { pace, sameReset, roundReset } = require('../src/renderer/quota-format.js');
function fixture(t) {
  const root = path.resolve(__dirname, '../.local/tests'); fs.mkdirSync(root, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(root, 'analytics-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true })); return dataDir;
}
const state = (at, used, reset, minutes = 10080) => [{ id: 'codex', name: 'Codex', status: 'ready', updatedAt: new Date(at).toISOString(), windows: [{ id: 'weekly', label: '7d', usedPercent: used, resetsAt: reset, windowMinutes: minutes }] }];
test('pace comes from the window clock: projection, limit time and daily budget without history', () => {
  const now = Date.parse('2026-10-22T12:00:00Z');
  // A 5-hour window opened 2 hours ago with 60% used: 30%/h, the limit falls 1h20 later, before the reset.
  const hot = pace({ windowMinutes: 300, resetsAt: now / 1000 + 3 * 3600, usedPercent: 60 }, now);
  assert.equal(Math.round(hot.projected), 150);
  assert.equal(hot.limitAt, now / 1000 + 4800);
  assert.equal(hot.perDay, null);
  // Same window at 20%: comfortably under the limit at the reset.
  const calm = pace({ windowMinutes: 300, resetsAt: now / 1000 + 3 * 3600, usedPercent: 20 }, now);
  assert.equal(Math.round(calm.projected), 50); assert.equal(calm.limitAt, null);
  // A weekly window with 5 days left and 40% used leaves 12% per day.
  const weekly = pace({ windowMinutes: 10080, resetsAt: now / 1000 + 5 * 86400, usedPercent: 40 }, now);
  assert.equal(Math.round(weekly.perDay), 12);
  // Ten minutes into a window the average is noise: no projection yet.
  const early = pace({ windowMinutes: 300, resetsAt: now / 1000 + 290 * 60, usedPercent: 5 }, now);
  assert.equal(early.early, true); assert.equal(early.projected, null);
  assert.equal(pace({ windowMinutes: null, resetsAt: now / 1000 + 60, usedPercent: 5 }, now), null);
});
test('a reset reported one second apart is the same window', () => {
  assert.ok(sameReset(1793293784, 1793293785)); assert.ok(sameReset(null, undefined));
  assert.ok(!sameReset(1793293784, 1793293784 + 3600)); assert.ok(!sameReset(null, 1793293784));
  assert.equal(roundReset(1793293784), 1793293800); assert.equal(roundReset(1793293785), 1793293800);
});
test('history keeps one window through reset jitter and forecasts from the first fresh reading', t => {
  const dataDir = fixture(t); let now = Date.parse('2026-10-22T10:00:00Z');
  const reset = Math.floor(now / 1000) + 5 * 86400;
  const store = new AnalyticsStore({ dataDir, now: () => now });
  for (const [index, used] of [20, 21, 22, 23].entries()) { store.record(state(now, used, reset + index % 2)); now += 300000; }
  now -= 300000;
  const summary = store.getSummary();
  assert.equal(summary.series[0].points.length, 4);
  assert.equal(new Set(summary.series[0].points.map(item => item.resetsAt)).size, 1);
  const [prediction] = summary.forecasts;
  assert.equal(prediction.status, 'ok');
  assert.ok(Math.abs(prediction.perDay - 77 / 5) < 0.1);
  assert.deepEqual(new AnalyticsStore({ dataDir, now: () => now }).getSummary(), summary);
  now += 6 * 60000;
  assert.equal(store.getSummary().forecasts[0].status, 'stale');
});
test('used today comes from the last reading before midnight in the same window', () => {
  const midnight = new Date(2026, 9, 22, 0, 0, 0).getTime(), now = midnight + 10 * 3600000;
  const reset = Math.floor(now / 1000) + 3 * 86400;
  const point = (at, usedPercent, resetsAt = reset) => ({ at: new Date(at).toISOString(), usedPercent, resetsAt });
  const series = { providerId: 'codex', windowId: 'weekly', windowMinutes: 10080, points: [point(midnight - 7200000, 50, reset - 7 * 86400), point(midnight - 3600000, 40), point(midnight + 3600000, 45), point(now - 60000, 52)] };
  assert.equal(forecast(series, now).usedToday, 12);
  assert.equal(forecast({ ...series, points: series.points.slice(2) }, now).usedToday, null);
});
test('a limit reached, an expired window and a reset never produce a fabricated forecast', t => {
  const dataDir = fixture(t); let now = Date.parse('2026-10-22T10:00:00Z');
  const store = new AnalyticsStore({ dataDir, now: () => now });
  store.record(state(now, 100, now / 1000 + 7200, 300));
  assert.equal(store.getSummary().forecasts[0].status, 'reached');
  now += 300000; store.record(state(now, 99, now / 1000 - 1, 300));
  assert.equal(store.getSummary().forecasts[0].status, 'awaiting');
});
test('readings imported from provider logs merge into the live series without duplicates', t => {
  const dataDir = fixture(t); const now = Date.parse('2026-10-22T10:00:00Z');
  const reset = Math.floor(now / 1000) + 3 * 86400;
  const store = new AnalyticsStore({ dataDir, now: () => now });
  store.record(state(now, 40, reset));
  const reading = (minutes, used) => ({ providerId: 'codex', providerName: 'Codex', windowId: 'weekly', label: '7d', windowMinutes: 10080, at: new Date(now - minutes * 60000).toISOString(), usedPercent: used, resetsAt: reset });
  assert.equal(store.importReadings([reading(600, 20), reading(300, 30), reading(300, 30)]), true);
  assert.deepEqual(store.getSummary().series[0].points.map(item => item.usedPercent), [20, 30, 40]);
  assert.equal(store.importReadings([reading(600, 20)]), false);
  assert.equal(store.importReadings([{ ...reading(10, 5), providerId: 'other' }]), false);
});
test('retention is 30 days and invalid history is preserved rather than silently overwritten', t => {
  const dataDir = fixture(t); let now = Date.parse('2026-09-01T10:00:00Z');
  const store = new AnalyticsStore({ dataDir, now: () => now });
  store.record(state(now, 10, now / 1000 + 7200));
  now += 31 * 86400000; store.record(state(now, 20, now / 1000 + 7200));
  assert.equal(store.getSummary({ range: 'week' }).series[0].points.length, 1);
  fs.writeFileSync(path.join(dataDir, 'usage-history.json'), '{ broken');
  const broken = new AnalyticsStore({ dataDir, now: () => now });
  assert.equal(broken.record(state(now, 30, now / 1000 + 7200)), false);
  assert.equal(broken.importReadings([{ providerId: 'codex', windowId: 'weekly', at: new Date(now).toISOString(), usedPercent: 5, resetsAt: now / 1000 + 60 }]), false);
  assert.equal(fs.readFileSync(path.join(dataDir, 'usage-history.json'), 'utf8'), '{ broken');
});

test('an unchanged reading seen recently keeps the forecast fresh although it is not stored again', t => {
  const dataDir = fixture(t); let now = Date.parse('2026-10-22T10:00:00Z');
  const reset = Math.floor(now / 1000) + 3 * 86400;
  const store = new AnalyticsStore({ dataDir, now: () => now });
  store.record(state(now, 40, reset));
  // The Claude account is read every four minutes; the same value four minutes later is not stored again.
  now += 4 * 60000; store.record(state(now, 40, reset));
  // Seven minutes after the stored point, the reading seen at four minutes still counts as fresh.
  now += 3 * 60000;
  const summary = store.getSummary();
  assert.equal(summary.series[0].points.length, 1);
  assert.notEqual(summary.forecasts[0].status, 'stale');
  assert.equal(Object.hasOwn(summary.series[0], 'seenAt'), false);
});
