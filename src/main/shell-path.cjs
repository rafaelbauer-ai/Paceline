'use strict';
const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

// Apps opened from Finder start with launchd's minimal PATH, which hides the CLIs installed by
// Homebrew, npm or the official installers. The user's login shell knows where they are.
const MARKER = '__PACELINE_PATH__';
// Common install folders, in case the shell is slow or its profile fails.
const FALLBACKS = ['/opt/homebrew/bin', '/usr/local/bin', '~/.local/bin', '~/.claude/local', '~/.npm-global/bin', '~/.bun/bin', '~/.volta/bin'];

function shellCommand(shell) {
  // fish keeps PATH as a list; every other supported shell already joins it with ':'.
  return path.basename(shell) === 'fish' ? `printf '\\n${MARKER}%s\\n' (string join : $PATH)` : `printf '\\n${MARKER}%s\\n' "$PATH"`;
}
function mergePath(lists, home) {
  const folders = lists.flatMap(list => String(list || '').split(':')).map(dir => dir.replace(/^~(?=\/)/, home)).filter(dir => path.posix.isAbsolute(dir));
  return [...new Set(folders)].join(':');
}
function loginShellPath({ env = process.env, home = os.homedir(), spawnProcess = spawn, timeoutMs = 5000 } = {}) {
  const shell = /^\/[\w./-]+\/(?:zsh|bash|sh|fish)$/.test(env.SHELL || '') ? env.SHELL : '/bin/zsh';
  return new Promise(resolve => {
    let output = '', done = false, child;
    const finish = () => {
      if (done) return;
      done = true; clearTimeout(timer);
      const found = (output.match(new RegExp(`${MARKER}(.*)`)) || [])[1] || '';
      resolve(mergePath([found, env.PATH, FALLBACKS.join(':')], home));
    };
    const timer = setTimeout(() => { child?.kill(); finish(); }, timeoutMs);
    try {
      // An interactive login shell reads the same profile files as the user's terminal.
      child = spawnProcess(shell, ['-i', '-l', '-c', shellCommand(shell)], { env, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { finish(); return; }
    child.stdout.on('data', chunk => { if (output.length < 1024 * 1024) output += chunk; });
    child.on('error', finish);
    child.on('close', finish);
  });
}
module.exports = { loginShellPath, mergePath };
