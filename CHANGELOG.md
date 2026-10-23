# Changelog

## 0.4.0 — Unreleased

- macOS version: a universal disk image (Apple Silicon and Intel, macOS 12+), ad-hoc signed and not notarized, built and smoke-tested by a macOS job in both workflows. The app lives in the menu bar on every Space, keeps its data in `~/Library/Application Support/Paceline` and finds the CLIs through the login shell's `PATH`. It reads the Claude Code login from the Keychain, opens the Claude sign-in in the terminal app and supports opening at login. Its shortcut is `Control+Option+V`. The automatic theme recognizes the desktop apps and terminals running one of the CLIs. Updates use their own manifest and a verified disk image.
- Rename the app from TOKEN-VAULT to Paceline. The data folder beside the executable moves from `token-vault-data` to `paceline-data` on first start, a terminal bridge installed by an older build is re-pointed to it, the `vault` theme becomes `paceline`, and `TOKEN_VAULT_HOME`/`TOKEN_VAULT_CODEX_COMMAND` become `PACELINE_HOME`/`PACELINE_CODEX_COMMAND`.
- Mascots follow the agents: busy while Claude Code or Codex runs a turn, a short celebration when it ends, and an optional "done" notification after tasks of a minute or more. Activity comes from the tail of the transcripts both CLIs write; nothing is stored.
- Group folderless conversations in Projects (Claude desktop scratch folders, Codex standalone chats) and merge Codex desktop chats named after a project folder into that project.
- Show each window's pace from its own clock (used so far ÷ time elapsed): a tick on the bar marks where an even pace would leave you, and one line says when the limit would run out before the reset, how much per day is left in a weekly window, or the usage expected at the reset. History uses the same estimate and adds today's usage; the old forecast, which needed four readings and inflated the pace about twofold, is gone.
- Treat resets reported a second apart as the same window. Codex's reset jitter had split its chart into dozens of pieces, blocked its forecast and could repeat alerts.
- Fill the history with the official Codex limit readings recorded in Codex's own session logs (last 30 days), so it no longer depends on Paceline having been open.
- Count Claude tokens per project from Claude Code's transcripts, which the terminal CLI and the Claude desktop app both write. Each response is counted once although transcripts repeat it per content block. The status-line bridge no longer counts tokens. The Projects headline leaves out cache reads.
- Read the first pass over large local histories in quick bounded rounds instead of one small read per minute.
- Claude sign-in: the card's action opens the official `claude auth login` in its own window instead of installing the status-line bridge, and an expired sign-in is stated on the card while the last reading stays visible. The bridge moves to an optional advanced setting.
- Show per-model weekly Claude limits (Opus, Sonnet) when the account reports them.
- Alerts in the cards' unit ("alert when 30/20/10/5% is left"), a general on/off switch in Settings, toasts that say what is left and when it renews, a weekly pace warning, and a "freed again" notice only after a window that got close to the limit, including Claude's 5-hour window, which reports no reset once it expires. Hidden providers no longer notify. Clicking a notification opens the panel.
- "Restart and install" reopens Paceline after the silent install; the update repository field moves under Advanced.
- Codex in Connections offers "Switch account" once signed in instead of always starting a new login.
- Remove the inactive-projects view: its Claude source was gone, most entries were scratch folders and it was outside the app's purpose.
- Add English and Spanish alongside Portuguese. Flags in the header switch the language in one click; by default it follows the system language. Main-process messages (provider status, tray, notifications, updates) switch too.
- The collapsed bar now shows only the mascot and the used percentage of each app's tightest limit.
- Mascot moods: crying when 15% or less is left, celebrating with arms up and jumps above 90% left; Codex's caret turns into a frown or a smile. The cursor mascot shows the same mood without jumping. Codex is drawn at the same visual scale as Claude.

- Harden the app: deny-by-default renderer CSP, every renderer network request refused, global guards against navigation, new windows and webviews, sandbox for all renderers, and Electron fuses in packaged builds (no run-as-Node, `NODE_OPTIONS` or inspector; ASAR integrity on). The Claude usage request refuses redirects.
- Remove the unused legacy Python ledger (`vault.py`, its schema, templates and tests) and an unused provider index module.
- Remember the last app in focus across restarts so the automatic theme no longer falls back to Vault green; give the Codex mascot an opaque centre in the theme colour.
- The portable launcher clears app extractions left by runs that did not exit cleanly.
- Add animated 3D Claude and Codex mascots built from layered vectors: they blink, float and react on hover. The brand mark switches to the mascot of the app in focus, and over the panel the pointer becomes that mascot. Respects reduced-motion settings.
- Read Claude 5-hour and weekly limits from the account usage endpoint with the existing Claude Code CLI login, so they appear without setup and also while working in the Claude desktop app. At most one request every 4 minutes, `Retry-After` honoured across restarts, no expired tokens sent and the token never stored. The status-line bridge remains an optional source.
- Give quota bars one stable meaning: remaining balance, with used percentage and renewal shown together for each independent limit. Clarify history filters and local tokens.
- Make the collapsed overlay vertical on the left and right edges while preserving the expanded panel.

## 0.3.1 — Unreleased

- Recognize the Windows Store Codex desktop app when its foreground process is `ChatGPT.exe`, using the Codex package path to distinguish it from ChatGPT.
- Add native Windows regression coverage for package identity, updated versions, browser/terminal matches and false positives.

## 0.3.0 — Unreleased

- Add quota history charts, qualified short-term forecasts and local token summaries by project/session.
- Add context-following themes, draggable placement and customization of scale, opacity, auto-hide, displayed providers and alerts.
- Add per-user NSIS installation with folder selection, shortcuts, and integration restoration on uninstall; preserve local data during upgrades and removal.
- Add explicit GitHub release check/download/install with strict repository/tag/filename binding, bounded HTTPS downloads and SHA-256/SHA-512 verification before execution.
- Generate release checksums/update metadata and prepare optional genuine certificate signing in a manual release workflow.
- Remove the vulnerable build-only `sprintf-js` dependency chain through a scoped `global-agent` 4.1.3 override; the full audit passed after the update.
- Keep public repository publication, publisher certificates and populated update releases as explicit external setup steps.

## 0.2.0 — Unreleased desktop preview

- Introduce an Electron desktop overlay with collapsed and expanded usage views, tray access, connection states and freshness indicators.
- Add official Codex app-server rate-limit integration and a local Claude Code status-line metrics bridge.
- Keep provider credentials with the official CLIs; persist only selected usage metrics and local settings.
- Add development/build commands, automated tests, contribution guidance, security policy, issue templates and MIT licensing.
- Preserve the original manual Python ledger as a separate optional tool.

### Legacy CLI 1.1.0

- Add `TOKEN_VAULT_LEGACY_HOME` to isolate manual data while retaining the original location by default.
- Make prompt refinement conservative; preserve paths, inline/fenced code and meaningful repeated text.
- Use unique identifiers for capsule and refined-prompt filenames to prevent same-time overwrites.
- Reject invalid, non-finite and out-of-range session/configuration values before opening the database.
- Protect the database and source paths from export overwrite; require `--force` for an existing JSON destination.
- Create queue folders on first use and close session-reporting database connections.
- Add isolated regressions with synthetic data.

## 1.0.0 — Original Python ledger

Manual session logging, heuristic Compute Unit budgets, reset/sync anchors, prompt preparation, memory capsules, deferred tasks and local JSON exports. This legacy version numbering is independent of the new desktop application.
