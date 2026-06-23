import Foundation

// MARK: - HarnessBreakdown

/// Per-harness usage totals for a time window.
///
/// Only harnesses that have at least one `llm_messages` row in the query
/// window are included; harnesses known to the `harnesses` table but with no
/// messages in the window are omitted.
struct HarnessBreakdown: Identifiable, Equatable {

    /// Stable SwiftUI identity — uses the harness slug so list items are stable
    /// across snapshot refreshes.
    var id: String { harnessId }

    /// The harness slug as stored in `harnesses.name` (e.g. `"pi"`, `"claude-code"`).
    /// Stable across versions; used as the FK throughout the schema.
    let harnessId: String

    /// Human-readable name from `harnesses.display_name` (e.g. `"Pi"`, `"Claude Code"`).
    let displayName: String

    /// Aggregated metrics for this harness over the query window.
    ///
    /// The `week` label is conventional; the actual window is controlled by the
    /// `since` timestamp passed to `queryHarnessBreakdowns`.
    let week: UsageBucket
}

// MARK: - UsageSnapshot

/// A point-in-time snapshot of all analytics data shown in the popover.
///
/// Produced by `AnalyticsQueries.loadSnapshot()`. UI views should read this
/// value and never query SQLite directly.
struct UsageSnapshot: Equatable {

    /// When this snapshot was loaded from the database.
    let loadedAt: Date

    /// Aggregated metrics for today (since local midnight), across all harnesses.
    let today: UsageBucket

    /// Aggregated metrics for the rolling 7-day window (today + 6 prior days),
    /// across all harnesses.
    let week: UsageBucket

    /// Per-day cost points for the 21-week tile chart.
    /// The query layer fills missing days with zero-cost `DailyCostPoint`s
    /// so the chart always shows a stable layout.
    let dailyCost: [DailyCostPoint]

    /// Today's 15-minute usage buckets for the Today-card decorative background.
    /// The query layer fills missing buckets with zero-value points.
    let intradayUsage: [IntradayUsagePoint]

    /// Top five models by cost across all harnesses, descending.
    /// May contain fewer than five entries if fewer distinct models were active.
    let topModels: [ModelBreakdown]

    /// Top five repositories by cost across all harnesses, descending.
    /// May contain fewer than five entries if fewer repositories were active.
    let topRepos: [RepoBreakdown]

    /// Per-harness cost and token breakdowns for the week window.
    ///
    /// Only harnesses with activity in the window appear here. The UI should
    /// present per-harness totals as the primary breakdown and any all-harness
    /// sum as an explicitly-labelled rollup, because different harnesses may
    /// disagree on list prices for the same model.
    let harnessBreakdowns: [HarnessBreakdown]

    /// Total count of messages with `cost_source = 'unknown'` across all
    /// harnesses in the week window.
    ///
    /// These messages contribute zero to `week.costUSD`. A non-zero value means
    /// the displayed total is a lower bound; the UI must surface a caveat so
    /// users are not misled into interpreting missing cost as "free".
    let unpricedMessages: Int64

    /// True when the database schema version is newer than what this tray build
    /// knows about but still within the forward-compatibility window.
    ///
    /// Derived from `AnalyticsSchema.schemaIsDegraded` at snapshot load time.
    /// When true the popover shows a non-blocking update banner; the tray can
    /// still read all data it understands from older schema columns.
    let schemaIsDegraded: Bool

    /// The time window used to produce `topModels` and `topRepos`.
    ///
    /// Carried here so the popover can label the sections correctly
    /// (e.g. "TOP MODELS · TODAY" vs. "TOP MODELS · 7 DAYS") without needing
    /// a separate reference to `AppSettings`.
    let topListsPeriod: TopListsPeriod
}
