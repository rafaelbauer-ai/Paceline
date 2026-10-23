# Installer, updates and signing

## Windows installation

Version 0.4.0 builds two x64 artifacts:

- `release/Paceline-0.4.0-setup-x64.exe`: assisted NSIS installer, per user, with a folder picker and Start menu/desktop shortcuts.
- `release/Paceline-0.4.0-windows-x64.exe`: portable application.

If `D:\projetos` exists, a new installation defaults to `D:\projetos\Paceline-Desktop`. An existing registered installation keeps its location. On machines without that folder the standard per-user program folder is used; the installer lets the user choose another writable directory. No administrator elevation is requested.

State is kept in `paceline-data/` beside the installed or portable executable unless `PACELINE_HOME` selects an absolute location. Keep the whole data folder when moving a portable copy. A portable copy and an installed copy in different directories otherwise have different state; to share existing state, configure the same absolute `PACELINE_HOME` before launch. Do not run both against one data folder concurrently.

The custom uninstaller restores the previous Claude status-line integration before removing the app. Restoration failures stop uninstall and preserve the application for recovery. Application updates do not remove the bridge. Both update and uninstall remove only known application files; local data and the data-location marker are preserved. Remove those files yourself only when you intend to erase your history and settings.

Manual integration recovery from the source checkout is also available:

```powershell
node scripts/install-claude-bridge.cjs --data-dir "<absolute-data-folder>" --uninstall
```

## macOS installation

`release/Paceline-0.4.0-mac-universal.dmg` holds one universal app for Apple Silicon and Intel (macOS 12 or newer). Drag it into Applications. Its data lives in `~/Library/Application Support/Paceline`, outside the app bundle, so replacing the app keeps history and settings. `PACELINE_HOME` can still choose another absolute folder.

The build is ad-hoc signed, which Apple Silicon requires before it runs any code, and it is not notarized. Gatekeeper therefore asks the user to approve the first launch (see the README). A Developer ID certificate and Apple notarization would remove that prompt; neither is configured. A disk image has no uninstaller, so before deleting the app, remove the optional Claude bridge with **Settings → Connections → Remove integration**.

## Configure an update publisher

Set the GitHub repository in Paceline settings to the trusted publisher's `owner/repo`. The field starts empty: this checkout has no invented remote or hosted feed. Only public, stable GitHub Releases are supported. Drafts, prereleases, private repositories, custom feed URLs and downgrade installs are not supported.

Checking, downloading and installing are explicit actions. The updater never supplies an account token to GitHub. GitHub can see your IP address and requested repository/asset when you use those actions. No usage metrics are sent.

A release must have tag `vX.Y.Z` and include, for each platform it serves:

1. Windows: `Paceline-X.Y.Z-setup-x64.exe` and `paceline-update.json`, generated from that exact final installer.
2. macOS: `Paceline-X.Y.Z-mac-universal.dmg` and `paceline-update-mac.json`, generated from that exact disk image.

Each app reads only its own platform's manifest. The manifest identifies the platform, architecture, semantic version, filename, size, SHA-256 and SHA-512. Besides the hashes, the downloaded file must look like the expected format: a Windows PE file, or a disk image ending in its UDIF trailer. On macOS, installing opens the verified disk image in Finder and quits Paceline, so you can drag the new version over the old one in Applications. The updater binds each asset URL to the selected repository and release; follows a bounded number of HTTPS redirects only to allowed GitHub download hosts; bounds metadata/download sizes; verifies both hashes and size; and repeats file verification immediately before passing the installer to the native launch callback. Partial/corrupt downloads cannot be installed. Downloaded installers remain in the local `updates/` directory for inspection or cleanup.

These checks establish integrity relative to the selected release. **A checksum fetched from the same repository is not an independent publisher signature.** Trust the configured publisher and protect its GitHub account. Authenticode signing adds Windows publisher verification when a real signing certificate is supplied.

## Build and publish metadata

```powershell
npm run dist:win
```

This builds NSIS and portable artifacts, then runs `scripts/create-update-manifest.cjs`. `npm run dist:installer` builds only NSIS plus metadata; `npm run dist:portable` builds only portable. On a Mac, `npm run dist:mac` builds the universal disk image and `paceline-update-mac.json` (`node scripts/create-update-manifest.cjs --mac` regenerates the manifest alone). If you sign or otherwise change the installer after building, run `npm run update:manifest` again and re-test before upload. Never reuse hashes from a previous artifact.

See [PUBLISHING.md](PUBLISHING.md). The optional release workflow builds and uploads artifacts to the workflow run. Its explicit `create_draft_release` input creates only a draft GitHub release; a maintainer must review and publish it. A draft or prerelease will not appear in the application's stable updater.

## Signing status

No signing certificate is bundled, invented or required to build locally. Without a certificate, Windows artifacts remain unsigned and may display publisher/reputation warnings. A public release feed and a real publisher certificate are external prerequisites; the source alone cannot create either.

For local builds, electron-builder supports `CSC_LINK` and `CSC_KEY_PASSWORD` from the environment. For the release workflow, configure GitHub Actions secrets `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD`. Use a genuine Windows signing certificate in a format supported by [electron-builder](https://www.electron.build/code-signing-win). Keep certificate material and passwords out of Git and build logs. The workflow checks Authenticode validity when a certificate was configured, and reports unsigned output otherwise.

## Build dependency correction

The original build tree pulled `sprintf-js` through `@electron/get → global-agent → roarr`. [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) lists unbounded precision denial of service and no patched `sprintf-js` version. A narrow npm override selects `global-agent` 4.1.3 for `@electron/get`, which removes that obsolete dependency chain while retaining its `bootstrap()` API. The bootstrap compatibility check and full npm audit passed after the change. Keep the lockfile and run a fresh audit before each release; this is not a permanent guarantee about future advisories.
