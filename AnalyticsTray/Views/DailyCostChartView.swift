import SwiftUI

/// Compact daily cost tile chart rendered in the popover.
///
/// Expects the `points` array to contain one entry per calendar day, as produced
/// by `AnalyticsQueries.fillMissingDays`. The visual style is intentionally
/// similar to GitHub's contribution graph: one square per day, grouped into
/// week columns, with fill intensity proportional to that day's cost.
///
/// Layout maths (21 weeks, ~256 pt available, 2 pt spacing):
///   available = 256 − (20 × 2) = 216
///   tileSize  = ⌊216 / 21⌋     = 10
///   height    = (10 × 7) + (2 × 6) = 82
struct DailyCostChartView: View {

    let points: [DailyCostPoint]

    private let tileSpacing: CGFloat = 2

    // Tracks the height computed inside GeometryReader and propagated via
    // preference key so the outer .frame can match it exactly.
    @State private var computedChartHeight: CGFloat = 82

    // MARK: - Derived

    /// True when every data point has zero cost (new install / no recent usage).
    private var allZero: Bool {
        points.allSatisfy { $0.costUSD == 0 }
    }

    /// The maximum cost value, used to normalize tile intensity.
    private var maxCost: Double {
        points.map(\.costUSD).max() ?? 0
    }

    /// Points laid out by columns of weeks, GitHub-style.
    private var weekColumns: [[DailyCostPoint]] {
        stride(from: 0, to: points.count, by: 7).map { start in
            Array(points[start..<min(start + 7, points.count)])
        }
    }

    // MARK: - Body

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionLabel("21-Week Usage")
            tileChart
        }
    }

    // MARK: - Tile chart

    private var tileChart: some View {
        GeometryReader { proxy in
            let cols = CGFloat(weekColumns.count)
            let ts   = tileSize(for: proxy.size.width, columns: cols)
            let h    = (ts * 7) + (tileSpacing * 6)

            HStack(alignment: .top, spacing: tileSpacing) {
                ForEach(Array(weekColumns.enumerated()), id: \.offset) { _, week in
                    VStack(spacing: tileSpacing) {
                        ForEach(week) { point in
                            tile(for: point, size: ts)
                        }
                    }
                }

                Spacer(minLength: 0)
            }
            .overlay(alignment: .center) {
                if allZero {
                    Text("No cost in this period")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .padding(.horizontal, 6)
                        .background(.regularMaterial, in: Capsule())
                        .allowsHitTesting(false)
                }
            }
            // Communicate the true content height upward so the outer frame
            // can be set to exactly the right value without hardcoding a max.
            .preference(key: ChartHeightPreferenceKey.self, value: h)
        }
        .onPreferenceChange(ChartHeightPreferenceKey.self) { computedChartHeight = $0 }
        .frame(height: computedChartHeight)
        .clipped()
        .accessibilityElement(children: .contain)
    }

    /// Returns the tile side length given the available width and the number of
    /// week columns.  The result is clamped to [1, 16] pt.
    private func tileSize(for width: CGFloat, columns: CGFloat) -> CGFloat {
        guard columns > 0 else { return 1 }
        let available = width - (tileSpacing * (columns - 1))
        return max(1, min(floor(available / columns), 16))
    }

    private func tile(for point: DailyCostPoint, size: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: min(size * 0.22, 3), style: .continuous)
            .fill(color(for: point.costUSD))
            .frame(width: size, height: size)
            .overlay {
                RoundedRectangle(cornerRadius: min(size * 0.22, 3), style: .continuous)
                    .strokeBorder(Color.secondary.opacity(0.10), lineWidth: 0.5)
            }
            .help("\(Self.fullDayFormatter.string(from: point.day)): \(Formatters.formatCost(point.costUSD))")
            .accessibilityLabel("\(Self.fullDayFormatter.string(from: point.day)), \(Formatters.formatCost(point.costUSD))")
    }

    private func color(for cost: Double) -> Color {
        guard maxCost > 0, cost > 0 else {
            return Color.secondary.opacity(0.14)
        }

        // Keep non-zero days visible while still showing relative intensity.
        let normalized = min(max(cost / maxCost, 0), 1)
        let opacity = 0.22 + (normalized * 0.58)
        return Color.accentColor.opacity(opacity)
    }

    // MARK: - Section label helper

    private func sectionLabel(_ text: String) -> some View {
        Text(text.uppercased())
            .font(.caption2)
            .fontWeight(.semibold)
            .foregroundStyle(.secondary)
            .tracking(0.5)
    }

    private static let fullDayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale.current
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter
    }()
}

// MARK: - Preference key

/// Carries the computed chart content height from inside GeometryReader to the
/// enclosing view so the outer `.frame(height:)` matches the actual tile layout.
private struct ChartHeightPreferenceKey: PreferenceKey {
    static let defaultValue: CGFloat = 82
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}
