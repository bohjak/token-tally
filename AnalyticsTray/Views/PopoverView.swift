import SwiftUI
import AppKit
import Combine

// MARK: - AnalyticsEnvironment

/// Shared container for `AppSettings` and `AnalyticsStore`.
///
/// Because `PopoverController` instantiates `PopoverView()` with no arguments,
/// `PopoverView` must own the store internally. Using a single wrapper class
/// lets both objects share the same `AppSettings` instance without the
/// chicken-and-egg problem of initialising one `@StateObject` from another.
///
/// `PopoverController` creates `PopoverView` once during its own `init()`, so
/// this environment lives for the full app lifetime — exactly what we want.
@MainActor
final class AnalyticsEnvironment: ObservableObject {
    let settings: AppSettings
    let store: AnalyticsStore

    private var cancellables = Set<AnyCancellable>()

    init() {
        let s = AppSettings()
        settings = s
        store = AnalyticsStore(settings: s)

        // PopoverView observes this environment object, not the nested store
        // directly. Forward store changes so SwiftUI re-renders when refreshes
        // move from idle/loading to loaded/error states.
        store.objectWillChange
            .sink { [weak self] _ in self?.objectWillChange.send() }
            .store(in: &cancellables)

        // Broadcast title updates from the store itself, not from PopoverView's
        // appearance lifecycle. This lets startup refreshes update the menu bar
        // before the user opens the popover for the first time.
        store.$menuBarTitle
            .removeDuplicates()
            .sink { title in
                NotificationCenter.default.post(
                    name: .analyticsMenuBarTitleChanged,
                    object: nil,
                    userInfo: ["title": title]
                )
            }
            .store(in: &cancellables)
    }

    func refreshOnStartup() {
        store.refresh()
    }
}

// MARK: - Notification name

extension Notification.Name {
    /// Posted by `PopoverView` whenever `AnalyticsStore.menuBarTitle` changes.
    ///
    /// `userInfo["title"]` contains the new `String` value. `StatusItemController`
    /// (wired up in T7 or later) can observe this to update the `NSStatusItem`
    /// label without needing a direct reference to the store.
    static let analyticsMenuBarTitleChanged = Notification.Name(
        "com.pi.analyticstray.menuBarTitleChanged"
    )
}

// MARK: - PopoverView

/// The root SwiftUI view hosted inside `NSPopover` via `NSHostingController`.
///
/// Responsibilities:
/// - Create and own an `AnalyticsStore` (via `AnalyticsEnvironment`).
/// - Trigger a refresh whenever the popover appears.
/// - Switch over `StoreState` to show the appropriate content.
/// - Provide footer actions: Refresh, Open Analytics Folder, Settings, Quit.
/// - Broadcast menu bar title changes via `NotificationCenter` for `StatusItemController`.
@MainActor
struct PopoverView: View {

    @ObservedObject private var env: AnalyticsEnvironment

    init() {
        env = AnalyticsEnvironment()
    }

    init(environment: AnalyticsEnvironment) {
        env = environment
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            headerBar
            Divider()
            contentArea
                .frame(maxWidth: .infinity)
            Divider()
            footerBar
        }
        .frame(width: 280)
        // Trigger data load whenever the popover becomes visible.
        .onAppear {
            env.store.refreshOnPopoverOpen()
        }
    }

    // MARK: - Header bar

    private var headerBar: some View {
        HStack {
            Text("pi Analytics")
                .font(.headline)
            Spacer()
            // Show a compact spinner alongside the title when a refresh is running
            // and we already have data to display (avoids the spinner + full loading
            // view appearing at the same time).
            if case .loading = env.store.state, env.store.lastSnapshot != nil {
                ProgressView()
                    .controlSize(.small)
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 14)
        .padding(.bottom, 10)
    }

    // MARK: - Main content area

    @ViewBuilder
    private var contentArea: some View {
        switch env.store.state {

        case .idle:
            // Before the first refresh; show a neutral loading view.
            loadingPlaceholder

        case .loading:
            // A refresh is in flight.
            if let snapshot = env.store.lastSnapshot {
                // Prefer stale data over a blank loading screen — less disorienting.
                summarySection(snapshot)
            } else {
                loadingPlaceholder
            }

        case .loaded(let snapshot):
            summarySection(snapshot)

        case .emptyDatabase:
            EmptyStateView(kind: .emptyDatabase, onOpenSettings: openSettings)

        case .missingDatabase(let path):
            EmptyStateView(kind: .missingDatabase(path: path), onOpenSettings: openSettings)

        case .schemaMismatch(let detail):
            EmptyStateView(kind: .schemaMismatch(detail: detail), onOpenSettings: openSettings)

        case .queryError(let message):
            ErrorStateView(message: message, onRefresh: { env.store.refresh() })
        }
    }

    // MARK: - Summary section (loaded state)

    private func summarySection(_ snapshot: UsageSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            SummaryCard(
                title: "Today",
                bucket: snapshot.today,
                showTurns: true,
                backgroundChartValues: snapshot.intradayUsage.map(\.costUSD)
            )
            SummaryCard(
                title: "Past 7 days",
                bucket: snapshot.week,
                showTurns: false,
                backgroundChartValues: Array(snapshot.dailyCost.suffix(7)).map(\.costUSD),
                backgroundChartTrimsZeroEdges: false,
                backgroundChartSmoothingWindow: 1
            )

            // 7-day cost chart — always shown when we have loaded data, even if
            // all bars are zero (sparse DB / new install).  fillMissingDays in
            // AnalyticsQueries guarantees the array has exactly 7 entries.
            if !snapshot.dailyCost.isEmpty {
                DailyCostChartView(points: snapshot.dailyCost)
            }

            // Top models — omit the section entirely when the array is empty
            // (edge case: data in bucket but no messages with model attribution).
            if !snapshot.topModels.isEmpty {
                TopModelsView(models: snapshot.topModels)
            }

            // Top repos — same defensive guard.
            if !snapshot.topRepos.isEmpty {
                TopReposView(repos: snapshot.topRepos)
            }
        }
        .padding(12)
    }

    // MARK: - Loading placeholder

    private var loadingPlaceholder: some View {
        VStack(spacing: 8) {
            ProgressView()
                .controlSize(.regular)
            Text("Loading…")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
    }

    // MARK: - Footer bar

    private var footerBar: some View {
        HStack(spacing: 6) {
            // Refresh
            Button(action: { env.store.refresh() }) {
                Image(systemName: "arrow.clockwise")
                    .imageScale(.medium)
            }
            .help("Refresh data now")

            // Open the analytics folder in Finder
            Button(action: openAnalyticsFolder) {
                Image(systemName: "folder")
                    .imageScale(.medium)
            }
            .help("Open analytics folder in Finder")

            Spacer()

            // Settings — placeholder until T7 implements SettingsView
            Button(action: openSettings) {
                Image(systemName: "gear")
                    .imageScale(.medium)
            }
            .help("Settings")

            Divider()
                .frame(height: 12)

            // Quit
            Button("Quit") {
                NSApplication.shared.terminate(nil)
            }
        }
        .buttonStyle(.plain)
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    // MARK: - Actions

    private func openAnalyticsFolder() {
        let url = Paths.analyticsFolder(forDatabasePath: env.settings.databasePath)
        NSWorkspace.shared.open(url)
    }

    private func openSettings() {
        // Open the settings window. The popover stays open (the user can dismiss
        // it separately); the settings window is brought to the foreground.
        SettingsWindowController.show(settings: env.settings)
    }
}
