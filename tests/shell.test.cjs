'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { overlayBounds } = require('../src/main/geometry.cjs');
const { dataDirectory, adoptLegacyData, safeSettings, permittedExternalURL, writeSettings, readSettings } = require('../src/main/settings.cjs');

test('overlay stays within secondary display work area on every edge and size', () => {
  const area = { x: -1920, y: 40, width: 1920, height: 1040 };
  for (const edge of ['top', 'bottom', 'left', 'right']) for (const expanded of [false, true]) {
    const b = overlayBounds(area, edge, expanded);
    assert.ok(b.x >= area.x && b.y >= area.y);
    assert.ok(b.x + b.width <= area.x + area.width);
    assert.ok(b.y + b.height <= area.y + area.height);
  }
});
test('small displays clamp geometry', () => {
  assert.deepEqual(overlayBounds({ x: 0, y: 0, width: 300, height: 400 }, 'bottom', true), { x: 0, y: 0, width: 300, height: 400 });
});
test('renderer settings cannot inject paths, URLs, or nonboolean values', () => {
  const s = safeSettings({ edge: '../../tmp', pinned: 'true', launchAtLogin: 1, script: 'evil', displayId: 2 });
  assert.equal(s.edge, 'top'); assert.equal(s.pinned, false); assert.equal(s.launchAtLogin, false);
  assert.equal(s.script, undefined); assert.equal(s.displayId, 2);
});
test('external navigation is HTTPS and host allowlisted including login', () => {
  for (const url of ['file:///etc/passwd', 'https://auth.openai.com.evil.test/', 'https://evil.test', 'javascript:alert(1)', 'https://user:pass@chatgpt.com/', 'https://chatgpt.com:8000/']) assert.equal(permittedExternalURL(url, true), false);
  assert.equal(permittedExternalURL('https://auth.openai.com/authorize?a=b', true), true);
  assert.equal(permittedExternalURL('https://claude.ai/settings/usage'), true);
});
test('data placement stays separate from source and respects an absolute override', () => {
  const root = path.resolve(__dirname, '..');
  assert.equal(dataDirectory({ packaged: false, appPath: root, env: {} }), path.join(root, '.local', 'data'));
  assert.equal(dataDirectory({ packaged: true, executable: path.join(root, 'app.exe'), env: {}, platform: 'win32' }), path.join(root, 'paceline-data'));
  // On macOS the data never lives inside the replaceable, signed app bundle.
  assert.equal(dataDirectory({ packaged: true, executable: '/Applications/Paceline.app/Contents/MacOS/Paceline', env: {}, platform: 'darwin', home: '/Users/dev' }), path.join('/Users/dev', 'Library', 'Application Support', 'Paceline'));
  assert.equal(dataDirectory({ packaged: false, appPath: root, env: { PACELINE_HOME: root } }), root);
  assert.throws(() => dataDirectory({ packaged: false, appPath: root, env: { PACELINE_HOME: '../relative' } }));
});
test('settings survive roundtrip and corrupt input falls back safely', () => {
  const base = path.resolve(__dirname, '../.local/tests');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'settings-'));
  try {
    writeSettings(dir, { pinned: true, edge: 'left' });
    assert.equal(readSettings(dir).pinned, true);
    fs.writeFileSync(path.join(dir, 'settings.json'), '{broken');
    assert.equal(readSettings(dir).edge, 'top');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('data from TOKEN-VAULT builds moves to the Paceline folder once, and the old theme name carries over', () => {
  const base = path.resolve(__dirname, '../.local/tests');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'legacy-'));
  try {
    const legacy = path.join(dir, 'token-vault-data'), target = path.join(dir, 'paceline-data');
    fs.mkdirSync(legacy); fs.writeFileSync(path.join(legacy, 'usage-history.json'), '{"version":1,"series":[]}');
    assert.deepEqual(adoptLegacyData(target), { dataDir: target, migrated: true });
    assert.equal(fs.existsSync(legacy), false); assert.equal(fs.existsSync(path.join(target, 'usage-history.json')), true);
    // Once the new folder exists, an old one that reappears is left alone.
    fs.mkdirSync(legacy);
    assert.deepEqual(adoptLegacyData(target), { dataDir: target, migrated: false });
    assert.equal(fs.existsSync(legacy), true);
    // Only the packaged folder name is ever migrated.
    assert.deepEqual(adoptLegacyData(path.join(dir, 'custom')), { dataDir: path.join(dir, 'custom'), migrated: false });
    assert.equal(safeSettings({ theme: 'vault' }).theme, 'paceline');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
