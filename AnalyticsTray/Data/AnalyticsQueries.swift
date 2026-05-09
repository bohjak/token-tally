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
        let todayMillis = milliseconds(since1970: todayStart)
        let weekMillis = milliseconds(since1970: weekStart)

        let today = try database.queryUsageBucket(since: todayMillis)
        let week = try database.queryUsageBucket(since: weekMillis)
        let rawDailyCost = try database.queryDailyCost(since: weekMillis)
        let dailyCost = fillMissingDays(rawDailyCost, endingAt: todayStart, calendar: calendar)
        let topModels = try database.queryTopModels(since: weekMillis, schema: schema)
        let topRepos = try database.queryTopRepos(since: weekMillis)

        return UsageSnapshot(
            loadedAt: now,
            today: today,
            week: week,
            dailyCost: dailyCost,
            topModels: topModels,
            topRepos: topRepos
        )
    }

    static func milliseconds(since1970 date: Date) -> Int64 {
        Int64((date.timeIntervalSince1970 * 1000).rounded())
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
