import Foundation

/// One intraday aggregate bucket used for the Today-card decorative sparkline.
///
/// Values are derived at query time from `llm_messages`; they are never stored
/// back into the analytics database.
struct IntradayUsagePoint: Identifiable, Equatable {

    /// Stable identity for SwiftUI lists/charts. Equal to `bucketStart`.
    var id: Date { bucketStart }

    /// Start of the local-time bucket, rounded down to the configured interval.
    let bucketStart: Date

    /// Total USD cost in this bucket.
    let costUSD: Double

    /// Non-cached tokens in this bucket (`input_tokens + output_tokens`).
    let billableTokens: Int64
}
