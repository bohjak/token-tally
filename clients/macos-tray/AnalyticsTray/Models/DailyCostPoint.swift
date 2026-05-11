import Foundation

/// One day's worth of cost and token data, used in the 7-day bar chart.
///
/// `id` and `day` carry the same `Date` value (local-midnight). `Identifiable`
/// conformance is required by SwiftUI Charts; using the day itself as the ID
/// is safe because chart data never has two points for the same calendar day.
struct DailyCostPoint: Identifiable, Equatable {

    /// Stable identity for SwiftUI Charts. Equal to `day`.
    var id: Date { day }

    /// The calendar day (local midnight in the user's time zone).
    let day: Date

    /// Total cost in USD for this day.
    let costUSD: Double

    /// Non-cached billable tokens (`input_tokens + output_tokens`) for this day.
    let billableTokens: Int64
}
