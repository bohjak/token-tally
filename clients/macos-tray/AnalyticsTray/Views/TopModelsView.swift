import SwiftUI

/// Lists the top five models by cost for the configured time window.
///
/// Model IDs come from `llm_messages.model_id` (preferred) or `turns.model_id`
/// (fallback). Rows that still cannot be attributed display "unattributed".
struct TopModelsView: View {

    let models: [ModelBreakdown]
    /// Short label appended to the section heading, e.g. "Today" or "7 days".
    let periodLabel: String

    private var totalCost: Double {
        models.reduce(0) { $0 + max($1.costUSD, 0) }
    }

    // MARK: - Body

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            sectionLabel("Top Models", period: periodLabel)
            if models.isEmpty {
                placeholderRow("No model data")
            } else {
                ForEach(models) { model in
                    modelRow(model, share: share(for: model))
                }
            }
        }
    }

    // MARK: - Row

    /// Single row: proportional background fill + model name + cost.
    ///
    /// Middle truncation is intentional — the suffix of a model ID often carries
    /// the version number (e.g. "claude-opus-4-5") which is more distinguishing
    /// than the prefix.
    private func modelRow(_ model: ModelBreakdown, share: Double) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(model.modelID)
                .font(.caption)
                .lineLimit(1)
                .truncationMode(.middle)
                .foregroundStyle(.primary)

            Spacer(minLength: 8)

            Text(Formatters.formatCost(model.costUSD))
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(alignment: .leading) {
            GeometryReader { proxy in
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .fill(Color.accentColor.opacity(0.16))
                    .frame(width: proxy.size.width * share)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
        .accessibilityLabel("\(model.modelID), \(Formatters.formatCost(model.costUSD)), \(Int((share * 100).rounded())) percent of shown model cost")
    }

    // MARK: - Helpers

    private func share(for model: ModelBreakdown) -> Double {
        guard totalCost > 0 else { return 0 }
        return min(max(model.costUSD / totalCost, 0), 1)
    }

    private func placeholderRow(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.tertiary)
    }

    private func sectionLabel(_ text: String, period: String) -> some View {
        Text("\(text.uppercased()) · \(period.uppercased())")
            .font(.caption2)
            .fontWeight(.semibold)
            .foregroundStyle(.secondary)
            .tracking(0.5)
    }
}
