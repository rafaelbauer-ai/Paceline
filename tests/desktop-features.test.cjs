'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { safeSettings } = require('../src/main/settings.cjs');
const { overlayBounds } = require('../src/main/geometry.cjs');
const { ActiveContext } = require('../src/main/active-context.cjs');
const { NotificationTracker } = require('../src/main/notifications.cjs');

test('personalization validates enums, finite sizes, visibility and bounded thresholds', () => {
  const value = safeSettings({ scale: 10, opacity: 0, hideDelayMs: NaN, visibleProviders: ['evil'], theme: 'url(https://evil)', alertThresholds: [95, 80, 95, -1, 101, '90'], position: { x: Infinity, y: 0 }, updateRepository: '../evil', followActiveApp: false });
  assert.equal(value.scale, 1.3); assert.equal(value.opacity, 0.5); assert.equal(value.hideDelayMs, 450);
  assert.deepEqual(value.visibleProviders, ['codex', 'claude']); assert.equal(value.theme, 'auto');
  assert.deepEqual(value.alertThresholds, [80, 95]); assert.equal(value.position, null); assert.equal(value.updateRepository, '');
  assert.equal(value.followActiveApp, false);
  assert.equal(safeSettings({ updateRepository: 'owner/Paceline' }).updateRepository, 'owner/Paceline');
});

test('dragged and scaled panel remains reachable after monitor changes', () => {
  const area = { x: -1280, y: 20, width: 1280, height: 720 };
  const value = overlayBounds(area, 'top', true, { scale: 1.3, position: { x: 5000, y: -9999 } });
  assert.equal(value.width, 541); assert.equal(value.height, 720);
  assert.equal(value.x, -541); assert.equal(value.y, 20);
});

test('automatic context retains provider while overlay is focused and never emits arbitrary titles', () => {
  const context = new ActiveContext({ platform: 'linux' });
  context.accept({ provider: 'codex' }); assert.equal(context.getState().provider, 'codex');
  context.accept({ provider: null }); assert.equal(context.getState().provider, 'codex');
  context.accept({ provider: 'claude', title: 'private project title' }); assert.equal(context.getState().provider, 'claude');
  context.accept({ provider: 'unexpected' }); assert.equal(context.getState().provider, 'claude');
  assert.equal(JSON.stringify(context.getState()).includes('private'), false);
  context.close();
});

test('notifications persist deduplication, support custom thresholds and require a confirmed reset', () => {
  const base = path.resolve(__dirname, '../.local/tests'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'notifications-')); let now = 1800000000000;
  const state = (usedPercent, resetsAt, updatedAt = new Date(now).toISOString()) => [{ id: 'codex', name: 'Codex', status: 'ready', updatedAt, windows: [{ id: 'weekly', label: '7d', usedPercent, resetsAt }] }];
  const settings = safeSettings({ alertThresholds: [70, 90] });
  try {
    let tracker = new NotificationTracker({ dataDir: dir, now: () => now });
    const reset = now / 1000 + 100;
    assert.equal(tracker.update(state(69, reset), settings).length, 0);
    assert.equal(tracker.update(state(71, reset), settings).length, 1);
    tracker = new NotificationTracker({ dataDir: dir, now: () => now });
    assert.equal(tracker.update(state(72, reset), settings).length, 0);
    assert.equal(tracker.update(state(92, reset), settings).length, 1);
    now += 101000;
    assert.equal(tracker.update(state(92, reset), settings).length, 0); // Time alone is not evidence of renewal.
    const notices = tracker.update(state(0, reset + 1000), settings);
    assert.equal(notices.length, 1); assert.match(notices[0].title, /liberado/); assert.equal(notices[0].provider, 'codex');
    assert.equal(tracker.update(state(0, reset + 1000), settings).length, 0);
    assert.equal(tracker.update(state(99, reset + 1000, new Date(now - 600000).toISOString()), settings).length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('notifications ignore reset jitter, announce a freed limit only after a tight window and include Claude expiries', () => {
  const base = path.resolve(__dirname, '../.local/tests'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'notifications-')); let now = 1800000000000;
  const window = (id, usedPercent, resetsAt, windowMinutes = 300) => ({ id, label: '5h', usedPercent, resetsAt, windowMinutes });
  const state = (provider, ...windows) => [{ id: provider, name: provider === 'claude' ? 'Claude Code' : 'Codex', status: 'ready', updatedAt: new Date(now).toISOString(), windows }];
  const settings = safeSettings({ alertThresholds: [80, 95] });
  try {
    const tracker = new NotificationTracker({ dataDir: dir, now: () => now });
    const reset = now / 1000 + 3600;
    assert.equal(tracker.update(state('codex', window('w', 81, reset)), settings).length, 1);
    // One second of jitter in the reported reset is the same window: no duplicate alert.
    assert.equal(tracker.update(state('codex', window('w', 82, reset + 1)), settings).length, 0);
    // The threshold toast tells what is left and when it renews.
    const toast = tracker.update(state('claude', window('five_hour', 96, reset)), settings);
    assert.equal(toast.length, 1); assert.match(toast[0].body, /4%/);
    // Claude reports no reset once the 5-hour window has expired: that is a renewal too.
    now = reset * 1000 + 1000;
    const freed = tracker.update(state('claude', window('five_hour', 0, null)), settings);
    assert.equal(freed.length, 1); assert.match(freed[0].title, /liberado/);
    // A window that never got close to the alert level renews silently.
    const calmReset = now / 1000 + 3600;
    tracker.update(state('claude', window('five_hour', 10, calmReset)), settings);
    now = calmReset * 1000 + 1000;
    assert.equal(tracker.update(state('claude', window('five_hour', 0, null)), settings).length, 0);
    // Providers hidden from the panel never notify.
    assert.equal(tracker.update(state('codex', window('other', 99, now / 1000 + 600)), safeSettings({ visibleProviders: ['claude'] })).length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a weekly window whose own pace runs out well before the reset warns once', () => {
  const base = path.resolve(__dirname, '../.local/tests'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'notifications-')); const now = 1800000000000;
  // Three of seven days elapsed with 60% used: the limit falls on day five, two days early.
  const weekly = { id: 'weekly', label: '7d', usedPercent: 60, resetsAt: now / 1000 + 4 * 86400, windowMinutes: 10080 };
  const state = [{ id: 'codex', name: 'Codex', status: 'ready', updatedAt: new Date(now).toISOString(), windows: [weekly] }];
  try {
    const tracker = new NotificationTracker({ dataDir: dir, now: () => now });
    const notices = tracker.update(state, safeSettings({ alertThresholds: [80, 95] }));
    assert.equal(notices.length, 1); assert.match(notices[0].title, /ritmo/);
    assert.equal(tracker.update(state, safeSettings({ alertThresholds: [80, 95] })).length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('alert levels saved by older versions move to the nearest level the settings offer', () => {
  assert.deepEqual(safeSettings({ alertThresholds: [50, 60, 85] }).alertThresholds, [70, 80]);
  assert.deepEqual(safeSettings({ alertThresholds: [80, 95] }).alertThresholds, [80, 95]);
  assert.deepEqual(safeSettings({ alertThresholds: [] }).alertThresholds, []);
});
