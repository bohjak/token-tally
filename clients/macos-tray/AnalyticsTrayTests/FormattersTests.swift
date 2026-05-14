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
        #expect(Formatters.formatTokens(0) == "0.00M")
    }

    @Test func belowOneMillion_twoDecimals() {
        #expect(Formatters.formatTokens(1) == "0.00M")
        #expect(Formatters.formatTokens(12_345) == "0.01M")
        #expect(Formatters.formatTokens(284_000) == "0.28M")
        #expect(Formatters.formatTokens(999_999) == "1.00M")
    }

    @Test func oneMillion() {
        #expect(Formatters.formatTokens(1_000_000) == "1.0M")
    }

    @Test func millions_oneDecimal() {
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

    // ToTally uses Σ (U+03A3, Greek capital sigma) to represent "sum of usage"
    // across all harnesses. All menu bar title tests must use Σ, not π.

    @Test func combined() {
        #expect(
            Formatters.menuBarTitle(tokens: 284_000, cost: 1.42, mode: .combinedTokensCost)
            == "Σ 0.28M · $1.42"
        )
    }

    @Test func tokensOnly() {
        #expect(
            Formatters.menuBarTitle(tokens: 284_000, cost: 1.42, mode: .tokensOnly)
            == "Σ 0.28M"
        )
    }

    @Test func costOnly() {
        #expect(
            Formatters.menuBarTitle(tokens: 284_000, cost: 1.42, mode: .costOnly)
            == "Σ $1.42"
        )
    }

    @Test func iconOnly() {
        #expect(
            Formatters.menuBarTitle(tokens: 284_000, cost: 1.42, mode: .iconOnly)
            == "Σ"
        )
    }

    @Test func combined_zeroData() {
        #expect(
            Formatters.menuBarTitle(tokens: 0, cost: 0, mode: .combinedTokensCost)
            == "Σ 0.00M · $0.00"
        )
    }
}

// MARK: - Paths

@Suite("Paths")
struct PathsTests {

    @Test func expandTilde() {
        let expanded = Paths.expandingTilde("~/.local/share/token-tally/events.db")
        #expect(!expanded.hasPrefix("~"))
        #expect(expanded.hasSuffix("/.local/share/token-tally/events.db"))
    }

    @Test func alreadyAbsolute() {
        let path = "/Users/test/.local/share/token-tally/events.db"
        #expect(Paths.expandingTilde(path) == path)
    }

    @Test func analyticsFolder_isParentDirectory() {
        // analyticsFolder returns the directory containing the DB file.
        let folder = Paths.analyticsFolder(
            forDatabasePath: "~/.local/share/token-tally/events.db"
        )
        #expect(folder.path.hasSuffix("/.local/share/token-tally"))
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
