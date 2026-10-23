'use strict';
const { execFile } = require('node:child_process');

// macOS gives no permission-free access to window titles. The provider comes from the frontmost
// app itself or, for terminals and editors, from the Claude Code or Codex CLI running inside it.
// The helper reports only the frontmost app; spinning the run loop (rather than a plain delay)
// lets NSWorkspace notice when another app comes to the front.
const SCRIPT = String.raw`ObjC.import('AppKit');
const out = $.NSFileHandle.fileHandleWithStandardOutput;
const write = line => out.writeData($(line + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
write('{"ready":true}');
for (;;) {
  const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  write(app.isNil() ? '{"app":null}' : JSON.stringify({ app: { pid: app.processIdentifier, bundle: ObjC.unwrap(app.bundleIdentifier) || '', name: ObjC.unwrap(app.localizedName) || '' } }));
  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.9));
}`;

const DESKTOP_APPS = [
  { provider: 'claude', bundles: ['com.anthropic.claudefordesktop'], names: ['claude'] },
  { provider: 'codex', bundles: ['com.openai.codex'], names: ['codex'] }
];
const RUNTIMES = new Set(['node', 'bun', 'deno']);

function classifyApp(app) {
  const bundle = String(app?.bundle || '').toLowerCase(), name = String(app?.name || '').trim().toLowerCase();
  return DESKTOP_APPS.find(entry => entry.bundles.includes(bundle) || entry.names.includes(name))?.provider || null;
}
// Only the program (or the script a runtime runs) is inspected; arguments are never kept.
function cliProvider(args) {
  const [first = '', second = ''] = String(args || '').trim().split(/\s+/, 2);
  const base = value => value.split('/').pop().toLowerCase();
  const target = RUNTIMES.has(base(first)) ? second : first;
  if (base(target) === 'claude' || /\/@anthropic-ai\/claude-code\/cli\.m?js$/.test(target)) return 'claude';
  if (base(target) === 'codex' || /\/@openai\/codex\/bin\/codex\.js$/.test(target)) return 'codex';
  return null;
}
function parseProcesses(text) {
  const processes = [];
  for (const line of String(text || '').split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (match) processes.push({ pid: Number(match[1]), ppid: Number(match[2]), args: match[3] });
  }
  return processes;
}
// The one provider whose CLI runs somewhere below the app; none or both leave the choice open.
function providerInside(processes, rootPid) {
  const children = new Map();
  for (const item of processes) children.set(item.ppid, [...(children.get(item.ppid) || []), item]);
  const found = new Set(), seen = new Set([rootPid]), queue = [rootPid];
  while (queue.length && seen.size < 10000) {
    for (const child of children.get(queue.shift()) || []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid); queue.push(child.pid);
      const provider = cliProvider(child.args);
      if (provider) found.add(provider);
    }
  }
  return found.size === 1 ? [...found][0] : null;
}
function listProcesses() {
  return new Promise((resolve, reject) => {
    execFile('/bin/ps', ['-axww', '-o', 'pid=,ppid=,args='], { encoding: 'utf8', timeout: 3000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(parseProcesses(stdout)));
  });
}
module.exports = { SCRIPT, classifyApp, cliProvider, parseProcesses, providerInside, listProcesses };
