/// Per-model cost breakdown for the "Top models" list.
///
/// `model_id` is sourced from `llm_messages.model_id` (preferred) with a
/// fallback to `turns.model_id`; rows with no model recorded use "unknown".
struct ModelBreakdown: Identifiable, Equatable {

    /// The model identifier string, e.g. "claude-opus-4-5". Doubles as the
    /// stable identity for SwiftUI list rendering.
    var id: String { modelID }

    let modelID: String

    /// Total cost in USD attributed to this model in the query window.
    let costUSD: Double

    /// Billable non-cached tokens for this model.
    let billableTokens: Int64

    /// Number of distinct turns that used this model.
    let turns: Int64
}
