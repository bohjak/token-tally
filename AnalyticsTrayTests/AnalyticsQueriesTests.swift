import Foundation
import SQLite3
import Testing
@testable import AnalyticsTray

// MARK: - Live-fixture tests (in-memory databases built at runtime)

@Suite("AnalyticsQueries")
struct AnalyticsQueriesTests {

    // MARK: Usage bucket

    @Test func queryUsageBucketMapsBillableAndCachedTokensSeparately() throws {
        let dbPath = try makeDatabase(includeMessageModelID: true)

        let bucket = try AnalyticsQueries.usageBucket(databasePath: dbPath, since: 1_700_000_000_000)

        #expect(bucket.costUSD == 1.5)
        #expect(bucket.billableTokens == 30)
        #expect(bucket.cachedTokens == 7)
        #expect(bucket.turns == 1)
        #expect(bucket.sessions == 1)
    }

    @Test func queryUsageBucketExcludesRowsOlderThanLowerBound() throws {
        let dbPath = try makeDatabase(includeMessageModelID: true)
        // The fixture row has ts = 1704067200000; querying with a bound after
        // that timestamp should return all-zero bucket.
        let future: Int64 = 9_999_999_999_000
        let bucket = try AnalyticsQueries.usageBucket(databasePath: dbPath, since: future)

        #expect(bucket.costUSD == 0)
        #expect(bucket.billableTokens == 0)
        #expect(bucket.turns == 0)
        #expect(bucket.sessions == 0)
        #expect(bucket.isEmpty)
    }

    // MARK: Top models

    @Test func topModelsPreferMessageModelID() throws {
        let dbPath = try makeDatabase(includeMessageModelID: true)

        let models = try AnalyticsQueries.topModels(databasePath: dbPath, since: 1_700_000_000_000)

        #expect(models.first == ModelBreakdown(modelID: "message-model", costUSD: 1.5, billableTokens: 30, turns: 1))
    }

    @Test func topModelsFallBackToTurnsWhenMessageModelIDColumnMissing() throws {
        let dbPath = try makeDatabase(includeMessageModelID: false)

        let models = try AnalyticsQueries.topModels(databasePath: dbPath, since: 1_700_000_000_000)

        #expect(models.first == ModelBreakdown(modelID: "turn-model", costUSD: 1.5, billableTokens: 30, turns: 1))
    }

    @Test func topModelsShowUnknownWhenNoModelIsRecorded() throws {
        // Build a database where both llm_messages.model_id and turns.model_id are NULL.
        let dbPath = try makeDatabaseWithNullModels()

        let models = try AnalyticsQueries.topModels(databasePath: dbPath, since: 1_700_000_000_000)

        #expect(models.first?.modelID == "unknown")
    }

    // MARK: Top repositories

    @Test func topReposUseOwnerNameWhenAvailable() throws {
        let dbPath = try makeDatabase(includeMessageModelID: true)

        let repos = try AnalyticsQueries.topRepos(databasePath: dbPath, since: 1_700_000_000_000)

        #expect(repos.first == RepoBreakdown(repo: "owner/repo", costUSD: 1.5, billableTokens: 30, sessions: 1))
    }

    @Test func topReposFallsBackToRemoteWhenOwnerIsNull() throws {
        let dbPath = try makeDatabaseWithRemoteOnlyRepo()

        let repos = try AnalyticsQueries.topRepos(databasePath: dbPath, since: 1_700_000_000_000)

        #expect(repos.first?.repo == "git@github.com:org/remote-repo.git")
    }

    @Test func topReposFallsBackToCwdWhenAllOtherFieldsAreNull() throws {
        let dbPath = try makeDatabaseWithCwdOnlyRepo()

        let repos = try AnalyticsQueries.topRepos(databasePath: dbPath, since: 1_700_000_000_000)

        #expect(repos.first?.repo == "/home/user/project")
    }

    // MARK: Daily cost

    @Test func dailyCostMapsSQLiteLocalDayRows() throws {
        let dbPath = try makeDatabase(includeMessageModelID: true)

        let points = try AnalyticsQueries.dailyCost(databasePath: dbPath, since: 1_700_000_000_000)

        #expect(points.count == 1)
        #expect(points[0].costUSD == 1.5)
        #expect(points[0].billableTokens == 30)
    }

    // MARK: Fill missing days

    @Test func fillMissingDaysProducesStableSevenDayWindow() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let end = Date(timeIntervalSince1970: 1_704_067_200) // 2024-01-01 00:00:00 UTC
        let existing = DailyCostPoint(day: end, costUSD: 2, billableTokens: 20)

        let filled = AnalyticsQueries.fillMissingDays([existing], endingAt: end, calendar: calendar)

        #expect(filled.count == 7)
        #expect(filled.last == existing)
        #expect(filled.dropLast().allSatisfy { $0.costUSD == 0 && $0.billableTokens == 0 })
    }

    @Test func fillMissingDaysWithNoDataProducesAllZeros() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let end = Date(timeIntervalSince1970: 1_704_067_200)

        let filled = AnalyticsQueries.fillMissingDays([], endingAt: end, calendar: calendar)

        #expect(filled.count == 7)
        #expect(filled.allSatisfy { $0.costUSD == 0 && $0.billableTokens == 0 })
    }

    @Test func fillMissingDaysPreservesExistingPointsInOrder() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        // 2024-01-07 = end; 2024-01-01 = six days prior
        let end    = Date(timeIntervalSince1970: 1_704_585_600) // 2024-01-07
        let dayOne = Date(timeIntervalSince1970: 1_704_067_200) // 2024-01-01
        let points = [
            DailyCostPoint(day: dayOne, costUSD: 1.0, billableTokens: 10),
            DailyCostPoint(day: end,    costUSD: 2.0, billableTokens: 20),
        ]

        let filled = AnalyticsQueries.fillMissingDays(points, endingAt: end, calendar: calendar)

        #expect(filled.count == 7)
        #expect(filled.first?.costUSD == 1.0)
        #expect(filled.last?.costUSD  == 2.0)
        // The five days in between should be zeros
        let midPoints = Array(filled.dropFirst().dropLast())
        #expect(midPoints.allSatisfy { $0.costUSD == 0 })
    }

    @Test func fillMissingDaysWithCustomDayCount() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let end = Date(timeIntervalSince1970: 1_704_067_200)

        let filled = AnalyticsQueries.fillMissingDays([], endingAt: end, days: 30, calendar: calendar)

        #expect(filled.count == 30)
        #expect(filled.allSatisfy { $0.costUSD == 0 })
    }

    // MARK: Error states

    @Test func missingDatabaseIsRecoverableError() throws {
        let missingPath = temporaryDirectory().appendingPathComponent("missing.db").path

        do {
            _ = try AnalyticsQueries.usageBucket(databasePath: missingPath, since: 0)
            Issue.record("Expected missing database error")
        } catch let error as SQLiteError {
            #expect(error.isDatabaseMissing)
        }
    }

    @Test func schemaMismatchIncludesMissingColumn() throws {
        let dbPath = try makeSchemaMismatchDatabase()

        do {
            _ = try AnalyticsQueries.usageBucket(databasePath: dbPath, since: 0)
            Issue.record("Expected schema mismatch")
        } catch let error as SQLiteError {
            #expect(error.isSchemaMismatch)
        }
    }
}

// MARK: - Fixture-file-backed tests

/// Tests that open the pre-built SQLite fixture files in AnalyticsTrayTests/Fixtures/.
///
/// These fixtures verify the "empty database" and "schema mismatch" paths against
/// real on-disk databases rather than dynamically-created temp files, ensuring
/// that the binary fixture files committed to the repo stay in sync with the app's
/// expectations.
@Suite("AnalyticsQueries — on-disk fixtures")
struct AnalyticsQueriesFixtureTests {

    /// Resolve a fixture file relative to this source file's location.
    ///
    /// Uses `#filePath` (the compile-time path) so the path is correct even
    /// when tests are run from a different working directory.
    private func fixturePath(_ name: String) -> String {
        let sourceDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        return sourceDir.appendingPathComponent("Fixtures/\(name)").path
    }

    @Test func emptyFixturePassesSchemaValidation() throws {
        let path = fixturePath("empty.db")
        // Schema is valid — should not throw.
        let schema = try AnalyticsQueries.validateSchema(databasePath: path)
        // The real analytics schema has model_id on llm_messages.
        #expect(schema.hasMessageModelID)
    }

    @Test func emptyFixtureProducesZeroBucket() throws {
        let path = fixturePath("empty.db")
        let bucket = try AnalyticsQueries.usageBucket(databasePath: path, since: 0)
        #expect(bucket.isEmpty)
        #expect(bucket.costUSD == 0)
        #expect(bucket.billableTokens == 0)
    }

    @Test func emptyFixtureProducesNoDailyCostPoints() throws {
        let path = fixturePath("empty.db")
        let points = try AnalyticsQueries.dailyCost(databasePath: path, since: 0)
        #expect(points.isEmpty)
    }

    @Test func emptyFixtureProducesNoTopModels() throws {
        let path = fixturePath("empty.db")
        let models = try AnalyticsQueries.topModels(databasePath: path, since: 0)
        #expect(models.isEmpty)
    }

    @Test func emptyFixtureProducesNoTopRepos() throws {
        let path = fixturePath("empty.db")
        let repos = try AnalyticsQueries.topRepos(databasePath: path, since: 0)
        #expect(repos.isEmpty)
    }

    @Test func schemaMismatchFixtureThrowsSchemaMismatchError() throws {
        let path = fixturePath("schema-mismatch.db")
        do {
            _ = try AnalyticsQueries.usageBucket(databasePath: path, since: 0)
            Issue.record("Expected SQLiteError.schemaMismatch")
        } catch let error as SQLiteError {
            #expect(error.isSchemaMismatch)
        }
    }

    @Test func schemaMismatchFixtureSchemaValidationFails() throws {
        let path = fixturePath("schema-mismatch.db")
        do {
            _ = try AnalyticsQueries.validateSchema(databasePath: path)
            Issue.record("Expected SQLiteError.schemaMismatch from validateSchema")
        } catch let error as SQLiteError {
            #expect(error.isSchemaMismatch)
        }
    }
}

// MARK: - Helpers

private extension AnalyticsQueriesTests {
    func makeDatabase(includeMessageModelID: Bool) throws -> String {
        let path = temporaryDirectory().appendingPathComponent(UUID().uuidString + ".db").path
        let modelColumn = includeMessageModelID ? ", model_id TEXT" : ""
        try executeSQL(path: path, sql: """
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          repo_owner TEXT,
          repo_name TEXT,
          repo_remote TEXT,
          cwd TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE turns (
          id TEXT PRIMARY KEY,
          model_id TEXT
        );
        CREATE TABLE llm_messages (
          id TEXT PRIMARY KEY,
          turn_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          ts INTEGER NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          cache_write_tokens INTEGER NOT NULL DEFAULT 0,
          cost_total REAL NOT NULL DEFAULT 0
          \(modelColumn)
        );
        INSERT INTO sessions (id, repo_owner, repo_name, repo_remote, cwd)
        VALUES ('s1', 'owner', 'repo', 'git@example.com:owner/repo.git', '/repo');
        INSERT INTO turns (id, model_id) VALUES ('t1', 'turn-model');
        """)

        let insert = includeMessageModelID
            ? """
              INSERT INTO llm_messages
                (id, turn_id, session_id, ts, input_tokens, output_tokens,
                 cache_read_tokens, cache_write_tokens, cost_total, model_id)
              VALUES ('m1', 't1', 's1', 1704067200000, 10, 20, 3, 4, 1.5, 'message-model');
              """
            : """
              INSERT INTO llm_messages
                (id, turn_id, session_id, ts, input_tokens, output_tokens,
                 cache_read_tokens, cache_write_tokens, cost_total)
              VALUES ('m1', 't1', 's1', 1704067200000, 10, 20, 3, 4, 1.5);
              """
        try executeSQL(path: path, sql: insert)
        return path
    }

    func makeDatabaseWithNullModels() throws -> String {
        let path = temporaryDirectory().appendingPathComponent(UUID().uuidString + ".db").path
        try executeSQL(path: path, sql: """
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY, repo_owner TEXT, repo_name TEXT,
          repo_remote TEXT, cwd TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE turns (id TEXT PRIMARY KEY, model_id TEXT);
        CREATE TABLE llm_messages (
          id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, session_id TEXT NOT NULL,
          ts INTEGER NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          cache_write_tokens INTEGER NOT NULL DEFAULT 0,
          cost_total REAL NOT NULL DEFAULT 0, model_id TEXT
        );
        INSERT INTO sessions VALUES ('s1', NULL, NULL, NULL, '/tmp');
        INSERT INTO turns VALUES ('t1', NULL);
        INSERT INTO llm_messages
          (id, turn_id, session_id, ts, input_tokens, output_tokens,
           cache_read_tokens, cache_write_tokens, cost_total, model_id)
        VALUES ('m1', 't1', 's1', 1704067200000, 10, 20, 0, 0, 1.0, NULL);
        """)
        return path
    }

    func makeDatabaseWithRemoteOnlyRepo() throws -> String {
        let path = temporaryDirectory().appendingPathComponent(UUID().uuidString + ".db").path
        try executeSQL(path: path, sql: """
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY, repo_owner TEXT, repo_name TEXT,
          repo_remote TEXT, cwd TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE turns (id TEXT PRIMARY KEY, model_id TEXT);
        CREATE TABLE llm_messages (
          id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, session_id TEXT NOT NULL,
          ts INTEGER NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          cache_write_tokens INTEGER NOT NULL DEFAULT 0,
          cost_total REAL NOT NULL DEFAULT 0, model_id TEXT
        );
        INSERT INTO sessions VALUES
          ('s1', NULL, NULL, 'git@github.com:org/remote-repo.git', '/tmp');
        INSERT INTO turns VALUES ('t1', 'gpt-4');
        INSERT INTO llm_messages
          (id, turn_id, session_id, ts, input_tokens, output_tokens,
           cache_read_tokens, cache_write_tokens, cost_total, model_id)
        VALUES ('m1', 't1', 's1', 1704067200000, 5, 5, 0, 0, 0.5, 'gpt-4');
        """)
        return path
    }

    func makeDatabaseWithCwdOnlyRepo() throws -> String {
        let path = temporaryDirectory().appendingPathComponent(UUID().uuidString + ".db").path
        try executeSQL(path: path, sql: """
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY, repo_owner TEXT, repo_name TEXT,
          repo_remote TEXT, cwd TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE turns (id TEXT PRIMARY KEY, model_id TEXT);
        CREATE TABLE llm_messages (
          id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, session_id TEXT NOT NULL,
          ts INTEGER NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          cache_write_tokens INTEGER NOT NULL DEFAULT 0,
          cost_total REAL NOT NULL DEFAULT 0, model_id TEXT
        );
        INSERT INTO sessions VALUES ('s1', NULL, NULL, NULL, '/home/user/project');
        INSERT INTO turns VALUES ('t1', 'gpt-4');
        INSERT INTO llm_messages
          (id, turn_id, session_id, ts, input_tokens, output_tokens,
           cache_read_tokens, cache_write_tokens, cost_total, model_id)
        VALUES ('m1', 't1', 's1', 1704067200000, 5, 5, 0, 0, 0.5, 'gpt-4');
        """)
        return path
    }

    func makeSchemaMismatchDatabase() throws -> String {
        let path = temporaryDirectory().appendingPathComponent(UUID().uuidString + ".db").path
        try executeSQL(path: path, sql: """
        CREATE TABLE sessions (id TEXT PRIMARY KEY);
        CREATE TABLE turns (id TEXT PRIMARY KEY);
        CREATE TABLE llm_messages (id TEXT PRIMARY KEY);
        """)
        return path
    }

    func executeSQL(path: String, sql: String) throws {
        var db: OpaquePointer?
        let rc = sqlite3_open(path, &db)
        guard rc == SQLITE_OK, let db else {
            throw SQLiteError.openFailed(path: path, code: rc, message: "could not open fixture")
        }
        defer { sqlite3_close(db) }

        var error: UnsafeMutablePointer<CChar>?
        let execRC = sqlite3_exec(db, sql, nil, nil, &error)
        guard execRC == SQLITE_OK else {
            let message = error.map { String(cString: $0) } ?? "unknown fixture SQL error"
            sqlite3_free(error)
            throw SQLiteError.queryFailed(sql: sql, code: execRC, message: message)
        }
    }

    func temporaryDirectory() -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("AnalyticsTrayTests", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}
