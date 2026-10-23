'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { classifyApp, cliProvider, parseProcesses, providerInside } = require('../src/main/foreground-mac.cjs');
const { ActiveContext } = require('../src/main/active-context.cjs');

test('macOS desktop apps and CLI processes map to their provider, other programs do not', () => {
  assert.equal(classifyApp({ bundle: 'com.anthropic.claudefordesktop', name: 'Claude' }), 'claude');
  assert.equal(classifyApp({ bundle: 'com.example.unknown', name: 'Codex' }), 'codex');
  assert.equal(classifyApp({ bundle: 'com.openai.chat', name: 'ChatGPT' }), null);
  assert.equal(classifyApp({ bundle: 'com.apple.Terminal', name: 'Terminal' }), null);
  const cases = [
    ['claude', 'claude'], ['/Users/dev/.local/bin/claude --resume', 'claude'],
    ['node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js', 'claude'],
    ['codex', 'codex'], ['/opt/homebrew/bin/node /opt/homebrew/bin/codex', 'codex'],
    ['node /usr/local/lib/node_modules/@openai/codex/bin/codex.js', 'codex'],
    ['vim codex.md', null], ['/bin/zsh -l', null], ['claude-monitor', null], ['node server.js claude', null], ['', null]
  ];
  for (const [args, expected] of cases) assert.equal(cliProvider(args), expected, args);
});

test('macOS terminal context comes only from CLIs running inside the frontmost app', () => {
  const processes = parseProcesses([
    '  100     1 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal',
    '  101   100 login -pf dev', '  102   101 -zsh', '  103   102 claude',
    '  200     1 /Applications/Ghostty.app/Contents/MacOS/ghostty', '  201   200 /bin/zsh', '  202   201 codex',
    '  300     1 /Applications/Both.app/Contents/MacOS/Both', '  301   300 claude', '  302   300 codex',
    'malformed line'
  ].join('\n'));
  assert.equal(processes.length, 10);
  assert.equal(providerInside(processes, 100), 'claude');
  assert.equal(providerInside(processes, 200), 'codex');
  assert.equal(providerInside(processes, 300), null, 'two different CLIs leave the choice open');
  assert.equal(providerInside(processes, 999), null);
});

test('macOS helper output drives the context without exposing app names or commands', async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
  const spawned = [];
  let scans = 0;
  const context = new ActiveContext({ platform: 'darwin', ownPid: 42, now: () => 0,
    spawnProcess: (command, args) => { spawned.push({ command, args }); return child; },
    listProcesses: async () => { scans++; return parseProcesses('500 1 /Applications/Term.app\n501 500 /bin/zsh\n502 501 claude --secret-flag'); } });
  assert.equal(context.getState().available, false);
  context.start();
  assert.equal(spawned[0].command, '/usr/bin/osascript');
  assert.deepEqual(spawned[0].args.slice(0, 3), ['-l', 'JavaScript', '-e']);
  // Stream data and the process scan both settle asynchronously.
  const send = async value => { child.stdout.write(JSON.stringify(value) + '\n'); await new Promise(resolve => setImmediate(resolve)); };
  await send({ ready: true });
  assert.equal(context.getState().available, true);
  await send({ app: { pid: 77, bundle: 'com.openai.codex', name: 'Codex' } });
  assert.equal(context.getState().provider, 'codex');
  await send({ app: { pid: 42, bundle: 'io.paceline.desktop', name: 'Paceline' } });
  assert.equal(context.getState().provider, 'codex', 'focusing Paceline keeps the last provider');
  await send({ app: { pid: 500, bundle: 'com.example.term', name: 'Term' } });
  await send({ app: { pid: 500, bundle: 'com.example.term', name: 'Term' } });
  assert.equal(context.getState().provider, 'claude');
  assert.equal(scans, 1, 'the process list is not re-read on every tick');
  assert.equal(/Term|secret|Codex"/.test(JSON.stringify(context.getState())), false);
  context.close();
});

function classifierSource() {
  const script = fs.readFileSync(path.resolve(__dirname, '../src/main/foreground.ps1'), 'utf8');
  const match = script.match(/Add-Type\s+-TypeDefinition\s+@'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(match, 'the shipped foreground helper must contain its C# classifier');
  return match[1];
}

test('foreground classifier recognizes Store Codex without treating arbitrary ChatGPT windows as Codex', {
  skip: process.platform !== 'win32',
  timeout: 30000,
}, () => {
  const codexPackage = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1016.6573.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe';
  const fixtures = [
    { label: 'installed Store Codex GUI', name: 'ChatGPT', title: 'A project', executablePath: codexPackage, expected: 'codex' },
    { label: 'case-insensitive Store identity', name: 'CHATGPT', title: '', executablePath: codexPackage.toLowerCase(), expected: 'codex' },
    { label: 'updated Store package', name: 'ChatGPT', title: '', executablePath: codexPackage.replace('26.1016.6573.0', '27.1017.7123.1'), expected: 'codex' },
    { label: 'updated ARM64 package on another drive', name: 'ChatGPT', title: '', executablePath: codexPackage.replace('C:', 'D:').replace('_x64__', '_arm64__'), expected: 'codex' },
    { label: 'invalid package version', name: 'ChatGPT', title: 'Codex', executablePath: codexPackage.replace('26.1016.6573.0', 'fake'), expected: '' },
    { label: 'ordinary ChatGPT Store app', name: 'ChatGPT', title: 'Codex', executablePath: codexPackage.replace('OpenAI.Codex_', 'OpenAI.ChatGPT_'), expected: '' },
    { label: 'generic ChatGPT executable', name: 'ChatGPT', title: 'Codex', executablePath: 'D:\\apps\\ChatGPT.exe', expected: '' },
    { label: 'missing executable identity', name: 'ChatGPT', title: 'Codex', executablePath: '', expected: '' },
    { label: 'incorrect package publisher', name: 'ChatGPT', title: 'Codex', executablePath: codexPackage.replace('2p2nqsd0c76g0', 'fakepublisher'), expected: '' },
    { label: 'prefixed package name', name: 'ChatGPT', title: 'Codex', executablePath: codexPackage.replace('OpenAI.Codex_', 'FakeOpenAI.Codex_'), expected: '' },
    { label: 'suffixed package name', name: 'ChatGPT', title: 'Codex', executablePath: codexPackage.replace('OpenAI.Codex_', 'OpenAI.Codex_Fake_'), expected: '' },
    { label: 'non-package directory', name: 'ChatGPT', title: 'Codex', executablePath: codexPackage.replace('WindowsApps', 'DownloadedApps'), expected: '' },
    { label: 'fake package ancestor', name: 'ChatGPT', title: 'Codex', executablePath: codexPackage.replace('WindowsApps', 'FakeWindowsApps'), expected: '' },
    { label: 'nested executable suffix', name: 'ChatGPT', title: 'Codex', executablePath: codexPackage + '\\other.exe', expected: '' },
    { label: 'wrong executable inside package', name: 'electron', title: 'Codex', executablePath: codexPackage.replace('ChatGPT.exe', 'electron.exe'), expected: '' },
    { label: 'native Codex process', name: 'CoDeX', title: '', executablePath: '', expected: 'codex' },
    { label: 'native Claude process', name: 'Claude', title: '', executablePath: '', expected: 'claude' },
    { label: 'generic Electron title', name: 'electron', title: 'Codex', executablePath: 'D:\\apps\\electron.exe', expected: '' },
    { label: 'document mentioning Codex', name: 'notepad', title: 'Codex.txt - Notepad', executablePath: '', expected: '' },
    { label: 'browser Codex app', name: 'chrome', title: 'Codex - ChatGPT - Google Chrome', executablePath: '', expected: 'codex' },
    { label: 'browser Claude app', name: 'msedge', title: 'A conversation | Claude - Microsoft Edge', executablePath: '', expected: 'claude' },
    { label: 'browser document mentioning Codex', name: 'chrome', title: 'Codex.txt - GitHub - Google Chrome', executablePath: '', expected: '' },
    { label: 'browser article mentioning Claude', name: 'firefox', title: 'How Claude works - Mozilla Firefox', executablePath: '', expected: '' },
    { label: 'Codex terminal', name: 'WindowsTerminal', title: 'Codex - project', executablePath: '', expected: 'codex' },
    { label: 'Claude Code terminal', name: 'pwsh', title: 'Claude Code - project', executablePath: '', expected: 'claude' },
    { label: 'terminal file mentioning Codex', name: 'pwsh', title: 'Codex.txt', executablePath: '', expected: '' },
    { label: 'unrecognized app', name: 'explorer', title: 'Documents', executablePath: '', expected: '' },
  ];
  const base = path.resolve(__dirname, '../.local/tests');
  fs.mkdirSync(base, { recursive: true });
  const temporaryDirectory = fs.mkdtempSync(path.join(base, 'foreground-'));
  try {
    // Compile only the shipped classifier; do not start its polling loop or read any real window.
    const fixtureBase64 = Buffer.from(JSON.stringify(fixtures), 'utf8').toString('base64');
    const command = [
      "$ErrorActionPreference = 'Stop'",
      "$ProgressPreference = 'SilentlyContinue'",
      "Add-Type -TypeDefinition @'",
      classifierSource(),
      "'@",
      "$cases = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + fixtureBase64 + "')) | ConvertFrom-Json",
      '$results = @($cases | ForEach-Object { [PacelineForeground]::Classify([string]$_.name, [string]$_.title, [string]$_.executablePath) })',
      'ConvertTo-Json -InputObject $results -Compress',
    ].join('\r\n');
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const output = execFileSync(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64'),
    ], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 25000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, TEMP: temporaryDirectory, TMP: temporaryDirectory },
    });
    const results = JSON.parse(output.trim());
    assert.equal(results.length, fixtures.length, 'every identity must return a classification');
    for (const [index, fixture] of fixtures.entries()) {
      assert.equal(results[index], fixture.expected, fixture.label);
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
