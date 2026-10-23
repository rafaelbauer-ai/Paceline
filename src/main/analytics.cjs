'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const i18n = require('../renderer/i18n.js');
const { pace, sameReset, roundReset } = require('../renderer/quota-format.js');

const DAY = 86400000;
const RETENTION = 30 * DAY;
const MAX_SERIES = 16;
const MAX_POINTS = 6000;
const percent = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
const safeText = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120) : '';
function point(value, now) {
  const timestamp = Date.parse(value?.at);
  if (!Number.isFinite(timestamp) || timestamp < now - RETENTION || timestamp > now + 60000 || !percent(value.usedPercent)) return null;
  return { at: new Date(timestamp).toISOString(), usedPercent: value.usedPercent, resetsAt: roundReset(value.resetsAt) };
}
function compact(points, now) {
  const buckets = new Map();
  for (const value of points) {
    const clean = point(value, now);
    if (!clean) continue;
    const at = Date.parse(clean.at);
    const width = at < now - DAY ? 15 * 60000 : 60000;
    // A reset starts a new segment even when it falls within the same bucket.
    buckets.set(`${Math.floor(at / width)}:${clean.resetsAt}`, clean);
  }
  return [...buckets.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-MAX_POINTS);
}
// Projection from the window's own clock (see PacelineQuota.pace); the history adds how much
// of a multi-day window was used today. Reasons are status codes the renderer translates.
function forecast(series, now) {
  const result = { providerId: series.providerId, windowId: series.windowId, status: 'insufficient', projected: null, limitAt: null, perDay: null, usedToday: null };
  const latest = series.points.at(-1);
  // An unchanged reading is not stored again for five minutes, so freshness uses when it was last seen.
  const seen = Math.max(latest ? Date.parse(latest.at) : 0, Date.parse(series.seenAt) || 0);
  if (!latest || now - seen > 5 * 60000) return { ...result, status: 'stale' };
  if (!latest.resetsAt || latest.resetsAt * 1000 <= now) return { ...result, status: 'awaiting' };
  if (latest.usedPercent >= 100) return { ...result, status: 'reached' };
  const estimate = pace({ windowMinutes: series.windowMinutes, resetsAt: latest.resetsAt, usedPercent: latest.usedPercent }, now);
  if (!estimate) return result;
  if (series.windowMinutes >= 2880) {
    const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
    const opened = (latest.resetsAt - series.windowMinutes * 60) * 1000;
    const window = series.points.filter(item => sameReset(item.resetsAt, latest.resetsAt));
    const before = window.filter(item => Date.parse(item.at) < midnight.getTime()).at(-1);
    const baseline = opened >= midnight.getTime() ? 0 : before ? before.usedPercent : null;
    if (baseline !== null) result.usedToday = Math.max(0, latest.usedPercent - baseline);
  }
  return { ...result, status: estimate.early ? 'early' : estimate.limitAt ? 'limit' : 'ok', projected: estimate.projected, limitAt: estimate.limitAt, perDay: estimate.perDay };
}
class AnalyticsStore {
  constructor({ dataDir, now = Date.now } = {}) {
    if (!dataDir || !path.isAbsolute(dataDir)) throw new Error('AnalyticsStore requires an absolute data directory.');
    this.file = path.join(dataDir, 'usage-history.json');
    this.now = now;
    this.series = [];
    this.updatedAt = null;
    // i18n key, resolved in getSummary so a language switch applies.
    this.error = null;
    this.loadError = false;
    try {
      const stat = fs.lstatSync(this.file);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('Invalid history file');
      const stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (stored.version !== 1 || !Array.isArray(stored.series)) throw new Error('Invalid history schema');
      this.series = stored.series.slice(0, MAX_SERIES).flatMap(item => {
        if (!['codex', 'claude'].includes(item.providerId) || typeof item.windowId !== 'string' || !Array.isArray(item.points)) return [];
        return [{ providerId: item.providerId, providerName: safeText(item.providerName), windowId: safeText(item.windowId), label: safeText(item.label), windowMinutes: Number.isFinite(item.windowMinutes) && item.windowMinutes > 0 ? item.windowMinutes : null, points: compact(item.points, this.now()) }];
      });
      this.updatedAt = this.series.flatMap(item => item.points).reduce((latest, item) => !latest || item.at > latest ? item.at : latest, null);
    } catch (error) { if (error.code !== 'ENOENT') { this.loadError = true; this.error = 'analytics.historyReadFailed'; } }
  }
  record(states) {
    if (!Array.isArray(states) || this.loadError) return false;
    const now = this.now();
    let changed = false;
    for (const provider of states) {
      const at = Date.parse(provider?.updatedAt);
      if (!['codex', 'claude'].includes(provider?.id) || provider.status !== 'ready' || !Number.isFinite(at) || at < now - 5 * 60000 || at > now + 60000 || !Array.isArray(provider.windows)) continue;
      for (const window of provider.windows.slice(0, MAX_SERIES)) {
        if (!window || typeof window.id !== 'string' || !percent(window.usedPercent)) continue;
        let series = this.series.find(item => item.providerId === provider.id && item.windowId === window.id);
        if (!series) {
          if (this.series.length >= MAX_SERIES) continue;
          series = { providerId: provider.id, providerName: safeText(provider.name), windowId: safeText(window.id), label: safeText(window.label), windowMinutes: Number.isFinite(window.windowMinutes) && window.windowMinutes > 0 ? window.windowMinutes : null, points: [] };
          this.series.push(series);
        }
        const next = point({ at: provider.updatedAt, usedPercent: window.usedPercent, resetsAt: window.resetsAt }, now);
        const last = series.points.at(-1);
        if (next && (!series.seenAt || next.at > series.seenAt)) series.seenAt = next.at;
        if (!next || (last && next.at <= last.at)) continue;
        if (last && next.usedPercent === last.usedPercent && sameReset(next.resetsAt, last.resetsAt) && at - Date.parse(last.at) < 5 * 60000) continue;
        series.points = compact([...series.points, next], now);
        series.label = safeText(window.label); series.providerName = safeText(provider.name);
        changed = true;
      }
    }
    // Retention and 15-minute buckets for older points only move slowly; apply them every 10 minutes.
    if (now - (this.compactedAt || 0) >= 600000) {
      this.compactedAt = now;
      const before = this.series.reduce((sum, item) => sum + item.points.length, 0);
      this.series = this.series.map(item => ({ ...item, points: compact(item.points, now) })).filter(item => item.points.length);
      changed ||= before !== this.series.reduce((sum, item) => sum + item.points.length, 0);
    }
    return changed ? this.persist() : false;
  }
  // Official readings recovered from a provider's own logs (taken while it was in use) fill
  // the gaps when Paceline was closed. They merge with, and never replace, live readings.
  importReadings(readings) {
    if (!Array.isArray(readings) || this.loadError) return false;
    const now = this.now();
    let changed = false;
    const seen = new Map();
    for (const reading of readings.slice(0, 20000)) {
      if (!['codex', 'claude'].includes(reading?.providerId) || typeof reading.windowId !== 'string') continue;
      const next = point(reading, now);
      if (!next) continue;
      let series = this.series.find(item => item.providerId === reading.providerId && item.windowId === reading.windowId);
      if (!series) {
        if (this.series.length >= MAX_SERIES) continue;
        series = { providerId: reading.providerId, providerName: safeText(reading.providerName), windowId: safeText(reading.windowId), label: safeText(reading.label), windowMinutes: Number.isFinite(reading.windowMinutes) && reading.windowMinutes > 0 ? reading.windowMinutes : null, points: [] };
        this.series.push(series);
      }
      if (!seen.has(series)) seen.set(series, new Set(series.points.map(item => item.at)));
      if (seen.get(series).has(next.at)) continue;
      seen.get(series).add(next.at); series.points.push(next); changed = true;
    }
    if (!changed) return false;
    this.series = this.series.map(item => ({ ...item, points: compact(item.points, now) })).filter(item => item.points.length);
    return this.persist();
  }
  persist() {
    this.updatedAt = this.series.flatMap(item => item.points).reduce((latest, item) => !latest || item.at > latest ? item.at : latest, null);
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      try { if (fs.lstatSync(this.file).isSymbolicLink()) throw new Error('Symlink history'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, series: this.series.map(({ seenAt, ...item }) => item) }) + '\n', { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.file);
      this.error = null;
    } catch { this.error = 'analytics.historySaveFailed'; }
    finally { try { fs.unlinkSync(temporary); } catch {} }
    return true;
  }
  getSummary({ range = 'day' } = {}) {
    const now = this.now();
    const cutoff = now - (range === 'week' ? 7 : 1) * DAY;
    const series = this.series.map(({ seenAt, ...item }) => {
      const visible = item.points.filter(entry => Date.parse(entry.at) >= cutoff);
      const stride = Math.max(1, Math.ceil(visible.length / 240));
      const points = visible.filter((_entry, index) => index % stride === 0 || index === visible.length - 1);
      return { ...item, points };
    }).filter(item => item.points.length);
    return structuredClone({ series, forecasts: this.series.map(item => forecast(item, now)), updatedAt: this.updatedAt, ...(this.error ? { message: i18n.t(this.error) } : {}) });
  }
}
module.exports = { AnalyticsStore, forecast };
