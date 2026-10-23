'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { atomicJSON } = require('./settings.cjs');
const i18n = require('../renderer/i18n.js');
const { limitLabel, pace, sameReset } = require('../renderer/quota-format.js');

// "When" in the reader's language: a time today, otherwise weekday and time.
function when(seconds, now) {
  const date = new Date(seconds * 1000);
  const sameDay = new Date(now).toDateString() === date.toDateString();
  return date.toLocaleString(i18n.locale(), sameDay ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}
function inTime(seconds, now) {
  const minutes = Math.max(1, Math.round((seconds * 1000 - now) / 60000));
  if (minutes < 60) return i18n.t('notify.inMinutes', { minutes });
  if (minutes < 2880) return i18n.t('notify.inHours', { hours: Math.round(minutes / 60) });
  return i18n.t('notify.inDays', { days: Math.round(minutes / 1440) });
}

class NotificationTracker {
  constructor({ dataDir, now = Date.now }) {
    this.file = path.join(dataDir, 'notifications.json'); this.now = now;
    // windows[id] = { resetsAt, peak }: the window's first reported reset and its highest usage.
    this.state = { windows: {}, sent: [] };
    try {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (value && typeof value.windows === 'object' && Array.isArray(value.sent)) {
        this.state.windows = Object.fromEntries(Object.entries(value.windows).filter(([k, v]) => k.length < 200 && (v?.resetsAt === null || Number.isFinite(v?.resetsAt))).map(([k, v]) => [k, { resetsAt: v.resetsAt, peak: Number.isFinite(v.peak) ? v.peak : 0 }]).slice(-100));
        this.state.sent = value.sent.filter(k => typeof k === 'string' && k.length < 240).slice(-256);
      }
    } catch { /* Missing/corrupt local notification state starts clean. */ }
  }
  update(providers, settings) {
    const before = JSON.stringify(this.state);
    const notices = []; const now = this.now();
    // One alert level, in "% used", shared by the "freed again" notice and the threshold alerts.
    const level = settings.alertThresholds.length ? Math.min(...settings.alertThresholds) : 80;
    for (const provider of providers) {
      const age = now - Date.parse(provider.updatedAt);
      if (!settings.visibleProviders.includes(provider.id) || provider.status !== 'ready' || !Number.isFinite(age) || age < -60000 || age > 300000) continue;
      for (const window of provider.windows || []) {
        if (!Number.isFinite(window.usedPercent)) continue;
        const id = `${provider.id}:${window.id}`;
        const old = this.state.windows[id];
        const reset = Number.isFinite(window.resetsAt) ? window.resetsAt : null;
        const label = limitLabel(window);
        const add = (key, title, body) => {
          if (this.state.sent.includes(key)) return;
          this.state.sent.push(key); notices.push({ title, body, provider: provider.id });
        };
        // A new window: the reset moved on, or the old one expired (Claude then reports no reset).
        const renewed = old && !sameReset(old.resetsAt, reset) && (reset === null || old.resetsAt === null || reset > old.resetsAt) && (old.resetsAt === null || now >= old.resetsAt * 1000 - 60000 || window.usedPercent < old.peak - 10);
        if (renewed && settings.notifications && settings.notifyOnReset && old.peak >= level && window.usedPercent < old.peak) {
          add(`${id}:freed:${old.resetsAt}`, i18n.t('notify.resetTitle', { name: provider.name, label }), i18n.t('notify.resetBody', { label, left: Math.round(100 - window.usedPercent) }));
        }
        const current = !old || renewed ? { resetsAt: reset, peak: window.usedPercent } : { resetsAt: old.resetsAt, peak: Math.max(old.peak, window.usedPercent) };
        this.state.windows[id] = current;
        if (!settings.notifications || reset === null || reset * 1000 <= now) continue;
        const threshold = [...settings.alertThresholds].reverse().find(n => window.usedPercent >= n);
        if (threshold !== undefined) add(`${id}:${current.resetsAt}:${threshold}`, i18n.t('notify.thresholdTitle', { name: provider.name, label }), i18n.t('notify.thresholdBody', { left: Math.round(100 - window.usedPercent), when: when(reset, now), in: inTime(reset, now) }));
        // Weekly limits: warn once when the window's own pace runs out well before the reset.
        const estimate = window.windowMinutes >= 2880 ? pace(window, now) : null;
        if (estimate?.limitAt && estimate.fraction >= 0.25 && reset - estimate.limitAt >= 43200 && window.usedPercent < (threshold ?? 101)) {
          add(`${id}:${current.resetsAt}:pace`, i18n.t('notify.paceTitle', { name: provider.name, label }), i18n.t('notify.paceBody', { when: when(estimate.limitAt, now), reset: when(reset, now) }));
        }
      }
    }
    this.state.sent = this.state.sent.slice(-256);
    this.state.windows = Object.fromEntries(Object.entries(this.state.windows).slice(-100));
    if (before !== JSON.stringify(this.state)) atomicJSON(this.file, this.state);
    return notices;
  }
}
module.exports = { NotificationTracker };
