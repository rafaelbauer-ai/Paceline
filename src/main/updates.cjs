"use strict";
const https = require('node:https');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const i18n = require('../renderer/i18n.js');

// Each platform has its own manifest and installer in the same GitHub release.
const UPDATE_TARGETS = Object.freeze({
  win32: Object.freeze({ manifest: 'paceline-update.json', arch: 'x64', file: version => `Paceline-${version}-setup-x64.exe` }),
  darwin: Object.freeze({ manifest: 'paceline-update-mac.json', arch: 'universal', file: version => `Paceline-${version}-mac-universal.dmg` })
});
// Windows installers are PE files ("MZ"); macOS disk images end with a 512-byte UDIF "koly" trailer.
function looksLikeInstaller(platform, header, trailer) {
  return platform === 'darwin' ? trailer.length === 512 && trailer.subarray(0, 4).toString('ascii') === 'koly' : header.toString('ascii') === 'MZ';
}
// Messages keep their i18n key so a later language switch re-renders the stored status.
const text = (key, vars) => ({ key, vars });
function failure(key, vars) { return Object.assign(new Error(i18n.t(key, vars)), { i18nKey: key, i18nVars: vars }); }
const MAX_INSTALLER = 512 * 1024 * 1024;
const DOWNLOAD_HOSTS = new Set(['github.com', 'api.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
function repositoryName(value) {
  if (typeof value !== 'string' || value.length > 200) return null;
  const clean = value.trim();
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(clean) && !clean.split('/').some(v => v === '.' || v === '..') ? clean : null;
}
function versionParts(value) {
  const match = typeof value === 'string' && value.match(/^(?:v)?(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/);
  if (!match) throw failure('updates.invalidVersion');
  return match.slice(1).map(Number);
}
function compareVersions(a, b) {
  const left = versionParts(a), right = versionParts(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
}
function safeURL(value) {
  let url;
  try { url = new URL(value); } catch { throw failure('updates.invalidAddress'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !DOWNLOAD_HOSTS.has(url.hostname) || url.hash) throw failure('updates.httpsOnly');
  return url;
}
function openResponse(value, redirects = 0) {
  const url = safeURL(value);
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Paceline-Updater', Accept: 'application/vnd.github+json', 'Accept-Encoding': 'identity' } }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (redirects >= 5 || !response.headers.location) return reject(failure('updates.invalidRedirect'));
        let next;
        try { next = safeURL(new URL(response.headers.location, url).href); } catch (error) { return reject(error); }
        openResponse(next.href, redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(response.statusCode === 404 ? failure('updates.noRelease') : failure('updates.httpError', { status: response.statusCode }));
      }
      resolve(response);
    });
    req.setTimeout(30000, () => req.destroy(failure('updates.connectionTimeout')));
    req.on('error', reject);
  });
}
async function readBuffer(url, limit, request) {
  safeURL(url);
  const response = await request(url);
  let size = 0;
  const chunks = [];
  const deadline = setTimeout(() => response.destroy(failure('updates.responseTimeout')), 60000);
  try {
    for await (const chunk of response) {
      size += chunk.length;
      if (size > limit) { response.destroy(); throw failure('updates.responseTooLarge'); }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally { clearTimeout(deadline); }
}
function releaseAsset(release, name, repo) {
  const asset = Array.isArray(release.assets) && release.assets.find(item => item.name === name);
  if (!asset) throw failure('updates.assetMissing', { name });
  const url = safeURL(asset.browser_download_url);
  const parts = url.pathname.split('/');
  const actualRepo = `${parts[1]}/${parts[2]}`;
  if (url.origin !== 'https://github.com' || url.search || actualRepo.toLowerCase() !== repo.toLowerCase() || parts.slice(3).join('/') !== `releases/download/${release.tag_name}/${name}`) throw failure('updates.assetForeign');
  return asset;
}
function validateManifest(manifest, release, currentVersion, repo, platform = 'win32') {
  const target = UPDATE_TARGETS[platform];
  if (!target) throw failure('updates.unsupportedPlatform');
  if (!manifest || manifest.schemaVersion !== 1 || typeof manifest.version !== 'string') throw failure('updates.invalidManifest');
  versionParts(manifest.version);
  if (release.tag_name !== `v${manifest.version}` || compareVersions(manifest.version, currentVersion) <= 0) throw failure('updates.manifestVersionMismatch');
  const name = target.file(manifest.version);
  if (manifest.file !== name || manifest.platform !== platform || manifest.arch !== target.arch) throw failure('updates.unexpectedInstaller');
  if (!Number.isSafeInteger(manifest.size) || manifest.size < 2 || manifest.size > MAX_INSTALLER) throw failure('updates.invalidInstallerSize');
  if (typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(manifest.sha256) || typeof manifest.sha512 !== 'string' || !/^[a-f0-9]{128}$/i.test(manifest.sha512)) throw failure('updates.invalidHashes');
  const asset = releaseAsset(release, name, repo);
  if (asset.size !== manifest.size) throw failure('updates.assetSizeMismatch');
  return { ...manifest, sha256: manifest.sha256.toLowerCase(), sha512: manifest.sha512.toLowerCase(), url: asset.browser_download_url };
}
async function verifyFile(filename, expected) {
  const stat = await fsp.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expected.size) throw failure('updates.localInstallerChanged');
  const hashes = { sha256: createHash('sha256'), sha512: createHash('sha512') };
  let count = 0, header = Buffer.alloc(0), trailer = Buffer.alloc(0);
  for await (const chunk of fs.createReadStream(filename)) {
    count += chunk.length;
    if (header.length < 2) header = Buffer.concat([header, chunk]).subarray(0, 2);
    trailer = Buffer.concat([trailer, chunk]).subarray(-512);
    if (count > expected.size) throw failure('updates.localInstallerGrew');
    hashes.sha256.update(chunk); hashes.sha512.update(chunk);
  }
  if (count !== expected.size || !looksLikeInstaller(expected.platform, header, trailer) || hashes.sha256.digest('hex') !== expected.sha256 || hashes.sha512.digest('hex') !== expected.sha512) throw failure('updates.integrityFailed');
}

class UpdateManager {
  constructor({ currentVersion, dataDir, getRepository = () => '', emit = () => {}, install, request = openResponse, platform = process.platform } = {}) {
    versionParts(currentVersion);
    if (!path.isAbsolute(dataDir || '')) throw new Error('Updates require an absolute data directory.');
    this.currentVersion = currentVersion;
    this.dataDir = dataDir;
    this.platform = platform;
    this.getRepository = getRepository;
    this.emit = emit;
    this.installCallback = install;
    this.request = request;
    this.busy = false;
    this.selection = null;
    this.downloadedPath = null;
    this.state = { status: 'idle', currentVersion, latestVersion: null, message: text('updates.idle'), progress: null, repository: repositoryName(getRepository()) || '' };
  }
  getState() {
    const state = structuredClone(this.state);
    if (state.message && typeof state.message === 'object') state.message = i18n.t(state.message.key, state.message.vars);
    return state;
  }
  set(patch) { this.state = { ...this.state, ...patch }; this.emit(this.getState()); return this.getState(); }
  fail(error) { return this.set({ status: 'error', message: error?.i18nKey ? text(error.i18nKey, error.i18nVars) : error instanceof Error ? error.message : text('updates.failed'), progress: null }); }
  configured() {
    const repo = repositoryName(this.getRepository());
    if (!repo) { this.selection = null; this.downloadedPath = null; this.set({ status: 'not-configured', repository: '', latestVersion: null, progress: null, message: text('updates.notConfigured') }); }
    return repo;
  }
  async check() {
    if (this.busy) return this.getState();
    const repo = this.configured();
    if (!repo) return this.getState();
    const target = UPDATE_TARGETS[this.platform];
    if (!target) return this.fail(failure('updates.unsupportedPlatform'));
    this.busy = true; this.selection = null; this.downloadedPath = null;
    this.set({ status: 'checking', repository: repo, progress: null, latestVersion: null, message: text('updates.checking') });
    try {
      const release = JSON.parse((await readBuffer(`https://api.github.com/repos/${repo}/releases/latest`, 1024 * 1024, this.request)).toString('utf8'));
      if (release.draft || release.prerelease || typeof release.tag_name !== 'string') throw failure('updates.notStable');
      versionParts(release.tag_name);
      const latestVersion = release.tag_name.replace(/^v/, '');
      if (compareVersions(latestVersion, this.currentVersion) <= 0) return this.set({ status: 'up-to-date', latestVersion, message: text('updates.upToDate') });
      const asset = releaseAsset(release, target.manifest, repo);
      const manifest = JSON.parse((await readBuffer(asset.browser_download_url, 65536, this.request)).toString('utf8'));
      const selected = validateManifest(manifest, release, this.currentVersion, repo, this.platform);
      if (repositoryName(this.getRepository()) !== repo) throw failure('updates.repositoryChanged');
      this.selection = { ...selected, repository: repo };
      return this.set({ status: 'available', latestVersion: selected.version, message: text('updates.available', { version: selected.version }) });
    } catch (error) { return this.fail(error); }
    finally { this.busy = false; }
  }
  async updateDirectory() {
    await fsp.mkdir(this.dataDir, { recursive: true });
    const base = await fsp.realpath(this.dataDir);
    const folder = path.join(base, 'updates');
    await fsp.mkdir(folder, { recursive: true });
    if (await fsp.realpath(folder) !== folder || (await fsp.lstat(folder)).isSymbolicLink()) throw failure('updates.folderSymlink');
    return folder;
  }
  async download() {
    if (this.busy) return this.getState();
    const repo = this.configured();
    if (!repo) return this.getState();
    if (!this.selection || this.selection.repository !== repo) return this.fail(failure('updates.checkBeforeDownload'));
    this.busy = true; this.downloadedPath = null;
    const selected = { ...this.selection };
    let partial;
    this.set({ status: 'downloading', progress: 0, message: text('updates.downloading') });
    try {
      const folder = await this.updateDirectory();
      partial = path.join(folder, `${selected.file}.${randomUUID()}.part`);
      safeURL(selected.url);
      const response = await this.request(selected.url);
      if (response.headers?.['content-length'] && Number(response.headers['content-length']) !== selected.size) { response.destroy(); throw failure('updates.contentLengthMismatch'); }
      const file = await fsp.open(partial, 'wx', 0o600);
      let received = 0;
      const deadline = setTimeout(() => response.destroy(failure('updates.downloadTimeout')), 5 * 60000);
      try {
        for await (const chunk of response) {
          received += chunk.length;
          if (received > selected.size) { response.destroy(); throw failure('updates.downloadTooLarge'); }
          await file.writeFile(chunk);
          const progress = Math.floor(received / selected.size * 100);
          if (progress !== this.state.progress) this.set({ progress });
        }
        await file.sync();
      } finally { clearTimeout(deadline); await file.close(); }
      if (received !== selected.size) throw failure('updates.downloadInterrupted');
      await verifyFile(partial, selected);
      if (repositoryName(this.getRepository()) !== repo) throw failure('updates.repositoryChangedDuringDownload');
      // Unique final names prevent replacing or trusting a previous local download.
      const destination = path.join(folder, `${randomUUID()}-${selected.file}`);
      await fsp.rename(partial, destination); partial = null;
      this.downloadedPath = destination;
      return this.set({ status: 'downloaded', progress: 100, message: text('updates.downloaded') });
    } catch (error) { return this.fail(error); }
    finally { if (partial) await fsp.unlink(partial).catch(() => {}); this.busy = false; }
  }
  async install() {
    if (this.busy) return this.getState();
    const repo = this.configured();
    if (!repo) return this.getState();
    if (!this.selection || !this.downloadedPath || this.selection.repository !== repo) return this.fail(failure('updates.downloadBeforeInstall'));
    if (typeof this.installCallback !== 'function') return this.fail(failure('updates.packagedOnly'));
    this.busy = true;
    try {
      const folder = await this.updateDirectory();
      if (path.dirname(this.downloadedPath) !== folder || await fsp.realpath(this.downloadedPath) !== this.downloadedPath) throw failure('updates.invalidPath');
      await verifyFile(this.downloadedPath, this.selection);
      this.set({ status: 'installing', message: text('updates.installing'), progress: 100 });
      await this.installCallback(this.downloadedPath);
      return this.getState();
    } catch (error) { return this.fail(error); }
    finally { this.busy = false; }
  }
}
module.exports = { UpdateManager, UPDATE_TARGETS, repositoryName, compareVersions, safeURL, validateManifest, verifyFile, openResponse };
