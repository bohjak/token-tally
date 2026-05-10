import Testing
@testable import AnalyticsTray

// MARK: - Cost formatting

@Suite("Formatters.formatCost")
struct FormatCostTests {

    @Test func zero() {
        #expect(Formatters.formatCost(0) == "$0.00")
    }

    @Test func typical() {
        #expect(Formatters.formatCost(1.42) == "$1.42")
    }

    @Test func trailingZero() {
        // Must keep two decimal places even when the last digit is zero.
        #expect(Formatters.formatCost(1.40) == "$1.40")
    }

    @Test func roundsUp() {
        // 0.005 is not exactly representable in IEEE 754 Double (it's slightly
        // below 0.005), so use a value that unambiguously rounds up.
        #expect(Formatters.formatCost(0.006) == "$0.01")
        #expect(Formatters.formatCost(0.015) == "$0.02")
    }

    @Test func subCent() {
        // Costs smaller than half a cent display as $0.00
        #expect(Formatters.formatCost(0.001) == "$0.00")
    }

    @Test func large() {
        #expect(Formatters.formatCost(100.00) == "$100.00")
    }
}

// MARK: - Token formatting

@Suite("Formatters.formatTokens")
struct FormatTokensTests {

    @Test func zero() {
        #expect(Formatters.formatTokens(0) == "0")
    }

    @Test func belowThousand() {
        #expect(Formatters.formatTokens(1) == "1")
        #expect(Formatters.formatTokens(999) == "999")
    }

    @Test func oneThousand() {
        // Exactly 1 000 → one decimal place.
        #expect(Formatters.formatTokens(1_000) == "1.0k")
    }

    @Test func lowThousands_oneDecimal() {
        #expect(Formatters.formatTokens(1_200) == "1.2k")
        #expect(Formatters.formatTokens(9_900) == "9.9k")
    }

    @Test func tenThousands_noDecimal() {
        #expect(Formatters.formatTokens(12_345) == "12k")
        #expect(Formatters.formatTokens(284_000) == "284k")
    }

    @Test func rounding_tenThousands() {
        // 12 500 rounds up to 13k; 12 499 stays at 12k.
        #expect(Formatters.formatTokens(12_500) == "13k")
        #expect(Formatters.formatTokens(12_499) == "12k")
    }

    @Test func oneMillion() {
        #expect(Formatters.formatTokens(1_000_000) == "1.0M")
    }

    @Test func millions() {
        #expect(Formatters.formatTokens(1_200_000) == "1.2M")
        // 1_250_000 sits on a rounding boundary (1.25); avoid it.
        // Use values that unambiguously round in one direction.
        #expect(Formatters.formatTokens(1_260_000) == "1.3M")  // 1.26 → 1.3
        #expect(Formatters.formatTokens(1_240_000) == "1.2M")  // 1.24 → 1.2
    }
}

// MARK: - Menu bar title

@Suite("Formatters.menuBarTitle")
struct MenuBarTitleTests {

    @Test func combined() {
        #expect(
            Formatters.menuBarTitle(tokens: 284_000, cost: 1.42, mode: .combinedTokensCost)
            == "π 284k · $1.42"
        )
    }

    @Test func tokensOnly() {
        #expect(
            Formatters.menuBarTitle(tokens: 284_000, cost: 1.42, mode: .tokensOnly)
            == "π 284k"
        )
    }

    @Test func costOnly() {
        #expect(
            Formatters.menuBarTitle(tokens: 284_000, cost: 1.42, mode: .costOnly)
            == "π $1.42"
        )
    }

    @Test func iconOnly() {
        #expect(
            Formatters.menuBarTitle(tokens: 284_000, cost: 1.42, mode: .iconOnly)
            == "π"
        )
    }

    @Test func combined_zeroData() {
        #expect(
            Formatters.menuBarTitle(tokens: 0, cost: 0, mode: .combinedTokensCost)
            == "π 0 · $0.00"
        )
    }
}

// MARK: - Paths

@Suite("Paths")
struct PathsTests {

    @Test func expandTilde() {
        let expanded = Paths.expandingTilde("~/.pi/analytics/events.db")
        #expect(!expanded.hasPrefix("~"))
        #expect(expanded.hasSuffix("/.pi/analytics/events.db"))
    }

    @Test func alreadyAbsolute() {
        let path = "/Users/test/.pi/analytics/events.db"
        #expect(Paths.expandingTilde(path) == path)
    }

    @Test func analyticsFolder_isParentDirectory() {
        let folder = Paths.analyticsFolder(forDatabasePath: "~/.pi/analytics/events.db")
        #expect(folder.path.hasSuffix("/.pi/analytics"))
    }
}

// MARK: - UsageBucket

@Suite("UsageBucket")
struct UsageBucketTests {

    @Test func zero_isDefault() {
        let b = UsageBucket.zero
        #expect(b.isEmpty)
        #expect(b.costUSD == 0)
        #expect(b.billableTokens == 0)
        #expect(b.cachedTokens == 0)
        #expect(b.turns == 0)
        #expect(b.sessions == 0)
    }

    @Test func nonEmpty() {
        let b = UsageBucket(
            costUSD: 1.42, billableTokens: 284_000,
            cachedTokens: 10_000, turns: 5, sessions: 2
        )
        #expect(!b.isEmpty)
        // Cached tokens must stay separate from billable tokens.
        #expect(b.billableTokens == 284_000)
        #expect(b.cachedTokens == 10_000)
    }
}
