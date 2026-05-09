import SwiftUI

/// Displays a rolled-up usage summary for a single time window (today or this week).
///
/// **Token accounting rule:** only `bucket.billableTokens` is shown. `cachedTokens`
/// is deliberately omitted so the displayed number matches what affects cost.
struct SummaryCard: View {

    let title: String
    let bucket: UsageBucket
    /// Pass `true` for the Today card; `false` for the Week card (which shows
    /// sessions but not turns per the PLAN.md product spec).
    var showTurns: Bool = true
    /// Optional background sparkline values. When non-empty, a subdued line
    /// chart is rendered behind the card text for visual flair.
    var backgroundChartValues: [Double] = []
    /// Trims inactive zero-value buckets at both ends of the background chart.
    /// Useful for intraday charts; leave disabled for fixed-window charts.
    var backgroundChartTrimsZeroEdges: Bool = true
    /// Moving-average window for the decorative line. Use 1 to preserve exact
    /// point-to-point shape for small fixed windows.
    var backgroundChartSmoothingWindow: Int = 3

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionLabel
            primaryMetricsRow
            secondaryMetricsRow
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            // Render the colored card background and the optional sparkline
            // together so the sparkline is clipped to the rounded rectangle.
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(.quaternary)
            if !backgroundChartValues.isEmpty {
                SparklineBackgroundView(
                    values: backgroundChartValues,
                    trimZeroEdges: backgroundChartTrimsZeroEdges,
                    smoothingWindow: backgroundChartSmoothingWindow
                )
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
        }
    }

    // MARK: - Section label

    private var sectionLabel: some View {
        Text(title.uppercased())
            .font(.caption2)
            .fontWeight(.semibold)
            .foregroundStyle(.secondary)
            .tracking(0.5)
    }

    // MARK: - Primary metrics (cost left, tokens right)

    private var primaryMetricsRow: some View {
        HStack(alignment: .lastTextBaseline) {
            metricColumn(
                value: Formatters.formatCost(bucket.costUSD),
                label: "cost"
            )
            Spacer()
            metricColumn(
                value: Formatters.formatTokens(bucket.billableTokens),
                label: "tokens"
            )
        }
    }

    private func metricColumn(value: String, label: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(value)
                .font(.system(.title3, design: .monospaced))
                .fontWeight(.semibold)
                .foregroundStyle(.primary)
            Text(label)
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    // MARK: - Secondary metrics (turns + sessions)

    private var secondaryMetricsRow: some View {
        HStack(spacing: 12) {
            if showTurns {
                miniStat(icon: "arrow.turn.down.right", count: bucket.turns, singular: "turn", plural: "turns")
            }
            miniStat(icon: "terminal", count: bucket.sessions, singular: "session", plural: "sessions")
            Spacer()
        }
    }

    private func miniStat(icon: String, count: Int64, singular: String, plural: String) -> some View {
        HStack(spacing: 3) {
            Image(systemName: icon)
                .imageScale(.small)
            Text("\(count) \(count == 1 ? singular : plural)")
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
    }
}
