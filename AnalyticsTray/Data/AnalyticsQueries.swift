import Foundation

/// High-level read-only analytics query facade.
///
/// This type keeps date-window math and missing-day filling outside the low-level
/// SQLite wrapper so the database layer remains a thin statement mapper.
enum AnalyticsQueries {
    static func validateSchema(databasePath: String) throws -> AnalyticsSchema {
        let database = try AnalyticsDatabase(path: databasePath)
        return try database.validateAnalyticsSchema()
    }

    static func usageBucket(databasePath: String, since lowerBoundMilliseconds: Int64) throws -> UsageBucket {
        let database = try AnalyticsDatabase(path: databasePath)
        _ = try database.validateAnalyticsSchema()
        return try database.queryUsageBucket(since: lowerBoundMilliseconds)
    }

    static func dailyCost(databasePath: String, since lowerBoundMilliseconds: Int64) throws -> [DailyCostPoint] {
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
        return try database.queryIntradayUsage(since: lowerBoundMilliseconds, bucketMinutes: bucketMinutes)
    }

    static func topModels(databasePath: String, since lowerBoundMilliseconds: Int64) throws -> [ModelBreakdown] {
        let database = try AnalyticsDatabase(path: databasePath)
        let schema = try database.validateAnalyticsSchema()
        return try database.queryTopModels(since: lowerBoundMilliseconds, schema: schema)
    }

    static func topRepos(databasePath: String, since lowerBoundMilliseconds: Int64) throws -> [RepoBreakdown] {
        let database = try AnalyticsDatabase(path: databasePath)
        _ = try database.validateAnalyticsSchema()
        return try database.queryTopRepos(since: lowerBoundMilliseconds)
    }

    static func loadSnapshot(databasePath: String, now: Date = Date(), calendar: Calendar = .current) throws -> UsageSnapshot {
        let database = try AnalyticsDatabase(path: databasePath)
        let schema = try database.validateAnalyticsSchema()

        let todayStart = calendar.startOfDay(for: now)
        let weekStart = calendar.date(byAdding: .day, value: -6, to: todayStart) ?? todayStart
        let chartStart = calendar.date(byAdding: .day, value: -146, to: todayStart) ?? todayStart
        let todayMillis = milliseconds(since1970: todayStart)
        let weekMillis = milliseconds(since1970: weekStart)
        let chartMillis = milliseconds(since1970: chartStart)

        let today = try database.queryUsageBucket(since: todayMillis)
        let week = try database.queryUsageBucket(since: weekMillis)
        let rawDailyCost = try database.queryDailyCost(since: chartMillis)
        let dailyCost = fillMissingDays(rawDailyCost, endingAt: todayStart, days: 147, calendar: calendar)
        let rawIntraday = try database.queryIntradayUsage(since: todayMillis, bucketMinutes: 15)
        let intradayUsage = fillMissingIntradayBuckets(rawIntraday, from: todayStart, through: now, bucketMinutes: 15)
        let topModels = try database.queryTopModels(since: weekMillis, schema: schema)
        let topRepos = try database.queryTopRepos(since: weekMillis)

        return UsageSnapshot(
            loadedAt: now,
            today: today,
            week: week,
            dailyCost: dailyCost,
            intradayUsage: intradayUsage,
            topModels: topModels,
            topRepos: topRepos
        )
    }

    static func milliseconds(since1970 date: Date) -> Int64 {
        Int64((date.timeIntervalSince1970 * 1000).rounded())
    }

    /// Fills gaps in the raw 15-minute intraday query result so every bucket
    /// from local midnight through the current bucket is represented.
    ///
    /// `end` is floored to the nearest bucket boundary internally, so callers
    /// can pass `Date()` directly. The loop is capped at 24 h worth of buckets
    /// to guard against unexpected input.
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

        let byBucket = points.reduce(into: [Date: IntradayUsagePoint]()) { buckets, point in
            if let existing = buckets[point.bucketStart] {
                buckets[point.bucketStart] = IntradayUsagePoint(
                    bucketStart: point.bucketStart,
                    costUSD: existing.costUSD + point.costUSD,
                    billableTokens: existing.billableTokens + point.billableTokens
                )
            } else {
                buckets[point.bucketStart] = point
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

    static func fillMissingDays(
        _ points: [DailyCostPoint],
        endingAt endDay: Date,
        days: Int = 7,
        calendar: Calendar = .current
    ) -> [DailyCostPoint] {
        let normalizedEnd = calendar.startOfDay(for: endDay)
        let byDay = Dictionary(uniqueKeysWithValues: points.map { (calendar.startOfDay(for: $0.day), $0) })

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
}
