/// Per-repository cost breakdown for the "Top repos" list.
///
/// `repo` is derived from `sessions`: prefers `repo_owner/repo_name`, then
/// `repo_remote`, then `cwd`, then "unknown". Rows that cannot be attributed
/// to any repository are grouped under "unknown".
struct RepoBreakdown: Identifiable, Equatable {

    /// Human-readable repository label (e.g. "owner/name"). Doubles as the
    /// stable identity for SwiftUI list rendering.
    var id: String { repo }

    let repo: String

    /// Total cost in USD attributed to this repository in the query window.
    let costUSD: Double

    /// Billable non-cached tokens for this repository.
    let billableTokens: Int64

    /// Number of distinct sessions in this repository.
    let sessions: Int64
}
