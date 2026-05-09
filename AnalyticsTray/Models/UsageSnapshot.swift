import Foundation

/// A point-in-time snapshot of all analytics data shown in the popover.
///
/// Produced by `AnalyticsStore` (T4) after running the five queries defined in
/// PLAN.md. UI views should read this value and never query SQLite directly.
struct UsageSnapshot: Equatable {

    /// When this snapshot was loaded from the database.
    let loadedAt: Date

    /// Aggregated metrics for today (since local midnight).
    let today: UsageBucket

    /// Aggregated metrics for the rolling 7-day window (today + 6 prior days).
    let week: UsageBucket

    /// Per-day cost points for the 7-day bar chart.
    /// The store/query layer fills missing days with zero-cost `DailyCostPoint`s
    /// so the chart always shows a stable 7-bar layout.
    let dailyCost: [DailyCostPoint]

    /// Top five models by cost, descending. May contain fewer than five entries
    /// if fewer models were used in the window.
    let topModels: [ModelBreakdown]

    /// Top five repositories by cost, descending. May contain fewer than five
    /// entries if fewer repos were active in the window.
    let topRepos: [RepoBreakdown]
}
