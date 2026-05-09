import SwiftUI
import Charts

/// Compact 7-day daily cost bar chart rendered in the popover.
///
/// Expects the `points` array to already contain one entry per calendar day
/// (including zero-cost days), as produced by `AnalyticsQueries.fillMissingDays`.
/// If sparse data is passed, Charts bins by `.day` and still renders correctly.
struct DailyCostChartView: View {

    let points: [DailyCostPoint]

    // MARK: - Derived

    /// True when every data point has zero cost (new install / no recent usage).
    private var allZero: Bool {
        points.allSatisfy { $0.costUSD == 0 }
    }

    /// The maximum cost value — used to set a sensible Y-domain lower bound.
    private var maxCost: Double {
        points.map(\.costUSD).max() ?? 0
    }

    // MARK: - Body

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionLabel("7-Day Cost")
            chartBody
        }
    }

    // MARK: - Chart

    @ViewBuilder
    private var chartBody: some View {
        ZStack(alignment: .center) {
            Chart(points) { point in
                BarMark(
                    x: .value("Day", point.day, unit: .day),
                    y: .value("Cost (USD)", point.costUSD)
                )
                // Dim bars to grey when all-zero so the "no data" state reads clearly.
                .foregroundStyle(allZero
                    ? Color.secondary.opacity(0.25)
                    : Color.accentColor.opacity(0.75)
                )
                .cornerRadius(2)
            }
            // X axis: one narrow weekday letter per bar (M T W T F S S).
            // Using narrow weekday keeps the 7 labels from overlapping at 280pt width.
            .chartXAxis {
                AxisMarks(values: points.map(\.day)) { value in
                    AxisValueLabel(
                        format: .dateTime.weekday(.narrow),
                        centered: true
                    )
                    .font(.caption2)
                }
            }
            // Y axis hidden — bar heights communicate relative cost.
            // Absolute values are shown in the summary cards above.
            .chartYAxis(.hidden)
            // Ensure the Y domain always starts at 0 and has a small positive
            // upper bound even when all bars are zero so the chart renders.
            .chartYScale(domain: 0...(max(maxCost, 0.001)))
            .frame(height: 80)

            // Overlay when there is nothing to show this week.
            if allZero {
                Text("No cost this week")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .allowsHitTesting(false)
            }
        }
    }

    // MARK: - Section label helper

    private func sectionLabel(_ text: String) -> some View {
        Text(text.uppercased())
            .font(.caption2)
            .fontWeight(.semibold)
            .foregroundStyle(.secondary)
            .tracking(0.5)
    }
}
