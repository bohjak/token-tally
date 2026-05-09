import SwiftUI

/// Lists the top five repositories by cost for the rolling 7-day window.
///
/// Repository labels are derived from sessions in priority order:
/// `owner/name` → `repo_remote` → `cwd` → `"unknown"`.
/// All cases render the same way; "unknown" is treated as a valid label.
struct TopReposView: View {

    let repos: [RepoBreakdown]

    private var totalCost: Double {
        repos.reduce(0) { $0 + max($1.costUSD, 0) }
    }

    // MARK: - Body

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            sectionLabel("Top Repos")
            if repos.isEmpty {
                placeholderRow("No repository data")
            } else {
                ForEach(repos) { repo in
                    repoRow(repo, share: share(for: repo))
                }
            }
        }
    }

    // MARK: - Row

    /// Single row: proportional background fill + repo label + cost.
    ///
    /// Middle truncation preserves both the owner prefix and the repo-name suffix
    /// which together are the most identifying parts of an "owner/name" label.
    private func repoRow(_ repo: RepoBreakdown, share: Double) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(repo.repo)
                .font(.caption)
                .lineLimit(1)
                .truncationMode(.middle)
                .foregroundStyle(.primary)

            Spacer(minLength: 8)

            Text(Formatters.formatCost(repo.costUSD))
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(alignment: .leading) {
            GeometryReader { proxy in
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .fill(Color.accentColor.opacity(0.12))
                    .frame(width: proxy.size.width * share)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
        .accessibilityLabel("\(repo.repo), \(Formatters.formatCost(repo.costUSD)), \(Int((share * 100).rounded())) percent of shown repository cost")
    }

    // MARK: - Helpers

    private func share(for repo: RepoBreakdown) -> Double {
        guard totalCost > 0 else { return 0 }
        return min(max(repo.costUSD / totalCost, 0), 1)
    }

    private func placeholderRow(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.tertiary)
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text.uppercased())
            .font(.caption2)
            .fontWeight(.semibold)
            .foregroundStyle(.secondary)
            .tracking(0.5)
    }
}
