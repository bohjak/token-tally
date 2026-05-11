import Foundation
import AppKit

/// Formatting helpers for costs, token counts, and menu bar labels.
///
/// All functions are pure; no mutable state, no singletons (the two lazily
/// created formatters are thread-safe after initialisation).
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
    /// Only `input_tokens + output_tokens` should be passed here; cache tokens
    /// must not be included in the primary display (see UsageBucket comment).
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

    // MARK: - Menu bar title (plain string)

    /// Builds the plain string shown in the `NSStatusItem` label.
    ///
    /// Uses `Σ` (U+03A3, Greek capital sigma) as the compact glyph representing
    /// "sum of usage" across all harnesses. This replaces the Pi-specific `π`
    /// from the original single-harness version.
    ///
    /// Examples:
    /// ```
    /// menuBarTitle(tokens: 284_000, cost: 1.42, mode: .combinedTokensCost)
    ///     → "Σ 284k · $1.42"
    ///
    /// menuBarTitle(tokens: 284_000, cost: 1.42, mode: .tokensOnly)
    ///     → "Σ 284k"
    ///
    /// menuBarTitle(tokens: 284_000, cost: 1.42, mode: .costOnly)
    ///     → "Σ $1.42"
    ///
    /// menuBarTitle(tokens: 284_000, cost: 1.42, mode: .iconOnly)
    ///     → "Σ"
    /// ```
    static func menuBarTitle(
        tokens: Int64,
        cost: Double,
        mode: MenuBarDisplayMode
    ) -> String {
        switch mode {
        case .combinedTokensCost:
            return "Σ \(formatTokens(tokens)) · \(formatCost(cost))"
        case .tokensOnly:
            return "Σ \(formatTokens(tokens))"
        case .costOnly:
            return "Σ \(formatCost(cost))"
        case .iconOnly:
            return "Σ"
        }
    }

    // MARK: - Menu bar attributed title

    /// Builds an `NSAttributedString` for the `NSStatusItem` title.
    ///
    /// Applies `NSFont.monospacedDigitSystemFont` to the entire string so all
    /// digits render at a fixed column width. Without this, the status bar label
    /// jitters horizontally as digit counts change: "9k" → "10k" widens by one
    /// proportional digit, causing everything to the right of the label to shift.
    /// Fixed-width digits eliminate the jitter while keeping the Σ glyph and
    /// letter characters in the regular system font style.
    ///
    /// `NSFont.systemFontSize` matches the standard AppKit control font size
    /// and looks correct alongside other macOS status bar items.
    static func menuBarAttributedTitle(
        tokens: Int64,
        cost: Double,
        mode: MenuBarDisplayMode
    ) -> NSAttributedString {
        let plain = menuBarTitle(tokens: tokens, cost: cost, mode: mode)
        // monospacedDigitSystemFont uses the system font with tabular (fixed-width)
        // number spacing applied. This is equivalent to the font feature pair
        // kNumberSpacingType / kMonospacedNumbersSelector but more convenient.
        let font = NSFont.monospacedDigitSystemFont(
            ofSize: NSFont.systemFontSize,
            weight: .regular
        )
        return NSAttributedString(string: plain, attributes: [.font: font])
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
