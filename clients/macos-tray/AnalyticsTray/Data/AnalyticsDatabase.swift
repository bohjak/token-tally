import Foundation
import SQLite3

// MARK: - Schema Version Constants

// The tray ships knowing a range [MIN, MAX] of schema versions it can read.
// Writers bump schema_version in schema_metadata when they migrate the DB.
//
// Compatibility rules (mirrors store/src/connection.ts):
//   version < MIN_SUPPORTED        → schemaMismatch ("run token-tally migrate")
//   MIN_SUPPORTED ≤ version ≤ MAX  → ok, normal reads
//   MAX < version ≤ MAX + WINDOW   → ok, degraded reads (unknown columns ignored)
//   version > MAX + WINDOW         → schemaMismatch ("update the tray app")
private let minSupportedSchemaVersion = 1
private let maxKnownSchemaVersion = 1
private let schemaForwardWindow = 2 // tolerate up to 2 versions beyond MAX_KNOWN

// MARK: - AnalyticsDatabase

/// Thin read-only wrapper around the central ToTally SQLite analytics database.
///
/// **WAL and query_only**
/// Opens the file with `SQLITE_OPEN_READWRITE` even though no writes are made.
/// WAL mode databases require write access to the -wal and -shm sidecar files
/// even for readers; `SQLITE_OPEN_READONLY | mode=ro` would return
/// `SQLITE_CANTOPEN` on a WAL database. `PRAGMA query_only = 1` applied
/// immediately after open provides the same engine-enforced read-only guarantee
/// for the lifetime of this connection.
///
/// **Lifetime**
/// Each instance owns one SQLite handle and closes it on deinit. Callers should
/// create short-lived instances (one per refresh cycle) rather than keeping a
/// long-lived connection open.
final class AnalyticsDatabase {
    private let path: String
    private var db: OpaquePointer?

    init(path: String) throws {
        self.path = Paths.expandingTilde(path)

        guard Paths.fileExists(atPath: self.path) else {
            throw SQLiteError.missingDatabase(path: self.path)
        }

        var handle: OpaquePointer?
        // SQLITE_OPEN_READWRITE without SQLITE_OPEN_CREATE: open an existing
        // database for read-write access (for WAL sidecar files). Fails with
        // SQLITE_CANTOPEN if the file doesn't exist — guarded by the check above.
        let rc = sqlite3_open_v2(self.path, &handle, SQLITE_OPEN_READWRITE, nil)

        guard rc == SQLITE_OK, let handle else {
            let message = handle.flatMap { sqlite3_errmsg($0) }.map(String.init(cString:)) ?? "unknown error"
            if let handle { sqlite3_close(handle) }
            throw SQLiteError.openFailed(path: self.path, code: rc, message: message)
        }

        db = handle

        // Engine-enforced read-only mode. After this pragma, any INSERT, UPDATE,
        // DELETE, or DDL on this connection is rejected by SQLite itself.
        // This is the primary safety boundary; SQLITE_OPEN_READWRITE is purely
        // for WAL sidecar compatibility.
        sqlite3_exec(handle, "PRAGMA query_only = 1;", nil, nil, nil)

        // Per the plan: every connection (reader or writer) must enable FK enforcement.
        // In query_only mode this is a no-op for writes, but enforces FKs on any
        // implicit reads triggered by query plans.
        sqlite3_exec(handle, "PRAGMA foreign_keys = ON;", nil, nil, nil)

        // Short busy timeout: readers in WAL mode rarely contend with writers,
        // but a checkpoint or exclusive lock can still block briefly.
        sqlite3_busy_timeout(handle, 250)
    }

    deinit {
        if let db { sqlite3_close(db) }
    }

    // MARK: - Schema Validation

    /// Validates that the database is a compatible central ToTally store.
    ///
    /// Returns an `AnalyticsSchema` value on success. Throws `SQLiteError.schemaMismatch`
    /// when:
    /// - The `schema_metadata` table is absent (this is not a ToTally database).
    /// - `schema_version` is below `minSupportedSchemaVersion` (run `token-tally migrate`).
    /// - `schema_version` is more than `schemaForwardWindow` versions beyond
    ///   `maxKnownSchemaVersion` (update the tray app).
    /// - A required table or column is missing.
    ///
    /// Callers must validate before running any analytics query.
    func validateAnalyticsSchema() throws -> AnalyticsSchema {
        let tables = try tableNames()

        // schema_metadata is the definitive marker of a ToTally central store.
        // A database without it is the old Pi analytics schema or some other file.
        guard tables.contains("schema_metadata") else {
            throw SQLiteError.schemaMismatch(
                detail: "missing table: schema_metadata — this is not a ToTally central store; " +
                        "run 'token-tally migrate' to create one, or check the configured database path"
            )
        }

        let version = try schemaVersion()

        if version < minSupportedSchemaVersion {
            throw SQLiteError.schemaMismatch(
                detail: "schema version \(version) is older than the minimum supported version " +
                        "\(minSupportedSchemaVersion); run 'token-tally migrate' to upgrade"
            )
        }

        if version > maxKnownSchemaVersion + schemaForwardWindow {
            throw SQLiteError.schemaMismatch(
                detail: "schema version \(version) is too far ahead of this tray build " +
                        "(max known: \(maxKnownSchemaVersion), forward window: \(schemaForwardWindow)); " +
                        "update the tray app to read this database"
            )
        }

        // Check required tables.
        for table in ["harnesses", "sessions", "turns", "llm_messages"] {
            guard tables.contains(table) else {
                throw SQLiteError.schemaMismatch(detail: "missing table: \(table)")
            }
        }

        // Check required columns per table.
        let llmColumns = try columnNames(in: "llm_messages")
        try require(
            [
                "ts", "harness_id",
                "cost_total_micros", "cost_source",
                "input_tokens", "output_tokens",
                "cache_read_tokens", "cache_write_tokens",
                "turn_id", "session_id",
            ],
            in: llmColumns, table: "llm_messages"
        )

        let turnsColumns = try columnNames(in: "turns")
        try require(["id", "session_id"], in: turnsColumns, table: "turns")

        let sessionsColumns = try columnNames(in: "sessions")
        try require(
            ["id", "harness_id", "repo_owner", "repo_name", "repo_remote", "cwd"],
            in: sessionsColumns, table: "sessions"
        )

        let harnessColumns = try columnNames(in: "harnesses")
        try require(["name", "display_name"], in: harnessColumns, table: "harnesses")

        // model_id is present on llm_messages in central schema v1+.
        // The hasMessageModelID flag is preserved for the query layer's model-attribution
        // SQL expression; it will always be true for valid central-schema databases.
        return AnalyticsSchema(
            schemaVersion: version,
            hasMessageModelID: llmColumns.contains("model_id")
        )
    }

    // MARK: - Usage Queries

    /// Aggregated usage metrics for all harnesses in the given time window.
    ///
    /// Costs are in USD (converted from integer micro-dollars at the query boundary).
    /// Messages with `cost_source = 'unknown'` contribute zero to `costUSD` but are
    /// counted in `unpricedMessages` so callers can show an accurate caveat.
    func queryUsageBucket(since lowerBoundMilliseconds: Int64) throws -> UsageBucket {
        // Explicit CASE on cost_source even though cost_total_micros is 0 for
        // 'unknown' rows by schema invariant. The CASE makes the exclusion intent
        // readable and guards against any future schema evolution that changes that
        // invariant.
        let sql = """
        SELECT
          COALESCE(
            SUM(CASE WHEN cost_source != 'unknown' THEN cost_total_micros ELSE 0 END),
            0
          ) / 1000000.0 AS cost_usd,
          COALESCE(SUM(input_tokens + output_tokens), 0) AS billable_tokens,
          COALESCE(SUM(cache_read_tokens + cache_write_tokens), 0) AS cached_tokens,
          COUNT(DISTINCT turn_id) AS turns,
          COUNT(DISTINCT session_id) AS sessions,
          COUNT(CASE WHEN cost_source = 'unknown' THEN 1 END) AS unpriced_messages
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
                sessions: sqlite3_column_int64(statement, 4),
                unpricedMessages: sqlite3_column_int64(statement, 5)
            )
        }
    }

    func queryDailyCost(since lowerBoundMilliseconds: Int64) throws -> [DailyCostPoint] {
        // cost_total_micros / 1_000_000.0 converts integer micro-dollars to USD.
        // This is the only conversion point; cost is stored as integers everywhere
        // else to avoid IEEE-754 drift.
        let sql = """
        SELECT
          date(ts / 1000, 'unixepoch', 'localtime') AS day,
          COALESCE(
            SUM(CASE WHEN cost_source != 'unknown' THEN cost_total_micros ELSE 0 END),
            0
          ) / 1000000.0 AS cost_usd,
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

    func queryIntradayUsage(
        since lowerBoundMilliseconds: Int64,
        bucketMinutes: Int
    ) throws -> [IntradayUsagePoint] {
        precondition(bucketMinutes > 0, "bucketMinutes must be positive")
        // ?1 = bucket size in seconds, referenced twice in the query. SQLite's
        // numbered parameter syntax (?N) allows a single bind to satisfy both uses.
        let sql = """
        SELECT
          ((ts / 1000) / ?1) * ?1 AS bucket_epoch_seconds,
          COALESCE(
            SUM(CASE WHEN cost_source != 'unknown' THEN cost_total_micros ELSE 0 END),
            0
          ) / 1000000.0 AS cost_usd,
          COALESCE(SUM(input_tokens + output_tokens), 0) AS billable_tokens
        FROM llm_messages
        WHERE ts >= ?2
        GROUP BY bucket_epoch_seconds
        ORDER BY bucket_epoch_seconds;
        """

        let bucketSeconds = Int64(bucketMinutes * 60)

        return try withStatement(sql) { statement in
            sqlite3_bind_int64(statement, 1, bucketSeconds)
            sqlite3_bind_int64(statement, 2, lowerBoundMilliseconds)
            var rows: [IntradayUsagePoint] = []
            while try step(statement, sql: sql) == SQLITE_ROW {
                let epochSeconds = sqlite3_column_int64(statement, 0)
                let bucketStart = Date(timeIntervalSince1970: TimeInterval(epochSeconds))
                rows.append(IntradayUsagePoint(
                    bucketStart: bucketStart,
                    costUSD: sqlite3_column_double(statement, 1),
                    billableTokens: sqlite3_column_int64(statement, 2)
                ))
            }
            return rows
        }
    }

    func queryTopModels(since lowerBoundMilliseconds: Int64, schema: AnalyticsSchema) throws -> [ModelBreakdown] {
        // Central schema v1 always has model_id on llm_messages, so hasMessageModelID
        // is always true. The conditional expression is retained so future schema
        // changes or degraded-mode reads (version slightly beyond MAX_KNOWN) can
        // still fall back to turns.model_id gracefully.
        //
        // GROUP BY 1 (positional) avoids ambiguity between llm_messages.model_id
        // and turns.model_id — SQLite 3.43+ errors on GROUP BY column-name when
        // the name appears in multiple joined tables.
        let modelExpression = schema.hasMessageModelID
            ? "COALESCE(NULLIF(m.model_id, ''), NULLIF(t.model_id, ''), 'unattributed')"
            : "COALESCE(NULLIF(t.model_id, ''), 'unattributed')"

        let sql = """
        SELECT
          \(modelExpression) AS mdl,
          COALESCE(
            SUM(CASE WHEN m.cost_source != 'unknown' THEN m.cost_total_micros ELSE 0 END),
            0
          ) / 1000000.0 AS cost_usd,
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
                    modelID: columnString(statement, index: 0) ?? "unattributed",
                    costUSD: sqlite3_column_double(statement, 1),
                    billableTokens: sqlite3_column_int64(statement, 2),
                    turns: sqlite3_column_int64(statement, 3)
                ))
            }
            return rows
        }
    }

    func queryTopRepos(since lowerBoundMilliseconds: Int64) throws -> [RepoBreakdown] {
        // Prefer repo_owner/repo_name together, then remote URL, then cwd, then
        // the sentinel "unknown". The NULLIF on the concat guards against both
        // columns being empty strings: owner='' + name='' → '/' → NULLIF rejects it.
        let sql = """
        SELECT
          COALESCE(
            NULLIF(s.repo_owner || '/' || s.repo_name, '/'),
            s.repo_remote,
            s.cwd,
            'unknown'
          ) AS repo,
          COALESCE(
            SUM(CASE WHEN m.cost_source != 'unknown' THEN m.cost_total_micros ELSE 0 END),
            0
          ) / 1000000.0 AS cost_usd,
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

    /// Per-harness aggregated usage for the given time window.
    ///
    /// Only harnesses that have at least one `llm_messages` row in the window are
    /// returned (INNER JOIN, not LEFT JOIN). Results are ordered by costUSD descending.
    func queryHarnessBreakdowns(since lowerBoundMilliseconds: Int64) throws -> [HarnessBreakdown] {
        let sql = """
        SELECT
          h.name AS harness_id,
          h.display_name,
          COALESCE(
            SUM(CASE WHEN m.cost_source != 'unknown' THEN m.cost_total_micros ELSE 0 END),
            0
          ) / 1000000.0 AS cost_usd,
          COALESCE(SUM(m.input_tokens + m.output_tokens), 0) AS billable_tokens,
          COALESCE(SUM(m.cache_read_tokens + m.cache_write_tokens), 0) AS cached_tokens,
          COUNT(DISTINCT m.turn_id) AS turns,
          COUNT(DISTINCT m.session_id) AS sessions,
          COUNT(CASE WHEN m.cost_source = 'unknown' THEN 1 END) AS unpriced_messages
        FROM harnesses h
        JOIN llm_messages m ON m.harness_id = h.name
        WHERE m.ts >= ?
        GROUP BY h.name, h.display_name
        ORDER BY cost_usd DESC;
        """

        return try withStatement(sql) { statement in
            sqlite3_bind_int64(statement, 1, lowerBoundMilliseconds)
            var rows: [HarnessBreakdown] = []
            while try step(statement, sql: sql) == SQLITE_ROW {
                let bucket = UsageBucket(
                    costUSD: sqlite3_column_double(statement, 2),
                    billableTokens: sqlite3_column_int64(statement, 3),
                    cachedTokens: sqlite3_column_int64(statement, 4),
                    turns: sqlite3_column_int64(statement, 5),
                    sessions: sqlite3_column_int64(statement, 6),
                    unpricedMessages: sqlite3_column_int64(statement, 7)
                )
                rows.append(HarnessBreakdown(
                    harnessId: columnString(statement, index: 0) ?? "unknown",
                    displayName: columnString(statement, index: 1) ?? "Unknown",
                    week: bucket
                ))
            }
            return rows
        }
    }

    // MARK: - Private Helpers

    private func schemaVersion() throws -> Int {
        let sql = "SELECT value FROM schema_metadata WHERE key = 'schema_version';"
        return try withStatement(sql) { statement in
            guard try step(statement, sql: sql) == SQLITE_ROW else {
                throw SQLiteError.schemaMismatch(
                    detail: "schema_metadata table has no 'schema_version' key"
                )
            }
            guard let text = sqlite3_column_text(statement, 0) else {
                throw SQLiteError.schemaMismatch(detail: "schema_version value is NULL")
            }
            let str = String(cString: text)
            guard let version = Int(str) else {
                throw SQLiteError.schemaMismatch(
                    detail: "schema_version '\(str)' is not a valid integer"
                )
            }
            return version
        }
    }

    private func tableNames() throws -> Set<String> {
        try queryStrings("SELECT name FROM sqlite_master WHERE type = 'table';")
    }

    private func columnNames(in table: String) throws -> Set<String> {
        // PRAGMA table_info returns one row per column; column index 1 is the name.
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
            throw SQLiteError.openFailed(
                path: path, code: SQLITE_MISUSE, message: "database handle is closed"
            )
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
        guard let db, let msg = sqlite3_errmsg(db) else { return "unknown error" }
        return String(cString: msg)
    }

    private func columnString(_ statement: OpaquePointer, index: Int32) -> String? {
        guard let text = sqlite3_column_text(statement, index) else { return nil }
        let value = String(cString: text)
        return value.isEmpty ? nil : value
    }

    private static let sqliteDayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()
}

// MARK: - AnalyticsSchema

/// Properties of the central ToTally schema detected at open time.
///
/// Returned by `validateAnalyticsSchema()` and passed to query methods that
/// need to adapt their SQL to schema evolution.
struct AnalyticsSchema: Equatable {
    /// The integer schema version read from `schema_metadata.schema_version`.
    /// Used for diagnostics and future compatibility checks.
    let schemaVersion: Int

    /// True when `llm_messages.model_id` is present.
    /// Always true for central schema v1+; retained for forward-compatibility in
    /// case a future schema version renames the column.
    let hasMessageModelID: Bool
}
