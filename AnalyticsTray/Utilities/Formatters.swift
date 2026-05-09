import Foundation

/// Formatting helpers for costs, token counts, and menu bar labels.
///
/// All functions are pure; no state, no singletons (except the two lazily
/// created `NumberFormatter`s, which are thread-safe after initialisation).
enum Formatters {

    // MARK: - Cost

    /// Formats a USD cost for display.
    ///
    /// Examples:
    /// ```
    /// formatCost(0)      → "$0.00"
    /// formatCost(1.42)   → "$1.42"
    /// formatCost(10.005) → "$10.01"  (rounds half-up)
    /// formatCost(0.001)  → "$0.00"
    /// ```
    static func formatCost(_ usd: Double) -> String {
        costFormatter.string(from: NSNumber(value: usd)) ?? "$\(usd)"
    }

    // MARK: - Tokens

    /// Formats a billable non-cached token count compactly.
    ///
    /// Examples:
    /// ```
    /// formatTokens(0)          → "0"
    /// formatTokens(999)        → "999"
    /// formatTokens(1_000)      → "1.0k"
    /// formatTokens(1_200)      → "1.2k"
    /// formatTokens(12_345)     → "12k"
    /// formatTokens(284_000)    → "284k"
    /// formatTokens(1_000_000)  → "1.0M"
    /// formatTokens(1_250_000)  → "1.3M"
    /// ```
    static func formatTokens(_ count: Int64) -> String {
        switch count {
        case ..<1_000:
            return "\(count)"
        case 1_000..<10_000:
            // One decimal place to distinguish e.g. 1.2k from 1.8k.
            let value = Double(count) / 1_000
            return String(format: "%.1fk", value)
        case 10_000..<1_000_000:
            // Round to nearest thousand; no decimal needed at this scale.
            let value = (count + 500) / 1_000
            return "\(value)k"
        default:
            // Millions — one decimal place.
            let value = Double(count) / 1_000_000
            return String(format: "%.1fM", value)
        }
    }

    // MARK: - Menu bar title

    /// Builds the string shown in the `NSStatusItem` label.
    ///
    /// Examples:
    /// ```
    /// menuBarTitle(tokens: 284_000, cost: 1.42, mode: .combinedTokensCost)
    ///     → "π 284k · $1.42"
    ///
    /// menuBarTitle(tokens: 284_000, cost: 1.42, mode: .tokensOnly)
    ///     → "π 284k"
    ///
    /// menuBarTitle(tokens: 284_000, cost: 1.42, mode: .iconOnly)
    ///     → "π"
    /// ```
    static func menuBarTitle(
        tokens: Int64,
        cost: Double,
        mode: MenuBarDisplayMode
    ) -> String {
        switch mode {
        case .combinedTokensCost:
            return "π \(formatTokens(tokens)) · \(formatCost(cost))"
        case .tokensOnly:
            return "π \(formatTokens(tokens))"
        case .iconOnly:
            return "π"
        }
    }

    // MARK: - Private

    private static let costFormatter: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "USD"
        f.currencySymbol = "$"
        // Always show exactly two decimal places so "$1.40" doesn't collapse to "$1.4".
        f.minimumFractionDigits = 2
        f.maximumFractionDigits = 2
        // Force en_US locale so the output is always "$1.42" regardless of the
        // user's system locale. Currency display is intentionally English/US-style
        // because the amounts are always in USD.
        f.locale = Locale(identifier: "en_US")
        return f
    }()
}
