import Foundation

/// Typed errors from the read-only SQLite layer (T3 — `AnalyticsDatabase`).
///
/// All errors are recoverable: the UI shows a corresponding state (missing
/// database, schema mismatch, query error) rather than crashing. The raw
/// SQLite result code and message are retained for diagnostic display.
enum SQLiteError: Error, LocalizedError {

    // MARK: Cases

    /// The database file was not found at the configured path.
    ///
    /// Distinct from `openFailed` so the UI can show the specific
    /// "No pi analytics database found" message rather than a generic error.
    case missingDatabase(path: String)

    /// `sqlite3_open_v2` returned a non-OK result code.
    case openFailed(path: String, code: Int32, message: String)

    /// A required table or column is absent from the opened database.
    ///
    /// This surfaces the "Unsupported analytics database schema" UI state
    /// without crashing and without running application queries against an
    /// incompatible schema.
    case schemaMismatch(detail: String)

    /// A query or statement step returned a non-OK/non-ROW result code.
    case queryFailed(sql: String, code: Int32, message: String)

    // MARK: LocalizedError

    var errorDescription: String? {
        switch self {
        case .missingDatabase(let path):
            return "Database not found at \(path)."
        case .openFailed(let path, let code, let msg):
            return "Could not open database at \(path): \(msg) (SQLite \(code))."
        case .schemaMismatch(let detail):
            return "Unsupported analytics database schema: \(detail)."
        case .queryFailed(_, let code, let msg):
            return "Query failed: \(msg) (SQLite \(code))."
        }
    }

    // MARK: Convenience

    /// True when the error is a missing or inaccessible database, so the UI
    /// can distinguish "not found" from "exists but broken".
    var isDatabaseMissing: Bool {
        if case .missingDatabase = self { return true }
        return false
    }

    /// True when the error is a schema mismatch.
    var isSchemaMismatch: Bool {
        if case .schemaMismatch = self { return true }
        return false
    }
}
