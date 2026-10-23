"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createHash } = require('node:crypto');
const { UpdateManager, repositoryName, compareVersions, safeURL, validateManifest } = require('../src/main/updates.cjs');
const { createManifest } = require('../scripts/create-update-manifest.cjs');
const pkg = require('../package.json');
async function fixture(t, options = {}) {
  const base = path.resolve(__dirname, '../.local/update-tests');
  await fs.mkdir(base, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(base, 'case-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const platform = options.platform || 'win32', mac = platform === 'darwin';
  // A synthetic disk image only needs the UDIF trailer that real .dmg files end with.
  const binary = options.binary || (mac ? Buffer.concat([Buffer.from('synthetic-disk-image-for-integrity-testing'), Buffer.from('koly'), Buffer.alloc(508)]) : Buffer.from('MZ-synthetic-installer-for-integrity-testing'));
  const repo = 'example/paceline';
  const file = mac ? 'Paceline-0.4.0-mac-universal.dmg' : 'Paceline-0.4.0-setup-x64.exe';
  const manifestName = mac ? 'paceline-update-mac.json' : 'paceline-update.json';
  const manifest = { schemaVersion: 1, version: '0.4.0', platform, arch: mac ? 'universal' : 'x64', file, size: binary.length, sha256: createHash('sha256').update(binary).digest('hex'), sha512: createHash('sha512').update(binary).digest('hex') };
  const baseURL = `https://github.com/${repo}/releases/download/v0.4.0/`;
  const release = { tag_name: 'v0.4.0', draft: false, prerelease: false, assets: [{ name: file, size: binary.length, browser_download_url: baseURL + file }, { name: manifestName, browser_download_url: baseURL + manifestName }] };
  const calls = [], installed = [];
  const context = { dataDir, binary, manifest, release, repo, file, calls, installed };
  const request = async url => {
    calls.push(url);
    let content = url.includes('api.github.com') ? Buffer.from(JSON.stringify(release)) : url.endsWith('.json') ? Buffer.from(JSON.stringify(manifest)) : (options.download || binary);
    if (options.request) content = options.request(url, content);
    const response = Readable.from([content]);
    response.headers = {};
    if (url.endsWith(file) && options.contentLength !== undefined) response.headers['content-length'] = options.contentLength;
    return response;
  };
  const updater = new UpdateManager({ currentVersion: '0.3.0', dataDir, platform, getRepository: () => context.repo, request, install: async filename => { installed.push(filename); } });
  return { ...context, context, updater };
}

test('update source and versions reject shell paths, non-HTTPS hosts and downgrades', () => {
  assert.equal(repositoryName(' example/paceline '), 'example/paceline');
  for (const bad of ['https://github.com/a/b', '../repo', 'a/b/c', 'a/b;cmd', 'a//b']) assert.equal(repositoryName(bad), null);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.throws(() => compareVersions('0.4.0-beta.1', '0.3.0'));
  for (const bad of ['http://github.com/a', 'https://github.com.evil.test/a', 'https://user:pass@github.com/a', 'file:///a.exe', 'https://127.0.0.1/a', 'https://github.com:444/a']) assert.throws(() => safeURL(bad));
  assert.equal(safeURL('https://release-assets.githubusercontent.com/file?sig=example').hostname, 'release-assets.githubusercontent.com');
});

test('unconfigured publisher never starts a network request', async t => {
  const f = await fixture(t); f.context.repo = '';
  assert.equal((await f.updater.check()).status, 'not-configured');
  assert.equal((await f.updater.download()).status, 'not-configured');
  assert.deepEqual(f.calls, []);
});

test('stable release downloads and installs only after both hashes match', async t => {
  const f = await fixture(t);
  assert.equal((await f.updater.check()).status, 'available');
  assert.equal((await f.updater.download()).status, 'downloaded');
  assert.equal((await f.updater.install()).status, 'installing');
  assert.equal(f.installed.length, 1);
  assert.ok(f.installed[0].startsWith(path.join(f.dataDir, 'updates') + path.sep));
  assert.deepEqual(await fs.readFile(f.installed[0]), f.binary);
});

test('manifest binds installer to repository, tag, filename, hashes and size', async t => {
  const f = await fixture(t);
  const variations = [ { file: '../payload.exe' }, { version: '0.3.0' }, { sha256: 'abcd' }, { sha512: 'abcd' }, { size: 900000000 }, { arch: 'arm64' } ];
  for (const patch of variations) assert.throws(() => validateManifest({ ...f.manifest, ...patch }, f.release, '0.3.0', f.repo));
  f.release.assets[0].browser_download_url = f.release.assets[0].browser_download_url.replace('example/paceline', 'attacker/paceline');
  assert.equal((await f.updater.check()).status, 'error');
  assert.equal(f.calls.length, 2);
});

test('GitHub repository case differences do not break a legitimate asset', async t => {
  const f = await fixture(t);
  f.release.assets.forEach(asset => { asset.browser_download_url = asset.browser_download_url.replace('example/paceline', 'Example/Paceline'); });
  assert.equal((await f.updater.check()).status, 'available');
});

test('corrupt downloads are discarded and cannot be installed', async t => {
  const f = await fixture(t, { download: Buffer.from('MZ-corrupt') });
  await f.updater.check();
  assert.equal((await f.updater.download()).status, 'error');
  assert.equal((await f.updater.install()).status, 'error');
  assert.deepEqual(f.installed, []);
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'updates')), []);
});

test('matching size with wrong hash fails verification', async t => {
  const f = await fixture(t, { request: (url, content) => url.endsWith('.exe') ? Buffer.from(content.toString().replace('synthetic', 'corrupted')) : content });
  await f.updater.check();
  assert.equal((await f.updater.download()).status, 'error');
  assert.match(f.updater.getState().message, /integridade/);
  assert.deepEqual(f.installed, []);
});

test('tampering after download is detected again before execution', async t => {
  const f = await fixture(t);
  await f.updater.check(); await f.updater.download();
  const folder = path.join(f.dataDir, 'updates');
  const [file] = await fs.readdir(folder);
  await fs.writeFile(path.join(folder, file), Buffer.alloc(f.binary.length, 65));
  assert.equal((await f.updater.install()).status, 'error');
  assert.deepEqual(f.installed, []);
});

test('repository changes invalidate a pending download and install', async t => {
  const f = await fixture(t);
  await f.updater.check(); await f.updater.download();
  f.context.repo = 'another/publisher';
  assert.equal((await f.updater.install()).status, 'error');
  assert.deepEqual(f.installed, []);
});

test('oversized metadata and mismatched Content-Length fail before installation', async t => {
  const f = await fixture(t, { contentLength: 999999 });
  await f.updater.check();
  assert.equal((await f.updater.download()).status, 'error');
  const large = await fixture(t, { request: url => Buffer.alloc(1024 * 1024 + 1, 65) });
  assert.equal((await large.updater.check()).status, 'error');
});

test('macOS updates use their own manifest and accept only a verified disk image', async t => {
  const f = await fixture(t, { platform: 'darwin' });
  assert.equal((await f.updater.check()).status, 'available');
  assert.ok(f.calls.some(url => url.endsWith('/paceline-update-mac.json')));
  assert.equal((await f.updater.download()).status, 'downloaded');
  assert.equal((await f.updater.install()).status, 'installing');
  assert.deepEqual(await fs.readFile(f.installed[0]), f.binary);
  // The Windows installer manifest is never accepted on a Mac, nor the reverse.
  const windows = await fixture(t);
  assert.throws(() => validateManifest(windows.manifest, windows.release, '0.3.0', windows.repo, 'darwin'));
  assert.throws(() => validateManifest(f.manifest, f.release, '0.3.0', f.repo, 'win32'));
  // Matching hashes are not enough: the file must also be a disk image.
  const fake = await fixture(t, { platform: 'darwin', binary: Buffer.from('MZ-not-a-disk-image') });
  await fake.updater.check();
  assert.equal((await fake.updater.download()).status, 'error');
  assert.deepEqual(fake.installed, []);
});

test('platforms without an update target never start a network request', async t => {
  const f = await fixture(t, { platform: 'linux' });
  assert.equal((await f.updater.check()).status, 'error');
  assert.deepEqual(f.calls, []);
});

test('release manifest generator writes the macOS manifest beside the disk image', async t => {
  const f = await fixture(t, { platform: 'darwin' });
  const file = `Paceline-${pkg.version}-mac-universal.dmg`;
  await fs.writeFile(path.join(f.dataDir, file), f.binary);
  const manifest = await createManifest(f.dataDir, 'darwin');
  assert.deepEqual({ platform: manifest.platform, arch: manifest.arch, file: manifest.file, sha256: manifest.sha256 }, { platform: 'darwin', arch: 'universal', file, sha256: f.manifest.sha256 });
  assert.equal(JSON.parse(await fs.readFile(path.join(f.dataDir, 'paceline-update-mac.json'), 'utf8')).file, file);
});

test('release manifest generator produces verifiable SHA-256 and SHA-512 from an artifact', async t => {
  const f = await fixture(t);
  const file = `Paceline-${pkg.version}-setup-x64.exe`;
  await fs.writeFile(path.join(f.dataDir, file), f.binary);
  const manifest = await createManifest(f.dataDir);
  assert.equal(manifest.size, f.binary.length);
  assert.equal(manifest.sha256, f.manifest.sha256);
  assert.equal(manifest.sha512, f.manifest.sha512);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.dataDir, 'paceline-update.json'), 'utf8')).version, pkg.version);
});
