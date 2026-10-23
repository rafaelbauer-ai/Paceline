# Contributing

Thanks for helping make usage limits easier to understand. Small, focused changes with clear reproduction steps are welcome.

## Set up

Use Node.js 22+ and npm. Clone into a writable development folder, then run `npm ci` and `npm start`. The current desktop target is Windows 10/11.

Run `npm test` and `npm run check` before submitting a pull request. Run `npm run pack` for changes affecting Electron packaging or native window behavior. Provider fixtures and test data must be synthetic. Tests must never use a contributor's real database, logs, credentials or account.

## Design constraints

- Prefer documented provider interfaces. Do not add credential scraping, unofficial OAuth impersonation, browser-cookie extraction or request interception.
- Keep credentials with the provider CLI. Store only the metrics the dashboard needs. The single exception is the Claude account usage reading: it holds the Claude Code CLI's access token in memory for one request to the usage endpoint, never stores, logs or forwards it, and never uses the refresh token. Do not extend this to other credentials.
- Missing, disconnected and stale states must stay distinct from zero consumption.
- Keep the renderer isolated; validate IPC arguments and avoid executing renderer-provided shell commands.
- Preserve existing user settings and provide a reversible setup path for local integrations.
- Respect reduced motion, keyboard access, clear focus states and readable contrast.
- Keep optional manual CU estimates separate from provider-reported percentages.

## Pull requests

Describe the problem, resulting behavior, relevant tests and any compatibility limits. Include screenshots for visible changes and explain how you checked hover/collapse, tray recovery and display scaling when affected. Update docs when setup or data collection changes.

Do not commit `.local`, databases, exports, private screenshots, logs, auth files, dependencies or generated releases. Use the issue templates for bugs and ideas; follow [SECURITY.md](SECURITY.md) for vulnerabilities. Never paste credentials into a public issue.

## Release checklist

Run tests from a clean checkout, create the Windows installer and portable build, and test the artifact itself: start, connect, stale/unavailable states, collapse/expand, tray restore, exit and restart with settings preserved. Verify its contents exclude user data. Test install, upgrade, uninstall and preserved data/Claude restoration in a separate folder. Regenerate update metadata from the exact final signed/unsigned installer. Configure GitHub Actions and private vulnerability reporting, review the staged files, and create a tagged release with platform and signing status. Publishing to GitHub and code signing are explicit release steps, not side effects of the build.

Contributions are accepted under the project's MIT license. Please be respectful, give reproducible evidence and keep review focused on the work.
