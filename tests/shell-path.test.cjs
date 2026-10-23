'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { loginShellPath } = require('../src/main/shell-path.cjs');

function fakeShell(output, { fail = false } = {}) {
  const calls = [];
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, stdio: options.stdio });
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill() { child.killed = true; } });
    setImmediate(() => {
      if (fail) { child.emit('error', new Error('spawn failed')); return; }
      child.stdout.end(output);
      child.stdout.on('end', () => child.emit('close', 0));
    });
    return child;
  };
  return { spawnProcess, calls };
}

test('a Finder-launched app learns the login shell PATH, keeping fallbacks for common installs', async () => {
  const shell = fakeShell('Welcome banner\n\n__PACELINE_PATH__/opt/homebrew/bin:/Users/dev/.local/bin:/usr/bin:relative/dir\n');
  const value = await loginShellPath({ env: { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' }, home: '/Users/dev', spawnProcess: shell.spawnProcess });
  const folders = value.split(':');
  assert.deepEqual(folders.slice(0, 4), ['/opt/homebrew/bin', '/Users/dev/.local/bin', '/usr/bin', '/bin']);
  assert.ok(folders.includes('/usr/local/bin') && folders.includes('/Users/dev/.claude/local'));
  assert.equal(folders.includes('relative/dir'), false, 'relative folders are never added');
  assert.equal(new Set(folders).size, folders.length);
  assert.deepEqual(shell.calls[0].args.slice(0, 3), ['-i', '-l', '-c']);
  assert.equal(shell.calls[0].stdio[0], 'ignore', 'the shell can never wait for input');
});

test('a failing or unknown shell still yields the current PATH and the fallbacks', async () => {
  const value = await loginShellPath({ env: { SHELL: '/usr/local/bin/nu', PATH: '/usr/bin' }, home: '/Users/dev', spawnProcess: fakeShell('', { fail: true }).spawnProcess });
  assert.equal(value.split(':')[0], '/usr/bin');
  assert.ok(value.includes('/opt/homebrew/bin'));
  const fish = fakeShell('__PACELINE_PATH__/opt/homebrew/bin:/usr/bin\n');
  await loginShellPath({ env: { SHELL: '/opt/homebrew/bin/fish' }, home: '/Users/dev', spawnProcess: fish.spawnProcess });
  assert.equal(fish.calls[0].command, '/opt/homebrew/bin/fish');
  assert.match(fish.calls[0].args[3], /string join : \$PATH/);
  const unknown = fakeShell('');
  await loginShellPath({ env: { SHELL: '/usr/local/bin/nu' }, home: '/Users/dev', spawnProcess: unknown.spawnProcess });
  assert.equal(unknown.calls[0].command, '/bin/zsh');
});
