# Today Card Intraday Background Chart Plan

## Goal

Add a decorative, subdued intraday line chart behind the text in the Today summary card.

The chart should:

- Represent **today's activity so far**.
- Use **query-time aggregation only**; do not store buckets in SQLite.
- Show **no scale, labels, axes, grid, legends, or hover UI**.
- Sit visually underneath the card text without reducing readability.
- Favor smooth visual rhythm over analytical precision.
- Keep the tray app read-only and privacy-preserving.

## Non-goals

- No database writes.
- No schema changes or migrations.
- No persisted aggregate/cache table.
- No user-facing chart controls in v1.
- No replacement for the existing long-range cost chart.
- No exact analytical intraday chart with labels/tooltips.

## Current code context

Relevant files:

- `AnalyticsTray/Views/SummaryCard.swift`
  - Renders Today and This week cards.
  - Currently accepts `title`, `bucket`, and `showTurns`.
- `AnalyticsTray/Views/PopoverView.swift`
  - Composes the summary section.
  - Currently creates the Today card from `snapshot.today`.
- `AnalyticsTray/Models/UsageSnapshot.swift`
  - Contains `today`, `week`, `dailyCost`, `topModels`, and `topRepos`.
- `AnalyticsTray/Data/AnalyticsQueries.swift`
  - Builds `UsageSnapshot` and fills missing daily chart points.
- `AnalyticsTray/Data/AnalyticsDatabase.swift`
  - Contains read-only SQLite query methods.

This feature should follow the existing pattern: SQLite query method -> `AnalyticsQueries.loadSnapshot` -> `UsageSnapshot` -> SwiftUI view composition.

## Product decision

Use **15-minute intraday buckets** and smooth them visually in SwiftUI.

Rationale:

- The target visual is optimized for an approximately 8-hour workday.
- Hourly buckets would produce only about 8 useful points during a normal workday, which is too coarse for a background line.
- 15-minute buckets produce about 32 points over an 8-hour workday and at most 96 points over a full day, which is still tiny.
- The line should feel like visual texture/flair, not a precise analytical chart.

## Data semantics

### Metric

Use `costUSD`.

Why:

- Cost is the primary left-side metric in the Today card.
- It captures the weighted impact of usage better than raw token volume.
- It visually aligns with the most prominent card number.
- The chart should reinforce the Today card's cost story rather than introduce a second competing meaning.

### Bucket lifecycle

Buckets are **ephemeral derived data**:

1. SQLite aggregates today's `llm_messages` into 15-minute windows.
2. Swift fills missing windows with zero values.
3. SwiftUI smooths the values for display.
4. Data is discarded on the next refresh.

No buckets should be stored in the database.

## Proposed model

Add a new model file:

```text
AnalyticsTray/Models/IntradayUsagePoint.swift
```

Suggested type:

```swift
import Foundation

/// One intraday aggregate bucket used for the Today-card decorative sparkline.
///
/// Values are derived at query time from `llm_messages`; they are never stored
/// back into the analytics database.
struct IntradayUsagePoint: Identifiable, Equatable {
    var id: Date { bucketStart }

    /// Start of the local-time bucket, rounded down to the configured interval.
    let bucketStart: Date

    /// Total USD cost in this bucket.
    let costUSD: Double

    /// Non-cached tokens in this bucket (`input_tokens + output_tokens`).
    let billableTokens: Int64
}
```

Extend `UsageSnapshot`:

```swift
let intradayUsage: [IntradayUsagePoint]
```

## Query plan

Add a method to `AnalyticsDatabase`:

```swift
func queryIntradayUsage(
    since lowerBoundMilliseconds: Int64,
    bucketMinutes: Int
) throws -> [IntradayUsagePoint]
```

Call it with `bucketMinutes: 15` from `AnalyticsQueries.loadSnapshot`.

### SQL approach

Use integer timestamp bucketing rather than storing buckets.

Conceptually:

```sql
SELECT
  ((ts / 1000) / (? * 60)) * (? * 60) AS bucket_epoch_seconds,
  COALESCE(SUM(cost_total), 0) AS cost_usd,
  COALESCE(SUM(input_tokens + output_tokens), 0) AS billable_tokens
FROM llm_messages
WHERE ts >= ?
GROUP BY bucket_epoch_seconds
ORDER BY bucket_epoch_seconds;
```

Then convert `bucket_epoch_seconds` to `Date` in Swift.

### Local-time caveat

The lower bound is local midnight computed in Swift, so the query only includes today's local rows. Bucket boundaries based on epoch seconds are absolute 15-minute boundaries, which is acceptable because 15-minute boundaries align naturally across time zones.

For this use case, avoid complex SQLite localtime string formatting unless tests show a concrete issue.

## Fill plan

Add a helper to `AnalyticsQueries`:

```swift
static func fillMissingIntradayBuckets(
    _ points: [IntradayUsagePoint],
    from start: Date,
    through end: Date,
    bucketMinutes: Int = 15,
    calendar: Calendar = .current
) -> [IntradayUsagePoint]
```

Responsibilities:

- Normalize `start` to the beginning of the current local day.
- Round `end` down to the current 15-minute bucket.
- Produce every bucket from midnight through the current bucket inclusive.
- Preserve existing points.
- Fill missing buckets with zero cost/tokens.
- Bound the loop defensively to avoid accidental unbounded iteration.

Expected size:

- Early day: small number of buckets.
- Normal 8-hour workday: around 32 buckets.
- Full day: up to 96 buckets.

## Snapshot loading plan

In `AnalyticsQueries.loadSnapshot`:

1. Compute `todayStart` as it does today.
2. Compute `todayMillis` as it does today.
3. Query raw intraday points:

```swift
let rawIntradayUsage = try database.queryIntradayUsage(
    since: todayMillis,
    bucketMinutes: 15
)
```

4. Fill missing points:

```swift
let intradayUsage = fillMissingIntradayBuckets(
    rawIntradayUsage,
    from: todayStart,
    through: now,
    bucketMinutes: 15,
    calendar: calendar
)
```

5. Include `intradayUsage` in `UsageSnapshot`.

## View plan

### New background view

Add:

```text
AnalyticsTray/Views/SparklineBackgroundView.swift
```

Suggested API:

```swift
struct SparklineBackgroundView: View {
    let values: [Double]
    var smoothingWindow: Int = 3
}
```

Responsibilities:

- Ignore hit testing.
- Be accessibility-hidden; the card text already communicates the data.
- Normalize values into the available geometry.
- Smooth display values only; do not mutate source data.
- Draw a subtle curved line.
- Render no axes, labels, grid, legends, or scale.
- Handle empty/all-zero/all-equal data without visual glitches.

Suggested default style:

- Stroke: `Color.accentColor.opacity(0.12...0.16)`
- Line width: `1.5`
- Add a light under-curve fill with a vertical fade.
- Fill should be very subtle, e.g. `Color.accentColor.opacity(0.04...0.07)` near the line fading to clear at the bottom.
- Slight vertical inset so the line and fill do not collide with card edges.

### Smoothing

Start with a 3-bucket moving average.

For 15-minute buckets:

- 3 buckets = 45 minutes of smoothing.
- This should reduce spiky noise while preserving visible bursts.

Keep smoothing in the view layer because it is a rendering decision, not a data decision.

### Curve rendering

Use a native SwiftUI `Path`, not Apple Charts.

Rationale:

- The view is decorative.
- There is no need for chart axes, marks, tooltips, or scales.
- A custom path gives tighter control over opacity, clipping, and layering.

A simple first version can draw quadratic curves between midpoints. Use the same curve path to close an under-curve shape to the bottom of the view and fill it with a faint vertical gradient. If curved fill is too much for the first pass, start with a smoothed polyline plus matching gradient fill; visual review can decide whether the curve needs refinement.

## Summary card integration

Extend `SummaryCard`:

```swift
var backgroundChartValues: [Double] = []
```

Change the body to layer content over the background chart:

```swift
ZStack {
    SparklineBackgroundView(values: backgroundChartValues)
        .padding(.horizontal, 8)
        .padding(.vertical, 8)
        .allowsHitTesting(false)
        .accessibilityHidden(true)

    VStack(alignment: .leading, spacing: 8) {
        sectionLabel
        primaryMetricsRow
        secondaryMetricsRow
    }
    .padding(10)
}
.frame(maxWidth: .infinity, alignment: .leading)
.background(
    .quaternary,
    in: RoundedRectangle(cornerRadius: 8, style: .continuous)
)
.clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
```

Ensure the background line is clipped to the rounded card.

## Popover integration

Pass values only to the Today card:

```swift
SummaryCard(
    title: "Today",
    bucket: snapshot.today,
    showTurns: true,
    backgroundChartValues: snapshot.intradayUsage.map(\.costUSD)
)
```

Leave the Week card unchanged:

```swift
SummaryCard(
    title: "This week",
    bucket: snapshot.week,
    showTurns: false
)
```

## Tests

Add tests to `AnalyticsQueriesTests.swift`.

### Query tests

- `intradayUsageGroupsRowsIntoFifteenMinuteBuckets`
  - Insert rows at `00:02`, `00:14`, `00:15`, and `00:31`.
  - Expect first two rows grouped into `00:00`, third into `00:15`, fourth into `00:30`.

- `intradayUsageExcludesRowsBeforeTodayLowerBound`
  - Verify `WHERE ts >= ?` behavior.

### Fill tests

- `fillMissingIntradayBucketsProducesMidnightToCurrentBucketWindow`
  - Given current time `01:37`, expect buckets through `01:30`.

- `fillMissingIntradayBucketsPreservesExistingPoints`
  - Existing non-zero point remains in the expected slot.

- `fillMissingIntradayBucketsWithNoDataProducesZeros`
  - Useful for sparse/no-usage days.

- `fillMissingIntradayBucketsRejectsOrSafelyHandlesInvalidBucketMinutes`
  - Prefer a precondition/assertion for programmer error or a safe fallback to 15.

## Visual verification

Run:

```sh
swift test
swift build
swift run
```

Manually verify:

- Today card text remains readable.
- Chart is visible but subdued in dark mode.
- Chart is visible but subdued in light mode.
- Empty/all-zero today does not look broken or distracting.
- Sparse usage does not create extreme visual spikes after smoothing.
- The existing 20-week chart remains unchanged.
- Refreshing the popover updates the intraday line.

## Suggested implementation order

1. Add `IntradayUsagePoint`.
2. Extend `UsageSnapshot` and update all initializers/call sites.
3. Add `queryIntradayUsage` to `AnalyticsDatabase`.
4. Add `fillMissingIntradayBuckets` to `AnalyticsQueries`.
5. Load intraday data in `loadSnapshot`.
6. Add query/fill tests.
7. Add `SparklineBackgroundView`.
8. Extend `SummaryCard` with optional background values.
9. Pass Today-card values from `PopoverView`.
10. Run tests/build and do visual tuning.

## Open tuning knobs

These should remain simple constants initially:

```text
Bucket size:       15 minutes
Smoothing window: 3 buckets
Metric:           costUSD
Stroke opacity:   0.12–0.16
Line width:       1.5
Fill:             faint under-curve vertical fade
```

Only promote these to settings if there is a real need later.
