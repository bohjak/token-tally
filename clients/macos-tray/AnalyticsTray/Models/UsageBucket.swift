/// A rolled-up aggregate of usage metrics for a time window (today, this week, etc.).
///
/// **Token accounting**
/// Only `billableTokens` (`input_tokens + output_tokens`) should appear in
/// menu bar labels and summary cards. `cachedTokens` (`cache_read_tokens +
/// cache_write_tokens`) is retained for context and future display, but must
/// never be mixed into the primary token total shown to the user.
///
/// **Cost accounting**
/// `costUSD` is computed from `cost_total_micros / 1_000_000.0` for messages
/// where `cost_source != 'unknown'`. Messages with `cost_source = 'unknown'`
/// have `cost_total_micros = 0` by schema invariant but are excluded explicitly
/// to make the accounting intent clear. Check `unpricedMessages` to know
/// whether `costUSD` is a complete total or a lower bound.
struct UsageBucket: Equatable {

    /// Total cost in USD, summing only messages with a known cost source.
    /// Excludes messages where `cost_source = 'unknown'`.
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

    /// Count of messages where `cost_source = 'unknown'`.
    ///
    /// These messages are excluded from `costUSD`. A non-zero value means
    /// `costUSD` is a lower bound rather than the complete total — the UI must
    /// display a caveat such as "+ N unpriced messages" so users are not misled
    /// into thinking zero-cost messages are free.
    let unpricedMessages: Int64

    // Custom init (suppresses the synthesized memberwise initializer) so
    // `unpricedMessages` can be given a default of `0`. This keeps existing
    // callsites that do not yet provide the field compilable without changes.
    init(
        costUSD: Double,
        billableTokens: Int64,
        cachedTokens: Int64 = 0,
        turns: Int64,
        sessions: Int64,
        unpricedMessages: Int64 = 0
    ) {
        self.costUSD = costUSD
        self.billableTokens = billableTokens
        self.cachedTokens = cachedTokens
        self.turns = turns
        self.sessions = sessions
        self.unpricedMessages = unpricedMessages
    }

    /// A bucket with all zeros. Useful as a safe default before the first load.
    static let zero = UsageBucket(
        costUSD: 0, billableTokens: 0, cachedTokens: 0,
        turns: 0, sessions: 0, unpricedMessages: 0
    )

    /// True when there is no meaningful data in this bucket.
    var isEmpty: Bool {
        costUSD == 0 && billableTokens == 0 && turns == 0
    }
}
