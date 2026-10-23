'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
let failures = 0;
function walk(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) walk(full);
    else if (/\.(?:nsh|ps1)$/.test(item.name)) {
      const source = fs.readFileSync(full, 'utf8');
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|\r(?!\n)/.test(source)) { console.error(`Invalid control character in ${path.relative(root, full)}`); failures++; }
    }
    else if (/\.(?:cjs|js)$/.test(item.name)) {
      const result = spawnSync(process.execPath, ['--check', full], { encoding: 'utf8' });
      if (result.status !== 0) { console.error(result.stderr); failures++; }
    }
  }
}
for (const dir of ['src', 'scripts', 'tests']) walk(path.join(root, dir));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (manifest.build.files.some(p => /^(?:\*|\.local|logs|vault\.db)/.test(p))) {
  console.error('Unsafe desktop package allowlist'); failures++;
}
const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
if (tracked.status === 0) {
  for (const file of tracked.stdout.split('\0').filter(Boolean)) {
    if (/(^|\/)(?:\.local|logs|node_modules|release|paceline-data)\/|\.(?:db|sqlite)(?:-|$)|\.(?:pfx|p12|key)$|(^|\/)(?:auth|credentials|storage-location|usage-history|local-usage|claude-local-usage|claude-transcripts)\.json$|(^|\/)\.env(?:\.|$)/i.test(file)) {
      console.error(`Private/generated file is tracked: ${file}`); failures++;
    }
    if (/\.(?:png|ico|icns)$/.test(file)) continue;
    const body = fs.readFileSync(path.join(root, file), 'utf8');
    const patterns = [/sk-(?:proj-|ant-)?[A-Za-z0-9_-]{35,}/, /gh[pousr]_[A-Za-z0-9]{30,}/, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/];
    if (patterns.some(pattern => pattern.test(body))) {
      console.error(`Potential credential pattern in ${file}; inspect locally before publishing.`); failures++;
    }
  }
}
console.log(failures ? `${failures} check(s) failed.` : 'Syntax and publication boundaries OK.');
process.exitCode = failures ? 1 : 0;
