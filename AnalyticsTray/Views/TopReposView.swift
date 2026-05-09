import SwiftUI

/// Lists the top five repositories by cost for the rolling 7-day window.
///
/// Repository labels are derived from sessions in priority order:
/// `owner/name` → `repo_remote` → `cwd` → `"unknown"`.
/// All cases render the same way; "unknown" is treated as a valid label.
struct TopReposView: View {

    let repos: [RepoBreakdown]

    // MARK: - Body

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            sectionLabel("Top Repos")
            if repos.isEmpty {
                placeholderRow("No repository data")
            } else {
                ForEach(repos) { repo in
                    repoRow(repo)
                }
            }
        }
    }

    // MARK: - Row

    /// Single row: repo label (truncated in the middle if long) + cost on the right.
    ///
    /// Middle truncation preserves both the owner prefix and the repo-name suffix
    /// which together are the most identifying parts of an "owner/name" label.
    private func repoRow(_ repo: RepoBreakdown) -> some View {
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
    }

    // MARK: - Helpers

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
