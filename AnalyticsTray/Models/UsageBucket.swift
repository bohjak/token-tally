/// A rolled-up aggregate of usage metrics for a time window (today, this week, etc.).
///
/// **Token accounting**
/// Only `billableTokens` (`input_tokens + output_tokens`) should appear in
/// menu bar labels and summary cards. `cachedTokens` (`cache_read_tokens +
/// cache_write_tokens`) is retained for context and future display, but must
/// never be mixed into the primary token total shown to the user.
struct UsageBucket: Equatable {

    /// Total cost in USD for the window.
    let costUSD: Double

    /// Non-cached tokens that affect cost: `input_tokens + output_tokens`.
    let billableTokens: Int64

    /// Cache-read and cache-write tokens. Tracked separately; not shown in
    /// primary displays to avoid inflating the perceived token count.
    let cachedTokens: Int64

    /// Number of distinct turns that had at least one LLM message in the window.
    let turns: Int64

    /// Number of distinct sessions that had at least one LLM message in the window.
    let sessions: Int64

    /// A bucket with all zeros. Useful as a safe default before the first load.
    static let zero = UsageBucket(
        costUSD: 0, billableTokens: 0, cachedTokens: 0, turns: 0, sessions: 0
    )

    /// True when there is no meaningful data in this bucket.
    var isEmpty: Bool {
        costUSD == 0 && billableTokens == 0 && turns == 0
    }
}
