"use strict";
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const pkg = require('../package.json');
const { UPDATE_TARGETS } = require('../src/main/updates.cjs');
async function createManifest(directory = path.resolve(__dirname, '../release'), platform = 'win32') {
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('A stable x.y.z package version is required.');
  const target = UPDATE_TARGETS[platform];
  if (!target) throw new Error(`No update target for ${platform}.`);
  const filename = target.file(pkg.version);
  const file = path.join(directory, filename);
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size < 2 || stat.size > 512 * 1024 * 1024) throw new Error('Invalid installer size.');
  const sha256 = createHash('sha256'), sha512 = createHash('sha512');
  for await (const chunk of fs.createReadStream(file)) { sha256.update(chunk); sha512.update(chunk); }
  const manifest = { schemaVersion: 1, version: pkg.version, platform, arch: target.arch, file: filename, size: stat.size, sha256: sha256.digest('hex'), sha512: sha512.digest('hex') };
  fs.writeFileSync(path.join(directory, target.manifest), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(directory, `${filename}.sha256`), `${manifest.sha256}  ${filename}\n`);
  return manifest;
}
if (require.main === module) {
  const platform = process.argv.includes('--mac') ? 'darwin' : 'win32';
  createManifest(undefined, platform).then(result => console.log(`Update manifest created for ${result.file}`)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { createManifest };
