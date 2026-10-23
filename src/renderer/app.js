'use strict';

(() => {
  const byId = (id) => document.getElementById(id);
  const root = byId('paceline');
  const demo = new URLSearchParams(window.location.search).has('demo');
  const bridge = window.paceline;
  let settingsOpen = false;
  let pointerInside = false;
  let keyboardFocus = false;
  let collapseTimer;
  let noticeTimer;
  let expanded = false;
  let view = 'monitor';
  let previousView = 'monitor';
  let localView = 'projects';
  // Remembered across restarts so the automatic theme does not fall back to Paceline until the next focus.
  let lastFocusedProvider = (() => {
    try { const saved = window.localStorage.getItem('tv-last-provider'); return ['codex', 'claude'].includes(saved) ? saved : null; }
    catch { return null; }
  })();
  let analytics = null;
  let localUsage = null;
  let analyticsLoading = false;
  let localLoading = false;
  let analyticsError = '';
  let localError = '';
  let analyticsLoadedAt = 0;
  let localLoadedAt = 0;
  let dragging = false;
  let dragFrame = null;
  let pendingDrag = null;
  let state = {
    expanded: false,
    providers: ['codex', 'claude'].map((id) => ({
      id, name: id === 'codex' ? 'Codex' : 'Claude Code',
      status: 'disconnected', updatedAt: null, windows: [],
      // Read lazily so a language switch applies before the first state arrives.
      get message() { return t(bridge ? 'app.provider.connectToTrack' : 'app.provider.openAppToConnect'); },
    })),
    settings: {
      pinned: false, edge: 'top', launchAtLogin: false, scale: 1, opacity: 1,
      hideDelayMs: 450, metricMode: 'remaining', visibleProviders: ['codex', 'claude'],
      theme: 'auto', alertThresholds: [80, 95], notifyOnReset: true, historyRange: 'day',
      updateRepository: '', followActiveApp: true,
    },
    context: { provider: null, available: false, mode: 'auto' },
    updates: { status: 'idle', message: '' },
    meta: { version: '' }, demo,
  };

  const usableWindows = (provider) => (provider.windows || []).filter((item) => (
    typeof item.usedPercent === 'number' && Number.isFinite(item.usedPercent)
  ));
  const { remaining, percent, compactPercent, limitLabel, sameReset, pace } = window.PacelineQuota;
  const i18n = window.PacelineI18n;
  const { t } = i18n;
  // Until the app reports its language, follow the saved preview choice or the system language.
  i18n.setLanguage((() => { try { return window.localStorage.getItem('tv-language'); } catch { return null; } })() || navigator.language);
  // Static markup carries data-i18n (text) and data-i18n-attr ("attr:key;attr:key") for translation.
  // data-i18n-mac names the macOS wording where the system is part of the label.
  function applyStaticTexts() {
    document.documentElement.lang = i18n.locale();
    const mac = state.meta?.platform === 'darwin';
    for (const element of document.querySelectorAll('[data-i18n]')) element.textContent = t(mac && element.dataset.i18nMac || element.dataset.i18n);
    for (const element of document.querySelectorAll('[data-i18n-attr]')) {
      for (const pair of element.dataset.i18nAttr.split(';')) {
        const [attribute, key] = pair.split(':').map((part) => part.trim());
        if (attribute && key) element.setAttribute(attribute, t(key));
      }
    }
    document.querySelectorAll('[data-language]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.language === i18n.getLanguage())));
    // The settings button label depends on state, so restore it after the static pass.
    byId('settings-toggle').setAttribute('aria-label', t(settingsOpen ? 'app.settings.close' : 'app.settings.open'));
  }

  // History reasons and local-usage messages arrive already translated, so refetch them on a switch.
  function changeLanguage(language) {
    i18n.setLanguage(language);
    applyStaticTexts();
    analytics = null; analyticsError = '';
    localUsage = null; localError = '';
    render();
    if (view === 'history') loadAnalytics(true);
    if (view === 'projects') loadLocalUsage(true);
  }
  const mascots = window.PacelineMascots;
  const brandMarks = [...document.querySelectorAll('[data-mascot-slot]')].map((slot) => (
    mascots.mountSlot(slot, { size: Number(slot.dataset.size) || 28, id: slot.dataset.mascotSlot })
  ));
  // Over a card the pointer becomes that card's mascot; elsewhere it follows the app in focus.
  mascots.mountCursor(root, { kindFor: (target) => {
    if (!expanded || !(target instanceof Element) || target.closest('input, select, textarea')) return null;
    const card = target.closest('.provider-card')?.dataset.provider;
    return card || (['claude', 'codex'].includes(root.dataset.theme) ? root.dataset.theme : null);
  }, moodFor: (kind) => moodFor((state.providers || []).find((provider) => provider.id === kind)) });
  const criticalWindow = (provider) => usableWindows(provider).reduce((result, item) => (
    !result || remaining(item) < remaining(result) ? item : result
  ), null);
  const age = (provider) => provider.updatedAt ? Math.max(0, Date.now() - new Date(provider.updatedAt).getTime()) : Infinity;
  const stale = (provider) => age(provider) > 300_000;
  const expired = (usage) => Boolean(usage.resetsAt && Number(usage.resetsAt) <= Date.now() / 1000);
  const hasExpired = (provider) => usableWindows(provider).some(expired);
  // A running agent busies its mascot and a finished turn makes it celebrate; otherwise the mood
  // follows the tightest limit: crying when almost out, cheering above 90% left.
  const moodFor = (provider) => {
    const status = provider && state.activity?.[provider.id]?.status;
    if (status === 'working') return 'working';
    if (status === 'done') return 'happy';
    const critical = provider && criticalWindow(provider);
    if (!critical || hasExpired(provider)) return null;
    const left = remaining(critical);
    return left <= 15 ? 'sad' : left > 90 ? 'happy' : null;
  };
  const nameFor = (id) => id === 'codex' ? 'Codex' : id === 'claude' ? 'Claude Code' : id;
  const selectedProviders = () => (state.providers || []).filter((provider) => state.settings.visibleProviders.includes(provider.id)).sort((a, b) => (
    state.settings.followActiveApp ? (b.id === state.context?.provider ? 1 : 0) - (a.id === state.context?.provider ? 1 : 0) : 0
  ));
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function showNotice(message, persistent = false) {
    clearTimeout(noticeTimer);
    byId('notice').textContent = message;
    byId('notice').hidden = false;
    if (!persistent) noticeTimer = setTimeout(() => { byId('notice').hidden = true; }, 7000);
  }

  function applyExpanded(value) {
    expanded = Boolean(value);
    root.classList.toggle('expanded', expanded);
    byId('peek').hidden = expanded;
    byId('dashboard').hidden = !expanded;
    byId('peek').setAttribute('aria-expanded', String(expanded));
  }

  async function setExpanded(value) {
    clearTimeout(collapseTimer);
    if (expanded === value) return;
    applyExpanded(value);
    try { if (bridge) await bridge.expand(value); }
    catch (error) { showNotice(error.message || t('app.error.adjustPanel')); }
  }

  function scheduleCollapse() {
    clearTimeout(collapseTimer);
    if (state.settings.pinned || settingsOpen || dragging || view !== 'monitor') return;
    collapseTimer = setTimeout(() => {
      if (state.settings.pinned || settingsOpen || dragging || view !== 'monitor') return;
      if (!pointerInside && !(keyboardFocus && root.contains(document.activeElement))) setExpanded(false);
    }, Math.max(200, Math.min(5000, Number(state.settings.hideDelayMs) || 450)));
  }

  function toggleSettings(value) {
    if (value && view !== 'settings') previousView = view;
    switchView(value ? 'settings' : previousView);
  }

  function switchView(nextView) {
    view = nextView;
    settingsOpen = view === 'settings';
    ['monitor', 'history', 'projects', 'settings'].forEach((id) => { byId(id).hidden = id !== view; });
    byId('view-nav').hidden = settingsOpen;
    document.querySelectorAll('[data-view]').forEach((button) => {
      if (button.dataset.view === view) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    byId('settings-toggle').setAttribute('aria-expanded', String(settingsOpen));
    byId('settings-toggle').setAttribute('aria-label', t(settingsOpen ? 'app.settings.close' : 'app.settings.open'));
    if (view !== 'monitor') setExpanded(true);
    else scheduleCollapse();
    if (view === 'history') loadAnalytics(true);
    if (view === 'projects') { renderLocalUsage(); loadLocalUsage(true); }
  }

  function freshness(provider) {
    if (!provider.updatedAt || !Number.isFinite(age(provider))) return t('app.freshness.none');
    const minutes = Math.floor(age(provider) / 60_000);
    if (minutes < 1) return t('app.freshness.now');
    if (minutes < 60) return t('app.freshness.minutes', { minutes });
    if (minutes < 1440) return t('app.freshness.hours', { hours: Math.floor(minutes / 60) });
    return t('app.freshness.days', { days: Math.floor(minutes / 1440) });
  }

  function resetText(usage) {
    if (!usage.resetsAt || !Number.isFinite(Number(usage.resetsAt))) return t('app.reset.unknown');
    const seconds = Number(usage.resetsAt) - Date.now() / 1000;
    if (seconds <= 0) return t('app.reset.waiting');
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    if (minutes < 60) return t('app.reset.minutes', { minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return minutes % 60 ? t('app.reset.hoursMinutes', { hours, minutes: minutes % 60 }) : t('app.reset.hours', { hours });
    const days = Math.floor(hours / 24);
    return hours % 24 ? t('app.reset.daysHours', { days, hours: hours % 24 }) : t('app.reset.days', { days });
  }

  // A time today, otherwise the weekday and time.
  function clock(seconds) {
    const date = new Date(seconds * 1000);
    const today = new Date().toDateString() === date.toDateString();
    return date.toLocaleString(i18n.locale(), today ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  }
  // One line about the window's pace, or null while it is too early to tell.
  // Kept to one short line: the limit time when the pace runs out first, else the daily budget
  // of a multi-day window, else the projection at the reset.
  function paceLine(estimate) {
    if (!estimate) return null;
    if (estimate.limitAt) return { text: t('app.pace.limit', { when: clock(estimate.limitAt) }), warn: true };
    if (estimate.perDay !== null) return { text: t('app.pace.perDay', { percent: compactPercent(estimate.perDay) }), warn: false };
    if (estimate.projected !== null) return { text: t('app.pace.projected', { percent: compactPercent(Math.min(100, estimate.projected)) }), warn: false };
    return null;
  }
  const claudeLoginProblem = (provider) => provider.id === 'claude' && ['missing', 'expired', 'rejected'].includes(provider.integration?.login);

  function connectionGuide(provider) {
    const integration = provider.integration || {};
    if (provider.id === 'claude') {
      // The account API needs only the Claude Code login; the status-line bridge is an extra source.
      // The account API needs only the Claude Code login; the CLI's own sign-in provides it.
      if (integration.login === 'missing') return { title: t('app.guide.claudeLoginTitle'), message: t('app.guide.claudeLoginMessage'), action: t('app.action.signInClaude') };
      if (integration.login === 'expired' || integration.login === 'rejected') return { title: t('app.guide.claudeRenewTitle'), message: t('app.guide.claudeRenewMessage'), action: t('app.action.renewLogin') };
      return { title: t('app.guide.claudeQueryingTitle'), message: provider.status === 'error' ? provider.message || t('app.guide.claudeQueryingMessage') : t('app.guide.claudeQueryingMessage'), action: t('app.action.refresh') };
    }
    if (integration.cliAvailable === false) return { title: t('app.guide.codexMissingTitle'), message: t('app.guide.codexMissingMessage'), action: t('app.action.connectCodex') };
    if (integration.authenticated === false) return { title: t('app.guide.codexSignInTitle'), message: t('app.guide.codexSignInMessage'), action: t('app.action.signInCodex') };
    return { title: t('app.guide.codexConnectTitle'), message: provider.message || t('app.guide.codexConnectMessage'), action: t('app.action.connect') };
  }

  async function connectProvider(provider) {
    if (!bridge) return showNotice(t('app.notice.demoNoConnect'));
    if (provider.id === 'codex') return bridge.connectCodex();
    if (claudeLoginProblem(provider)) {
      await bridge.loginClaude();
      return showNotice(t('app.notice.claudeLoginOpened'), true);
    }
    return bridge.refresh();
  }

  function renderProvider(provider) {
    const fragment = byId('provider-template').content.cloneNode(true);
    const card = fragment.querySelector('.provider-card');
    card.dataset.provider = provider.id;
    card.classList.toggle('context-active', state.settings.followActiveApp && provider.id === state.context?.provider);
    card.querySelector('h2').textContent = provider.name || (provider.id === 'codex' ? 'Codex' : 'Claude Code');
    const mascot = mascots.create(provider.id, { size: provider.id === 'claude' ? 30 : 28, id: `card-${provider.id}` });
    mascots.setMood(mascot, moodFor(provider));
    card.querySelector('.provider-symbol').replaceChildren(mascot || '');
    const badge = card.querySelector('.provider-state');
    const windows = usableWindows(provider);
    const critical = criticalWindow(provider);
    const hasData = windows.length > 0;
    const guide = connectionGuide(provider);
    const outdated = hasData && stale(provider);
    const labels = { ready: hasExpired(provider) ? t('app.status.awaitingReading') : outdated ? t('app.status.oldReading') : t('app.status.connected'), waiting: t('app.status.awaitingSession'), disconnected: t('app.status.notConnected'), error: t('app.status.checkConnection') };
    const focusedAndHealthy = state.settings.followActiveApp && provider.id === state.context?.provider && provider.status === 'ready' && !outdated && !hasExpired(provider);
    badge.textContent = focusedAndHealthy ? t('app.status.inFocus') : !hasData && provider.integration?.installed && provider.status !== 'error' ? t('app.status.configured') : labels[provider.status] || t('app.status.noReading');
    badge.classList.toggle('warning', outdated || hasExpired(provider) || provider.status === 'waiting');
    badge.classList.toggle('error', provider.status === 'error');
    badge.title = provider.message || '';
    const content = card.querySelector('.provider-content');

    if (hasData) {
      const windowsNode = element('div', 'windows');
      // Providers can expose multiple independent limits. Keep all of them visible.
      windows.forEach((usage) => {
        const row = element('div', 'usage-window');
        const old = expired(usage) || outdated || provider.status !== 'ready';
        row.classList.toggle('reading-old', old);
        const label = element('div', 'window-label', limitLabel(usage));
        const balance = element('div', 'window-balance');
        balance.append(element('strong', remaining(usage) <= 15 ? 'low' : '', `${percent(remaining(usage))}%`), element('span', '', t('app.quota.left')));
        const used = element('p', 'window-used', t(old ? 'app.quota.usedOld' : 'app.quota.used', { used: percent(usage.usedPercent) }));
        const meter = element('div', 'meter');
        meter.setAttribute('role', 'meter');
        meter.setAttribute('aria-label', t(old ? 'app.meter.labelOld' : 'app.meter.label', { name: provider.name, limit: limitLabel(usage) }));
        meter.setAttribute('aria-valuemin', '0');
        meter.setAttribute('aria-valuemax', '100');
        meter.setAttribute('aria-valuenow', String(remaining(usage)));
        meter.setAttribute('aria-valuetext', t(old ? 'app.meter.valueOld' : 'app.meter.value', { left: percent(remaining(usage)), used: percent(usage.usedPercent) }));
        const fill = element('div', `meter-fill${remaining(usage) <= 15 ? ' low' : ''}`);
        fill.style.width = `${remaining(usage)}%`;
        meter.append(fill);
        // The tick marks where an even pace would leave you now; a fill left of it is running ahead.
        const estimate = old ? null : pace(usage);
        if (estimate && estimate.fraction < 0.98) {
          const tick = element('span', 'meter-pace');
          tick.style.left = `${100 - estimate.expectedUsed}%`;
          tick.title = t('app.pace.marker', { left: percent(100 - estimate.expectedUsed) });
          meter.append(tick);
        }
        const reset = element('div', 'window-reset', resetText(usage));
        if (usage.resetsAt) reset.title = t('app.reset.reported', { date: new Date(Number(usage.resetsAt) * 1000).toLocaleString(i18n.locale()) });
        row.append(label, balance, used, meter, reset);
        const line = paceLine(estimate);
        if (line) { const note = element('p', `window-pace${line.warn ? ' warn' : ''}`, line.text); note.title = t('app.pace.help'); row.append(note); }
        windowsNode.append(row);
      });
      content.append(windowsNode);
      // An expired sign-in keeps the last reading on screen; say why it stopped updating.
      if (claudeLoginProblem(provider)) content.append(element('p', 'login-warning', t('app.card.loginProblem')));
    } else {
      const empty = element('div', 'empty-content');
      empty.append(element('span', 'empty-value', '—'));
      const copy = element('div', 'onboarding-copy');
      copy.append(element('strong', '', guide.title), element('p', '', guide.message));
      empty.append(copy);
      content.append(empty);
    }

    const fresh = card.querySelector('.freshness');
    fresh.textContent = freshness(provider);
    fresh.title = [provider.source, provider.updatedAt ? new Date(provider.updatedAt).toLocaleString(i18n.locale()) : ''].filter(Boolean).join(' · ');
    fresh.classList.toggle('stale', outdated);
    const action = card.querySelector('.provider-action');
    const connected = hasData && provider.status !== 'disconnected' && !claudeLoginProblem(provider);
    action.textContent = connected ? t('app.action.openAccount') : guide.action;
    action.setAttribute('aria-label', t(connected ? 'app.action.openAccountFor' : 'app.action.connectFor', { name: provider.name }));
    action.disabled = !bridge && !demo;
    action.addEventListener('click', () => perform(action, async () => {
      if (connected) {
        if (demo && !bridge) return showNotice(t('app.notice.demoNoAccount'));
        await bridge.openUsage(provider.id);
      } else {
        return connectProvider(provider);
      }
    }));
    return fragment;
  }

  function emptyState(title, copy) {
    const panel = element('div', 'empty-state');
    panel.append(element('span', 'empty-state-mark', '—'), element('h3', '', title), element('p', '', copy));
    return panel;
  }

  function timestamp(value) {
    if (typeof value === 'number') return value < 10_000_000_000 ? value * 1000 : value;
    return new Date(value).getTime();
  }


  function chartFor(series) {
    const points = (series.points || []).map((point) => ({ ...point, time: timestamp(point.at) }))
      .filter((point) => Number.isFinite(point.time) && Number.isFinite(point.usedPercent)).sort((a, b) => a.time - b.time);
    if (!points.length) return null;
    const card = element('article', 'history-card');
    card.dataset.provider = series.providerId;
    const heading = element('div', 'history-card-heading');
    heading.append(element('h3', '', `${nameFor(series.providerId)} · ${limitLabel(series)}`), element('strong', '', t('app.quota.used', { used: percent(points.at(-1).usedPercent) })));
    card.append(heading);
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 320 112');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', t('app.chart.label', { name: nameFor(series.providerId), label: series.label || '', count: points.length, latest: percent(points.at(-1).usedPercent) }));
    svg.classList.add('history-chart');
    [0, 50, 100].forEach((level) => {
      const line = document.createElementNS(svgNS, 'line');
      const y = 92 - level * 0.76;
      line.setAttribute('x1', '37'); line.setAttribute('x2', '314'); line.setAttribute('y1', y); line.setAttribute('y2', y);
      line.classList.add('chart-grid'); svg.append(line);
      const label = document.createElementNS(svgNS, 'text');
      label.setAttribute('x', '0'); label.setAttribute('y', y + 4); label.textContent = `${level}%`;
      label.classList.add('chart-axis'); svg.append(label);
    });
    const first = points[0].time;
    const span = Math.max(1, points.at(-1).time - first);
    let path = '';
    points.forEach((point, index) => {
      const x = points.length === 1 ? 177 : 38 + (point.time - first) / span * 274;
      const y = 92 - Math.max(0, Math.min(100, point.usedPercent)) * 0.76;
      const previous = points[index - 1];
      const reset = previous && ((previous.resetsAt && point.resetsAt && !sameReset(previous.resetsAt, point.resetsAt)) || point.usedPercent < previous.usedPercent - 5);
      path += `${index === 0 || reset ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)} `;
      if (points.length === 1 || index === points.length - 1 || reset) {
        const dot = document.createElementNS(svgNS, 'circle');
        dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('r', '3'); dot.classList.add('chart-point');
        svg.append(dot);
      }
    });
    const line = document.createElementNS(svgNS, 'path');
    line.setAttribute('d', path); line.classList.add('chart-line'); svg.append(line);
    card.append(svg);
    const dates = element('div', 'chart-dates');
    const format = state.settings.historyRange === 'week' ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' };
    dates.append(element('span', '', new Date(first).toLocaleString(i18n.locale(), format)), element('span', '', points.length === 1 ? t('app.chart.firstReading') : new Date(points.at(-1).time).toLocaleString(i18n.locale(), format)));
    card.append(dates);
    const forecast = (analytics?.forecasts || []).find((item) => item.providerId === series.providerId && item.windowId === series.windowId);
    if (forecast) {
      const parts = [];
      if (forecast.status === 'limit') parts.push(t('app.forecast.limit', { when: clock(forecast.limitAt) }));
      else if (forecast.status === 'ok') parts.push(t('app.forecast.ok', { percent: compactPercent(Math.min(100, forecast.projected)) }));
      else parts.push(t(`app.forecast.${forecast.status}`));
      if (Number.isFinite(forecast.perDay)) parts.push(t('app.pace.perDay', { percent: compactPercent(forecast.perDay) }));
      if (Number.isFinite(forecast.usedToday)) parts.push(t('app.forecast.today', { percent: compactPercent(forecast.usedToday) }));
      const note = element('p', `forecast-note${forecast.status === 'limit' ? ' warn' : ''}`, parts.join(' · '));
      note.title = t('app.pace.help');
      card.append(note);
    }
    return card;
  }

  function renderAnalytics() {
    document.querySelectorAll('[data-range]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.range === state.settings.historyRange)));
    const target = byId('history-content');
    if (analyticsLoading && !analytics) return target.replaceChildren(emptyState(t('app.history.loadingTitle'), t('app.history.loadingCopy')));
    if (analyticsError) return target.replaceChildren(emptyState(t('app.history.errorTitle'), analyticsError));
    const charts = (analytics?.series || []).filter((series) => state.settings.visibleProviders.includes(series.providerId)).map(chartFor).filter(Boolean);
    target.replaceChildren(...(charts.length ? charts : [emptyState(t('app.history.emptyTitle'), t('app.history.emptyCopy'))]));
  }

  async function loadAnalytics(force = false) {
    if (analyticsLoading || (!force && analytics?.range === state.settings.historyRange)) return renderAnalytics();
    analyticsLoading = true; analyticsError = ''; renderAnalytics();
    const range = state.settings.historyRange;
    try {
      const result = bridge?.getAnalytics ? await bridge.getAnalytics({ range }) : { series: [], forecasts: [] };
      analytics = { ...result, range };
      analyticsLoadedAt = Date.now();
    } catch (error) { analyticsError = error.message || t('app.error.tryRefresh'); }
    finally {
      analyticsLoading = false;
      if (range !== state.settings.historyRange) { analytics = null; loadAnalytics(true); }
      else renderAnalytics();
    }
  }

  const compactNumber = (value) => new Intl.NumberFormat(i18n.locale(), { notation: 'compact', maximumFractionDigits: 1 }).format(Number.isFinite(Number(value)) ? Number(value) : 0);

  function renderLocalUsage() {
    document.querySelectorAll('[data-local-view]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.localView === localView)));
    const target = byId('projects-content');
    byId('local-usage-status').textContent = localLoading ? t('app.local.loadingStatus') : localUsage?.message || '';
    if (localError) return target.replaceChildren(emptyState(t('app.local.errorTitle'), localError));
    if (localLoading && !localUsage) return target.replaceChildren(emptyState(t('app.local.loadingTitle'), t('app.local.loadingCopy')));
    const rows = (localUsage?.[localView] || []).filter((entry) => {
      const providerIds = entry.providers || [entry.provider];
      return providerIds.some((id) => state.settings.visibleProviders.includes(id));
    });
    if (!rows.length) return target.replaceChildren(emptyState(t('app.local.emptyTitle'), t('app.local.emptyCopy')));
    const nodes = rows.map((entry) => {
      const row = element('article', 'project-card');
      const header = element('div', 'project-heading');
      // 'Projeto local' is the stored fallback for a folder with no name; show it in the current language.
      const name = entry.name || entry.projectName;
      const title = element('h3', '', name === 'Projeto local' ? t('local.defaultProject') : name || t('app.local.noProject'));
      title.title = title.textContent;
      // Cache reads are cheap repeats of the same context; the headline counts the rest.
      const headline = element('strong', '', compactNumber(Math.max(0, (entry.totalTokens || 0) - (entry.cachedTokens || 0))));
      headline.title = t('app.local.headlineHelp');
      header.append(title, headline);
      const providers = (entry.providers || [entry.provider]).filter(Boolean).map(nameFor).join(' + ');
      const detail = element('p', 'project-detail', localView === 'projects' ? t('app.local.detailProjects', { providers, count: entry.sessionCount || 0 }) : t('app.local.detailSessions', { providers }));
      const counts = element('dl', 'token-counts');
      [[t('app.local.input'), entry.inputTokens], [t('app.local.output'), entry.outputTokens], [t('app.local.cache'), entry.cachedTokens]].forEach(([label, value]) => {
        const pair = element('div'); pair.append(element('dt', '', label), element('dd', '', compactNumber(value))); counts.append(pair);
      });
      row.append(header, detail, counts);
      const partial = entry.partial || entry.measurement === 'observed_responses';
      if (partial) row.append(element('p', 'coverage-note', typeof entry.coverage === 'string' && entry.coverage || t('app.local.partialCoverage')));
      if (entry.lastActivity) row.append(element('p', 'activity-date', t('app.local.lastActivity', { date: new Date(timestamp(entry.lastActivity)).toLocaleString(i18n.locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) })));
      return row;
    });
    target.replaceChildren(...nodes);
  }

  async function loadLocalUsage(force = false) {
    if (localLoading || (!force && localUsage)) return renderLocalUsage();
    localLoading = true; localError = ''; renderLocalUsage();
    try {
      localUsage = bridge?.getLocalUsage ? await bridge.getLocalUsage() : { status: 'empty', projects: [], sessions: [], message: demo ? t('app.local.demoMessage') : '' };
      localLoadedAt = Date.now();
    }
    catch (error) { localError = error.message || t('app.error.tryRefresh'); }
    finally { localLoading = false; renderLocalUsage(); }
  }

  // Settings re-render on every state update; remember whether the bridge section is open.
  let bridgeSectionOpen = false;
  function renderIntegrations() {
    const focusedAction = byId('integration-settings').contains(document.activeElement) ? document.activeElement?.dataset?.integrationAction : null;
    const rows = (state.providers || []).map((provider) => {
      const row = element('article', 'integration-row');
      const guide = connectionGuide(provider);
      row.append(element('h4', '', provider.name || nameFor(provider.id)), element('p', '', criticalWindow(provider) ? `${freshness(provider)}. ${provider.source || ''}` : `${guide.title}. ${guide.message}`));
      const actions = element('div', 'integration-actions');
      const codexReady = provider.id === 'codex' && provider.integration?.authenticated === true;
      const label = provider.id === 'codex' ? (codexReady ? 'app.action.switchAccount' : 'app.action.connectAccount') : claudeLoginProblem(provider) ? (provider.integration.login === 'missing' ? 'app.action.signInClaudePlain' : 'app.action.renewLoginPlain') : 'app.action.switchAccount';
      const setup = element('button', 'secondary-button', t(label));
      setup.dataset.integrationAction = `setup-${provider.id}`;
      setup.addEventListener('click', () => perform(setup, async () => {
        if (provider.id === 'claude') {
          if (!bridge) return showNotice(t('app.notice.demoNoConnect'));
          await bridge.loginClaude();
          return showNotice(t('app.notice.claudeLoginOpened'), true);
        }
        return connectProvider(provider);
      }));
      actions.append(setup);
      row.append(actions);
      if (provider.id !== 'claude') return row;
      // The status-line bridge only feeds the terminal CLI; the account reading never needs it.
      const advanced = element('details', 'advanced bridge-advanced');
      advanced.open = bridgeSectionOpen;
      advanced.addEventListener('toggle', () => { bridgeSectionOpen = advanced.open; });
      advanced.append(element('summary', '', t('app.integration.bridgeTitle')), element('p', 'field-help', t('app.integration.bridgeHelp')));
      const bridgeActions = element('div', 'integration-actions');
      const install = element('button', 'secondary-button', t(provider.integration?.installed ? 'app.action.reconfigure' : 'app.action.setupIntegration'));
      install.dataset.integrationAction = 'bridge-claude';
      install.addEventListener('click', () => perform(install, async () => {
        if (!bridge) return showNotice(t('app.notice.demoNoConnect'));
        const result = await bridge.installClaudeBridge();
        showNotice(t('app.notice.integrationConfigured'));
        return result;
      }));
      bridgeActions.append(install);
      advanced.append(bridgeActions);
      if (provider.integration?.installed) {
        const remove = element('button', 'text-button danger-action', t('app.action.removeIntegration'));
        remove.dataset.integrationAction = 'remove-claude';
        remove.addEventListener('click', () => perform(remove, async () => {
          if (!bridge?.removeClaudeBridge) return showNotice(t('app.notice.removeUnavailable'));
          const result = await bridge.removeClaudeBridge();
          showNotice(t('app.notice.integrationRemoved'));
          return result;
        }));
        bridgeActions.append(remove);
      }
      row.append(advanced); return row;
    });
    byId('integration-settings').replaceChildren(...rows);
    if (focusedAction) byId('integration-settings').querySelector(`[data-integration-action="${focusedAction}"]`)?.focus({ preventScroll: true });
  }

  function syncInput(id, value) {
    if (document.activeElement !== byId(id)) byId(id).value = value;
  }

  function renderSettings() {
    syncInput('theme-select', state.settings.theme);
    syncInput('scale', Math.round(state.settings.scale * 100));
    syncInput('opacity', Math.round(state.settings.opacity * 100));
    syncInput('hide-delay', state.settings.hideDelayMs);
    byId('scale-output').textContent = `${byId('scale').value}%`;
    byId('opacity-output').textContent = `${byId('opacity').value}%`;
    byId('hide-delay-output').textContent = `${byId('hide-delay').value} ms`;
    document.querySelectorAll('[data-alert-left]').forEach((chip) => chip.setAttribute('aria-pressed', String(state.settings.alertThresholds.includes(100 - Number(chip.dataset.alertLeft)))));
    byId('notify-all').checked = state.settings.notifications !== false;
    byId('notify-done').checked = state.settings.notifyOnDone !== false;
    syncInput('update-repository', state.settings.updateRepository || state.updates?.repository || '');
    byId('notify-reset').checked = state.settings.notifyOnReset;
    byId('follow-active').checked = state.settings.followActiveApp;
    document.querySelectorAll('[data-visible-provider]').forEach((input) => { input.checked = state.settings.visibleProviders.includes(input.dataset.visibleProvider); });
    byId('context-help').textContent = state.context?.available === false
      ? t('app.settings.contextUnavailable')
      : t('app.settings.contextHelp');
    renderIntegrations();
    const update = state.updates || {};
    const statusText = { checking: t('app.update.checking'), available: t('app.update.available', { version: update.latestVersion || '' }), downloading: Number.isFinite(update.progress) ? t('app.update.downloadingProgress', { progress: Math.round(update.progress) }) : t('app.update.downloading'), downloaded: t('app.update.ready'), ready: t('app.update.ready'), installing: t('app.update.installing'), 'not-configured': t('app.update.notConfigured'), 'up-to-date': t('app.update.upToDate'), current: t('app.update.upToDate'), error: t('app.update.error') };
    byId('update-status').textContent = update.message || statusText[update.status] || t('app.update.idle');
    byId('download-update').hidden = update.status !== 'available';
    byId('install-update').hidden = !['downloaded', 'ready'].includes(update.status);
    byId('update-progress').hidden = update.status !== 'downloading';
    byId('update-progress').value = Number(update.progress) || 0;
    byId('check-update').disabled = ['checking', 'downloading'].includes(update.status) || (!bridge && !demo);
  }

  function renderTheme() {
    if (state.settings.followActiveApp && ['codex', 'claude'].includes(state.context?.provider) && lastFocusedProvider !== state.context.provider) {
      lastFocusedProvider = state.context.provider;
      try { window.localStorage.setItem('tv-last-provider', lastFocusedProvider); } catch { /* The theme still follows focus for this session. */ }
    }
    root.dataset.theme = state.settings.theme === 'auto' ? state.settings.followActiveApp && lastFocusedProvider || 'paceline' : state.settings.theme;
    root.dataset.themeMode = state.settings.theme;
    const themed = (state.providers || []).find((provider) => provider.id === root.dataset.theme);
    brandMarks.forEach((show) => show(root.dataset.theme, moodFor(themed)));
    byId('context-status').textContent = state.settings.followActiveApp && state.context?.provider
      ? t('app.theme.inFocus', { name: nameFor(state.context.provider).toUpperCase() })
      : state.settings.theme === 'auto' && state.settings.followActiveApp && lastFocusedProvider ? t('app.theme.named', { name: nameFor(lastFocusedProvider).toUpperCase() }) : t('app.theme.tagline');
  }

  function render() {
    const focusedProvider = document.activeElement?.closest('.provider-card')?.dataset.provider;
    const restoreProviderFocus = focusedProvider && document.activeElement?.classList.contains('provider-action');
    const providers = selectedProviders();
    byId('providers').replaceChildren(...providers.map(renderProvider));
    if (restoreProviderFocus) byId('providers').querySelector(`[data-provider="${focusedProvider}"] .provider-action`)?.focus();
    const ready = providers.filter((provider) => provider.status === 'ready' && criticalWindow(provider) && !stale(provider) && !hasExpired(provider));
    const status = byId('monitor-status');
    const dot = element('span', `signal-dot${ready.length ? ' live' : ''}`);
    status.replaceChildren(dot, document.createTextNode(ready.length ? t(ready.length === 1 ? 'app.monitor.connected.one' : 'app.monitor.connected.other', { count: ready.length }) : t('app.monitor.awaitingConnection')));
    root.dataset.edge = state.settings.edge;
    byId('metric-caption').textContent = t('app.monitor.caption');
    (state.providers || []).forEach((provider) => {
      const target = byId(`peek-${provider.id}`);
      if (!target) return;
      target.closest('.peek-provider').hidden = !state.settings.visibleProviders.includes(provider.id);
      target.closest('.peek-provider').style.order = providers.findIndex((item) => item.id === provider.id) + 3;
      const critical = criticalWindow(provider);
      // The collapsed bar reads "USO": it shows how much of the tightest limit is used.
      const used = critical ? Math.max(0, Math.min(100, critical.usedPercent)) : 0;
      target.textContent = critical && !hasExpired(provider) && !stale(provider) && provider.status === 'ready' ? `${compactPercent(used)}%` : '—';
      target.title = hasExpired(provider) ? t('peek.waiting', { name: provider.name })
        : critical ? t('peek.title', { name: provider.name, used: percent(used), left: percent(remaining(critical)), freshness: freshness(provider) })
          : t('peek.none', { name: provider.name });
      target.classList.toggle('stale', Boolean(critical) && stale(provider));
    });
    byId('peek').setAttribute('aria-label', t('peek.open', { details: providers.map((provider) => byId(`peek-${provider.id}`)?.title).filter(Boolean).join('. ') }));
    byId('peek-dot').className = `signal-dot${ready.length ? ' live' : ''}`;
    byId('pin').setAttribute('aria-pressed', String(state.settings.pinned));
    byId('pin').title = t(state.settings.pinned ? 'app.pin.unpin' : 'app.pin.keepOpen');
    byId('pin').setAttribute('aria-label', byId('pin').title);
    byId('launch-login').checked = Boolean(state.settings.launchAtLogin);
    document.querySelectorAll('[data-edge]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.edge === state.settings.edge));
    });
    byId('version').textContent = state.meta?.version ? `v${state.meta.version}` : '';
    byId('demo-badge').hidden = !(demo || state.demo);
    byId('footer-status').replaceChildren(element('span', 'signal-dot'), document.createTextNode(t(demo || state.demo ? 'app.footer.demo' : 'app.footer.local')));
    renderTheme();
    renderSettings();
    if (view === 'history') renderAnalytics();
    if (view === 'projects') renderLocalUsage();
  }

  function acceptState(next) {
    if (!next || !Array.isArray(next.providers)) return;
    const historyChanged = next.meta?.historyUpdatedAt !== state.meta?.historyUpdatedAt;
    const localChanged = next.meta?.localUsageUpdatedAt !== state.meta?.localUsageUpdatedAt;
    const platformChanged = Boolean(next.meta?.platform) && next.meta.platform !== state.meta?.platform;
    state = { ...state, ...next, settings: { ...state.settings, ...next.settings } };
    if (next.meta?.language && next.meta.language !== i18n.getLanguage()) changeLanguage(next.meta.language);
    else if (platformChanged) applyStaticTexts();
    if (state.settings.pinned) clearTimeout(collapseTimer);
    if (typeof next.expanded === 'boolean') applyExpanded(next.expanded);
    render();
    if (view === 'history' && historyChanged) loadAnalytics(true);
    if (view === 'projects' && localChanged) loadLocalUsage(true);
  }

  async function perform(button, action) {
    if (button.disabled) return;
    button.disabled = true;
    try { const next = await action(); if (next?.providers) acceptState(next); }
    catch (error) { showNotice(error.message || t('app.error.generic')); }
    finally { button.disabled = false; }
  }

  async function updateSettings(partial) {
    if (bridge) {
      const next = await bridge.updateSettings(partial);
      if (next?.providers) acceptState(next);
      else { state.settings = { ...state.settings, ...partial }; render(); }
    } else if (demo) {
      state.settings = { ...state.settings, ...partial };
      render();
    }
  }

  root.addEventListener('pointerenter', () => { pointerInside = true; setExpanded(true); });
  root.addEventListener('pointerleave', () => { pointerInside = false; scheduleCollapse(); });
  root.addEventListener('pointerdown', () => { keyboardFocus = false; });
  root.addEventListener('focusin', (event) => {
    clearTimeout(collapseTimer);
    setExpanded(true);
    if (event.target === byId('peek')) requestAnimationFrame(() => byId('pin').focus());
  });
  root.addEventListener('focusout', scheduleCollapse);
  byId('peek').addEventListener('click', () => { setExpanded(true); byId('pin').focus(); });
  byId('settings-toggle').addEventListener('click', () => toggleSettings(!settingsOpen));
  document.querySelectorAll('[data-language]').forEach((button) => button.addEventListener('click', () => perform(button, async () => {
    const { language } = button.dataset;
    changeLanguage(language);
    if (bridge) return updateSettings({ language });
    try { window.localStorage.setItem('tv-language', language); } catch { /* The choice still applies to this preview. */ }
  })));
  byId('settings-close').addEventListener('click', () => toggleSettings(false));
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
  document.querySelectorAll('[data-range]').forEach((button) => button.addEventListener('click', () => perform(button, async () => {
    await updateSettings({ historyRange: button.dataset.range });
    analytics = null;
    await loadAnalytics(true);
  })));
  document.querySelectorAll('[data-local-view]').forEach((button) => button.addEventListener('click', () => {
    localView = button.dataset.localView; renderLocalUsage(); loadLocalUsage();
  }));
  document.querySelectorAll('[data-visible-provider]').forEach((input) => input.addEventListener('change', async () => {
    const selected = [...document.querySelectorAll('[data-visible-provider]:checked')].map((control) => control.dataset.visibleProvider);
    if (!selected.length) { input.checked = true; showNotice(t('app.notice.keepOneVisible')); return; }
    try { await updateSettings({ visibleProviders: selected }); }
    catch (error) { showNotice(error.message || t('app.error.save')); render(); }
  }));
  byId('theme-select').addEventListener('change', async (event) => {
    try { await updateSettings({ theme: event.target.value }); }
    catch (error) { event.target.value = state.settings.theme; showNotice(error.message || t('app.error.theme')); }
  });
  [['scale', 'scale', 100, '%'], ['opacity', 'opacity', 100, '%'], ['hide-delay', 'hideDelayMs', 1, ' ms']].forEach(([id, key, divisor, suffix]) => {
    byId(id).addEventListener('input', () => { byId(`${id}-output`).textContent = `${byId(id).value}${suffix}`; });
    byId(id).addEventListener('change', async () => {
      try { await updateSettings({ [key]: Number(byId(id).value) / divisor }); }
      catch (error) { byId(id).value = state.settings[key] * divisor; renderSettings(); showNotice(error.message || t('app.error.saveSetting')); }
    });
  });
  [['notify-all', 'notifications'], ['notify-reset', 'notifyOnReset'], ['notify-done', 'notifyOnDone'], ['follow-active', 'followActiveApp']].forEach(([id, key]) => {
    byId(id).addEventListener('change', async (event) => {
      try { await updateSettings({ [key]: event.target.checked }); }
      catch (error) { event.target.checked = state.settings[key]; showNotice(error.message || t('app.error.save')); }
    });
  });
  // Chips speak in "% left" like the cards; settings keep the "% used" thresholds.
  document.querySelectorAll('[data-alert-left]').forEach((chip) => chip.addEventListener('click', () => perform(chip, async () => {
    const used = 100 - Number(chip.dataset.alertLeft);
    const current = state.settings.alertThresholds || [];
    const next = current.includes(used) ? current.filter((value) => value !== used) : [...current, used];
    await updateSettings({ alertThresholds: [...new Set(next)].sort((a, b) => a - b) });
  })));
  byId('repository-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const repository = byId('update-repository').value.trim();
    if (repository && !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository)) { showNotice(t('app.notice.repositoryInvalid')); return; }
    perform(event.submitter || byId('repository-form').querySelector('button'), async () => {
      await updateSettings({ updateRepository: repository });
      showNotice(t(repository ? 'app.notice.repositorySaved' : 'app.notice.repositoryRemoved'));
    });
  });
  [['check-update', 'checkForUpdates'], ['download-update', 'downloadUpdate'], ['install-update', 'installUpdate']].forEach(([id, method]) => {
    byId(id).addEventListener('click', () => perform(byId(id), async () => {
      if (!bridge?.[method]) return showNotice(t('app.notice.updatesInstalledOnly'));
      const result = await bridge[method]();
      if (result?.providers) return result;
      if (result?.status) { state.updates = { ...state.updates, ...result }; renderSettings(); }
    }));
  });

  const dragHandle = byId('drag-handle');
  dragHandle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !bridge?.moveOverlay) return;
    event.preventDefault(); dragging = true; clearTimeout(collapseTimer);
    dragHandle.setPointerCapture(event.pointerId); root.classList.add('is-dragging');
    bridge.moveOverlay({ x: event.screenX, y: event.screenY, phase: 'start' }).catch((error) => showNotice(error.message || t('app.error.move')));
  });
  dragHandle.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    pendingDrag = { x: event.screenX, y: event.screenY, phase: 'move' };
    if (!dragFrame) dragFrame = requestAnimationFrame(() => {
      dragFrame = null;
      if (pendingDrag) bridge.moveOverlay(pendingDrag).catch(() => {});
      pendingDrag = null;
    });
  });
  const endDrag = (event) => {
    if (!dragging) return;
    dragging = false; root.classList.remove('is-dragging');
    if (dragFrame) cancelAnimationFrame(dragFrame);
    dragFrame = null; pendingDrag = null;
    if (dragHandle.hasPointerCapture(event.pointerId)) dragHandle.releasePointerCapture(event.pointerId);
    bridge.moveOverlay({ x: event.screenX, y: event.screenY, phase: 'end' }).catch((error) => showNotice(error.message || t('app.error.savePosition')));
    scheduleCollapse();
  };
  dragHandle.addEventListener('pointerup', endDrag);
  dragHandle.addEventListener('pointercancel', endDrag);
  byId('pin').addEventListener('click', () => perform(byId('pin'), async () => {
    const pinned = !state.settings.pinned;
    if (bridge) {
      const next = await bridge.pin(pinned);
      if (next?.providers) acceptState(next);
      else { state.settings.pinned = pinned; render(); }
    } else if (demo) { state.settings.pinned = pinned; render(); }
    if (!pinned) scheduleCollapse();
  }));
  document.querySelectorAll('[data-edge]').forEach((button) => {
    button.addEventListener('click', () => perform(button, () => updateSettings({ edge: button.dataset.edge })));
  });
  byId('launch-login').addEventListener('change', async (event) => {
    try { await updateSettings({ launchAtLogin: event.target.checked }); }
    catch (error) { render(); showNotice(error.message || t('app.error.launch')); }
  });
  byId('refresh').addEventListener('click', () => perform(byId('refresh'), async () => {
    root.classList.add('is-refreshing');
    try {
      if (bridge) {
        const next = await bridge.refresh();
        if (view === 'history') await loadAnalytics(true);
        if (view === 'projects') await loadLocalUsage(true);
        return next;
      }
      if (demo) { state.providers.forEach((provider) => { provider.updatedAt = new Date().toISOString(); }); render(); }
    } finally { root.classList.remove('is-refreshing'); }
  }));
  byId('quit').addEventListener('click', () => perform(byId('quit'), async () => {
    if (bridge) await bridge.quit();
    else showNotice(t('app.notice.previewQuit'));
  }));
  document.addEventListener('keydown', async (event) => {
    keyboardFocus = true;
    if (event.key !== 'Escape') return;
    event.preventDefault();
    byId('notice').hidden = true;
    if (settingsOpen) { toggleSettings(false); byId('settings-toggle').focus(); return; }
    if (view !== 'monitor') { switchView('monitor'); byId('view-nav').querySelector('[data-view="monitor"]').focus(); return; }
    if (state.settings.pinned) {
      try { if (bridge) await bridge.pin(false); state.settings.pinned = false; render(); }
      catch (error) { showNotice(error.message || t('app.error.unpin')); return; }
    }
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    await setExpanded(false);
  });

  if (demo && !bridge) {
    const now = Math.floor(Date.now() / 1000);
    state = {
      ...state, expanded: true, demo: true, meta: { version: '0.4.0' },
      providers: [
        { id: 'codex', name: 'Codex', status: 'ready', get source() { return t('app.demo.source'); }, updatedAt: new Date().toISOString(), windows: [
          { id: 'primary', label: '5 horas', usedPercent: 24, resetsAt: now + 7800, windowMinutes: 300 },
          { id: 'secondary', label: '7 dias', usedPercent: 39, resetsAt: now + 284400, windowMinutes: 10080 },
        ] },
        { id: 'claude', name: 'Claude Code', status: 'ready', get source() { return t('app.demo.source'); }, updatedAt: new Date(Date.now() - 120000).toISOString(), windows: [
          { id: 'primary', label: '5 horas', usedPercent: 62, resetsAt: now + 4380, windowMinutes: 300 },
          { id: 'secondary', label: '7 dias', usedPercent: 31, resetsAt: now + 389100, windowMinutes: 10080 },
        ] },
      ],
    };
    applyExpanded(true);
  }
  applyStaticTexts();
  render();
  const ticker = setInterval(() => {
    render();
    if (view === 'history' && Date.now() - analyticsLoadedAt >= 30_000) loadAnalytics(true);
    if (view === 'projects' && Date.now() - localLoadedAt >= 30_000) loadLocalUsage(true);
  }, 30_000);
  let unsubscribe;
  if (bridge) {
    unsubscribe = bridge.onState(acceptState);
    bridge.getState().then(acceptState).catch((error) => { setExpanded(true); showNotice(error.message || t('app.error.load')); });
  } else if (!demo) {
    applyExpanded(true);
    [byId('pin'), byId('refresh'), byId('launch-login'), ...document.querySelectorAll('[data-edge]')].forEach((control) => { control.disabled = true; });
  }
  window.addEventListener('beforeunload', () => { clearInterval(ticker); clearTimeout(collapseTimer); clearTimeout(noticeTimer); unsubscribe?.(); });
})();
