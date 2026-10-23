'use strict';

const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, shell, screen, globalShortcut, Notification, powerMonitor, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { overlayBounds } = require('./geometry.cjs');
const { dataDirectory, adoptLegacyData, readSettings, writeSettings, safeSettings, permittedExternalURL, atomicJSON } = require('./settings.cjs');
const { ActiveContext } = require('./active-context.cjs');
const { NotificationTracker } = require('./notifications.cjs');
const { AnalyticsStore, forecast } = require('./analytics.cjs');
const { LocalUsageCollector } = require('./local-usage.cjs');
const { UpdateManager } = require('./updates.cjs');
const { loginShellPath } = require('./shell-path.cjs');
const { percent: quotaPercent, remaining: quotaRemaining } = require('../renderer/quota-format.js');
const i18n = require('../renderer/i18n.js');
// Errors before app ready (data folder) need a language too: start from the OS locale.
i18n.setLanguage(Intl.DateTimeFormat().resolvedOptions().locale);

app.setName('Paceline');
app.enableSandbox();
// Defence in depth for every web contents, present or future: no new windows, navigation or webviews.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', event => event.preventDefault());
  contents.on('will-redirect', event => event.preventDefault());
  contents.on('will-attach-webview', event => event.preventDefault());
});
const smoke = process.argv.includes('--smoke-test');
const demo = smoke || process.argv.includes('--demo');
const root = path.resolve(__dirname, '../..');
const uninstallIntegration = process.argv.includes('--uninstall-integration');
const executableDir = path.dirname(process.env.PORTABLE_EXECUTABLE_FILE || process.execPath);
const storageMarker = path.join(executableDir, 'storage-location.json');
let dataDir = dataDirectory({ packaged: app.isPackaged, appPath: root, executable: process.execPath });
if (uninstallIntegration) {
  const index = process.argv.indexOf('--data-dir');
  if (!process.env.PACELINE_HOME && index >= 0 && path.isAbsolute(process.argv[index + 1] || '')) dataDir = path.resolve(process.argv[index + 1]);
  try {
    const marker = JSON.parse(fs.readFileSync(storageMarker, 'utf8'));
    if (!process.env.PACELINE_HOME && typeof marker.dataDir === 'string' && path.isAbsolute(marker.dataDir)) dataDir = marker.dataDir;
  } catch { /* Older installations have no storage marker. */ }
}
// Before anything creates the new data folder, take over the one from the TOKEN-VAULT builds.
let migratedData = false;
if (app.isPackaged && !uninstallIntegration && !process.env.PACELINE_HOME) ({ dataDir, migrated: migratedData } = adoptLegacyData(dataDir));
const runtimeDir = demo ? path.join(dataDir, 'demo') : dataDir;
if (uninstallIntegration) {
  require(path.join(root, 'scripts/install-claude-bridge.cjs')).uninstallClaudeBridge({ dataDir })
    .then(() => app.exit(0)).catch(() => app.exit(1));
} else {
try {
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(runtimeDir, 'cache'), { recursive: true });
  app.setPath('userData', runtimeDir);
  app.setPath('sessionData', path.join(runtimeDir, 'cache'));
  app.setPath('crashDumps', path.join(runtimeDir, 'crashes'));
  app.setAppLogsPath(path.join(runtimeDir, 'app-logs'));
  // The marker serves the Windows uninstaller; on macOS it would land inside the signed app bundle.
  if (app.isPackaged && !demo && process.platform === 'win32') atomicJSON(storageMarker, { dataDir });
} catch {
  dialog.showErrorBox('Paceline', i18n.t('main.dataDirError'));
  app.exit(1);
}

if (!app.requestSingleInstanceLock()) app.quit();
else start();
}

function start() {
  let win;
  let tray;
  let trayMenu;
  let providers = [];
  let expanded = demo;
  let quitting = false;
  let refreshing = null;
  // The smoke test asserts Portuguese labels, so it never follows the machine's language.
  let settings = smoke ? safeSettings({ language: 'pt' }) : readSettings(runtimeDir);
  const applyLanguage = () => i18n.setLanguage(settings.language === 'auto' ? app.getLocale() : settings.language);
  let timer;
  let claudeTimer;
  let heartbeat;
  let context;
  let activity;
  let dragging = null;
  // Apps opened from Finder do not see the terminal's PATH; ask the login shell while the app starts.
  const shellPath = process.platform === 'darwin' && !demo ? loginShellPath() : null;
  const analytics = new AnalyticsStore({ dataDir: runtimeDir });
  const localUsage = new LocalUsageCollector({ dataDir: runtimeDir });
  const notifications = new NotificationTracker({ dataDir: runtimeDir });
  const updates = new UpdateManager({ currentVersion: app.getVersion(), dataDir: runtimeDir, getRepository: () => settings.updateRepository,
    emit: () => publish(), install: async installer => {
      if (!app.isPackaged || demo) throw Object.assign(new Error(i18n.t('main.installPackagedOnly')), { i18nKey: 'main.installPackagedOnly' });
      if (process.platform === 'darwin') {
        // The verified disk image opens in Finder; quitting lets it replace the app in Applications.
        const error = await shell.openPath(installer);
        if (error) throw new Error(error);
        app.quit();
        return;
      }
      // Portable users choose an installation folder in the installer. Installed users retain theirs.
      // --force-run reopens Paceline once the silent install finishes; /D must come last.
      const args = process.env.PORTABLE_EXECUTABLE_FILE ? [] : ['/S', '--force-run', `/D=${executableDir}`];
      // NSIS ignores a quoted /D=, and Node quotes any argument with a space: pass the line verbatim.
      await new Promise((resolve, reject) => {
        const child = spawn(installer, args, { argv0: `"${installer}"`, windowsVerbatimArguments: true, detached: true, windowsHide: true, stdio: 'ignore' });
        child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
      });
      app.quit();
    }
  });
  const rendererURL = pathToFileURL(path.join(root, 'src/renderer/index.html')).href;

  // Demo texts hold i18n keys and are translated when sent, so a language switch applies to them.
  const demoStates = [
    { id: 'codex', name: 'Codex', status: 'ready', source: 'main.demoSource', message: '', updatedAt: new Date().toISOString(), windows: [{ id: 'primary', label: 'main.demoWeekly', usedPercent: 39, resetsAt: Math.floor(Date.now() / 1000) + 205200, windowMinutes: 10080 }] },
    { id: 'claude', name: 'Claude Code', status: 'ready', source: 'main.demoSource', message: '', updatedAt: new Date().toISOString(), windows: [{ id: 'five_hour', label: 'main.demoFiveHours', usedPercent: 24, resetsAt: Math.floor(Date.now() / 1000) + 8280, windowMinutes: 300 }, { id: 'seven_day', label: 'main.demoWeekly', usedPercent: 68, resetsAt: Math.floor(Date.now() / 1000) + 324000, windowMinutes: 10080 }] }
  ];
  const demoHistory = {
    updatedAt: new Date().toISOString(), forecasts: [],
    series: demoStates.flatMap(p => p.windows.map(w => ({ providerId: p.id, providerName: p.name, windowId: w.id, label: w.label, windowMinutes: w.windowMinutes,
      points: Array.from({ length: 25 }, (_, i) => ({ at: new Date(Date.now() - (24 - i) * 900000).toISOString(), usedPercent: Math.max(0, w.usedPercent - (24 - i) * 1.2), resetsAt: w.resetsAt }))
    })))
  };
  const demoLocalUsage = { status: 'partial', updatedAt: new Date().toISOString(), message: 'main.demoLocalUsage', projects: [
    { id: 'demo-project', name: 'main.demoProjectName', providers: ['codex', 'claude'], sessionCount: 3, inputTokens: 185000, outputTokens: 18000, cachedTokens: 120000, totalTokens: 203000, lastActivity: new Date().toISOString(), partial: true }
  ], sessions: [{ id: 'demo-session', provider: 'codex', projectName: 'main.demoProjectName', inputTokens: 95000, outputTokens: 12000, cachedTokens: 60000, totalTokens: 107000, lastActivity: new Date().toISOString(), partial: false, measurement: 'cumulative_session' }] };
  const localDemoStates = () => demoStates.map(p => ({ ...p, source: i18n.t(p.source), windows: p.windows.map(w => ({ ...w, label: i18n.t(w.label) })) }));
  const localDemoHistory = () => ({ ...demoHistory, forecasts: demoHistory.series.map(s => forecast(s, Date.now())), series: demoHistory.series.map(s => ({ ...s, label: i18n.t(s.label) })) });
  const localDemoUsage = () => ({ ...demoLocalUsage, message: i18n.t(demoLocalUsage.message),
    projects: demoLocalUsage.projects.map(p => ({ ...p, name: i18n.t(p.name) })),
    sessions: demoLocalUsage.sessions.map(s => ({ ...s, projectName: i18n.t(s.projectName) })) });

  function snapshot() {
    return {
      providers: demo ? localDemoStates() : providers.map(p => p.getState()),
      settings,
      expanded,
      demo,
      context: { ...(context?.getState() || { provider: null, available: false, message: i18n.t(settings.followActiveApp ? 'main.contextWaiting' : 'main.contextDisabled') }), mode: settings.followActiveApp ? 'auto' : 'manual' },
      updates: updates.getState(),
      // Whether each agent is running a turn right now; the demo shows Claude at work.
      activity: demo ? { claude: { status: 'working', turnStartedAt: null, finishedAt: null }, codex: { status: 'idle', turnStartedAt: null, finishedAt: null } } : activity?.getState() || null,
      meta: { version: app.getVersion(), dataDir, platform: process.platform, packaged: app.isPackaged, historyUpdatedAt: analytics.updatedAt, localUsageUpdatedAt: localUsage.updatedAt, language: i18n.getLanguage() }
    };
  }

  function publish() {
    const state = snapshot();
    if (!demo) { analytics.record(state.providers); state.meta.historyUpdatedAt = analytics.updatedAt; }
    if (win && !win.isDestroyed() && !win.webContents.isLoading()) win.webContents.send('paceline:state', state);
    if (tray && !tray.isDestroyed()) {
      const summary = state.providers.filter(p => settings.visibleProviders.includes(p.id)).map(p => {
        const w = (p.windows || []).filter(w => !w.resetsAt || w.resetsAt * 1000 > Date.now()).sort((a, b) => b.usedPercent - a.usedPercent)[0];
        return `${p.name}: ${w ? i18n.t('main.trayRemaining', { percent: quotaPercent(quotaRemaining(w)) }) : i18n.t('main.trayWaiting')}`;
      }).join(' · ');
      tray.setToolTip(`Paceline · ${summary}`.slice(0, 120));
    }
    maybeNotify();
  }

  function currentDisplay() {
    return screen.getAllDisplays().find(d => d.id === settings.displayId) || screen.getPrimaryDisplay();
  }

  function place() {
    if (win && !win.isDestroyed()) {
      win.setBounds(overlayBounds(currentDisplay().workArea, settings.edge, expanded, settings), false);
      win.webContents.setZoomFactor(settings.scale);
      win.setOpacity(settings.opacity);
    }
  }

  function syncContext() {
    if (demo || !settings.followActiveApp) { context?.close(); context = null; return; }
    if (!context) { context = new ActiveContext(); context.on('change', publish); context.start(); }
  }

  function setExpanded(value, focus = false) {
    expanded = Boolean(value);
    place();
    if (win && !win.isDestroyed()) {
      win.showInactive();
      // A menu-bar app on macOS is not active by default; activate it so the panel takes keys.
      if (focus) { if (process.platform === 'darwin') app.focus({ steal: true }); win.show(); win.focus(); }
    }
    publish();
  }

  function save(patch) {
    if (Object.hasOwn(patch, 'edge') || Object.hasOwn(patch, 'displayId')) patch = { ...patch, position: null };
    const next = safeSettings(patch, settings);
    if (next.launchAtLogin !== settings.launchAtLogin) {
      if (!app.isPackaged || !['win32', 'darwin'].includes(process.platform)) {
        throw new Error(i18n.t('main.launchAtLoginUnavailable'));
      }
      if (process.platform === 'darwin') {
        app.setLoginItemSettings({ openAtLogin: next.launchAtLogin });
        // macOS may hold an unsigned login item for approval; report it rather than show a false switch.
        if (app.getLoginItemSettings().openAtLogin !== next.launchAtLogin) throw new Error(i18n.t('main.launchAtLoginFailed'));
      } else {
        const executable = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
        app.setLoginItemSettings({ openAtLogin: next.launchAtLogin, path: executable, args: [] });
      }
    }
    writeSettings(runtimeDir, next);
    const languageChanged = next.language !== settings.language;
    settings = next;
    if (languageChanged) applyLanguage();
    syncContext();
    if (settings.pinned) expanded = true;
    place();
    buildMenu();
    publish();
    // Provider messages are composed in the main process; refresh them in the new language.
    if (languageChanged) void refresh();
  }

  // Shown notifications are kept referenced until closed, or their click handler is collected.
  const shownNotices = new Set();
  function notify({ title, body }) {
    if (!Notification.isSupported()) return;
    const notice = new Notification({ title, body, silent: true });
    shownNotices.add(notice);
    notice.on('click', () => setExpanded(true, true));
    notice.on('close', () => shownNotices.delete(notice));
    notice.show();
  }
  function maybeNotify() {
    if (demo) return;
    let notices = [];
    try { notices = notifications.update(providers.map(p => p.getState()), settings); } catch { /* Current readings remain usable when persistence temporarily fails. */ }
    for (const notice of notices) notify(notice);
  }

  // Local logs are read in bounded rounds; while a backlog remains, the next round comes soon.
  let localTimer;
  async function refreshLocal() {
    clearTimeout(localTimer);
    await localUsage.refresh();
    analytics.importReadings(localUsage.takeReadings());
    if (localUsage.backlog && !quitting) localTimer = setTimeout(() => { void refreshLocal().then(publish).catch(() => {}); }, 1000);
  }
  async function refresh() {
    if (demo) { publish(); return; }
    if (refreshing) return refreshing;
    refreshing = Promise.allSettled([...providers.map(p => p.refresh()), refreshLocal()]).then(() => publish()).finally(() => { refreshing = null; });
    return refreshing;
  }

  function buildMenu() {
    if (!tray) return;
    const items = [
      { label: i18n.t('main.menuOpen'), click: () => setExpanded(true, true) },
      { label: i18n.t('main.menuKeepOpen'), type: 'checkbox', checked: settings.pinned, click: item => save({ pinned: item.checked }) },
      { label: i18n.t('main.menuRefresh'), click: () => { void refresh(); } },
      { type: 'separator' },
      { label: i18n.t('main.menuEdge'), submenu: [['top', 'main.edgeTop'], ['right', 'main.edgeRight'], ['bottom', 'main.edgeBottom'], ['left', 'main.edgeLeft']].map(([edge, key]) => ({ label: i18n.t(key), type: 'radio', checked: settings.edge === edge, click: () => save({ edge }) })) },
      { label: i18n.t('main.menuDisplays'), submenu: screen.getAllDisplays().map((display, index) => ({ label: i18n.t(display.id === screen.getPrimaryDisplay().id ? 'main.menuDisplayPrimary' : 'main.menuDisplay', { number: index + 1 }), type: 'radio', checked: currentDisplay().id === display.id, click: () => save({ displayId: display.id }) })) },
      { label: i18n.t('main.menuAlerts'), type: 'checkbox', checked: settings.notifications, click: item => save({ notifications: item.checked }) },
      { type: 'separator' },
      { label: i18n.t('main.menuDataFolder'), click: () => { void shell.openPath(dataDir); } },
      { label: i18n.t('main.menuQuit'), click: () => app.quit() }
    ];
    // On macOS an attached menu would take over the left click, which opens the panel everywhere else.
    trayMenu = Menu.buildFromTemplate(items);
    if (process.platform !== 'darwin') tray.setContextMenu(trayMenu);
  }

  function validSender(event) {
    return win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && event.senderFrame.url.split('?')[0] === rendererURL;
  }

  ipcMain.handle('paceline:state', event => {
    if (!validSender(event)) throw new Error('Invalid sender');
    return snapshot();
  });
  ipcMain.handle('paceline:action', async (event, action, value) => {
    if (!validSender(event)) throw new Error('Invalid sender');
    try {
      switch (action) {
        case 'expand': setExpanded(Boolean(value)); break;
        case 'pin': save({ pinned: Boolean(value) }); break;
        case 'refresh': await refresh(); break;
        case 'getAnalytics': return demo ? localDemoHistory() : analytics.getSummary({ range: value?.range === 'week' ? 'week' : 'day' });
        case 'getLocalUsage': return demo ? localDemoUsage() : localUsage.getSummary();
        case 'checkForUpdates':
        case 'downloadUpdate':
        case 'installUpdate':
          if (demo) throw new Error(i18n.t('main.demoNoUpdates'));
          return await updates[{ checkForUpdates: 'check', downloadUpdate: 'download', installUpdate: 'install' }[action]]();
        case 'moveOverlay': {
          if (!value || !['start', 'move', 'end'].includes(value.phase) || !Number.isFinite(value.x) || !Number.isFinite(value.y) || Math.abs(value.x) > 100000 || Math.abs(value.y) > 100000) throw new Error(i18n.t('main.invalidPosition'));
          if (value.phase === 'start') dragging = { x: value.x, y: value.y, bounds: win.getBounds() };
          else if (dragging) {
            const x = Math.round(dragging.bounds.x + value.x - dragging.x), y = Math.round(dragging.bounds.y + value.y - dragging.y);
            const display = screen.getDisplayNearestPoint({ x: Math.round(x + dragging.bounds.width / 2), y: Math.round(y + dragging.bounds.height / 2) });
            settings = safeSettings({ position: { x, y }, displayId: display.id }, settings);
            place();
            if (value.phase === 'end') { dragging = null; writeSettings(runtimeDir, settings); buildMenu(); publish(); }
          }
          break;
        }
        case 'updateSettings':
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(i18n.t('main.invalidSettings'));
          save(value); break;
        case 'connectCodex':
          if (demo) throw new Error(i18n.t('main.demoNoConnections'));
          await providers.find(p => p.getState().id === 'codex').connect();
          break;
        case 'loginClaude': {
          if (demo) throw new Error(i18n.t('main.demoNoConnections'));
          if (!['win32', 'darwin'].includes(process.platform)) throw new Error(i18n.t('main.claudeLoginUnsupported'));
          const { findCommand } = require('../providers/codex.cjs');
          const executable = findCommand('claude');
          // The path is quoted into a command line below; Windows paths never contain quotes, and % would expand.
          if (!executable || /["%\r\n]/.test(executable)) throw new Error(i18n.t('main.claudeMissing'));
          if (process.platform === 'darwin') {
            // A .command file opens in the user's terminal app, where the official sign-in prompts and
            // browser link stay readable. Single quotes keep the path literal; the app never sees credentials.
            const script = path.join(runtimeDir, 'claude-login.command');
            fs.writeFileSync(script, `#!/bin/sh\nexec '${executable.replace(/'/g, `'\\''`)}' auth login\n`, { mode: 0o700 });
            fs.chmodSync(script, 0o700);
            await new Promise((resolve, reject) => {
              const child = spawn('/usr/bin/open', [script], { stdio: 'ignore', shell: false });
              child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
            });
          } else {
            // `start` gives the official CLI its own visible console, where its sign-in prompts and
            // browser link stay readable. The hidden cmd.exe exits at once; the app never sees credentials.
            await new Promise((resolve, reject) => {
              const cmd = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
              const child = spawn(cmd, ['/d', '/c', `start "Claude Code" "${executable}" auth login`], { windowsVerbatimArguments: true, windowsHide: true, stdio: 'ignore', shell: false });
              child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
            });
          }
          providers.find(p => p.getState().id === 'claude').retrySoon?.();
          return { ok: true, message: i18n.t('main.claudeLoginStarted') };
        }
        case 'installClaudeBridge': {
          if (demo) throw new Error(i18n.t('main.demoNoConnections'));
          const { installClaudeBridge } = require(path.join(root, 'scripts/install-claude-bridge.cjs'));
          await installClaudeBridge({ dataDir, scriptPath: path.join(root, 'scripts/claude-statusline.cjs') });
          await providers.find(p => p.getState().id === 'claude').refresh();
          publish();
          return { ok: true, message: i18n.t('main.bridgeInstalled') };
        }
        case 'removeClaudeBridge': {
          if (demo) throw new Error(i18n.t('main.demoNoConnections'));
          const { uninstallClaudeBridge } = require(path.join(root, 'scripts/install-claude-bridge.cjs'));
          const result = await uninstallClaudeBridge({ dataDir });
          await providers.find(p => p.getState().id === 'claude').refresh(); publish();
          return { ok: true, message: result.message };
        }
        case 'openDataFolder': await shell.openPath(dataDir); break;
        case 'openUsage': {
          const url = { codex: 'https://chatgpt.com/codex/settings/usage', claude: 'https://claude.ai/settings/usage' }[value];
          if (!url || !permittedExternalURL(url)) throw new Error(i18n.t('main.invalidDestination'));
          await shell.openExternal(url);
          break;
        }
        case 'quit': app.quit(); break;
        default: throw new Error(i18n.t('main.unknownAction'));
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: typeof error?.message === 'string' ? error.message.slice(0, 300) : i18n.t('main.actionFailed') };
    }
  });

  app.on('second-instance', () => setExpanded(true, true));
  app.on('activate', () => setExpanded(true, true));
  app.on('window-all-closed', () => { if (quitting) app.quit(); });
  app.on('before-quit', () => {
    quitting = true;
    clearInterval(timer); clearInterval(claudeTimer); clearInterval(heartbeat); clearTimeout(localTimer);
    context?.close(); activity?.close(); updates.close?.();
    globalShortcut.unregisterAll();
    for (const provider of providers) provider.close?.();
    if (tray && !tray.isDestroyed()) tray.destroy();
  });

  app.whenReady().then(async () => {
    // Windows-only API. On macOS the app lives in the menu bar, without a Dock icon.
    if (process.platform === 'win32') app.setAppUserModelId('io.paceline.desktop');
    if (process.platform === 'darwin') app.dock?.hide();
    applyLanguage();
    if (shellPath) process.env.PATH = await shellPath;
    if (!demo) {
      const { CodexProvider } = require('../providers/codex.cjs');
      const { ClaudeProvider } = require('../providers/claude.cjs');
      // A terminal bridge installed by a TOKEN-VAULT build still points at the old folder; re-point it.
      if (migratedData && fs.existsSync(path.join(dataDir, 'claude-bridge.json'))) {
        try { await require(path.join(root, 'scripts/install-claude-bridge.cjs')).installClaudeBridge({ dataDir, scriptPath: path.join(root, 'scripts/claude-statusline.cjs') }); }
        catch { /* Settings → Connections reports the bridge state and can reconfigure it. */ }
      }
      providers = [new CodexProvider({ dataDir }), new ClaudeProvider({ dataDir })];
      for (const provider of providers) {
        provider.on?.('update', publish);
        provider.on?.('change', publish);
        provider.on?.('open-url', url => {
          if (permittedExternalURL(url, true)) void shell.openExternal(url);
        });
      }
    }
    expanded = demo || settings.pinned;
    win = new BrowserWindow({
      ...overlayBounds(currentDisplay().workArea, settings.edge, expanded, settings),
      title: 'Paceline',
      icon: path.join(root, 'assets/icon.png'),
      frame: false, transparent: true, backgroundColor: '#00000000',
      alwaysOnTop: true, skipTaskbar: true, resizable: false,
      maximizable: false, minimizable: false, fullscreenable: false,
      hasShadow: false, show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: !app.isPackaged, spellcheck: false }
    });
    win.setAlwaysOnTop(true, 'floating');
    // macOS keeps windows per Space; the bar stays on every Space and above full-screen apps.
    if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    place();
    // Deterministic UI smoke: physical cursor position must not override injected pointer events.
    if (smoke) win.setIgnoreMouseEvents(true);
    win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    win.webContents.session.setPermissionCheckHandler(() => false);
    // The renderer is fully local. Provider and update requests run in Node, outside this session.
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file|data|devtools):/i.test(details.url) }));
    win.on('close', event => { if (!quitting) { event.preventDefault(); setExpanded(false); } });
    win.once('ready-to-show', () => win.showInactive());
    const icon = nativeImage.createFromPath(path.join(root, 'assets/icon.png'));
    if (!smoke) {
      // The macOS menu bar takes an 18-point icon; the 2x image keeps it sharp on Retina displays.
      tray = new Tray(process.platform === 'darwin' ? nativeImage.createFromBuffer(icon.resize({ width: 36, height: 36 }).toPNG(), { scaleFactor: 2 }) : icon.resize({ width: 20, height: 20 }));
      tray.on('click', event => { if (process.platform === 'darwin' && event.ctrlKey) tray.popUpContextMenu(trayMenu); else setExpanded(!expanded, true); });
      if (process.platform === 'darwin') tray.on('right-click', () => tray.popUpContextMenu(trayMenu));
      buildMenu();
      // Cmd+Option+V belongs to Finder ("Move item here"), so macOS uses Control+Option+V.
      globalShortcut.register(process.platform === 'darwin' ? 'Control+Alt+V' : 'CommandOrControl+Alt+V', () => setExpanded(!expanded, true));
    }
    if (!demo) {
      // Agent activity comes from the transcripts both CLIs write while a turn runs.
      const { AgentActivity } = require('./agent-activity.cjs');
      activity = new AgentActivity();
      const previous = {};
      activity.on('change', state => {
        for (const id of ['claude', 'codex']) {
          const now = state[id] || {};
          const started = Date.parse(now.turnStartedAt), finished = Date.parse(now.finishedAt);
          // A finished turn that ran for a minute or more is worth a notification; short replies are not.
          if (now.status === 'done' && previous[id] !== 'done' && finished - started >= 60000 && settings.notifications && settings.notifyOnDone && settings.visibleProviders.includes(id)) {
            const name = id === 'claude' ? 'Claude Code' : 'Codex';
            notify({ title: i18n.t('notify.doneTitle', { name }), body: i18n.t('notify.doneBody', { minutes: Math.round((finished - started) / 60000) }) });
          }
          previous[id] = now.status;
        }
        publish();
      });
      activity.start();
    }
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, () => { place(); buildMenu(); });
    powerMonitor.on('resume', () => { void refresh(); });
    await win.loadFile(path.join(root, 'src/renderer/index.html'));
    syncContext();
    publish();
    void refresh();
    timer = setInterval(() => { void refresh(); }, 60000);
    // Claude's collector is a local file only. Polling it makes no model requests.
    claudeTimer = setInterval(() => { if (!demo) void providers[1].refresh().then(publish).catch(() => {}); }, 3000);
    heartbeat = setInterval(publish, 30000);

    if (smoke) {
      setTimeout(async () => {
        try {
          const result = await win.webContents.executeJavaScript(`({ title: document.title, text: document.body.innerText, width: innerWidth, height: innerHeight, api: typeof window.paceline?.getState, overflowX: document.documentElement.scrollWidth > innerWidth })`);
          if (result.api !== 'function' || result.overflowX || !result.text.includes('Codex') || !result.text.includes('Claude')) throw new Error('Renderer did not pass smoke checks.');
          const output = path.join(runtimeDir, 'smoke.png');
          fs.writeFileSync(output, (await win.webContents.capturePage()).toPNG());
          await win.webContents.executeJavaScript(`window.paceline.expand(false)`);
          if (win.getBounds().width !== overlayBounds(currentDisplay().workArea, settings.edge, false, settings).width) throw new Error('Collapse geometry failed.');
          await win.webContents.executeJavaScript(`window.paceline.expand(true)`);
          if (win.getBounds().width !== 416) throw new Error('Expansion geometry failed.');
          await win.webContents.executeJavaScript(`document.getElementById('settings-toggle').click()`);
          const settingsVisible = await win.webContents.executeJavaScript(`!document.getElementById('settings').hidden && document.getElementById('monitor').hidden`);
          if (!settingsVisible) throw new Error('Settings did not open.');
          for (const edge of ['right', 'bottom', 'left', 'top']) {
            await win.webContents.executeJavaScript(`window.paceline.updateSettings({edge:${JSON.stringify(edge)}})`);
            const expected = overlayBounds(currentDisplay().workArea, edge, true);
            if (JSON.stringify(win.getBounds()) !== JSON.stringify(expected)) throw new Error('Edge positioning failed.');
          }
          const blockedLogin = await win.webContents.executeJavaScript(`window.paceline.connectCodex().then(() => false, () => true)`);
          if (!blockedLogin) throw new Error('Demo mode allowed a real login.');
          await win.webContents.executeJavaScript(`document.getElementById('settings-close').click()`);
          await win.webContents.executeJavaScript(`window.paceline.pin(true)`);
          const waitRender = () => new Promise(resolve => setTimeout(resolve, 350));
          // Synthetic focus drives the same state pipeline as the Windows helper.
          context = new ActiveContext({ platform: 'linux' });
          for (const provider of ['claude', 'codex']) {
            context.accept({ provider }); publish(); await waitRender();
            const theme = await win.webContents.executeJavaScript(`({theme:document.getElementById('paceline').dataset.theme,first:document.querySelector('.provider-card').dataset.provider})`);
            if (theme.theme !== provider || theme.first !== provider || !expanded) throw new Error('Automatic theme/order or pinned visibility failed.');
            fs.writeFileSync(path.join(runtimeDir, `smoke-${provider}.png`), (await win.webContents.capturePage()).toPNG());
          }
          // The demo marks Claude as running a turn: its card mascot must be busy, Codex's must not.
          const moods = await win.webContents.executeJavaScript(`({claude:document.querySelector('[data-provider="claude"] .mascot')?.dataset.mood||null,codex:document.querySelector('[data-provider="codex"] .mascot')?.dataset.mood||null})`);
          if (moods.claude !== 'working' || moods.codex === 'working') throw new Error('Agent activity did not reach the mascots: '+JSON.stringify(moods));
          const pace = await win.webContents.executeJavaScript(`document.querySelectorAll('.meter-pace').length`);
          if (!pace) throw new Error('Pace marker missing.');
          const quota = await win.webContents.executeJavaScript(`({remaining:document.querySelector('[data-provider="codex"] .window-balance').textContent,used:document.querySelector('[data-provider="codex"] .window-used').textContent,meter:document.querySelector('[data-provider="codex"] .meter').getAttribute('aria-valuenow'),toggle:document.querySelector('[data-metric-mode]')!==null})`);
          if (!quota.remaining.includes('61%') || !quota.used.includes('39%') || quota.meter !== '61' || quota.toggle) throw new Error('Quota meaning is ambiguous.');
          await win.webContents.executeJavaScript(`window.paceline.pin(false)`);
          for (const scale of [0.8, 1, 1.3]) for (const edge of ['left', 'right', 'top', 'bottom']) {
            await win.webContents.executeJavaScript(`window.paceline.updateSettings({edge:${JSON.stringify(edge)},scale:${scale}})`);
            await win.webContents.executeJavaScript(`window.paceline.expand(false)`); await waitRender();
            const actual = win.getBounds(), expected = overlayBounds(currentDisplay().workArea, edge, false, { ...settings, scale });
            if (Math.abs(actual.width - expected.width) > 1 || Math.abs(actual.height - expected.height) > 1) throw new Error('Collapsed edge dimensions failed: '+JSON.stringify({scale,edge,actual,expected}));
            const layout = await win.webContents.executeJavaScript(`({edge:document.getElementById('paceline').dataset.edge,direction:getComputedStyle(document.getElementById('peek')).flexDirection,overflow:document.getElementById('peek').scrollWidth>document.getElementById('peek').clientWidth || document.getElementById('peek').scrollHeight>document.getElementById('peek').clientHeight})`);
            if (layout.edge !== edge || layout.direction !== (['left','right'].includes(edge)?'column':'row') || layout.overflow) throw new Error('Collapsed orientation or clipping failed: '+JSON.stringify({scale,edge,...layout}));
            if (scale === 1 && ['right','top'].includes(edge)) fs.writeFileSync(path.join(runtimeDir, `smoke-peek-${edge}.png`), (await win.webContents.capturePage()).toPNG());
          }
          await win.webContents.executeJavaScript(`window.paceline.updateSettings({edge:'top',scale:1});window.paceline.pin(true)`);
          await win.webContents.executeJavaScript(`window.paceline.updateSettings({followActiveApp:false,theme:'paceline',metricMode:'used',visibleProviders:['codex'],scale:1.15,opacity:0.85,hideDelayMs:750,alertThresholds:[60,90],notifyOnReset:false})`);
          await waitRender();
          const personalized = await win.webContents.executeJavaScript(`({cards:document.querySelectorAll('.provider-card').length,label:document.getElementById('metric-caption').textContent,theme:document.getElementById('paceline').dataset.theme,overflow:document.documentElement.scrollWidth>innerWidth})`);
          if (personalized.cards !== 1 || personalized.label !== 'LIMITES DA ASSINATURA' || personalized.theme !== 'paceline' || personalized.overflow || win.getBounds().width !== 478 || Math.abs(win.getOpacity() - 0.85) > 0.01) throw new Error('Personalization failed.');
          await win.webContents.executeJavaScript(`window.paceline.updateSettings({scale:1,opacity:1,visibleProviders:['codex','claude'],metricMode:'remaining',hideDelayMs:450,theme:'paceline'})`);
          const beforeDrag = win.getBounds();
          await win.webContents.executeJavaScript(`(async()=>{await window.paceline.moveOverlay({phase:'start',x:100,y:100});await window.paceline.moveOverlay({phase:'move',x:140,y:170});await window.paceline.moveOverlay({phase:'end',x:140,y:170})})()`);
          if (!settings.position || win.getBounds().x === beforeDrag.x && win.getBounds().y === beforeDrag.y) throw new Error('Drag failed.');
          await win.webContents.executeJavaScript(`window.paceline.updateSettings({edge:'top'})`);
          for (const view of ['history', 'projects']) {
            await win.webContents.executeJavaScript(`document.querySelector('[data-view="${view}"]').click()`); await waitRender();
            const count = await win.webContents.executeJavaScript(`document.querySelectorAll(${JSON.stringify(view === 'history' ? '.history-chart' : '.project-card')}).length`);
            if (!count) throw new Error(`${view} did not render its synthetic data.`);
            fs.writeFileSync(path.join(runtimeDir, `smoke-${view}.png`), (await win.webContents.capturePage()).toPNG());
          }
          await win.webContents.executeJavaScript(`document.querySelector('[data-local-view="sessions"]').click()`); await waitRender();
          if (!(await win.webContents.executeJavaScript(`document.querySelectorAll('.project-card').length`))) throw new Error('Session breakdown failed.');
          const loginBlocked = await win.webContents.executeJavaScript(`window.paceline.loginClaude().then(()=>false,()=>true)`);
          if (!loginBlocked) throw new Error('Demo allowed a real Claude login.');
          await win.webContents.executeJavaScript(`document.querySelector('[data-view="monitor"]').click()`);
          const blockedUpdate = await win.webContents.executeJavaScript(`window.paceline.installUpdate().then(()=>false,()=>true)`);
          if (!blockedUpdate) throw new Error('Demo allowed installing a real update.');
          await win.webContents.executeJavaScript(`window.paceline.pin(true)`);
          await win.webContents.executeJavaScript(`document.getElementById('paceline').dispatchEvent(new PointerEvent('pointerleave'))`);
          await new Promise(resolve => setTimeout(resolve, 600));
          if (!expanded) throw new Error('Pinned panel collapsed.');
          await win.webContents.executeJavaScript(`window.paceline.pin(false)`);
          await win.webContents.executeJavaScript(`document.getElementById('paceline').dispatchEvent(new PointerEvent('pointerleave'))`);
          await new Promise(resolve => setTimeout(resolve, 600));
          if (expanded) throw new Error('Auto-hide failed.');
          atomicJSON(path.join(runtimeDir, 'smoke-result.json'), { ok: true, checks: ['renderer', 'collapse', 'expand', 'settings', 'four-edges', 'demo-isolation', 'automatic-themes-and-order', 'personalization', 'quota-clarity', 'vertical-peek', 'pace', 'agent-activity', 'drag', 'history', 'projects', 'sessions', 'update-isolation', 'pin', 'auto-hide'], width: result.width, height: result.height, screenshot: output });
          console.log('PACELINE_SMOKE_OK');
          app.quit();
        } catch (error) { console.error('PACELINE_SMOKE_FAILED', error.message); app.exit(1); }
      }, 1200);
    }
  }).catch(error => {
    console.error('Paceline startup failed:', error.message);
    if (!smoke) dialog.showErrorBox('Paceline', i18n.t('main.startupFailed'));
    app.exit(1);
  });
}
