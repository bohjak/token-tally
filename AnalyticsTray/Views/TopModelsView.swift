import SwiftUI

/// Lists the top five models by cost for the rolling 7-day window.
///
/// Model IDs come from `llm_messages.model_id` (preferred) or `turns.model_id`
/// (fallback). Rows whose model is unknown display "unknown" — this is a valid
/// value from the query layer and renders identically to any other model name.
struct TopModelsView: View {

    let models: [ModelBreakdown]

    // MARK: - Body

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            sectionLabel("Top Models")
            if models.isEmpty {
                placeholderRow("No model data")
            } else {
                ForEach(models) { model in
                    modelRow(model)
                }
            }
        }
    }

    // MARK: - Row

    /// Single row: model name (truncated in the middle if long) + cost on the right.
    ///
    /// Middle truncation is intentional — the suffix of a model ID often carries
    /// the version number (e.g. "claude-opus-4-5") which is more distinguishing
    /// than the prefix.
    private func modelRow(_ model: ModelBreakdown) -> some View {
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
