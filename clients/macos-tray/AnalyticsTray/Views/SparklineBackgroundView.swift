import SwiftUI

/// Decorative background sparkline rendered behind the Today summary card.
///
/// Draws a smoothed curved line with a faint under-curve vertical-fade fill.
/// There are no axes, labels, scale, grid, or hit-testing regions — this view
/// is purely decorative and is accessibility-hidden.
///
/// Rendering is skipped entirely when `values` is empty or all-zero.
struct SparklineBackgroundView: View {

    let values: [Double]
    var trimZeroEdges: Bool = true
    /// Number of points used for display-only moving average. Use 1 to render
    /// exact source buckets, which is better for tiny fixed windows like 7 days.
    var smoothingWindow: Int = 3

    // Horizontal inset keeps the line away from the rounded card edges.
    private let hInset: CGFloat = 10

    // Fraction of the card height the chart occupies, measured from a baseline
    // slightly above the bottom edge. This keeps zero-value segments from
    // sitting exactly on the rounded card boundary.
    private let vFraction: CGFloat = 0.70
    private let bottomInset: CGFloat = 8

    var body: some View {
        GeometryReader { proxy in
            let visibleValues = trimZeroEdges ? trimZeroEdges(values) : values
            let smoothed = applyMovingAverage(visibleValues, window: smoothingWindow)
            let maxVal = smoothed.max() ?? 0

            if maxVal > 0 {
                let pts = chartPoints(smoothed, maxVal: maxVal, in: proxy.size)
                if pts.count >= 2 {
                    let line = smoothLinePath(through: pts)
                    let fill = smoothFillPath(through: pts, bottomY: proxy.size.height - bottomInset)

                    // Gradient starts at the top of the chart area so opacity
                    // is highest near the curve peaks and fades to zero at the
                    // card bottom, reinforcing the "under the line" visual.
                    let gradientStart = UnitPoint(x: 0.5, y: 1 - vFraction)

                    ZStack {
                        fill
                            .fill(
                                LinearGradient(
                                    colors: [
                                        Color.accentColor.opacity(0.07),
                                        Color.accentColor.opacity(0),
                                    ],
                                    startPoint: gradientStart,
                                    endPoint: .bottom
                                )
                            )
                        line
                            .stroke(
                                Color.accentColor.opacity(0.15),
                                style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round)
                            )
                    }
                }
            }
        }
    }

    // MARK: - Smoothing

    /// Removes leading and trailing zero-value buckets so the decorative line
    /// occupies the available card width instead of showing inactive deadspace
    /// before the first or after the last activity burst.
    private func trimZeroEdges(_ input: [Double]) -> [Double] {
        guard let firstNonZero = input.firstIndex(where: { $0 > 0 }) else { return [] }
        guard let lastNonZero = input.lastIndex(where: { $0 > 0 }) else { return [] }
        return Array(input[firstNonZero...lastNonZero])
    }

    /// Applies a symmetric moving average with the given window size.
    ///
    /// Returns `input` unchanged when the window is 1 or input is too short
    /// to benefit from smoothing.
    private func applyMovingAverage(_ input: [Double], window: Int) -> [Double] {
        guard window > 1, input.count > window else { return input }
        let half = window / 2
        return input.indices.map { i in
            let lo = max(0, i - half)
            let hi = min(input.count - 1, i + half)
            let slice = input[lo...hi]
            return slice.reduce(0, +) / Double(slice.count)
        }
    }

    // MARK: - Layout

    /// Maps smoothed values to CGPoints in the available geometry.
    ///
    /// X spans `[hInset, size.width - hInset]`. Y is confined above a bottom
    /// inset so zero-value segments do not sit on the card boundary.
    private func chartPoints(_ smoothed: [Double], maxVal: Double, in size: CGSize) -> [CGPoint] {
        guard smoothed.count >= 2 else { return [] }
        let usableWidth  = size.width - hInset * 2
        let bottomY      = size.height - bottomInset
        let usableHeight = bottomY * vFraction
        let step         = usableWidth / CGFloat(smoothed.count - 1)

        return smoothed.enumerated().map { idx, val in
            let x          = hInset + CGFloat(idx) * step
            let normalised = min(max(val / maxVal, 0), 1)
            // High value → small Y (near topY); zero → bottomY baseline.
            let y          = bottomY - normalised * usableHeight
            return CGPoint(x: x, y: y)
        }
    }

    // MARK: - Paths

    /// Smooth curve through all points using quadratic Béziers over midpoints.
    ///
    /// The midpoint technique keeps the curve continuous and tangent at every
    /// data point without requiring cubic spline coefficient solving.
    private func smoothLinePath(through pts: [CGPoint]) -> Path {
        guard pts.count >= 2 else { return Path() }
        var path = Path()
        if pts.count == 2 {
            path.move(to: pts[0])
            path.addLine(to: pts[1])
            return path
        }
        path.move(to: pts[0])
        for i in 1..<pts.count - 1 {
            path.addQuadCurve(
                to: midpoint(pts[i], pts[i + 1]),
                control: pts[i]
            )
        }
        path.addLine(to: pts[pts.count - 1])
        return path
    }

    /// The same smooth curve closed down to `bottomY` to form a fill region.
    private func smoothFillPath(through pts: [CGPoint], bottomY: CGFloat) -> Path {
        var path = smoothLinePath(through: pts)
        path.addLine(to: CGPoint(x: pts[pts.count - 1].x, y: bottomY))
        path.addLine(to: CGPoint(x: pts[0].x, y: bottomY))
        path.closeSubpath()
        return path
    }

    private func midpoint(_ a: CGPoint, _ b: CGPoint) -> CGPoint {
        CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
    }
}
