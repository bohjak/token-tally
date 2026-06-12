import Foundation
import SQLite3
import Testing
@testable import AnalyticsTray

// MARK: - AnalyticsQueriesTests
//
// All fixture helpers build central ToTally schema databases (schema_version = 1
// with schema_metadata, harnesses, sessions, turns, llm_messages, …).
// There are no legacy Pi schema databases here; legacy data must be imported into
// the central schema before the tray can read it.

@Suite("AnalyticsQueries — usage bucket")
struct UsageBucketQueryTests {

    // MARK: Basic aggregation

    @Test func billableAndCachedTokensKeptSeparate() throws {
        let db = try CentralFixture()
        db.insertHarness(name: "pi", displayName: "Pi")
        let s = db.insertSession(harnessId: "pi", sessionId: "s1")
        let t = db.insertTurn(sessionId: s, harnessId: "pi", turnId: "t1")
        db.insertMessage(
            id: "m1", sessionId: s, turnId: t, harnessId: "pi",
            ts: 1_704_067_200_000,
            inputTokens: 10, outputTokens: 20,
            cacheReadTokens: 3, cacheWriteTokens: 4,
            costInputMicros: 1_000_000, costOutputMicros: 500_000,
            costSource: "harness"
        )

        let bucket = try AnalyticsQueries.usageBucket(
            databasePath: db.path, since: 1_700_000_000_000
        )

        // cost_total_micros / 1_000_000 = (1_000_000 + 500_000) / 1_000_000 = 1.5
        #expect(bucket.costUSD == 1.5)
        // billableTokens = input + output only (10 + 20 = 30)
        #expect(bucket.billableTokens == 30)
        // cachedTokens = cache_read + cache_write (3 + 4 = 7)
        #expect(bucket.cachedTokens == 7)
        #expect(bucket.turns == 1)
        #expect(bucket.sessions == 1)
        #expect(bucket.unpricedMessages == 0)
    }

    @Test func excludesRowsOlderThanLowerBound() throws {
        let db = try CentralFixture()
        db.insertHarness(name: "pi", displayName: "Pi")
        let s = db.insertSession(harnessId: "pi", sessionId: "s1")
        let t = db.insertTurn(sessionId: s, harnessId: "pi", turnId: "t1")
        db.insertMessage(
            id: "m1", sessionId: s, turnId: t, harnessId: "pi",
            ts: 1_704_067_200_000,         // 2024-01-01
            inputTokens: 10, outputTokens: 20,
            costInputMicros: 1_000_000, costOutputMicros: 500_000,
            costSource: "harness"
        )

        // Query with a lower bound far in the future → empty bucket
        let future: Int64 = 9_999_999_999_000
        let bucket = try AnalyticsQueries.usageBucket(databasePath: db.path, since: future)

        #expect(bucket.costUSD == 0)
        #expect(bucket.billableTokens == 0)
        #expect(bucket.turns == 0)
        #expect(bucket.sessions == 0)
        #expect(bucket.isEmpty)
    }

    // MARK: Unpriced messages

    @Test func unpricedMessagesExcludedFromCostUSD() throws {
        let db = try CentralFixture()
        db.insertHarness(name: "pi", displayName: "Pi")
        let s = db.insertSession(harnessId: "pi", sessionId: "s1")
        let t = db.insertTurn(sessionId: s, harnessId: "pi", turnId: "t1")
        // Priced message: 1.0 USD
        db.insertMessage(
            id: "m1", sessionId: s, turnId: t, harnessId: "pi",
            ts: 1_704_067_200_000,
            inputTokens: 10, outputTokens: 10,
            costInputMicros: 600_000, costOutputMicros: 400_000,
            costSource: "writer"
        )
        // Unpriced message: cost_source='unknown', all cost columns = 0
        db.insertMessage(
            id: "m2", sessionId: s, turnId: t, harnessId: "pi",
            ts: 1_704_067_300_000,
            inputTokens: 50, outputTokens: 50,
            costInputMicros: 0, costOutputMicros: 0,
            costSource: "unknown"
        )

        let bucket = try AnalyticsQueries.usageBucket(
            databasePath: db.path, since: 1_700_000_000_000
        )

        // Only the priced message contributes to costUSD
        #expect(bucket.costUSD == 1.0)
        // Both messages contribute to billableTokens
        #expect(bucket.billableTokens == 120)
        // One unpriced message
        #expect(bucket.unpricedMessages == 1)
    }

    @Test func unpricedMessagesCountedInUnpricedField() throws {
        let db = try CentralFixture()
        db.insertHarness(name: "pi", displayName: "Pi")
        let s = db.insertSession(harnessId: "pi", sessionId: "s1")
        let t = db.insertTurn(sessionId: s, harnessId: "pi", turnId: "t1")
        for i in 0..<5 {
            db.insertMessage(
                id: "m\(i)", sessionId: s, turnId: t, harnessId: "pi",
                ts: 1_704_067_200_000 + Int64(i * 1000),
                inputTokens: 10, outputTokens: 10,
                costInputMicros: 0, costOutputMicros: 0,
                costSource: "unknown"
            )
        }

        let bucket = try AnalyticsQueries.usageBucket(
            databasePath: db.path, since: 1_700_000_000_000
        )

        #expect(bucket.costUSD == 0)
        #expect(bucket.unpricedMessages == 5)
    }

    // MARK: Subscription-covered semantics

    @Test func subscriptionCoveredMessagesIncludedInCostUSD() throws {
        // Subscription-covered messages still hold the PAYG list-price equivalent
        // so callers can answer "what would this have cost without the subscription?"
        // They should be INCLUDED in costUSD (only 'unknown' is excluded).
        let db = try CentralFixture()
        db.insertHarness(name: "claude-code", displayName: "Claude Code")
        let sub = db.insertSubscription(
            id: "sub1", harnessId: "claude-code",
            planName: "claude-pro",
            periodStart: 1_700_000_000_000, periodEnd: 1_710_000_000_000,
            fixedCost: 20.0
        )
        let s = db.insertSession(harnessId: "claude-code", sessionId: "s1")
        let t = db.insertTurn(sessionId: s, harnessId: "claude-code", turnId: "t1")
        // Message covered by subscription: list-price equivalent = 2.0 USD
        db.insertMessage(
            id: "m1", sessionId: s, turnId: t, harnessId: "claude-code",
            ts: 1_704_067_200_000,
            inputTokens: 100, outputTokens: 200,
            costInputMicros: 1_000_000, costOutputMicros: 1_000_000,
            costSource: "subscription_covered",
            subscriptionId: sub
        )

        let bucket = try AnalyticsQueries.usageBucket(
            databasePath: db.path, since: 1_700_000_000_000
        )

        // subscription_covered is NOT excluded from costUSD — the list-price
        // equivalent is still meaningful ("what would this cost on PAYG?")
        #expect(bucket.costUSD == 2.0)
        #expect(bucket.unpricedMessages == 0)
    }

    // MARK: Multi-harness aggregation

    @Test func allHarnessesTotalsAggregate() throws {
        // Two harnesses each contributing one message; the bucket should sum both.
        let db = try CentralFixture()
        db.insertHarness(name: "pi",          displayName: "Pi")
        db.insertHarness(name: "claude-code", displayName: "Claude Code")
        let s1 = db.insertSession(harnessId: "pi",          sessionId: "s1")
        let s2 = db.insertSession(harnessId: "claude-code", sessionId: "s2")
        let t1 = db.insertTurn(sessionId: s1, harnessId: "pi",          turnId: "t1")
        let t2 = db.insertTurn(sessionId: s2, harnessId: "claude-code", turnId: "t2")
        db.insertMessage(
            id: "m1", sessionId: s1, turnId: t1, harnessId: "pi",
            ts: 1_704_067_200_000,
            inputTokens: 10, outputTokens: 20,
            costInputMicros: 600_000, costOutputMicros: 400_000,
            costSource: "harness"
        )
        db.insertMessage(
            id: "m2", sessionId: s2, turnId: t2, harnessId: "claude-code",
            ts: 1_704_067_300_000,
            inputTokens: 30, outputTokens: 40,
            costInputMicros: 1_200_000, costOutputMicros: 800_000,
            costSource: "harness"
        )

        let bucket = try AnalyticsQueries.usageBucket(
            databasePath: db.path, since: 1_700_000_000_000
        )

        #expect(bucket.costUSD == 3.0)         // 1.0 + 2.0
        #expect(bucket.billableTokens == 100)   // (10+20) + (30+40)
        #expect(bucket.sessions == 2)
        #expect(bucket.turns == 2)
    }
}

// MARK: -

@Suite("AnalyticsQueries — harness breakdowns")
struct HarnessBreakdownQueryTests {

    @Test func perHarnessDataReturned() throws {
        let db = try CentralFixture()
        db.insertHarness(name: "pi",          displayName: "Pi")
        db.insertHarness(name: "claude-code", displayName: "Claude Code")
        let s1 = db.insertSession(harnessId: "pi",          sessionId: "s1")
        let s2 = db.insertSession(harnessId: "claude-code", sessionId: "s2")
        let t1 = db.insertTurn(sessionId: s1, harnessId: "pi",          turnId: "t1")
        let t2 = db.insertTurn(sessionId: s2, harnessId: "claude-code", turnId: "t2")
        db.insertMessage(
            id: "m1", sessionId: s1, turnId: t1, harnessId: "pi",
            ts: 1_704_067_200_000,
            inputTokens: 10, outputTokens: 20,
            costInputMicros: 1_000_000, costOutputMicros: 500_000,
            costSource: "harness"
        )
        db.insertMessage(
            id: "m2", sessionId: s2, turnId: t2, harnessId: "claude-code",
            ts: 1_704_067_300_000,
            inputTokens: 5, outputTokens: 5,
            costInputMicros: 200_000, costOutputMicros: 300_000,
            costSource: "harness"
        )

        // Snapshot uses week window — pass a lower bound earlier than all fixtures
        let snapshot = try AnalyticsQueries.loadSnapshot(
            databasePath: db.path,
            now: Date(timeIntervalSince1970: 1_704_153_600), // 2024-01-02 00:00 UTC
            calendar: utcCalendar()
        )

        #expect(snapshot.harnessBreakdowns.count == 2)
        let pi = snapshot.harnessBreakdowns.first { $0.harnessId == "pi" }
        let cc = snapshot.harnessBreakdowns.first { $0.harnessId == "claude-code" }
        #expect(pi?.displayName == "Pi")
        #expect(pi?.week.costUSD == 1.5)
        #expect(pi?.week.billableTokens == 30)
        #expect(cc?.displayName == "Claude Code")
        #expect(cc?.week.costUSD == 0.5)
        #expect(cc?.week.billableTokens == 10)
    }

    @Test func inactiveHarnessesExcluded() throws {
        // A harness with no llm_messages in the query window must not appear.
        let db = try CentralFixture()
        db.insertHarness(name: "pi",     displayName: "Pi")
        db.insertHarness(name: "cursor", displayName: "Cursor")  // no messages
        let s = db.insertSession(harnessId: "pi", sessionId: "s1")
        let t = db.insertTurn(sessionId: s, harnessId: "pi", turnId: "t1")
        db.insertMessage(
            id: "m1", sessionId: s, turnId: t, harnessId: "pi",
            ts: 1_704_067_200_000,
            inputTokens: 5, outputTokens: 5,
            costInputMicros: 500_000, costOutputMicros: 500_000,
            costSource: "harness"
        )

        let snapshot = try AnalyticsQueries.loadSnapshot(
            databasePath: db.path,
            now: Date(timeIntervalSince1970: 1_704_153_600),
            calendar: utcCalendar()
        )

        // Only "pi" has messages; "cursor" must be absent.
        #expect(snapshot.harnessBreakdowns.count == 1)
        #expect(snapshot.harnessBreakdowns[0].harnessId == "pi")
    }

    @Test func unpricedCountTrackedPerHarness() throws {
        let db = try CentralFixture()
        db.insertHarness(name: "pi", displayName: "Pi")
        let s = db.insertSession(harnessId: "pi", sessionId: "s1")
        let t = db.insertTurn(sessionId: s, harnessId: "pi", turnId: "t1")
        db.insertMessage(
            id: "m1", sessionId: s, turnId: t, harnessId: "pi",
            ts: 1_704_067_200_000,
            inputTokens: 5, outputTokens: 5,
            costInputMicros: 0, costOutputMicros: 0,
            costSource: "unknown"
        )
        db.insertMessage(
            id: "m2", sessionId: s, turnId: t, harnessId: "pi",
            ts: 1_704_067_300_000,
            inputTokens: 5, outputTokens: 5,
            costInputMicros: 500_000, costOutputMicros: 500_000,
            costSource: "harness"
        )

        let snapshot = try AnalyticsQueries.loadSnapshot(
            databasePath: db.path,
            now: Date(timeIntervalSince1970: 1_704_153_600),
            calendar: utcCalendar()
        )

        let pi = snapshot.harnessBreakdowns.first { $0.harnessId == "pi" }
        #expect(pi?.week.unpricedMessages == 1)
        // snapshot.unpricedMessages mirrors week.unpricedMessages
        #expect(snapshot.unpricedMessages == 1)
    }
}

// MARK: -

@Suite("AnalyticsQueries — top models")
struct TopModelsQueryTests {

    @Test func preferMessageModelIDOverTurnModelID() throws {
        let db = try CentralFixture()
        db.insertHarness(name: "pi", displayName: "Pi")
        let s = db.insertSession(harnessId: "pi", sessionId: "s1")
        // Turn has model_id = "turn-model"
        let t = db.insertTurn(sessionId: s, harnessId: "pi", turnId: "t1", modelId: "turn-model")
        // Message has model_id = "message-model" — this should win
        db.insertMessage(
            id: "m1", sessionId: s, turnId: t, harnessId: "pi",
            ts: 1_704_067_200_000,
            inputTokens: 10, outputTokens: 20,
            costInputMicros: 1_000_000, costOutputMicros: 500_000,
            costSource: "harness", modelId: "message-model"
        )

        let models = try AnalyticsQueries.topModels(
            databasePath: db.path, since: 1_700_000_000_000
        )

        #expect(models.first?.modelID == "message-model")
        #expect(models.first?.costUSD == 1.5)
        #expect(models.first?.billableTokens == 30)
    }

    @Test func fallsBackToTurnModelIDWhenMessageModelIDIsNull() throws {
        let db = try CentralFixture()
        db.insertHarness(name: "pi", displayName: "Pi")
        let s = db.insertSession(harnessId: "pi", sessionId: "s1")
        let t = db.insertTurn(sessionId: s, harnessId: "pi", turnId: "t1", modelId: "turn-model")
        // Message has no model_id — should fall back to turn's model_id
        db.insertMessage(
            id: "m1", sessionId: s, turnId: t, harnessId: "pi",
            ts: 1_704_067_200_000,
            inputTokens: 10, outputTokens: 20,
            costInputMicros: 1_000_000, costOutputMicros: 500_000,
            costSource: "harness", modelId: nil
        )

        let models = try AnalyticsQueries.topModels(
            databasePath: db.path, since: 1_700_000_000_000
        )

        #expect(models.first?.modelID == "turn-model")
    }

    @Test func showsUnattributedWhenBothModelIDsAreNull() throws {
        let db = try CentralFixture()
        db.insertHarness(name: "pi", displayName: "Pi")
        let s = db.insertSession(harnessId: "pi", sessionId: "s1")
        let t = db.insertTurn(sessionId: s, harnessId: "pi", turnId: "t1", modelId: nil)
        db.insertMessage(
            id: "m1", sessionId: s, turnId: t, harnessId: "pi",
            ts: 1_704_067_200_000,
            inputTokens: 5, outputTokens: 5,
            costInputMicros: 500_000, costOutputMicros: 500_000,
            costSource: "harness", modelId: nil
        )

        let models = try AnalyticsQueries.topModels(
            databasePath: db.path, since: 1_700_000_000_000
        )

        #expect(models.first?.modelID == "unattributed")
    }
}

// MARK: -

@Suite("AnalyticsQueries — top repos")
struct TopReposQueryTests {

    @Test func prefersOwnerAndName() throws {
        let db = try CentralFixture()
        db.insertHarness(name: "pi", displayName: "Pi")
        let s = db.insertSession(
            harnessId: "pi", sessionId: "s1",
            repoOwner: "owner", repoName: "repo",
            repoRemote: "git@github.com:owner/repo.git",
            cwd: "/home/user/repo"
        )
        let t = db.insertTurn(sessionId: s, harnessId: "pi", turnId: "t1")
        db.insertMessage(
            id: "m1", sessionId: s, turnId: t, harnessId: "pi",
            ts: 1_704_067_200_000,
            inputTokens: 10, outputTokens: 20,
            costInputMicros: 1_000_000, costOutputMicros: 500_000,
            costSource: "harness"
        )

        let repos = try AnalyticsQueries.topRepos(
            databasePath: db.path, since: 1_700_000_000_000
        )

        #expect(repos.first?.repo == "owner/repo")
    }

    @Test func fallsBackToRemoteWhenOwnerIsNull() throws {
        let db = try CentralFixture()
        db.insertHarness(name: "pi", displayName: "Pi")
        let s = db.insertSession(
            harnessId: "pi", sessionId: "s1",
            repoOwner: nil, repoName: nil,
            repoRemote: "git@github.com:org/remote-repo.git",
            cwd: "/tmp"
        )
        let t = db.insertTurn(sessionId: s, harnessId: "pi", turnId: "t1")
        db.insertMessage(
            id: "m1", sessionId: s, turnId: t, harnessId: "pi",
            ts: 1_704_067_200_000,
            inputTokens: 5, outputTokens: 5,
            costInputMicros: 500_000, costOutputMicros: 500_000,
            costSource: "harness"
        )

        let repos = try AnalyticsQueries.topRepos(
            databasePath: db.path, since: 1_700_000_000_000
        )

        #expect(repos.first?.repo == "git@github.com:org/remote-repo.git")
    }

    @Test func fallsBackToCwdWhenRemoteIsNull() throws {
        let db = try CentralFixture()
        db.insertHarness(name: "pi", displayName: "Pi")
        let s = db.insertSession(
            harnessId: "pi", sessionId: "s1",
            repoOwner: nil, repoName: nil,
            repoRemote: nil, cwd: "/home/user/project"
        )
        let t = db.insertTurn(sessionId: s, harnessId: "pi", turnId: "t1")
        db.insertMessage(
            id: "m1", sessionId: s, turnId: t, harnessId: "pi",
            ts: 1_704_067_200_000,
            inputTokens: 5, outputTokens: 5,
            costInputMicros: 500_000, costOutputMicros: 500_000,
            costSource: "harness"
        )

        let repos = try AnalyticsQueries.topRepos(
            databasePath: db.path, since: 1_700_000_000_000
        )

        #expect(repos.first?.repo == "/home/user/project")
    }
}

// MARK: -

@Suite("AnalyticsQueries — daily cost")
struct DailyCostQueryTests {

    @Test func aggregatesByLocalDay() throws {
        let db = try CentralFixture()
        db.insertHarness(name: "pi", displayName: "Pi")
        let s = db.insertSession(harnessId: "pi", sessionId: "s1")
        let t = db.insertTurn(sessionId: s, harnessId: "pi", turnId: "t1")
        db.insertMessage(
            id: "m1", sessionId: s, turnId: t, harnessId: "pi",
            ts: 1_704_067_200_000,  // 2024-01-01 00:00 UTC
            inputTokens: 10, outputTokens: 20,
            costInputMicros: 1_000_000, costOutputMicros: 500_000,
            costSource: "harness"
        )

        let points = try AnalyticsQueries.dailyCost(
            databasePath: db.path, since: 1_700_000_000_000
        )

        #expect(points.count == 1)
        #expect(points[0].costUSD == 1.5)
        #expect(points[0].billableTokens == 30)
    }

    @Test func excludesUnpricedMessagesFromDailyCostUSD() throws {
        let db = try CentralFixture()
        db.insertHarness(name: "pi", displayName: "Pi")
        let s = db.insertSession(harnessId: "pi", sessionId: "s1")
        let t = db.insertTurn(sessionId: s, harnessId: "pi", turnId: "t1")
        // Priced
        db.insertMessage(
            id: "m1", sessionId: s, turnId: t, harnessId: "pi",
            ts: 1_704_067_200_000,
            inputTokens: 10, outputTokens: 10,
            costInputMicros: 500_000, costOutputMicros: 500_000,
            costSource: "writer"
        )
        // Unpriced
        db.insertMessage(
            id: "m2", sessionId: s, turnId: t, harnessId: "pi",
            ts: 1_704_067_300_000,
            inputTokens: 50, outputTokens: 50,
            costInputMicros: 0, costOutputMicros: 0,
            costSource: "unknown"
        )

        let points = try AnalyticsQueries.dailyCost(
            databasePath: db.path, since: 1_700_000_000_000
        )

        #expect(points.count == 1)
        #expect(points[0].costUSD == 1.0)  // only the priced message
        #expect(points[0].billableTokens == 120)  // both messages
    }
}

// MARK: -

@Suite("AnalyticsQueries — fill missing days (pure)")
struct FillMissingDaysTests {

    @Test func producesStableSevenDayWindow() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        let end = Date(timeIntervalSince1970: 1_704_067_200) // 2024-01-01 00:00 UTC
        let existing = DailyCostPoint(day: end, costUSD: 2, billableTokens: 20)

        let filled = AnalyticsQueries.fillMissingDays([existing], endingAt: end, calendar: cal)

        #expect(filled.count == 7)
        #expect(filled.last == existing)
        #expect(filled.dropLast().allSatisfy { $0.costUSD == 0 && $0.billableTokens == 0 })
    }

    @Test func withNoDataProducesAllZeros() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        let end = Date(timeIntervalSince1970: 1_704_067_200)

        let filled = AnalyticsQueries.fillMissingDays([], endingAt: end, calendar: cal)

        #expect(filled.count == 7)
        #expect(filled.allSatisfy { $0.costUSD == 0 && $0.billableTokens == 0 })
    }

    @Test func preservesExistingPointsInOrder() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        let end    = Date(timeIntervalSince1970: 1_704_585_600) // 2024-01-07
        let dayOne = Date(timeIntervalSince1970: 1_704_067_200) // 2024-01-01
        let points = [
            DailyCostPoint(day: dayOne, costUSD: 1.0, billableTokens: 10),
            DailyCostPoint(day: end,    costUSD: 2.0, billableTokens: 20),
        ]

        let filled = AnalyticsQueries.fillMissingDays(points, endingAt: end, calendar: cal)

        #expect(filled.count == 7)
        #expect(filled.first?.costUSD == 1.0)
        #expect(filled.last?.costUSD  == 2.0)
        let mid = Array(filled.dropFirst().dropLast())
        #expect(mid.allSatisfy { $0.costUSD == 0 })
    }

    @Test func withCustomDayCount() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        let end = Date(timeIntervalSince1970: 1_704_067_200)

        let filled = AnalyticsQueries.fillMissingDays([], endingAt: end, days: 30, calendar: cal)

        #expect(filled.count == 30)
        #expect(filled.allSatisfy { $0.costUSD == 0 })
    }
}

// MARK: -

@Suite("AnalyticsQueries — intraday usage")
struct IntradayUsageQueryTests {

    @Test func groupsRowsIntoFifteenMinuteBuckets() throws {
        let db = try CentralFixture()
        db.insertHarness(name: "pi", displayName: "Pi")
        let s = db.insertSession(harnessId: "pi", sessionId: "s1")
        let t = db.insertTurn(sessionId: s, harnessId: "pi", turnId: "t1")
        // Four rows across three 15-minute buckets anchored at 2024-01-01 00:00 UTC:
        //   00:02 → 00:00 bucket, cost=0.50, tokens=100
        //   00:14 → 00:00 bucket, cost=0.30, tokens=80
        //   00:15 → 00:15 bucket, cost=1.00, tokens=200
        //   00:31 → 00:30 bucket, cost=0.20, tokens=50
        let rows: [(String, Int64, Int64, Int64, Int64, Int64)] = [
            ("m1", 1_704_067_320_000,  60,  40, 300_000, 200_000),  // 00:02
            ("m2", 1_704_068_040_000,  50,  30, 180_000, 120_000),  // 00:14
            ("m3", 1_704_068_100_000, 100, 100, 600_000, 400_000),  // 00:15
            ("m4", 1_704_069_060_000,  25,  25, 120_000,  80_000),  // 00:31
        ]
        for (id, ts, inp, out, inMicros, outMicros) in rows {
            db.insertMessage(
                id: id, sessionId: s, turnId: t, harnessId: "pi",
                ts: ts, inputTokens: inp, outputTokens: out,
                costInputMicros: inMicros, costOutputMicros: outMicros,
                costSource: "harness"
            )
        }

        let midnight: Int64 = 1_704_067_200_000
        let points = try AnalyticsQueries.intradayUsage(databasePath: db.path, since: midnight)

        #expect(points.count == 3)
        let b0000 = Date(timeIntervalSince1970: 1_704_067_200)
        let b0015 = Date(timeIntervalSince1970: 1_704_068_100)
        let b0030 = Date(timeIntervalSince1970: 1_704_069_000)
        #expect(points[0].bucketStart == b0000)
        #expect(abs(points[0].costUSD - 0.8) < 1e-6, "00:00 bucket cost = 0.30 + 0.50 = 0.80")
        #expect(points[0].billableTokens == 180)
        #expect(points[1].bucketStart == b0015)
        #expect(abs(points[1].costUSD - 1.0) < 1e-6)
        #expect(points[1].billableTokens == 200)
        #expect(points[2].bucketStart == b0030)
        #expect(abs(points[2].costUSD - 0.2) < 1e-6)
        #expect(points[2].billableTokens == 50)
    }

    @Test func excludesRowsBeforeLowerBound() throws {
        let db = try CentralFixture()
        db.insertHarness(name: "pi", displayName: "Pi")
        let s = db.insertSession(harnessId: "pi", sessionId: "s1")
        let t = db.insertTurn(sessionId: s, harnessId: "pi", turnId: "t1")
        db.insertMessage(
            id: "m1", sessionId: s, turnId: t, harnessId: "pi",
            ts: 1_704_067_200_000,
            inputTokens: 10, outputTokens: 10,
            costInputMicros: 500_000, costOutputMicros: 500_000,
            costSource: "harness"
        )

        let points = try AnalyticsQueries.intradayUsage(
            databasePath: db.path, since: 9_999_999_999_000
        )

        #expect(points.isEmpty)
    }
}

// MARK: -

@Suite("AnalyticsQueries — fill missing intraday buckets (pure)")
struct FillMissingIntradayBucketsTests {

    @Test func producesWindowFromStartToEnd() {
        let start = Date(timeIntervalSince1970: 1_704_067_200)
        let end   = Date(timeIntervalSince1970: 1_704_067_200 + 90 * 60) // 01:30

        let filled = AnalyticsQueries.fillMissingIntradayBuckets([], from: start, through: end)

        // 00:00, 00:15, 00:30, 00:45, 01:00, 01:15, 01:30 → 7 buckets
        #expect(filled.count == 7)
        #expect(filled.first?.bucketStart == start)
        #expect(filled.last?.bucketStart  == Date(timeIntervalSince1970: 1_704_067_200 + 90 * 60))
        #expect(filled.allSatisfy { $0.costUSD == 0 && $0.billableTokens == 0 })
    }

    @Test func preservesExistingPoints() {
        let start      = Date(timeIntervalSince1970: 1_704_067_200)
        let end        = Date(timeIntervalSince1970: 1_704_067_200 + 90 * 60)
        let bucket0015 = Date(timeIntervalSince1970: 1_704_068_100)
        let existing   = IntradayUsagePoint(bucketStart: bucket0015, costUSD: 5.0, billableTokens: 999)

        let filled = AnalyticsQueries.fillMissingIntradayBuckets([existing], from: start, through: end)

        #expect(filled.count == 7)
        let preserved = filled.first { $0.bucketStart == bucket0015 }
        #expect(preserved?.costUSD == 5.0)
        #expect(preserved?.billableTokens == 999)
        #expect(filled.filter { $0.bucketStart != bucket0015 }.allSatisfy { $0.costUSD == 0 })
    }

    @Test func withNoDataProducesAllZeros() {
        let start = Date(timeIntervalSince1970: 1_704_067_200)
        let end   = Date(timeIntervalSince1970: 1_704_067_200 + 30 * 60)

        let filled = AnalyticsQueries.fillMissingIntradayBuckets([], from: start, through: end)

        // 00:00, 00:15, 00:30 → 3 buckets
        #expect(filled.count == 3)
        #expect(filled.allSatisfy { $0.costUSD == 0 && $0.billableTokens == 0 })
    }

    @Test func endBeforeStartProducesEmpty() {
        let start = Date(timeIntervalSince1970: 1_704_067_200 + 3600)
        let end   = Date(timeIntervalSince1970: 1_704_067_200)

        let filled = AnalyticsQueries.fillMissingIntradayBuckets([], from: start, through: end)

        #expect(filled.isEmpty)
    }
}

// MARK: -

@Suite("AnalyticsQueries — snapshot")
struct SnapshotTests {

    @Test func loadSnapshotIncludesFilledIntradayUsage() throws {
        let db = try CentralFixture()
        db.insertHarness(name: "pi", displayName: "Pi")
        let s = db.insertSession(harnessId: "pi", sessionId: "s1")
        let t = db.insertTurn(sessionId: s, harnessId: "pi", turnId: "t1")
        // Rows in the first three 15-minute buckets of 2024-01-01 UTC
        let rows: [(String, Int64, Int64, Int64, Int64, Int64)] = [
            ("m1", 1_704_067_320_000,  60,  40, 300_000, 200_000),
            ("m2", 1_704_068_040_000,  50,  30, 180_000, 120_000),
            ("m3", 1_704_068_100_000, 100, 100, 600_000, 400_000),
            ("m4", 1_704_069_060_000,  25,  25, 120_000,  80_000),
        ]
        for (id, ts, inp, out, inMicros, outMicros) in rows {
            db.insertMessage(
                id: id, sessionId: s, turnId: t, harnessId: "pi",
                ts: ts, inputTokens: inp, outputTokens: out,
                costInputMicros: inMicros, costOutputMicros: outMicros,
                costSource: "harness"
            )
        }

        // now = 2024-01-01 01:37 UTC → 7 intraday buckets from 00:00 through 01:30
        let snapshot = try AnalyticsQueries.loadSnapshot(
            databasePath: db.path,
            now: Date(timeIntervalSince1970: 1_704_067_200 + 97 * 60),
            calendar: utcCalendar()
        )

        #expect(snapshot.intradayUsage.count == 7)
        #expect(snapshot.intradayUsage[0].bucketStart == Date(timeIntervalSince1970: 1_704_067_200))
        #expect(snapshot.intradayUsage.last?.bucketStart == Date(timeIntervalSince1970: 1_704_067_200 + 90 * 60))
        #expect(abs(snapshot.intradayUsage[0].costUSD - 0.8) < 1e-6)
        #expect(abs(snapshot.intradayUsage[1].costUSD - 1.0) < 1e-6)
        #expect(abs(snapshot.intradayUsage[2].costUSD - 0.2) < 1e-6)
        #expect(snapshot.intradayUsage.dropFirst(3).allSatisfy { $0.costUSD == 0 })
    }

    @Test func loadSnapshotIncludesHarnessBreakdownsAndUnpricedTotal() throws {
        let db = try CentralFixture()
        db.insertHarness(name: "pi",          displayName: "Pi")
        db.insertHarness(name: "claude-code", displayName: "Claude Code")
        let s1 = db.insertSession(harnessId: "pi",          sessionId: "s1")
        let s2 = db.insertSession(harnessId: "claude-code", sessionId: "s2")
        let t1 = db.insertTurn(sessionId: s1, harnessId: "pi",          turnId: "t1")
        let t2 = db.insertTurn(sessionId: s2, harnessId: "claude-code", turnId: "t2")
        db.insertMessage(
            id: "m1", sessionId: s1, turnId: t1, harnessId: "pi",
            ts: 1_704_067_200_000,
            inputTokens: 10, outputTokens: 10,
            costInputMicros: 0, costOutputMicros: 0,
            costSource: "unknown"
        )
        db.insertMessage(
            id: "m2", sessionId: s2, turnId: t2, harnessId: "claude-code",
            ts: 1_704_067_300_000,
            inputTokens: 20, outputTokens: 20,
            costInputMicros: 1_000_000, costOutputMicros: 1_000_000,
            costSource: "harness"
        )

        let snapshot = try AnalyticsQueries.loadSnapshot(
            databasePath: db.path,
            now: Date(timeIntervalSince1970: 1_704_153_600),
            calendar: utcCalendar()
        )

        #expect(snapshot.harnessBreakdowns.count == 2)
        #expect(snapshot.unpricedMessages == 1)
        // Total week cost: only the claude-code message (pi message is unknown)
        #expect(snapshot.week.costUSD == 2.0)
    }
}

// MARK: -

@Suite("AnalyticsQueries — schema validation")
struct SchemaValidationTests {

    @Test func validVersion1SchemaPassesValidation() throws {
        let db = try CentralFixture()
        let schema = try AnalyticsQueries.validateSchema(databasePath: db.path)
        #expect(schema.schemaVersion == 1)
        // Central schema v1 always has model_id on llm_messages
        #expect(schema.hasMessageModelID)
    }

    @Test func tooOldSchemaVersionThrowsSchemaMismatch() throws {
        // schema_version = 0 is below MIN_SUPPORTED = 1 → must throw schemaMismatch
        let db = try CentralFixture(schemaVersion: "0")
        do {
            _ = try AnalyticsQueries.validateSchema(databasePath: db.path)
            Issue.record("Expected schemaMismatch for version 0")
        } catch let e as SQLiteError {
            #expect(e.isSchemaMismatch)
        }
    }

    @Test func tooNewSchemaVersionThrowsSchemaMismatch() throws {
        // schema_version = 4 exceeds MAX_KNOWN(1) + WINDOW(2) = 3 → must throw
        let db = try CentralFixture(schemaVersion: "4")
        do {
            _ = try AnalyticsQueries.validateSchema(databasePath: db.path)
            Issue.record("Expected schemaMismatch for version 4")
        } catch let e as SQLiteError {
            #expect(e.isSchemaMismatch)
        }
    }

    @Test func degradedSchemaVersionPassesValidation() throws {
        // schema_version = 2 is within the forward window (1 < 2 ≤ 3) → no throw
        let db = try CentralFixture(schemaVersion: "2")
        let schema = try AnalyticsQueries.validateSchema(databasePath: db.path)
        #expect(schema.schemaVersion == 2)
    }

    @Test func missingSchemaMetadataThrowsSchemaMismatch() throws {
        // A database without schema_metadata is not a ToTally central store
        let path = try makeNonToTallyDB()
        do {
            _ = try AnalyticsQueries.validateSchema(databasePath: path)
            Issue.record("Expected schemaMismatch for missing schema_metadata")
        } catch let e as SQLiteError {
            #expect(e.isSchemaMismatch)
        }
    }

    @Test func missingRequiredTableThrowsSchemaMismatch() throws {
        // A schema_metadata + schema_version=1 DB missing 'harnesses' should fail
        let path = try makeIncompleteToTallyDB()
        do {
            _ = try AnalyticsQueries.validateSchema(databasePath: path)
            Issue.record("Expected schemaMismatch for missing table")
        } catch let e as SQLiteError {
            #expect(e.isSchemaMismatch)
        }
    }

    // MARK: Helpers

    private func makeNonToTallyDB() throws -> String {
        let path = tmpDir().appendingPathComponent(UUID().uuidString + ".db").path
        try execSQL(path: path, sql: """
        CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT NOT NULL DEFAULT '');
        CREATE TABLE turns (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
        CREATE TABLE llm_messages (id TEXT PRIMARY KEY, turn_id TEXT, session_id TEXT);
        """)
        return path
    }

    private func makeIncompleteToTallyDB() throws -> String {
        let path = tmpDir().appendingPathComponent(UUID().uuidString + ".db").path
        try execSQL(path: path, sql: """
        CREATE TABLE schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO schema_metadata VALUES ('schema_version','1'),('created_at','0'),('last_migrated_at','0');
        -- intentionally missing: harnesses, sessions, turns, llm_messages
        """)
        return path
    }
}

// MARK: -

@Suite("AnalyticsQueries — legacy import diagnostics")
struct LegacyImportDiagnosticsTests {

    @Test func dbWithImportMetadataPassesValidation() throws {
        // When 'token-tally import legacy-pi' has run, it writes an 'import_legacy_pi'
        // key into schema_metadata. The tray must still open the DB without error.
        let db = try CentralFixture()
        let importResult = """
        {"sourcePath":"/Users/me/.pi/analytics/events.db","centralPath":"/tmp/central.db","completedAt":1704067200000,"tables":{"sessions":{"legacy":10,"added":10},"turns":{"legacy":20,"added":20},"messages":{"legacy":100,"added":100},"toolCalls":{"legacy":5,"added":5}}}
        """
        try execSQL(path: db.path, sql: """
        INSERT OR REPLACE INTO schema_metadata (key, value)
        VALUES ('import_legacy_pi', '\(importResult.replacingOccurrences(of: "'", with: "''"))');
        """)

        // Validation must succeed — the extra key in schema_metadata is benign
        let schema = try AnalyticsQueries.validateSchema(databasePath: db.path)
        #expect(schema.schemaVersion == 1)
    }

    @Test func dbWithImportMetadataQueriesSuccessfully() throws {
        // After import, actual data rows are present in the central schema.
        // Verify that the tray can query them normally (imported data is just
        // regular central-schema rows, indistinguishable from live writes).
        let db = try CentralFixture()
        try execSQL(path: db.path, sql: """
        INSERT INTO schema_metadata (key, value)
        VALUES ('import_legacy_pi', '{"sourcePath":"~/.pi/analytics/events.db","completedAt":1704067200000}');
        """)
        db.insertHarness(name: "pi", displayName: "Pi")
        let s = db.insertSession(harnessId: "pi", sessionId: "s1")
        let t = db.insertTurn(sessionId: s, harnessId: "pi", turnId: "t1")
        // Imported message: cost_source='writer' (the importer tag for legacy data)
        db.insertMessage(
            id: "m1", sessionId: s, turnId: t, harnessId: "pi",
            ts: 1_704_067_200_000,
            inputTokens: 10, outputTokens: 20,
            costInputMicros: 1_000_000, costOutputMicros: 500_000,
            costSource: "writer"
        )

        let bucket = try AnalyticsQueries.usageBucket(
            databasePath: db.path, since: 1_700_000_000_000
        )

        #expect(bucket.costUSD == 1.5)
        #expect(bucket.billableTokens == 30)
    }
}

// MARK: -

@Suite("AnalyticsQueries — error states")
struct ErrorStateTests {

    @Test func missingDatabaseIsRecoverableError() throws {
        let missing = tmpDir().appendingPathComponent("does-not-exist.db").path
        do {
            _ = try AnalyticsQueries.usageBucket(databasePath: missing, since: 0)
            Issue.record("Expected missingDatabase error")
        } catch let e as SQLiteError {
            #expect(e.isDatabaseMissing)
        }
    }

    @Test func schemaMismatchOnOldSchemaDB() throws {
        // A dynamically-created DB that lacks schema_metadata
        let path = tmpDir().appendingPathComponent(UUID().uuidString + ".db").path
        try execSQL(path: path, sql: """
        CREATE TABLE sessions (id TEXT PRIMARY KEY);
        CREATE TABLE turns (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
        CREATE TABLE llm_messages (id TEXT PRIMARY KEY, turn_id TEXT, session_id TEXT);
        """)
        do {
            _ = try AnalyticsQueries.usageBucket(databasePath: path, since: 0)
            Issue.record("Expected schemaMismatch")
        } catch let e as SQLiteError {
            #expect(e.isSchemaMismatch)
        }
    }

    @Test func emptyDatabaseProducesZeroBucket() throws {
        let db = try CentralFixture()
        let bucket = try AnalyticsQueries.usageBucket(databasePath: db.path, since: 0)
        #expect(bucket.isEmpty)
        #expect(bucket.costUSD == 0)
        #expect(bucket.billableTokens == 0)
        #expect(bucket.unpricedMessages == 0)
    }

    @Test func emptyDatabaseProducesNoTopModels() throws {
        let db = try CentralFixture()
        let models = try AnalyticsQueries.topModels(databasePath: db.path, since: 0)
        #expect(models.isEmpty)
    }

    @Test func emptyDatabaseProducesNoTopRepos() throws {
        let db = try CentralFixture()
        let repos = try AnalyticsQueries.topRepos(databasePath: db.path, since: 0)
        #expect(repos.isEmpty)
    }

    @Test func emptyDatabaseProducesNoDailyCost() throws {
        let db = try CentralFixture()
        let points = try AnalyticsQueries.dailyCost(databasePath: db.path, since: 0)
        #expect(points.isEmpty)
    }

    @Test func emptyDatabaseProducesNoHarnessBreakdowns() throws {
        let db = try CentralFixture()
        let snapshot = try AnalyticsQueries.loadSnapshot(
            databasePath: db.path,
            now: Date(timeIntervalSince1970: 1_704_067_200),
            calendar: utcCalendar()
        )
        #expect(snapshot.harnessBreakdowns.isEmpty)
        #expect(snapshot.today.isEmpty)
        #expect(snapshot.week.isEmpty)
    }
}

// MARK: -

@Suite("AnalyticsQueries — on-disk fixtures")
struct AnalyticsQueriesFixtureTests {

    private func fixturePath(_ name: String) -> String {
        let sourceDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        return sourceDir.appendingPathComponent("Fixtures/\(name)").path
    }

    @Test func emptyFixturePassesSchemaValidation() throws {
        let schema = try AnalyticsQueries.validateSchema(databasePath: fixturePath("empty.db"))
        #expect(schema.schemaVersion == 1)
        #expect(schema.hasMessageModelID)
    }

    @Test func emptyFixtureProducesZeroBucket() throws {
        let bucket = try AnalyticsQueries.usageBucket(databasePath: fixturePath("empty.db"), since: 0)
        #expect(bucket.isEmpty)
        #expect(bucket.unpricedMessages == 0)
    }

    @Test func emptyFixtureProducesNoDailyCost() throws {
        let points = try AnalyticsQueries.dailyCost(databasePath: fixturePath("empty.db"), since: 0)
        #expect(points.isEmpty)
    }

    @Test func emptyFixtureProducesNoTopModels() throws {
        let models = try AnalyticsQueries.topModels(databasePath: fixturePath("empty.db"), since: 0)
        #expect(models.isEmpty)
    }

    @Test func emptyFixtureProducesNoTopRepos() throws {
        let repos = try AnalyticsQueries.topRepos(databasePath: fixturePath("empty.db"), since: 0)
        #expect(repos.isEmpty)
    }

    @Test func schemaMismatchFixtureThrowsSchemaMismatch() throws {
        do {
            _ = try AnalyticsQueries.usageBucket(
                databasePath: fixturePath("schema-mismatch.db"), since: 0
            )
            Issue.record("Expected SQLiteError.schemaMismatch")
        } catch let e as SQLiteError {
            #expect(e.isSchemaMismatch)
        }
    }

    @Test func schemaMismatchFixtureSchemaValidationFails() throws {
        do {
            _ = try AnalyticsQueries.validateSchema(databasePath: fixturePath("schema-mismatch.db"))
            Issue.record("Expected SQLiteError.schemaMismatch from validateSchema")
        } catch let e as SQLiteError {
            #expect(e.isSchemaMismatch)
        }
    }
}

// MARK: -

@Suite("AnalyticsQueries — degraded schema flag")
struct DegradedSchemaFlagTests {

    // schema_version = 1 (MAX_KNOWN) → not degraded
    @Test func normalSchemaSnapshotIsNotDegraded() throws {
        let db = try CentralFixture(schemaVersion: "1")
        let snapshot = try AnalyticsQueries.loadSnapshot(
            databasePath: db.path,
            now: Date(timeIntervalSince1970: 1_704_153_600),
            calendar: utcCalendar()
        )
        #expect(snapshot.schemaIsDegraded == false)
    }

    // schema_version = 2 (MAX_KNOWN+1, within forward window) → degraded
    @Test func degradedSchemaSnapshotIsFlagged() throws {
        let db = try CentralFixture(schemaVersion: "2")
        let snapshot = try AnalyticsQueries.loadSnapshot(
            databasePath: db.path,
            now: Date(timeIntervalSince1970: 1_704_153_600),
            calendar: utcCalendar()
        )
        // The tray must still load the snapshot without throwing — degraded
        // mode means reads succeed on known columns, not that the DB is broken.
        #expect(snapshot.schemaIsDegraded == true)
    }

    // schema_version = 3 (MAX_KNOWN+WINDOW, last tolerated version) → degraded
    @Test func degradedSchemaAtWindowEdgeIsFlagged() throws {
        let db = try CentralFixture(schemaVersion: "3")
        let snapshot = try AnalyticsQueries.loadSnapshot(
            databasePath: db.path,
            now: Date(timeIntervalSince1970: 1_704_153_600),
            calendar: utcCalendar()
        )
        #expect(snapshot.schemaIsDegraded == true)
    }

    // schema_version = 4 (beyond MAX_KNOWN+WINDOW) → loadSnapshot must throw,
    // not return a degraded snapshot. This guards against the flag being set
    // incorrectly on too-new databases that validateAnalyticsSchema rejects.
    @Test func tooNewSchemaDoesNotProduceSnapshot() throws {
        let db = try CentralFixture(schemaVersion: "4")
        do {
            _ = try AnalyticsQueries.loadSnapshot(
                databasePath: db.path,
                now: Date(timeIntervalSince1970: 1_704_153_600),
                calendar: utcCalendar()
            )
            Issue.record("Expected schemaMismatch for version 4")
        } catch let e as SQLiteError {
            #expect(e.isSchemaMismatch)
        }
    }
}

// MARK: - Shared helpers

/// Central-schema fixture database.
///
/// Creates a valid ToTally central store (schema_version = 1, all required
/// tables and indexes) in a temp directory. Use the insert methods to
/// populate test rows; the database is deleted when the process exits
/// (standard tmp cleanup).
private final class CentralFixture {
    let path: String

    init(schemaVersion: String = "1") throws {
        path = tmpDir()
            .appendingPathComponent(UUID().uuidString + ".db")
            .path
        try execSQL(path: path, sql: centralSchemaDDL(version: schemaVersion))
    }

    // MARK: Row helpers

    func insertHarness(name: String, displayName: String) {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        try? execSQL(path: path, sql: """
        INSERT INTO harnesses (name, display_name, first_seen_at, last_seen_at)
        VALUES ('\(name)', '\(displayName)', \(now), \(now));
        """)
    }

    /// Returns the canonical session UUID for chaining to child inserts.
    @discardableResult
    func insertSession(
        harnessId: String, sessionId: String,
        repoOwner: String? = "owner", repoName: String? = "repo",
        repoRemote: String? = nil, cwd: String? = "/repo"
    ) -> String {
        let uuid = UUID().uuidString
        let owner  = repoOwner.map { "'\($0)'" } ?? "NULL"
        let name   = repoName.map  { "'\($0)'" } ?? "NULL"
        let remote = repoRemote.map { "'\($0)'" } ?? "NULL"
        let cwdVal = cwd.map { "'\($0)'" } ?? "NULL"
        try? execSQL(path: path, sql: """
        INSERT INTO sessions
          (id, harness_id, harness_session_id, cwd,
           repo_owner, repo_name, repo_remote, started_at)
        VALUES ('\(uuid)', '\(harnessId)', '\(sessionId)', \(cwdVal),
                \(owner), \(name), \(remote), 1700000000000);
        """)
        return uuid
    }

    /// Returns the canonical turn UUID.
    @discardableResult
    func insertTurn(
        sessionId: String, harnessId: String, turnId: String,
        modelId: String? = nil
    ) -> String {
        let uuid = UUID().uuidString
        let model = modelId.map { "'\($0)'" } ?? "NULL"
        try? execSQL(path: path, sql: """
        INSERT INTO turns
          (id, session_id, harness_id, harness_turn_id,
           started_at, model_id)
        VALUES ('\(uuid)', '\(sessionId)', '\(harnessId)', '\(turnId)',
                1700000000000, \(model));
        """)
        return uuid
    }

    /// Returns the subscription UUID.
    @discardableResult
    func insertSubscription(
        id: String, harnessId: String, planName: String,
        periodStart: Int64, periodEnd: Int64, fixedCost: Double
    ) -> String {
        try? execSQL(path: path, sql: """
        INSERT INTO subscriptions
          (id, harness_id, plan_name, period_start, period_end, fixed_cost)
        VALUES ('\(id)', '\(harnessId)', '\(planName)',
                \(periodStart), \(periodEnd), \(fixedCost));
        """)
        return id
    }

    func insertMessage(
        id: String, sessionId: String, turnId: String, harnessId: String,
        ts: Int64,
        inputTokens: Int64 = 0, outputTokens: Int64 = 0,
        cacheReadTokens: Int64 = 0, cacheWriteTokens: Int64 = 0,
        costInputMicros: Int64 = 0, costOutputMicros: Int64 = 0,
        costCacheReadMicros: Int64 = 0, costCacheWriteMicros: Int64 = 0,
        costSource: String = "harness",
        modelId: String? = "claude-opus-4-5",
        subscriptionId: String? = nil
    ) {
        let totalMicros = costInputMicros + costOutputMicros + costCacheReadMicros + costCacheWriteMicros
        let model = modelId.map { "'\($0)'" } ?? "NULL"
        let sub   = subscriptionId.map { "'\($0)'" } ?? "NULL"
        let msgId = UUID().uuidString
        try? execSQL(path: path, sql: """
        INSERT INTO llm_messages (
          id, session_id, turn_id, harness_id, harness_message_id, ts,
          model_id,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          cost_input_micros, cost_output_micros,
          cost_cache_read_micros, cost_cache_write_micros,
          cost_total_micros, cost_source, subscription_id
        ) VALUES (
          '\(msgId)', '\(sessionId)', '\(turnId)', '\(harnessId)', '\(id)', \(ts),
          \(model),
          \(inputTokens), \(outputTokens), \(cacheReadTokens), \(cacheWriteTokens),
          \(costInputMicros), \(costOutputMicros),
          \(costCacheReadMicros), \(costCacheWriteMicros),
          \(totalMicros), '\(costSource)', \(sub)
        );
        """)
    }
}

// MARK: SQL helpers

private func centralSchemaDDL(version: String) -> String {
    // Compact DDL for tests — mirrors 001_initial.sql + 002_indexes.sql.
    // Uses CREATE TABLE (not IF NOT EXISTS) so duplicate calls surface as errors.
    """
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO schema_metadata VALUES
      ('schema_version',   '\(version)'),
      ('created_at',       '0'),
      ('last_migrated_at', '0');
    CREATE TABLE harnesses (
      name TEXT PRIMARY KEY, display_name TEXT NOT NULL,
      version TEXT, integration_version TEXT,
      first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
    );
    CREATE TABLE subscriptions (
      id TEXT NOT NULL PRIMARY KEY, harness_id TEXT NOT NULL,
      plan_name TEXT NOT NULL, period_start INTEGER NOT NULL,
      period_end INTEGER NOT NULL, fixed_cost REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      quota_limit INTEGER, quota_used INTEGER, quota_unit TEXT,
      FOREIGN KEY (harness_id) REFERENCES harnesses(name) ON DELETE RESTRICT,
      UNIQUE (harness_id, plan_name, period_start)
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, harness_id TEXT NOT NULL,
      harness_session_id TEXT NOT NULL,
      session_file TEXT, cwd TEXT, repo_owner TEXT, repo_name TEXT, repo_remote TEXT,
      started_at INTEGER NOT NULL, ended_at INTEGER,
      FOREIGN KEY (harness_id) REFERENCES harnesses(name) ON DELETE RESTRICT,
      UNIQUE (harness_id, harness_session_id)
    );
    CREATE TABLE turns (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      harness_id TEXT NOT NULL, harness_turn_id TEXT NOT NULL,
      turn_index INTEGER, started_at INTEGER NOT NULL, ended_at INTEGER,
      provider TEXT, model_id TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE RESTRICT,
      FOREIGN KEY (harness_id) REFERENCES harnesses(name) ON DELETE RESTRICT,
      UNIQUE (session_id, harness_turn_id)
    );
    CREATE TABLE llm_messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT,
      harness_id TEXT NOT NULL, harness_message_id TEXT NOT NULL,
      ts INTEGER NOT NULL, provider TEXT, model_id TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost_input_micros INTEGER NOT NULL DEFAULT 0,
      cost_output_micros INTEGER NOT NULL DEFAULT 0,
      cost_cache_read_micros INTEGER NOT NULL DEFAULT 0,
      cost_cache_write_micros INTEGER NOT NULL DEFAULT 0,
      cost_total_micros INTEGER NOT NULL DEFAULT 0,
      cost_currency TEXT NOT NULL DEFAULT 'USD',
      cost_source TEXT NOT NULL DEFAULT 'unknown'
        CHECK (cost_source IN ('harness','writer','subscription_covered','unknown')),
      subscription_id TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE RESTRICT,
      FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE RESTRICT,
      FOREIGN KEY (harness_id) REFERENCES harnesses(name) ON DELETE RESTRICT,
      FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE RESTRICT,
      UNIQUE (harness_id, harness_message_id),
      CHECK (cost_total_micros =
             cost_input_micros + cost_output_micros +
             cost_cache_read_micros + cost_cache_write_micros)
    );
    CREATE TABLE tool_calls (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT,
      harness_id TEXT NOT NULL, harness_tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL, started_at INTEGER NOT NULL,
      ended_at INTEGER, is_error INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE RESTRICT,
      FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE RESTRICT,
      FOREIGN KEY (harness_id) REFERENCES harnesses(name) ON DELETE RESTRICT,
      UNIQUE (harness_id, harness_tool_call_id)
    );
    CREATE TABLE raw_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, harness_id TEXT NOT NULL,
      ts INTEGER NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL,
      FOREIGN KEY (harness_id) REFERENCES harnesses(name) ON DELETE RESTRICT
    );
    CREATE INDEX idx_llm_messages_ts ON llm_messages(ts);
    CREATE INDEX idx_llm_messages_harness_ts ON llm_messages(harness_id, ts);
    CREATE INDEX idx_llm_messages_session ON llm_messages(session_id);
    CREATE INDEX idx_llm_messages_subscription ON llm_messages(subscription_id);
    CREATE INDEX idx_turns_session ON turns(session_id);
    CREATE INDEX idx_tool_calls_session ON tool_calls(session_id);
    CREATE INDEX idx_raw_events_harness_ts ON raw_events(harness_id, ts);
    """
}

private func execSQL(path: String, sql: String) throws {
    var db: OpaquePointer?
    let rc = sqlite3_open(path, &db)
    guard rc == SQLITE_OK, let db else {
        throw SQLiteError.openFailed(path: path, code: rc, message: "fixture open failed")
    }
    defer { sqlite3_close(db) }
    var err: UnsafeMutablePointer<CChar>?
    let execRC = sqlite3_exec(db, sql, nil, nil, &err)
    guard execRC == SQLITE_OK else {
        let msg = err.map { String(cString: $0) } ?? "unknown error"
        sqlite3_free(err)
        throw SQLiteError.queryFailed(sql: sql, code: execRC, message: msg)
    }
}

private func tmpDir() -> URL {
    let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("TTTests", isDirectory: true)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

private func utcCalendar() -> Calendar {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = TimeZone(secondsFromGMT: 0)!
    return cal
}
