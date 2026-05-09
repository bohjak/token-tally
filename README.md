# pi Analytics Tray

A native macOS menu bar app that shows a glanceable view of your local [pi](https://github.com/j-bohacek/pi) usage and costs. It reads directly from `~/.pi/analytics/events.db` — the same SQLite database that pi's analytics extension writes — and never transmits any data anywhere.

```
π 284k · $1.42
```

## Features

- **Menu bar label** — today's non-cached tokens and USD cost, updated every 60 s
- **Popover** — today and this-week summary cards, 7-day cost chart, top models, top repos
- **Read-only** — never writes to the analytics database, never opens a network connection
- **Graceful states** — missing database, empty database, schema mismatch, and query errors all show helpful messages instead of crashing
- **Settings** — custom database path, refresh interval, display mode, optional launch-at-login

## Requirements

- macOS 14 or later
- Command Line Tools for Xcode (or full Xcode)
- The [pi analytics extension](https://github.com/j-bohacek/pi) running locally (produces the SQLite database the app reads)

## Building with SwiftPM

```sh
# From the repo root:
swift build

# Run directly (no .app bundle; Dock icon is suppressed programmatically):
swift run
```

The executable appears in `.build/debug/AnalyticsTray`. You can launch it from the terminal or double-click after copying (see below).

## Building with Xcode

Open the project with:

```sh
cd pi-analytics-tray
xed .        # opens Package.swift in Xcode as a SwiftPM project
```

Select the `AnalyticsTray` scheme, choose **My Mac** as the run destination, and press ▶. Xcode handles code signing automatically for local runs (using an ad-hoc certificate).

## Running locally without code signing

SwiftPM builds are unsigned by default and will run on the machine they were compiled on without any signing configuration.

```sh
swift build && swift run
```

You may see a Gatekeeper warning when running a binary copied from the build directory on another machine, but for local-only use this is not an issue.

## Optional: install to /Applications

Launch-at-login and some system-level APIs work best (or exclusively) when the app lives in `/Applications`. For day-to-day development you do **not** need to do this.

```sh
make install
```

This builds a release binary, wraps it in `dist/AnalyticsTray.app`, and copies the bundle to `/Applications/AnalyticsTray.app`.

After installing, launch with:

```sh
open /Applications/AnalyticsTray.app
```

## Running the tests

```sh
swift test
```

The test suite uses Swift Testing (`import Testing`) linked against the Command Line Tools Testing framework. All tests should compile and pass. The test runner prints "Build complete!" with exit code 0 when all tests pass; no individual test output is shown because Swift Testing suppresses output for passing tests in this CLT environment.

To run a specific suite by name:

```sh
swift test --filter AnalyticsQueriesTests
swift test --filter FormattersTests
```

### Fixture databases

The on-disk SQLite fixture files in `AnalyticsTrayTests/Fixtures/` are excluded from the SwiftPM test target to avoid resource warnings. Fixture tests access them via `#filePath` (compile-time source path), so they do not need to be bundled resources.

## Manual verification against the real database

Compare the app's numbers to raw SQLite queries:

```sh
# Today's totals (replace the timestamp with today's local midnight in ms)
TODAY_MS=$(python3 -c "
import time, datetime
today = datetime.datetime.combine(datetime.date.today(), datetime.time())
print(int(today.timestamp() * 1000))
")

sqlite3 ~/.pi/analytics/events.db "
SELECT
  round(sum(cost_total), 4) AS cost_usd,
  sum(input_tokens + output_tokens) AS billable_tokens,
  count(distinct turn_id) AS turns,
  count(distinct session_id) AS sessions
FROM llm_messages
WHERE ts >= $TODAY_MS;
"

# This week's totals (six days back)
WEEK_MS=$(python3 -c "
import time, datetime
week = datetime.datetime.combine(datetime.date.today() - datetime.timedelta(days=6), datetime.time())
print(int(week.timestamp() * 1000))
")

sqlite3 ~/.pi/analytics/events.db "
SELECT round(sum(cost_total), 4), sum(input_tokens + output_tokens)
FROM llm_messages WHERE ts >= $WEEK_MS;
"

# Top models this week
sqlite3 ~/.pi/analytics/events.db "
SELECT
  coalesce(model_id, 'unknown') AS model,
  round(sum(cost_total), 4) AS cost,
  sum(input_tokens + output_tokens) AS tokens
FROM llm_messages
WHERE ts >= $WEEK_MS
GROUP BY model ORDER BY cost DESC LIMIT 5;
"
```

## Privacy and safety

- **No network access** — all data stays on your Mac
- **Read-only database access** — the app opens the SQLite file with `SQLITE_OPEN_READONLY` and URI mode `?mode=ro`; it never writes, migrates, or vacuums the database
- **No prompt content** — only aggregate numeric usage data and model/repository labels are read; prompt text and tool outputs are never accessed
- **Local settings only** — the custom database path setting is stored in `UserDefaults` on your machine, not synced

## Token accounting

The menu bar label and summary cards show only **non-cached (billable) tokens**:

```
billable_tokens = input_tokens + output_tokens
```

Cache-read and cache-write tokens are tracked separately in the database and are available for future display, but are deliberately excluded from the primary token count to avoid inflating the perceived usage.

## App icon

SwiftPM executables do not support `.xcassets` icon catalogs in the same way Xcode app targets do. An app icon requires either:

1. Full Xcode project (`.xcodeproj`) with an Asset Catalog target
2. A manual `AppIcon.icns` file copied to the `.app/Contents/Resources/` directory alongside an `Info.plist` that references it

For local MVP use the default system icon is acceptable. To add a proper icon later, create a 1024×1024 PNG, convert it with `iconutil`, and reference it in `Info.plist`:

```sh
mkdir MyIcon.iconset
# ... add icon sizes ...
iconutil -c icns MyIcon.iconset -o AnalyticsTray/Resources/AppIcon.icns
```

Then add to `Info.plist`:

```xml
<key>CFBundleIconFile</key>
<string>AppIcon</string>
```

## Future work (out of scope for v1)

- Code signing with a Developer ID certificate
- Notarization and Gatekeeper stapling
- Auto-update (e.g. via Sparkle)
- Distribution outside the local machine
- 30-day cost trend, cache savings trend, stacked model charts
- Multiple analytics database support