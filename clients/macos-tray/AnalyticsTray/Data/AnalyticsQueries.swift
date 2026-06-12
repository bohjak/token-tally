import Foundation

/// High-level read-only analytics query facade.
///
/// This type keeps date-window math and missing-value filling outside the
/// low-level SQLite wrapper so the database layer remains a thin statement mapper.
///
/// All methods create a fresh `AnalyticsDatabase` per call. For snapshot loads
/// the single instance is reused across all sub-queries of the same refresh.
enum AnalyticsQueries {

    // MARK: - Default Database Path

    /// Returns the path to the central ToTally analytics database.
    ///
    /// Honors `$XDG_DATA_HOME` when set; falls back to `~/.local/share/token-tally/events.db`.
    /// This is the path `AppSettings` (T9) should use as the factory default.
    static func defaultDatabasePath() -> String {
        // $XDG_DATA_HOME overrides the default base data directory per the XDG spec.
        let xdgDataHome = ProcessInfo.processInfo.environment["XDG_DATA_HOME"]
        let dataBase = xdgDataHome ?? Paths.expandingTilde("~/.local/share")
        // Trim any trailing slash before appending so the path is canonical.
        let base = dataBase.hasSuffix("/") ? String(dataBase.dropLast()) : dataBase
        return base + "/token-tally/events.db"
    }

    // MARK: - Schema

    static func validateSchema(databasePath: String) throws -> AnalyticsSchema {
        let database = try AnalyticsDatabase(path: databasePath)
        return try database.validateAnalyticsSchema()
    }

    // MARK: - Individual Queries

    static func usageBucket(
        databasePath: String,
        since lowerBoundMilliseconds: Int64
    ) throws -> UsageBucket {
        let database = try AnalyticsDatabase(path: databasePath)
        _ = try database.validateAnalyticsSchema()
        return try database.queryUsageBucket(since: lowerBoundMilliseconds)
    }

    static func dailyCost(
        databasePath: String,
        since lowerBoundMilliseconds: Int64
    ) throws -> [DailyCostPoint] {
        let database = try AnalyticsDatabase(path: databasePath)
        _ = try database.validateAnalyticsSchema()
        return try database.queryDailyCost(since: lowerBoundMilliseconds)
    }

    static func intradayUsage(
        databasePath: String,
        since lowerBoundMilliseconds: Int64,
        bucketMinutes: Int = 15
    ) throws -> [IntradayUsagePoint] {
        let database = try AnalyticsDatabase(path: databasePath)
        _ = try database.validateAnalyticsSchema()
        return try database.queryIntradayUsage(
            since: lowerBoundMilliseconds, bucketMinutes: bucketMinutes
        )
    }

    static func topModels(
        databasePath: String,
        since lowerBoundMilliseconds: Int64
    ) throws -> [ModelBreakdown] {
        let database = try AnalyticsDatabase(path: databasePath)
        let schema = try database.validateAnalyticsSchema()
        return try database.queryTopModels(since: lowerBoundMilliseconds, schema: schema)
    }

    static func topRepos(
        databasePath: String,
        since lowerBoundMilliseconds: Int64
    ) throws -> [RepoBreakdown] {
        let database = try AnalyticsDatabase(path: databasePath)
        _ = try database.validateAnalyticsSchema()
        return try database.queryTopRepos(since: lowerBoundMilliseconds)
    }

    // MARK: - Full Snapshot

    /// Loads the complete analytics snapshot shown in the popover.
    ///
    /// Opens the database once and runs all sub-queries through the same
    /// connection. Callers (e.g. `AnalyticsStore`) should invoke this on a
    /// background task to avoid blocking the main thread.
    static func loadSnapshot(
        databasePath: String,
        now: Date = Date(),
        calendar: Calendar = .current
    ) throws -> UsageSnapshot {
        let database = try AnalyticsDatabase(path: databasePath)
        let schema = try database.validateAnalyticsSchema()

        let todayStart  = calendar.startOfDay(for: now)
        // "This week" = today + 6 prior full days (7 days inclusive).
        let weekStart   = calendar.date(byAdding: .day, value: -6, to: todayStart) ?? todayStart
        // Chart covers 21 weeks = 147 days.
        let chartStart  = calendar.date(byAdding: .day, value: -146, to: todayStart) ?? todayStart

        let todayMillis = milliseconds(since1970: todayStart)
        let weekMillis  = milliseconds(since1970: weekStart)
        let chartMillis = milliseconds(since1970: chartStart)

        let today  = try database.queryUsageBucket(since: todayMillis)
        let week   = try database.queryUsageBucket(since: weekMillis)

        let rawDailyCost  = try database.queryDailyCost(since: chartMillis)
        let dailyCost     = fillMissingDays(rawDailyCost, endingAt: todayStart, days: 147, calendar: calendar)

        let rawIntraday   = try database.queryIntradayUsage(since: todayMillis, bucketMinutes: 15)
        let intradayUsage = fillMissingIntradayBuckets(rawIntraday, from: todayStart, through: now, bucketMinutes: 15)

        let topModels        = try database.queryTopModels(since: weekMillis, schema: schema)
        let topRepos         = try database.queryTopRepos(since: weekMillis)
        let harnessBreakdowns = try database.queryHarnessBreakdowns(since: weekMillis)

        return UsageSnapshot(
            loadedAt: now,
            today: today,
            week: week,
            dailyCost: dailyCost,
            intradayUsage: intradayUsage,
            topModels: topModels,
            topRepos: topRepos,
            harnessBreakdowns: harnessBreakdowns,
            // Surface the week-window unpriced count from the aggregate bucket.
            // This is the same value that appears in week.unpricedMessages but
            // promoted to the top level so the UI doesn't have to drill in.
            unpricedMessages: week.unpricedMessages,
            // Forward the degraded flag so PopoverView can show the update
            // banner without making a second database query.
            schemaIsDegraded: schema.schemaIsDegraded
        )
    }

    // MARK: - Timestamp Helper

    static func milliseconds(since1970 date: Date) -> Int64 {
        Int64((date.timeIntervalSince1970 * 1000).rounded())
    }

    // MARK: - Missing-Day Fill

    /// Fills gaps in a sparse daily cost series so every day in the window is
    /// represented (with costUSD = 0 for empty days).
    ///
    /// Returns `days` entries ending at `endDay` (local midnight), oldest first.
    static func fillMissingDays(
        _ points: [DailyCostPoint],
        endingAt endDay: Date,
        days: Int = 7,
        calendar: Calendar = .current
    ) -> [DailyCostPoint] {
        let normalizedEnd = calendar.startOfDay(for: endDay)
        let byDay = Dictionary(uniqueKeysWithValues: points.map {
            (calendar.startOfDay(for: $0.day), $0)
        })

        return (0..<days).reversed().compactMap { offset in
            guard let day = calendar.date(byAdding: .day, value: -offset, to: normalizedEnd) else {
                return nil
            }
            if let existing = byDay[day] {
                return DailyCostPoint(day: day, costUSD: existing.costUSD, billableTokens: existing.billableTokens)
            }
            return DailyCostPoint(day: day, costUSD: 0, billableTokens: 0)
        }
    }

    // MARK: - Missing-Bucket Fill

    /// Fills gaps in a sparse intraday series so every `bucketMinutes`-wide
    /// bucket from `start` through `end` is represented.
    ///
    /// `end` is floored to the nearest bucket boundary internally, so callers
    /// can pass `Date()` directly. The loop is capped at one full day's worth
    /// of buckets to guard against unexpected input.
    static func fillMissingIntradayBuckets(
        _ points: [IntradayUsagePoint],
        from start: Date,
        through end: Date,
        bucketMinutes: Int = 15
    ) -> [IntradayUsagePoint] {
        precondition(bucketMinutes > 0, "bucketMinutes must be positive")
        let bucketSeconds = TimeInterval(bucketMinutes * 60)
        let firstEpoch = (start.timeIntervalSince1970 / bucketSeconds).rounded(.down) * bucketSeconds
        let lastEpoch  = (end.timeIntervalSince1970   / bucketSeconds).rounded(.down) * bucketSeconds

        guard lastEpoch >= firstEpoch else { return [] }

        let byBucket = points.reduce(into: [Date: IntradayUsagePoint]()) { acc, point in
            if let existing = acc[point.bucketStart] {
                // Merge duplicate bucket entries (should not occur in normal usage,
                // but guard against malformed data from the query layer).
                acc[point.bucketStart] = IntradayUsagePoint(
                    bucketStart: point.bucketStart,
                    costUSD: existing.costUSD + point.costUSD,
                    billableTokens: existing.billableTokens + point.billableTokens
                )
            } else {
                acc[point.bucketStart] = point
            }
        }

        // Defensive cap: one full day is at most 24 * 60 / bucketMinutes buckets.
        let maxBuckets = (24 * 60 / bucketMinutes) + 1
        var result: [IntradayUsagePoint] = []
        result.reserveCapacity(min(maxBuckets, Int((lastEpoch - firstEpoch) / bucketSeconds) + 1))

        var epoch = firstEpoch
        while epoch <= lastEpoch, result.count < maxBuckets {
            let date = Date(timeIntervalSince1970: epoch)
            if let existing = byBucket[date] {
                result.append(existing)
            } else {
                result.append(IntradayUsagePoint(bucketStart: date, costUSD: 0, billableTokens: 0))
            }
            epoch += bucketSeconds
        }
        return result
    }
}
