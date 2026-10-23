# Local data and measurements

Paceline does not run its own cloud service or send usage history to a remote analytics service. Provider CLIs continue their normal communication with their providers. Optional update checks/downloads contact GitHub and expose normal request metadata, such as your IP address, to that service.

## Sources and retained fields

| Feature | Read locally | Retained |
| --- | --- | --- |
| Codex account limits | Official app-server account rate-limit response | Supported windows, percentages, reset timestamps and reading time |
| Claude limits | Account usage endpoint read with the Claude Code CLI login; optional `statusLine` JSON supplied by Claude Code | Allowlisted limit metrics, timestamps, request deadlines/failure reason and bounded hashed session/replay fingerprints. Never the token |
| Codex project/session tokens and limit history | JSONL files under `CODEX_HOME/sessions` and `CODEX_HOME/archived_sessions`, or the standard `.codex` directory | Session/project/file hashes, project folder name, token counters, activity times, scan cursors, and the official limit readings (percentage, window length, reset) those logs record |
| Claude project/session tokens | Claude Code transcript JSONL files under `CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects`, written by the terminal CLI and by Claude Code in the Claude desktop app | Project/session hashes, project folder name, input/output/cache counters, activity times, per-file scan cursors keyed by path hash, and 16-hex-character hashes of message identifiers for deduplication |
| Agent activity (mascots, "done" notification) | The last few kilobytes of the Claude Code transcripts and Codex session logs written in the last minutes: record types and turn markers only | Nothing on disk; in memory only each provider's status (working, done, idle) and the current turn's start/end times |
| Active-app theme | Foreground process name and window title on Windows; on macOS the frontmost app's name and bundle identifier, and the process list (program names only) below a frontmost terminal or editor | Only the last recognized provider (`codex` or `claude`) in memory; no window-title, app or command history |
| Settings and updates | User preferences and public release metadata | Preferences and downloaded verified installers |

The Codex scanner reads bounded chunks of local session files to find `session_meta` and `event_msg/token_count` records; lines are matched on those record names before any parsing. The Claude scanner does the same for assistant messages that carry `usage`. Both kinds of files also contain conversation content; it is never parsed into Paceline storage, logged or sent anywhere. The scanners do not read auth files, do not traverse symlinks and do not change source files. Each refresh reads a bounded amount (48 MiB of Codex logs, 32 MiB of Claude transcripts); while unread data remains, the next round follows a second later, so the first pass over a large history finishes in a few minutes.

For Claude limits, Paceline reads only `claudeAiOauth.accessToken` and `expiresAt` from the Claude Code CLI's `.credentials.json`, or on macOS from the same JSON in the CLI's `Claude Code-credentials` Keychain item. The access token is held in memory for one HTTPS request to `https://api.anthropic.com/api/oauth/usage` and is never logged, written to Paceline storage or sent to any other host. The refresh token is never used; near expiry, Paceline runs the official `claude auth status` with its output discarded. `claude-api-state.json` keeps only the next request time, the last renewal attempt and a failure code.

The Claude bridge does not scrape credentials or browser sessions. Installing it backs up the user's existing Claude settings byte-for-byte and changes only the integration setup. A pre-existing settings file may contain user-supplied environment values or commands, so its backup must be treated as private even though the usage snapshot contains no authentication material.

## Meaning of token totals

Local tokens and subscription percentages answer different questions. Provider limits cover the account's rate-limit windows; locally observed tokens cover available sessions/responses on this machine. They cannot be reliably converted into one another.

For Codex, cumulative input/output values come from recorded session usage. Cached input is already included in input, and reasoning is already included in output; the app does not add either twice. Total is input plus output.

For Claude, every assistant response in a transcript carries its usage. Claude Code writes the same response once per content block, and forked or resumed sessions can copy earlier responses, so each response is counted once by its message and request identifiers. Input includes cache writes and cache reads; the headline number leaves cache reads out. Token totals are not invoices, subscription credit balances or monetary prices; no API price table is used.

## History and forecasts

`usage-history.json` retains up to 30 days of observed quota readings, bounded to 16 series and 6,000 points per series. Older readings are compacted into 15-minute buckets. UI chart ranges are 24 hours and 7 days. The history holds the readings this app collected plus the official Codex limit readings found in the last 30 days of Codex logs; it does not reach back to the start of the provider subscription. `claude-transcripts.json` keeps the Claude scanner's sessions, cursors and message hashes, pruned after 30 days.

`local-usage.json` retains at most 2,000 sessions, pruned 30 days after last activity. Only usage metadata and hashed identities are retained. Project folder names remain readable locally and may be sensitive. Diagnostic exports should not include these names by default.

The pace uses only the current reading: a window opens at 0% used, so the used percentage divided by the elapsed share of the window projects the usage at the reset. It is withheld in the first minutes of a window and when the latest reading is older than five minutes. It is an estimate; pauses, tasks and provider rules can change the result.

## Control and deletion

Data lives in `.local/data` in development, in `paceline-data` beside the executable in packaged Windows builds, and in `~/Library/Application Support/Paceline` on macOS; `PACELINE_HOME` can override the location. Local files are not encrypted at rest. Protect the OS account and data folder. The Git ignore/build allowlists exclude runtime data, settings backups and account screenshots.

Turn off active-app following to use a fixed theme. Remove the Claude bridge from settings or using the documented uninstall command to restore its previous status line. Uninstalling Paceline preserves the data folder deliberately. Stop the app before manually deleting that folder if you want to erase its settings/history; preserve or restore any integration configuration first. This does not delete provider-side history or reset provider quotas.
