/* Shared, read-only presentation of subscription limits. */
'use strict';
(function (root) {
  const i18n = typeof module === 'object' && module.exports ? require('./i18n.js') : root.PacelineI18n;
  const { t } = i18n;
  const number = (value, digits) => new Intl.NumberFormat(i18n.locale(), { maximumFractionDigits: digits }).format(value);
  const remaining = usage => Math.max(0, Math.min(100, 100 - usage.usedPercent));
  const percent = value => {
    if (value > 0 && value < 0.1) return `<${number(0.1, 1)}`;
    if (value > 99.9 && value < 100) return `>${number(99.9, 1)}`;
    return number(value, 1);
  };
  function limitLabel(usage) {
    const raw = String(usage.label || '').trim();
    const bucket = raw.includes(' · ') ? raw.slice(0, raw.lastIndexOf(' · ')) : '';
    const minutes = usage.windowMinutes;
    let label;
    // The Claude spend limit arrives with a fixed Portuguese label from the standalone collector.
    if ((usage.id ?? usage.windowId) === 'spend_limit') label = t('quota.spendLimit');
    else if (minutes === 10080) label = t('quota.weekly');
    else if (Number.isFinite(minutes) && minutes > 0) {
      const n = minutes % 1440 === 0 ? minutes / 1440 : minutes % 60 === 0 ? minutes / 60 : minutes;
      const [one, other] = minutes % 1440 === 0 ? ['quota.limitDays.one', 'quota.limitDays.other']
        : minutes % 60 === 0 ? ['quota.limitHours.one', 'quota.limitHours.other'] : ['quota.limitMinutes.one', 'quota.limitMinutes.other'];
      label = t(n === 1 ? one : other, { n: number(n, 1) });
    } else if (/^(semanal|7d)$/i.test(raw)) label = t('quota.weekly');
    else label = raw.replace(/(\d+)h\b/g, (match, n) => t('quota.rawHours', { n }))
      .replace(/(\d+)d\b/g, (match, n) => t('quota.rawDays', { n }))
      .replace(/(\d+)min\b/g, (match, n) => t('quota.rawMinutes', { n })) || t('quota.unknownPeriod');
    return bucket && Number.isFinite(minutes) ? `${bucket} · ${label}` : label;
  }
  const compactPercent = value => value > 0 && value < 1 ? '<1' : value > 99 && value < 100 ? '>99' : number(value, 0);
  // Providers jitter the reported reset by a second or so between readings; two readings
  // whose resets differ by at most two minutes belong to the same limit window.
  const sameReset = (a, b) => (a ?? null) === (b ?? null) || (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 120);
  const roundReset = value => Number.isFinite(value) && value > 0 ? Math.round(value / 60) * 60 : null;
  // A window opens at 0% used, so its own clock gives the average pace without any history:
  // used so far / time elapsed, projected to the reset. Too early in the window it is noise.
  function pace(usage, now = Date.now()) {
    const minutes = usage?.windowMinutes, reset = Number(usage?.resetsAt), used = usage?.usedPercent;
    if (!Number.isFinite(minutes) || minutes <= 0 || !Number.isFinite(reset) || !Number.isFinite(used)) return null;
    const length = minutes * 60, left = reset - now / 1000, elapsed = length - left;
    if (left <= 0 || elapsed <= 0) return null;
    const fraction = Math.min(1, elapsed / length);
    const result = { fraction, expectedUsed: fraction * 100, early: elapsed < Math.max(900, Math.min(length * 0.1, 3 * 3600)),
      projected: null, limitAt: null, perDay: minutes >= 2880 && left >= 86400 ? Math.max(0, 100 - used) / (left / 86400) : null };
    if (result.early || used >= 100) return result;
    const rate = used / elapsed;
    result.projected = used + rate * left;
    if (rate > 0 && result.projected > 100) result.limitAt = Math.round(now / 1000 + (100 - used) / rate);
    return result;
  }
  const api = { remaining, percent, compactPercent, limitLabel, sameReset, roundReset, pace };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PacelineQuota = Object.freeze(api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
