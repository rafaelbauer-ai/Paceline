'use strict';
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const i18n = require('../renderer/i18n.js');
const mac = require('./foreground-mac.cjs');

const SUPPORTED = ['win32', 'darwin'];

class ActiveContext extends EventEmitter {
  constructor({ platform = process.platform, spawnProcess = spawn, listProcesses = mac.listProcesses, ownPid = process.pid, now = Date.now } = {}) {
    super(); this.platform = platform; this.spawnProcess = spawnProcess;
    this.listProcesses = listProcesses; this.ownPid = ownPid; this.now = now;
    // `message` holds an i18n key; getState() translates it so a language switch applies.
    this.state = { provider: null, available: false, message: SUPPORTED.includes(platform) ? 'context.detecting' : 'context.unsupported' };
    this.child = null; this.buffer = ''; this.closed = false; this.retries = 0;
    this.frontPid = null; this.scanning = false; this.lastScan = { pid: null, at: 0 };
  }
  getState() { return { ...this.state, message: i18n.t(this.state.message) }; }
  accept(value) {
    if (!value || typeof value !== 'object' || (value.ready !== true && value.provider !== null && !['codex', 'claude'].includes(value.provider))) return;
    const old = JSON.stringify(this.state);
    if (value.ready === true || Object.hasOwn(value, 'provider')) {
      this.state.available = true; this.state.message = 'context.active';
    }
    // Retain the last matching provider while the overlay or an unrelated app is focused.
    if (['codex', 'claude'].includes(value.provider)) this.state.provider = value.provider;
    if (old !== JSON.stringify(this.state)) this.emit('change', this.getState());
  }
  // macOS reports the frontmost app; terminals and editors are resolved from the CLIs they run.
  acceptMac(value) {
    if (!value || typeof value !== 'object') return;
    if (value.ready === true) { this.accept({ ready: true }); return; }
    if (!Object.hasOwn(value, 'app')) return;
    const app = value.app && Number.isInteger(value.app.pid) ? value.app : null;
    this.frontPid = app?.pid ?? null;
    if (!app || app.pid === this.ownPid) { this.accept({ provider: null }); return; }
    const provider = mac.classifyApp(app);
    if (provider) { this.accept({ provider }); return; }
    // The process list is read at most every 2 s for the same app, and once whenever the app changes.
    if (this.scanning || (this.lastScan.pid === app.pid && this.now() - this.lastScan.at < 2000)) return;
    this.scanning = true; this.lastScan = { pid: app.pid, at: this.now() };
    this.listProcesses()
      .then(processes => { if (!this.closed && this.frontPid === app.pid) this.accept({ provider: mac.providerInside(processes, app.pid) }); }, () => {})
      .finally(() => { this.scanning = false; });
  }
  start() {
    if (this.closed || this.child || !SUPPORTED.includes(this.platform)) return;
    let child;
    if (this.platform === 'darwin') {
      child = this.spawnProcess('/usr/bin/osascript', ['-l', 'JavaScript', '-e', mac.SCRIPT], { stdio: ['ignore', 'pipe', 'pipe'] });
    } else {
      const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
      const script = `$pacelineParentId = ${process.pid}\n` + fs.readFileSync(path.join(__dirname, 'foreground.ps1'), 'utf8');
      child = this.spawnProcess(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    }
    this.child = child;
    const failed = () => {
      if (this.child !== child) return;
      this.child = null; this.buffer = '';
      this.state.available = false; this.state.message = 'context.unavailable';
      this.emit('change', this.getState());
      if (!this.closed && this.retries++ < 2) { this.retry = setTimeout(() => this.start(), 10000); this.retry.unref?.(); }
    };
    child.on('error', failed); child.on('exit', failed);
    child.stderr.on('data', () => {});
    child.stdout.on('data', chunk => {
      this.buffer += chunk.toString();
      if (this.buffer.length > 8192) { this.buffer = ''; return; }
      let end;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        try {
          const value = JSON.parse(line);
          if (this.platform === 'darwin') this.acceptMac(value); else this.accept(value);
        } catch { /* Ignore malformed helper output. */ }
      }
    });
  }
  close() { this.closed = true; clearTimeout(this.retry); this.child?.kill(); this.child = null; }
}
module.exports = { ActiveContext };
