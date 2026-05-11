import SwiftUI

/// Shown when a SQLite open or query failure occurs that is not covered by the
/// more specific `EmptyStateView` cases (missing database, schema mismatch).
///
/// Displays a compact error message and a Refresh button so the user can retry
/// without relaunching the app.
struct ErrorStateView: View {

    /// Human-readable error description. Comes from `SQLiteError.localizedDescription`
    /// or any other `Error.localizedDescription` surfaced by `AnalyticsStore`.
    let message: String

    /// Called when the user taps Refresh. Should invoke `AnalyticsStore.refresh()`.
    let onRefresh: () -> Void

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle")
                .font(.title2)
                .foregroundStyle(.orange)

            Text(message)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .lineLimit(5)
                .fixedSize(horizontal: false, vertical: true)

            Button("Refresh", action: onRefresh)
                .buttonStyle(.bordered)
                .controlSize(.small)
        }
        .padding(24)
        .frame(maxWidth: .infinity)
    }
}
