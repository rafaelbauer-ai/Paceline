# Security

Paceline is a local desktop utility. Provider authentication belongs to the official Codex/Claude Code tools. The overlay must not persist passwords, OAuth tokens, browser cookies, prompts or conversation transcripts. Local token summaries parse only supported metadata from local session files and discard conversation fields; see [PRIVACY.md](docs/PRIVACY.md).

## Report privately

If the repository's **Security → Report a vulnerability** feature is enabled, use it to send a private report. Include the affected version, platform, reproduction steps and impact, using synthetic examples.

If private reporting is unavailable, open an issue that only asks the maintainer to enable private vulnerability reporting. Do not include exploit details, personal data or credentials in that public issue. No private contact address is published yet.

Only the latest development release is currently maintained. There is no guaranteed response-time or backport policy during this early stage.

## Boundaries and local data

The Electron renderer is not a place for secrets. All process launches, filesystem access and provider communications belong in the main process and must use validated, narrow interfaces. The local Claude bridge should accept status-line input and persist only a small allowlist of metrics.

Data is stored locally, not encrypted at rest. Anyone with access to the same OS account or data directory may read it.

Hardening in place: the renderer runs sandboxed with context isolation and no Node.js, under a deny-by-default Content Security Policy; every network request from its session is refused; navigation, new windows, webviews and permission requests are denied for all web contents; IPC accepts only the app's own page. Packaged builds disable the run-as-Node, `NODE_OPTIONS` and inspector Electron fuses and enable ASAR integrity validation. The Claude usage request refuses redirects so the access token cannot be forwarded.

Use official provider CLIs and a supported runtime. Packaged Windows builds are unsigned unless a real certificate is configured. Updates are user initiated from a configured public GitHub repository. The app checks release binding, size and SHA-256/SHA-512 before installation. Those hashes verify integrity relative to the selected publisher; they do not independently authenticate that publisher. See [UPDATES.md](docs/UPDATES.md).

Before a public release, enable private vulnerability reporting in GitHub, review dependencies and verify that archives contain no `.local` state, auth files, databases or logs.
