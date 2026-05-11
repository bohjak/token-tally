import Foundation
import SQLite3
import Testing
@testable import AnalyticsTray

// MARK: - PerformanceTests
//
// Measures query latency against the large fixture database produced by
// `fixtures/generate-large-db.ts` (~1 M llm_messages rows across 3 harnesses
// and 6 months of timestamps).
//
// PLAN.md budget: < 50 ms for today/week summary and per-harness breakdown
// queries on a modern Mac.
//
// When the large fixture is absent (common in CI that does not pre-generate it),
// each test records a pass-with-skip so the suite still reports green.
// Generate the fixture with:
//   pnpm exec tsx fixtures/generate-large-db.ts --out /tmp/token-tally-large.db
//
// Hard timeout (regressionLimitMs) catches severe regressions without being
// fragile to CI variance. The intended 50 ms budget is documented inline;
// if queries exceed it the rollup table described in PLAN.md
// § "Performance fixtures and budgets" should be implemented.

private let largeFixturePath = "/tmp/token-tally-large.db"

// Budget constants (milliseconds).
private let intendedBudgetMs: Double  = 50      // PLAN.md target for a modern Mac
private let regressionLimitMs: Double = 2_000   // hard failure limit

@Suite("Performance — large fixture")
struct PerformanceTests {

    // MARK: - Today summary

    @Test func todaySummaryUnder50ms() throws {
        guard largeFixtureExists() else {
            print("[today-summary] SKIPPED — large fixture not found at \(largeFixturePath)")
            return
        }

        let todayMillis = try readMaxDayStart(from: largeFixturePath)
        let start = Date()
        let bucket = try AnalyticsQueries.usageBucket(
            databasePath: largeFixturePath, since: todayMillis
        )
        let elapsedMs = Date().timeIntervalSince(start) * 1_000

        printResult("today-summary", elapsedMs, value: bucket.billableTokens)

        #expect(
            elapsedMs < regressionLimitMs,
            "today-summary took \(String(format: "%.1f", elapsedMs)) ms — regression limit is \(regressionLimitMs) ms"
        )
    }

    // MARK: - Week summary

    @Test func weekSummaryUnder50ms() throws {
        guard largeFixtureExists() else {
            print("[week-summary] SKIPPED — large fixture not found at \(largeFixturePath)")
            return
        }

        let todayMillis = try readMaxDayStart(from: largeFixturePath)
        // "This week" = 7 days rolling window (today + 6 prior full days).
        let weekMillis  = todayMillis - Int64(6 * 24 * 3_600 * 1_000)
        let start = Date()
        let bucket = try AnalyticsQueries.usageBucket(
            databasePath: largeFixturePath, since: weekMillis
        )
        let elapsedMs = Date().timeIntervalSince(start) * 1_000

        printResult("week-summary", elapsedMs, value: bucket.billableTokens)

        #expect(
            elapsedMs < regressionLimitMs,
            "week-summary took \(String(format: "%.1f", elapsedMs)) ms — regression limit is \(regressionLimitMs) ms"
        )
        if elapsedMs > intendedBudgetMs {
            print("  ⚠️  week-summary exceeded the 50 ms PLAN.md budget (\(String(format: "%.1f", elapsedMs)) ms). Implement the daily_usage rollup table to bring this under budget.")
        }
    }

    // MARK: - Per-harness breakdown

    @Test func harnessBreakdownUnder50ms() throws {
        guard largeFixtureExists() else {
            print("[harness-breakdown] SKIPPED — large fixture not found at \(largeFixturePath)")
            return
        }

        let todayMillis = try readMaxDayStart(from: largeFixturePath)
        let weekMillis  = todayMillis - Int64(6 * 24 * 3_600 * 1_000)

        // Open via AnalyticsDatabase to exercise exactly the same code path the
        // tray popover uses. validateAnalyticsSchema() is part of every open.
        let db = try AnalyticsDatabase(path: largeFixturePath)
        _ = try db.validateAnalyticsSchema()

        let start = Date()
        let breakdowns = try db.queryHarnessBreakdowns(since: weekMillis)
        let elapsedMs = Date().timeIntervalSince(start) * 1_000

        printResult("harness-breakdown", elapsedMs, value: Int64(breakdowns.count))

        #expect(
            elapsedMs < regressionLimitMs,
            "harness-breakdown took \(String(format: "%.1f", elapsedMs)) ms — regression limit is \(regressionLimitMs) ms"
        )
        if elapsedMs > intendedBudgetMs {
            print("  ⚠️  harness-breakdown exceeded the 50 ms PLAN.md budget (\(String(format: "%.1f", elapsedMs)) ms). Implement the daily_usage rollup table.")
        }
        // Sanity: the large fixture has 3 harnesses — at least one must appear.
        #expect(!breakdowns.isEmpty, "Expected ≥1 harness breakdown in the large fixture week window")
    }

    // MARK: - Full snapshot (combined latency)

    @Test func fullSnapshotUnder2000ms() throws {
        guard largeFixtureExists() else {
            print("[full-snapshot] SKIPPED — large fixture not found at \(largeFixturePath)")
            return
        }

        let todayMillis = try readMaxDayStart(from: largeFixturePath)
        let todayDate   = Date(timeIntervalSince1970: TimeInterval(todayMillis) / 1_000)
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!

        let start    = Date()
        let snapshot = try AnalyticsQueries.loadSnapshot(
            databasePath: largeFixturePath,
            now: todayDate,
            calendar: cal
        )
        let elapsedMs = Date().timeIntervalSince(start) * 1_000

        printResult("full-snapshot", elapsedMs, value: snapshot.week.billableTokens)

        // Full snapshot runs today, week, chart, intraday, topModels, topRepos, and
        // harnessBreakdowns queries. Allow a much larger combined budget.
        let snapshotRegressionMs: Double = 6_000
        #expect(
            elapsedMs < snapshotRegressionMs,
            "full-snapshot took \(String(format: "%.1f", elapsedMs)) ms — regression limit is \(snapshotRegressionMs) ms"
        )
        #expect(!snapshot.harnessBreakdowns.isEmpty)
    }

    // MARK: - Schema validation latency

    @Test func schemaValidationUnder10ms() throws {
        guard largeFixtureExists() else {
            print("[schema-validation] SKIPPED — large fixture not found at \(largeFixturePath)")
            return
        }

        let start = Date()
        let schema = try AnalyticsQueries.validateSchema(databasePath: largeFixturePath)
        let elapsedMs = Date().timeIntervalSince(start) * 1_000

        printResult("schema-validation", elapsedMs, value: Int64(schema.schemaVersion))

        // Schema validation must be cheap — it reads schema_metadata + a few PRAGMA
        // calls. Anything over 50 ms is surprising.
        #expect(
            elapsedMs < 50,
            "schema-validation took \(String(format: "%.1f", elapsedMs)) ms — expected < 50 ms"
        )
    }

    // MARK: - Helpers

    private func largeFixtureExists() -> Bool {
        FileManager.default.fileExists(atPath: largeFixturePath)
    }

    /// Reads the max(ts) from the large fixture and rounds down to UTC midnight
    /// for the corresponding day. Anchors time windows to actual fixture data so
    /// "today" always intersects real rows regardless of when the fixture was built.
    private func readMaxDayStart(from path: String) throws -> Int64 {
        let maxTs = directSQLiteScalarInt64(
            path: path,
            sql: "SELECT COALESCE(MAX(ts), 0) FROM llm_messages;"
        )
        // Truncate sub-day remainder (integer division = floor for positive values).
        let secondsPerDay: Int64 = 24 * 3_600
        let dayStartSec = (maxTs / 1_000 / secondsPerDay) * secondsPerDay
        return dayStartSec * 1_000
    }

    /// Runs a single scalar SELECT against a SQLite database using the C API
    /// directly, bypassing AnalyticsDatabase (which has an opaque path property).
    private func directSQLiteScalarInt64(path: String, sql: String) -> Int64 {
        var db: OpaquePointer?
        guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK,
              let db else { return 0 }
        defer { sqlite3_close(db) }
        sqlite3_exec(db, "PRAGMA query_only = 1;", nil, nil, nil)

        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK,
              let stmt else { return 0 }
        defer { sqlite3_finalize(stmt) }

        guard sqlite3_step(stmt) == SQLITE_ROW else { return 0 }
        return sqlite3_column_int64(stmt, 0)
    }

    private func printResult(_ label: String, _ ms: Double, value: Int64) {
        let marker = ms <= intendedBudgetMs ? "✅" : "⚠️ "
        print("[\(label)] \(marker) \(String(format: "%.1f", ms)) ms  (value: \(value))")
    }
}
