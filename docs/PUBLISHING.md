# Publish the first GitHub release

The repository is prepared for publication; building it does not push code, create a GitHub repository or upload a release. Use an account and repository name that you own. Replace `<owner>` below with your actual GitHub username or organization.

## Verify the source and artifact

```powershell
npm ci
npm test
npm run check
npm audit --omit=dev
npm audit
npm run dist:win
```

Review any audit findings. Version 0.3.0 removes the previously flagged build dependency chain with a scoped override; the full audit passed after the change. Recheck at release time because advisories change. Do not use `npm audit fix --force` blindly: it may change the packager incompatibly.

Check the freshly built portable executable itself. Verify tray recovery, expand/collapse, exit/restart, data directory, connecting/disconnecting, missing/stale readings and display scaling. Use synthetic readings for published screenshots. The native validation targets are Windows 10/11 and macOS 12+. The macOS workflow job verifies the signature and both architectures and runs the packaged app's smoke test. That does not replace opening the disk image on a real Mac: check the first-launch prompt, the menu bar icon, the Keychain prompt, notifications, the Claude sign-in in Terminal and the bar on a display with a notch.

The installer and portable executable are unsigned unless a real certificate is configured. State the actual signing status in release notes. The application supports a user-configured stable GitHub Releases source; no repository is preselected. See [UPDATES.md](UPDATES.md) for signing and installer details.

For a local shortcut after building, run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/create-shortcut.ps1`. It creates `Abrir Paceline.lnk` in the checkout. This shortcut uses `scripts/start-portable.ps1` to keep portable extraction inside the ignored `.local/runtime-tmp` folder on the project's drive. Opening the executable directly uses the operating system's temporary directory instead. Recreate the shortcut if you move the checkout.

## Inspect exactly what will be published

Start in your checkout. If Git has not yet been initialized:

```powershell
git init -b main
```

Then review the ignored state and stage the source:

```powershell
git status --short --ignored
git check-ignore .local node_modules release graphify-out
git add .
git diff --cached --stat
git diff --cached --check
git diff --cached
```

Review the complete staged diff before committing. No database, logs, exports, `.local` state, settings backup, credentials, real-account screenshot, dependencies or generated release should be staged. Check license ownership and attribution. If a secret was ever committed, ignoring it later does not remove it from history: resolve that before publishing.

```powershell
git commit -m "Prepare Paceline 0.4.0 desktop release"
git branch -M main
```

Do not change global Git identity to complete this step. Configure repository-local identity if needed using your own details.

## Create the public repository

With the official GitHub CLI installed and authenticated, run the following only when ready to make the reviewed source public:

```powershell
gh repo create <owner>/Paceline --public --source=. --remote=origin --push
```

For an already-created empty repository instead:

```powershell
git remote add origin https://github.com/<owner>/Paceline.git
git push -u origin main
```

Use one method, not both. Inspect `git remote -v` first if an origin already exists. Enable private vulnerability reporting in **Settings → Code security**, and enable the included GitHub Actions workflow. Confirm the clean-checkout checks pass.

## Tag and attach the artifact

After testing the exact artifacts, create a reviewable draft release. The built installer and generated manifest must be uploaded together:

```powershell
git tag -a v0.4.0 -m "Desktop 0.4.0"
git push origin v0.4.0
gh release create v0.4.0 release/Paceline-0.4.0-setup-x64.exe release/Paceline-0.4.0-windows-x64.exe release/paceline-update.json release/Paceline-0.4.0-setup-x64.exe.sha256 --draft --title "Paceline 0.4.0" --notes-file CHANGELOG.md
```

To serve Macs too, attach `release/Paceline-0.4.0-mac-universal.dmg`, `release/paceline-update-mac.json` and its `.sha256` from a macOS build (the **Build release candidate** workflow produces them).

Do not upload the entire checkout or data folder. Include the checksums, actual signing status (the macOS image is ad-hoc signed and not notarized), Windows x64 and macOS universal targets, Node.js requirement of the optional terminal bridge, the use of the Claude Code login for the undocumented usage endpoint, and pace-estimate limitations in release notes. Review the draft and publish it as a stable release only when ready. Configure the application's update repository to the real `owner/repo` after publication. The updater ignores drafts and prereleases.

Alternatively, run **Build release candidate** in GitHub Actions. Its default builds downloadable workflow artifacts. Selecting `create_draft_release` additionally creates a draft release; it never publishes automatically. Optional genuine signing uses `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD` secrets.

Rebuild and re-test if sources change after the last build. Regenerate the update manifest after any post-build signing. Do not claim signed distribution or working public updates until the certificate and published release actually exist.
