# Tasks — Native pi Analytics Menu Bar App

> Generated from `PLAN.md` on 2026-05-09

## Dependency Graph

```text
T1 ──→ T2 ──┬──→ T3 ──┐
            │         ├──→ T4 ──→ T5 ──→ T6 ──→ T7 ──→ T8
            └─────────┘
```

## Legend

- `[ ]` Pending — ready to pick up when all dependencies are done
- `[→]` In Progress — claimed by an agent
- `[x]` Done
- `[!]` Blocked — dependency failed or issue found

---

## Wave 1 — Project Foundation

### T1: Buildable macOS menu bar skeleton
- [x] **Status:** Done
- **Depends on:** —
- **Files:** `Package.swift`, `AnalyticsTray/AnalyticsTrayApp.swift`, `AnalyticsTray/AppDelegate.swift`, `AnalyticsTray/StatusItemController.swift`, `AnalyticsTray/PopoverController.swift`, `AnalyticsTray/Views/PopoverView.swift`, `AnalyticsTray/Resources/Info.plist`
- **Description:** Create the initial SwiftPM-based macOS app skeleton using SwiftUI plus AppKit. The app must run as a menu bar-only utility with an `NSStatusItem`, an `NSPopover` hosting a placeholder `PopoverView`, and a Quit action. Configure the app so it does not show a Dock icon in normal runs, e.g. via `LSUIElement` in `Info.plist` or equivalent app activation policy.
- **Interface:** Provide `StatusItemController` with an updateable title API such as `setTitle(_ title: String)`. Provide `PopoverController` with `toggle(relativeTo:)`, `show(relativeTo:)`, and `close()` behavior; later UI tasks will replace the placeholder popover content but should not need to rewrite status item setup.
- **Verify:** `swift build`; run the executable and confirm a menu bar item appears, clicking it opens/closes a placeholder popover, and Quit exits the app.

---

## Wave 2 — Core Types and Utilities

### T2: Models, settings, paths, and formatting utilities
- [x] **Status:** Done
- **Depends on:** T1
- **Files:** `AnalyticsTray/Models/UsageBucket.swift`, `AnalyticsTray/Models/UsageSnapshot.swift`, `AnalyticsTray/Models/DailyCostPoint.swift`, `AnalyticsTray/Models/ModelBreakdown.swift`, `AnalyticsTray/Models/RepoBreakdown.swift`, `AnalyticsTray/Models/AppSettings.swift`, `AnalyticsTray/Utilities/Paths.swift`, `AnalyticsTray/Utilities/Formatters.swift`, `AnalyticsTray/Utilities/SQLiteError.swift`, `AnalyticsTrayTests/FormattersTests.swift`
- **Description:** Define the shared value types and utility APIs consumed by the data and UI layers. Token totals must distinguish billable non-cached tokens (`input_tokens + output_tokens`) from cached tokens; summary cards and menu labels must use billable tokens only. Implement default settings for database path `~/.pi/analytics/events.db`, refresh interval `60`, combined menu bar display mode, and launch-at-login disabled.
- **Interface:** Export `UsageBucket`, `UsageSnapshot`, `DailyCostPoint`, `ModelBreakdown`, `RepoBreakdown`, `AppSettings`, `Paths.expandingTilde(_:)`, `Paths.analyticsFolder(forDatabasePath:)`, currency formatting, compact token formatting, and status/menu title formatting for `π 284k · $1.42` style labels.
- **Verify:** `swift test --filter FormattersTests` and `swift build`.

---

## Wave 3 — Read-Only Data Access

### T3: Read-only SQLite query layer
- [x] **Status:** Done
- **Depends on:** T1, T2
- **Files:** `AnalyticsTray/Data/AnalyticsDatabase.swift`, `AnalyticsTray/Data/AnalyticsQueries.swift`, `AnalyticsTrayTests/AnalyticsQueriesTests.swift`
- **Description:** Implement SQLite access through the system `sqlite3` C API. Open databases read-only using URI mode with correctly percent-escaped `file:` URIs, set a short busy timeout around 250ms, never run writes/migrations/`VACUUM`/`PRAGMA journal_mode`, and treat open/query/schema errors as typed recoverable errors. Implement schema validation for required tables and columns, not just table names.
- **Interface:** Provide query functions that accept a database path and date bounds in Unix milliseconds and return `UsageBucket`, `[DailyCostPoint]`, `[ModelBreakdown]`, and `[RepoBreakdown]`. Required queries: today/week summaries, 7-day daily cost, top models preferring `llm_messages.model_id` with `turns.model_id` fallback, and top repositories via `sessions`. Missing `llm_messages.model_id` should choose the fallback query rather than failing schema validation.
- **Verify:** `swift test --filter AnalyticsQueriesTests`; manually compare at least one summary result against `sqlite3 ~/.pi/analytics/events.db` when the local DB exists.

---

## Wave 4 — Store and Refresh

### T4: Async analytics store and refresh timer
- [x] **Status:** Done
- **Depends on:** T2, T3
- **Files:** `AnalyticsTray/Data/AnalyticsStore.swift`, `AnalyticsTray/Data/AnalyticsRefreshTimer.swift`
- **Description:** Implement the observable state layer that loads snapshots from the SQLite query layer without blocking the main thread. Refresh should run on popover open, manual refresh, and a configurable timer; UI state updates must be published on the main actor. The store must represent loading, loaded, missing database, empty database, schema mismatch, and query error states while preserving last-known values where useful.
- **Interface:** Provide an `@MainActor` observable `AnalyticsStore` with state, `refresh()`, `refreshOnPopoverOpen()`, and settings-aware database path/interval handling. The store should produce a `UsageSnapshot` containing today, week, daily cost, top models, and top repos, and expose a menu bar title string or enough data for `StatusItemController` to set one.
- **Verify:** `swift build`; with a real DB path, trigger refresh and confirm state transitions complete without main-thread blocking or crashes.

---

## Wave 5 — Basic Popover

### T5: Popover MVP summaries and footer actions
- [x] **Status:** Done
- **Depends on:** T1, T2, T4
- **Files:** `AnalyticsTray/Views/PopoverView.swift`, `AnalyticsTray/Views/SummaryCard.swift`, `AnalyticsTray/Views/EmptyStateView.swift`, `AnalyticsTray/Views/ErrorStateView.swift`
- **Description:** Replace the placeholder popover with the MVP SwiftUI UI: today summary card, week summary card, loading/empty/missing/schema/query error states, and footer actions. Footer actions must include Refresh, Open Analytics Folder, Settings placeholder, and Quit. Opening the popover should trigger refresh through `AnalyticsStore`.
- **Interface:** `PopoverView` should accept or create an `AnalyticsStore` and call its refresh APIs. `SummaryCard` should render cost, billable tokens, turns, and sessions where applicable; cached tokens must not be mixed into the primary token display. `ErrorStateView` should show compact error text and a Refresh button.
- **Verify:** `swift build`; run the app and manually verify popover opens quickly, Refresh updates UI state, missing DB paths show the planned message, and Quit works.

---

## Wave 6 — Charts and Breakdowns

### T6: 7-day chart and top breakdown views
- [x] **Status:** Done
- **Depends on:** T5
- **Files:** `AnalyticsTray/Views/DailyCostChartView.swift`, `AnalyticsTray/Views/TopModelsView.swift`, `AnalyticsTray/Views/TopReposView.swift`, `AnalyticsTray/Views/PopoverView.swift`
- **Description:** Add the visual breakdown section to the popover. Render a 7-day daily cost bar chart using Apple's Charts framework and list the top five models and repositories by cost. The UI must handle sparse data, unknown/null model and repo labels, and should remain narrow/readable without unnecessary scrolling.
- **Interface:** `DailyCostChartView` consumes `[DailyCostPoint]` with missing days already filled by the store/query layer or fills them locally if not available. `TopModelsView` consumes `[ModelBreakdown]`; `TopReposView` consumes `[RepoBreakdown]`. `PopoverView` should compose these below the summary cards when loaded data exists.
- **Verify:** `swift build`; run against a sparse or small DB and confirm the chart still renders seven stable day buckets and lists handle `unknown` labels gracefully.

---

## Wave 7 — Settings

### T7: Settings UI and persisted preferences
- [x] **Status:** Done
- **Depends on:** T6
- **Files:** `AnalyticsTray/Views/SettingsView.swift`, `AnalyticsTray/SettingsWindowController.swift`, `AnalyticsTray/Models/AppSettings.swift`, `AnalyticsTray/Views/PopoverView.swift`
- **Description:** Implement settings for custom database path, refresh interval, menu bar display mode, and best-effort launch at login. Settings must persist in `UserDefaults`, invalid DB paths must be recoverable, and changing the DB path or refresh interval should trigger store/timer updates. Launch-at-login failures must not block normal app use and should explain common causes such as unsigned builds outside `/Applications`.
- **Interface:** `SettingsView` edits `AppSettings` values and exposes Save/Cancel or live update behavior. Provide a small `SettingsWindowController` or sheet presentation API callable from the popover footer. Menu display mode should support at least combined non-cached tokens + cost, tokens-only, and icon-only if feasible; combined remains the default.
- **Verify:** `swift build`; run the app, change settings, relaunch, and confirm preferences persist and invalid paths show recoverable UI states.

---

## Wave 8 — Final Integration, Tests, and Local Packaging

### T8: Polish, fixture tests, and unsigned local packaging
- [x] **Status:** Done
- **Depends on:** T6, T7
- **Files:** `AnalyticsTray/Resources/AppIcon.*`, `AnalyticsTray/Utilities/AppVersion.swift`, `AnalyticsTrayTests/AnalyticsQueriesTests.swift`, `AnalyticsTrayTests/FormattersTests.swift`, `AnalyticsTrayTests/Fixtures/empty.db`, `AnalyticsTrayTests/Fixtures/schema-mismatch.db`, `README.md`
- **Description:** Finish MVP polish and verification. Add an app icon if practical, app version/build metadata for diagnostics, fixture coverage for empty and schema-mismatch databases, tests for date bucket generation/missing-day fill logic, and local unsigned build/run instructions. Keep code signing, notarization, auto-update, and external distribution explicitly out of MVP.
- **Interface:** Diagnostics shown in schema/query error states should be able to include database path and app version. `README.md` should document building with SwiftPM or Xcode, running locally, optional copying to `/Applications`, privacy/read-only guarantees, and manual SQLite verification commands.
- **Verify:** `swift test`; `swift build`; manually run the packaged/local app and verify normal DB, missing DB, empty fixture, schema mismatch fixture, and refresh-while-pi-writes scenarios.
