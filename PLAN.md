# Native pi Analytics Menu Bar App — Plan

## Goal

Build a native macOS menu bar app, written in Swift/SwiftUI, that acts as a lightweight second frontend for the existing pi analytics data stored locally in `~/.pi/analytics/events.db`.

The app must be read-only in v1, fast to open, privacy-preserving, and useful as an always-on glanceable view of local pi usage.

This plan is influenced by the architectural-decisions guide: iterate in small increments, avoid over-engineering, prefer stable platform-native patterns, keep security/privacy explicit, and document hard-to-change choices before implementation.

## Non-goals for v1

- No new analytics collection pipeline.
- No cloud sync.
- No writes to the analytics database.
- No replacement for `/usage` inside pi.
- No cross-platform support.
- No complicated alerting/rules engine.
- No code signing, notarization, or distribution pipeline required for v1.

## Existing data source

The pi analytics extension already writes local data to:

```text
~/.pi/analytics/events.db
~/.pi/analytics/raw/events-YYYY-MM-DD.ndjson
```

The tray app should query SQLite directly and ignore the raw NDJSON logs for v1.

Important current tables:

- `sessions`
- `turns`
- `llm_messages`
- `tool_calls`
- `files_touched`
- `pr_associations`
- `commits_made`
- `resource_usage`

## Product shape

### Menu bar item

Default display:

```text
π 284k · $1.42
```

This represents today's non-cached tokens plus total pi cost in USD. Non-cached tokens are `input_tokens + output_tokens` only.

Future display modes:

- Today non-cached tokens
- Combined non-cached tokens + cost
- Compact icon-only mode

Token displays should show only actual non-cached tokens that affect cost: `input_tokens + output_tokens`. Cached read/write tokens are tracked separately for context, but should not be included in the primary token count shown in the menu bar or summary cards.

### Expanded popover

Clicking the menu bar item opens a SwiftUI popover with:

1. Today summary
   - cost
   - tokens
   - turns
   - sessions
2. This week summary
   - cost
   - tokens
   - sessions
3. 7-day cost chart
4. Top models by cost
5. Top repositories by cost
6. Footer actions
   - Refresh
   - Open Analytics Folder
   - Settings
   - Quit

## Technical recommendation

Use a native macOS app:

- SwiftUI for UI
- AppKit `NSStatusItem` for menu bar integration
- AppKit `NSPopover` for the expanded view
- Apple's Charts framework for simple graphs
- SQLite via the system `sqlite3` C API initially

Rationale:

- Native behavior matters more than implementation speed here.
- SwiftUI + AppKit is the standard path for menu bar apps.
- The required SQL is small enough that duplicating query logic in Swift is acceptable.
- Avoiding a third-party SQLite wrapper keeps the first version dependency-light.

Potential later dependency:

- `SQLite.swift` if raw `sqlite3` becomes too verbose.

## Build, signing, and distribution

The v1 app is a local utility and does not require code signing or notarization.

MVP build approach:

- Build with SwiftPM or Xcode locally.
- Assemble or run a normal `.app` bundle.
- Install locally by copying to `/Applications` when needed, especially for launch-at-login testing.
- Do not block the MVP on Developer ID certificates, hardened runtime, notarization, auto-update, or release packaging.

Code signing can be added later if the app is shared outside the local machine. For local development, signing failures should not block app functionality. Launch at login should still surface recoverable errors when macOS refuses registration, for example when the app is not installed in `/Applications`.

## Proposed repository layout

```text
analytics-tray/
  PLAN.md
  AnalyticsTray.xcodeproj/
  AnalyticsTray/
    AnalyticsTrayApp.swift
    AppDelegate.swift
    StatusItemController.swift
    PopoverController.swift

    Data/
      AnalyticsDatabase.swift
      AnalyticsQueries.swift
      AnalyticsStore.swift
      AnalyticsRefreshTimer.swift

    Models/
      UsageBucket.swift
      UsageSnapshot.swift
      DailyCostPoint.swift
      ModelBreakdown.swift
      RepoBreakdown.swift
      AppSettings.swift

    Views/
      PopoverView.swift
      SummaryCard.swift
      DailyCostChartView.swift
      TopModelsView.swift
      TopReposView.swift
      EmptyStateView.swift
      ErrorStateView.swift
      SettingsView.swift

    Utilities/
      Paths.swift
      Formatters.swift
      SQLiteError.swift

  AnalyticsTrayTests/
    AnalyticsQueriesTests.swift
    FormattersTests.swift
```

## Data model

### `UsageBucket`

```swift
struct UsageBucket {
    let costUSD: Double
    /// Actual non-cached tokens that affect the primary displayed token count.
    /// Computed as input_tokens + output_tokens.
    let billableTokens: Int64
    /// Cached read/write tokens, tracked separately and never mixed into the
    /// primary displayed token total.
    let cachedTokens: Int64
    let turns: Int64
    let sessions: Int64
}
```

### `UsageSnapshot`

```swift
struct UsageSnapshot {
    let loadedAt: Date
    let today: UsageBucket
    let week: UsageBucket
    let dailyCost: [DailyCostPoint]
    let topModels: [ModelBreakdown]
    let topRepos: [RepoBreakdown]
}
```

### `DailyCostPoint`

```swift
struct DailyCostPoint: Identifiable {
    let id: Date
    let day: Date
    let costUSD: Double
    let billableTokens: Int64
}
```

## Query plan

### Today summary

Use local midnight as the lower bound from Swift and pass it as Unix milliseconds.

```sql
SELECT
  COALESCE(SUM(cost_total), 0) AS cost_usd,
  COALESCE(SUM(input_tokens + output_tokens), 0) AS billable_tokens,
  COALESCE(SUM(cache_read_tokens + cache_write_tokens), 0) AS cached_tokens,
  COUNT(DISTINCT turn_id) AS turns,
  COUNT(DISTINCT session_id) AS sessions
FROM llm_messages
WHERE ts >= ?;
```

### Week summary

Same query, with start of local day six days ago as the lower bound.

### 7-day daily cost chart

```sql
SELECT
  date(ts / 1000, 'unixepoch', 'localtime') AS day,
  COALESCE(SUM(cost_total), 0) AS cost_usd,
  COALESCE(SUM(input_tokens + output_tokens), 0) AS billable_tokens
FROM llm_messages
WHERE ts >= ?
GROUP BY day
ORDER BY day;
```

The Swift layer should fill missing days with zero-value points so the chart is visually stable.

### Top models

Prefer the model recorded directly on `llm_messages`. Keep a fallback join to
`turns` for compatibility with older analytics schemas where message-level
`model_id` may be absent or null.

If `llm_messages.model_id` exists:

```sql
SELECT
  COALESCE(m.model_id, t.model_id, 'unknown') AS model_id,
  COALESCE(SUM(m.cost_total), 0) AS cost_usd,
  COALESCE(SUM(m.input_tokens + m.output_tokens), 0) AS billable_tokens,
  COUNT(DISTINCT m.turn_id) AS turns
FROM llm_messages m
LEFT JOIN turns t ON t.id = m.turn_id
WHERE m.ts >= ?
GROUP BY model_id
ORDER BY cost_usd DESC
LIMIT 5;
```

If schema validation determines that `llm_messages.model_id` is unavailable,
use `COALESCE(t.model_id, 'unknown')` instead.

### Top repositories

Join `llm_messages` to `sessions` by `session_id`.

```sql
SELECT
  COALESCE(NULLIF(s.repo_owner || '/' || s.repo_name, '/'), s.repo_remote, s.cwd, 'unknown') AS repo,
  COALESCE(SUM(m.cost_total), 0) AS cost_usd,
  COALESCE(SUM(m.input_tokens + m.output_tokens), 0) AS billable_tokens,
  COUNT(DISTINCT m.session_id) AS sessions
FROM llm_messages m
LEFT JOIN sessions s ON s.id = m.session_id
WHERE m.ts >= ?
GROUP BY repo
ORDER BY cost_usd DESC
LIMIT 5;
```

## SQLite behavior

Open the database read-only:

```text
file:/Users/<user>/.pi/analytics/events.db?mode=ro
```

Requirements:

- Use SQLite URI mode.
- Build SQLite file URIs with proper percent escaping; do not concatenate raw paths into `file:` URLs because custom paths may contain spaces, `#`, `?`, or other reserved characters.
- Never run writes, migrations, `VACUUM`, or `PRAGMA journal_mode`.
- Set a short busy timeout, e.g. 250ms.
- Treat database-open failure as a recoverable UI state.
- Refresh on popover open and on timer.
- Default timer interval: 60 seconds.
- Run all SQLite work off the main thread.
- Prefer either short-lived read-only connections per refresh or a single serialized database actor/queue that owns the SQLite connection.
- Publish UI state changes back on the main actor.
- Do not block popover opening on database reads; show loading/last-known values while refreshing.

Performance note: the analytics DB may not have a plain `llm_messages(ts)` index.
The tray app is read-only and must not create indexes itself, so query work must
remain asynchronous and cancellable where practical. If the DB grows large enough
for refresh latency to matter, add an upstream analytics migration for a timestamp
index such as `llm_messages(ts)` rather than mutating the DB from the tray app.

The app should tolerate WAL sidecar files:

```text
events.db-wal
events.db-shm
```

## UI states

### Normal state

Show summary, chart, top models, top repos.

### Missing database

Message:

```text
No pi analytics database found.
Start pi with the analytics extension enabled, or choose a custom database path in Settings.
```

### Empty database

Message:

```text
No usage data yet.
```

### Query error

Show compact error text and a Refresh button. Do not crash.

### Schema mismatch

If required tables or columns are missing, show:

```text
Unsupported analytics database schema.
```

Include the DB path and app version in a copyable diagnostic block later.

## Settings

Persist in `UserDefaults`:

- Database path
  - default: `~/.pi/analytics/events.db`
- Refresh interval
  - default: 60 seconds
- Menu bar display mode
  - default: combined non-cached tokens + cost
- Launch at login
  - default: off
  - implemented with the macOS login item APIs
  - best-effort for MVP; failures must be recoverable and should explain common causes such as running an unsigned build outside `/Applications`

## Graphs

Use Apple's Charts framework.

MVP graph:

- 7-day daily cost bar chart

Later graphs:

- 30-day cost trend
- token trend
- model cost stacked bars
- cache savings trend

Design constraints:

- Keep the popover narrow and readable.
- Prefer simple bars over complex dashboards.
- Avoid scrolling in the first version if possible.

## Implementation phases

### Phase 1 — Project skeleton

- Create macOS SwiftUI app.
- Add AppKit app delegate.
- Create `NSStatusItem`.
- Create `NSPopover` hosting `PopoverView`.
- Add Quit action.

Acceptance criteria:

- App launches as menu bar-only app.
- Clicking the menu bar item opens/closes a popover.
- App does not show a Dock icon unless intentionally configured for debug.

### Phase 2 — Read-only SQLite access

- Implement path expansion for `~`.
- Open SQLite read-only with URI mode.
- Add lightweight query helpers.
- Implement required schema validation for both tables and columns used by queries.
- Add today/week summary query.

Acceptance criteria:

- App can read `~/.pi/analytics/events.db`.
- Missing DB and query failures produce UI states, not crashes.
- Status item shows today's cost.

### Phase 3 — Popover MVP

- Implement `UsageSnapshot` loading.
- Render today and week summary cards.
- Add Refresh button.
- Add Open Analytics Folder action.
- Add basic loading/error/empty states.

Acceptance criteria:

- Opening the popover refreshes data.
- Manual refresh updates the UI.
- Values match equivalent `sqlite3` queries.

### Phase 4 — Graphs and breakdowns

- Add 7-day cost chart.
- Fill missing days in Swift.
- Add top models list.
- Add top repos list.

Acceptance criteria:

- Chart renders even with sparse data.
- Top model/repo lists handle unknown/null values gracefully.
- UI remains responsive during refresh.

### Phase 5 — Settings

- Add settings window or popover sheet.
- Support custom DB path.
- Support refresh interval.
- Support menu bar display mode.
- Support start at login if feasible without blocking unsigned local development.

Acceptance criteria:

- Settings persist across launches.
- Invalid DB paths are recoverable.
- Changing DB path triggers refresh.

### Phase 6 — Polish and packaging

- Add app icon.
- Add or finish start at login option if not completed in Phase 5.
- Add formatting polish for currency/non-cached tokens.
- Add app version/build metadata.
- Add basic tests for formatters and query mapping.
- Package unsigned local build first.
- Keep code signing and notarization out of the MVP; document them as future distribution work only.

Acceptance criteria:

- App can be built and run locally from Xcode or SwiftPM without signing.
- Launch-at-login failures do not block normal app use.
- App is usable as an always-on menu bar utility.
- Unsigned local packaging is sufficient for MVP verification.

## Testing strategy

### Unit tests

- Currency formatting
- Non-cached token formatting
- Date bucket generation
- Missing-day chart fill logic
- SQLite row mapping, using fixture DBs

### Manual verification

Compare app values against direct SQLite queries:

```sh
sqlite3 ~/.pi/analytics/events.db "SELECT round(sum(cost_total), 4) FROM llm_messages WHERE ts >= ...;"
```

Manual scenarios:

- DB exists and has data
- DB path missing
- Empty DB fixture
- Schema-mismatch fixture
- Large-ish DB
- Popover refresh while pi is writing analytics events

## Privacy and safety

- Do not transmit data anywhere.
- Do not read prompt text or tool argument/output payloads in v1.
- Only aggregate numeric usage data and repo/model labels.
- Open the DB read-only.
- Keep custom DB path local in `UserDefaults`.

## Open questions

1. Should the menu bar label show `π $x.xx` or just `$x.xx`?
2. Should default chart range be 7 days or 30 days?
3. Should the app live under `~/.pi/analytics-tray` or a normal code directory like `~/code/analytics-tray`?
4. Should we support multiple pi analytics DBs later?

## Recommended MVP definition

Ship the smallest version that is useful daily:

- Native menu bar app
- Read-only SQLite
- Combined non-cached tokens + cost in menu bar
- Unsigned local build/package path
- Popover with today/week summaries
- 7-day cost chart
- Top models
- Top repos
- Manual refresh
- Graceful missing/error states

Everything else can follow after this is running locally.
