import Foundation
import SQLite3

/// Thin read-only wrapper around a SQLite analytics database.
///
/// The tray app never mutates the analytics database. Each instance owns one
/// SQLite handle and closes it on deinit; callers should create short-lived
/// instances for refreshes or keep access serialized from a single owner.
final class AnalyticsDatabase {
    private let path: String
    private var db: OpaquePointer?

    init(path: String) throws {
        self.path = Paths.expandingTilde(path)

        guard Paths.fileExists(atPath: self.path) else {
            throw SQLiteError.missingDatabase(path: self.path)
        }

        var handle: OpaquePointer?
        let flags = SQLITE_OPEN_READONLY | SQLITE_OPEN_URI
        let uri = try Self.readOnlyURI(forPath: self.path)
        let rc = sqlite3_open_v2(uri, &handle, flags, nil)

        guard rc == SQLITE_OK, let handle else {
            let message = handle.flatMap { sqlite3_errmsg($0) }.map(String.init(cString:)) ?? "unknown error"
            if let handle {
                sqlite3_close(handle)
            }
            throw SQLiteError.openFailed(path: self.path, code: rc, message: message)
        }

        db = handle
        sqlite3_busy_timeout(handle, 250)
    }

    deinit {
        if let db {
            sqlite3_close(db)
        }
    }

    func validateAnalyticsSchema() throws -> AnalyticsSchema {
        let tables = try tableNames()
        for table in ["llm_messages", "turns", "sessions"] where !tables.contains(table) {
            throw SQLiteError.schemaMismatch(detail: "missing table: \(table)")
        }

        let llmColumns = try columnNames(in: "llm_messages")
        let turnsColumns = try columnNames(in: "turns")
        let sessionsColumns = try columnNames(in: "sessions")

        let requiredLLM = [
            "ts", "cost_total", "input_tokens", "output_tokens",
            "cache_read_tokens", "cache_write_tokens", "turn_id", "session_id"
        ]
        try require(requiredLLM, in: llmColumns, table: "llm_messages")
        try require(["id", "model_id"], in: turnsColumns, table: "turns")
        try require(["id", "repo_owner", "repo_name", "repo_remote", "cwd"], in: sessionsColumns, table: "sessions")

        return AnalyticsSchema(hasMessageModelID: llmColumns.contains("model_id"))
    }

    func queryUsageBucket(since lowerBoundMilliseconds: Int64) throws -> UsageBucket {
        let sql = """
        SELECT
          COALESCE(SUM(cost_total), 0) AS cost_usd,
          COALESCE(SUM(input_tokens + output_tokens), 0) AS billable_tokens,
          COALESCE(SUM(cache_read_tokens + cache_write_tokens), 0) AS cached_tokens,
          COUNT(DISTINCT turn_id) AS turns,
          COUNT(DISTINCT session_id) AS sessions
        FROM llm_messages
        WHERE ts >= ?;
        """

        return try withStatement(sql) { statement in
            sqlite3_bind_int64(statement, 1, lowerBoundMilliseconds)
            guard try step(statement, sql: sql) == SQLITE_ROW else { return .zero }
            return UsageBucket(
                costUSD: sqlite3_column_double(statement, 0),
                billableTokens: sqlite3_column_int64(statement, 1),
                cachedTokens: sqlite3_column_int64(statement, 2),
                turns: sqlite3_column_int64(statement, 3),
                sessions: sqlite3_column_int64(statement, 4)
            )
        }
    }

    func queryDailyCost(since lowerBoundMilliseconds: Int64) throws -> [DailyCostPoint] {
        let sql = """
        SELECT
          date(ts / 1000, 'unixepoch', 'localtime') AS day,
          COALESCE(SUM(cost_total), 0) AS cost_usd,
          COALESCE(SUM(input_tokens + output_tokens), 0) AS billable_tokens
        FROM llm_messages
        WHERE ts >= ?
        GROUP BY day
        ORDER BY day;
        """

        return try withStatement(sql) { statement in
            sqlite3_bind_int64(statement, 1, lowerBoundMilliseconds)
            var rows: [DailyCostPoint] = []
            while try step(statement, sql: sql) == SQLITE_ROW {
                guard let text = sqlite3_column_text(statement, 0) else { continue }
                let dayString = String(cString: text)
                guard let day = Self.sqliteDayFormatter.date(from: dayString) else { continue }
                rows.append(DailyCostPoint(
                    day: Calendar.current.startOfDay(for: day),
                    costUSD: sqlite3_column_double(statement, 1),
                    billableTokens: sqlite3_column_int64(statement, 2)
                ))
            }
            return rows
        }
    }

    func queryTopModels(since lowerBoundMilliseconds: Int64, schema: AnalyticsSchema) throws -> [ModelBreakdown] {
        let modelExpression = schema.hasMessageModelID
            ? "COALESCE(m.model_id, t.model_id, 'unknown')"
            : "COALESCE(t.model_id, 'unknown')"
        // Use positional GROUP BY 1 to avoid ambiguity: both llm_messages and
        // turns have a model_id column. SQLite 3.43 treats GROUP BY model_id as
        // ambiguous and returns an error; GROUP BY 1 groups on the first SELECT
        // expression (the COALESCE alias) unambiguously.
        let sql = """
        SELECT
          \(modelExpression) AS mdl,
          COALESCE(SUM(m.cost_total), 0) AS cost_usd,
          COALESCE(SUM(m.input_tokens + m.output_tokens), 0) AS billable_tokens,
          COUNT(DISTINCT m.turn_id) AS turns
        FROM llm_messages m
        LEFT JOIN turns t ON t.id = m.turn_id
        WHERE m.ts >= ?
        GROUP BY 1
        ORDER BY cost_usd DESC
        LIMIT 5;
        """

        return try withStatement(sql) { statement in
            sqlite3_bind_int64(statement, 1, lowerBoundMilliseconds)
            var rows: [ModelBreakdown] = []
            while try step(statement, sql: sql) == SQLITE_ROW {
                rows.append(ModelBreakdown(
                    modelID: columnString(statement, index: 0) ?? "unknown",
                    costUSD: sqlite3_column_double(statement, 1),
                    billableTokens: sqlite3_column_int64(statement, 2),
                    turns: sqlite3_column_int64(statement, 3)
                ))
            }
            return rows
        }
    }

    func queryTopRepos(since lowerBoundMilliseconds: Int64) throws -> [RepoBreakdown] {
        let sql = """
        SELECT
          COALESCE(NULLIF(s.repo_owner || '/' || s.repo_name, '/'), s.repo_remote, s.cwd, 'unknown') AS repo,
          COALESCE(SUM(m.cost_total), 0) AS cost_usd,
          COALESCE(SUM(m.input_tokens + m.output_tokens), 0) AS billable_tokens,
          COUNT(DISTINCT m.session_id) AS sessions
        FROM llm_messages m
        LEFT JOIN sessions s ON s.id = m.session_id
        WHERE m.ts >= ?
        GROUP BY repo
        ORDER BY cost_usd DESC
        LIMIT 5;
        """

        return try withStatement(sql) { statement in
            sqlite3_bind_int64(statement, 1, lowerBoundMilliseconds)
            var rows: [RepoBreakdown] = []
            while try step(statement, sql: sql) == SQLITE_ROW {
                rows.append(RepoBreakdown(
                    repo: columnString(statement, index: 0) ?? "unknown",
                    costUSD: sqlite3_column_double(statement, 1),
                    billableTokens: sqlite3_column_int64(statement, 2),
                    sessions: sqlite3_column_int64(statement, 3)
                ))
            }
            return rows
        }
    }

    private func tableNames() throws -> Set<String> {
        try queryStrings("SELECT name FROM sqlite_master WHERE type = 'table';")
    }

    private func columnNames(in table: String) throws -> Set<String> {
        let safeTable = table.replacingOccurrences(of: "'", with: "''")
        return try queryStrings("PRAGMA table_info('\(safeTable)');", column: 1)
    }

    private func queryStrings(_ sql: String, column: Int32 = 0) throws -> Set<String> {
        try withStatement(sql) { statement in
            var values = Set<String>()
            while try step(statement, sql: sql) == SQLITE_ROW {
                if let value = columnString(statement, index: column) {
                    values.insert(value)
                }
            }
            return values
        }
    }

    private func require(_ required: [String], in available: Set<String>, table: String) throws {
        for column in required where !available.contains(column) {
            throw SQLiteError.schemaMismatch(detail: "missing column: \(table).\(column)")
        }
    }

    private func withStatement<T>(_ sql: String, _ body: (OpaquePointer) throws -> T) throws -> T {
        guard let db else {
            throw SQLiteError.openFailed(path: path, code: SQLITE_MISUSE, message: "database handle is closed")
        }

        var statement: OpaquePointer?
        let rc = sqlite3_prepare_v2(db, sql, -1, &statement, nil)
        guard rc == SQLITE_OK, let statement else {
            throw SQLiteError.queryFailed(sql: sql, code: rc, message: errorMessage)
        }
        defer { sqlite3_finalize(statement) }
        return try body(statement)
    }

    private func step(_ statement: OpaquePointer, sql: String) throws -> Int32 {
        let rc = sqlite3_step(statement)
        guard rc == SQLITE_ROW || rc == SQLITE_DONE else {
            throw SQLiteError.queryFailed(sql: sql, code: rc, message: errorMessage)
        }
        return rc
    }

    private var errorMessage: String {
        guard let db, let message = sqlite3_errmsg(db) else { return "unknown error" }
        return String(cString: message)
    }

    private func columnString(_ statement: OpaquePointer, index: Int32) -> String? {
        guard let text = sqlite3_column_text(statement, index) else { return nil }
        let value = String(cString: text)
        return value.isEmpty ? nil : value
    }

    private static func readOnlyURI(forPath path: String) throws -> String {
        var components = URLComponents()
        components.scheme = "file"
        components.path = path
        components.queryItems = [URLQueryItem(name: "mode", value: "ro")]
        guard let uri = components.string else {
            throw SQLiteError.openFailed(path: path, code: SQLITE_CANTOPEN, message: "could not construct SQLite URI")
        }
        return uri
    }

    private static let sqliteDayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()
}

struct AnalyticsSchema: Equatable {
    let hasMessageModelID: Bool
}
