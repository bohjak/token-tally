import SwiftUI

/// Shown when there is no meaningful data to display — not a transient error.
///
/// Covers three cases:
/// - **Missing database** — the configured path does not exist.
/// - **Empty database** — the database opened successfully but has no usage rows yet.
/// - **Schema mismatch** — required tables or columns are absent.
struct EmptyStateView: View {

    enum Kind {
        /// The database file was not found at the configured path.
        case missingDatabase(path: String)
        /// The database opened but contains no llm_messages rows.
        case emptyDatabase
        /// Required tables or columns were absent from the opened database.
        case schemaMismatch(detail: String)
    }

    let kind: Kind
    /// Called when the user taps "Open Settings" (missing DB case) or any
    /// action that leads to settings. T7 will implement the real settings sheet;
    /// until then this opens a placeholder alert from PopoverView.
    let onOpenSettings: () -> Void

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: iconName)
                .font(.title2)
                .foregroundStyle(.secondary)

            VStack(spacing: 4) {
                Text(headline)
                    .font(.subheadline)
                    .fontWeight(.medium)
                    .multilineTextAlignment(.center)

                Text(subheadline)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if case .missingDatabase = kind {
                Button("Open Settings", action: onOpenSettings)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity)
    }

    // MARK: - Derived strings

    private var iconName: String {
        switch kind {
        case .missingDatabase:  return "externaldrive.badge.exclamationmark"
        case .emptyDatabase:    return "chart.bar"
        case .schemaMismatch:   return "doc.badge.exclamationmark"
        }
    }

    private var headline: String {
        switch kind {
        case .missingDatabase:
            return "No pi analytics database found."
        case .emptyDatabase:
            return "No usage data yet."
        case .schemaMismatch:
            return "Unsupported analytics database schema."
        }
    }

    private var subheadline: String {
        switch kind {
        case .missingDatabase:
            return "Start pi with the analytics extension enabled, or choose a custom database path in Settings."
        case .emptyDatabase:
            return "Run some pi sessions to see usage statistics here."
        case .schemaMismatch(let detail):
            return "Schema detail: \(detail)"
        }
    }
}
