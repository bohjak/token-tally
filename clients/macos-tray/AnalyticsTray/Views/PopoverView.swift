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

        // Forward store changes so SwiftUI re-renders when refreshes transition
        // between idle/loading and loaded/error states.
        store.objectWillChange
            .sink { [weak self] _ in self?.objectWillChange.send() }
            .store(in: &cancellables)

        // Broadcast title updates so StatusItemController can update the label
        // without a direct reference to the store.
        //
        // dropFirst() suppresses the initial placeholder that AnalyticsStore
        // emits before its first real refresh. StatusItemController sets its
        // own "Σ …" placeholder at init time, which should remain
        // visible until actual data arrives.
        store.$menuBarTitle
            .dropFirst()
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
    /// Posted by `AnalyticsEnvironment` whenever `AnalyticsStore.menuBarTitle`
    /// changes. `userInfo["title"]` contains the new `String` value.
    /// `StatusItemController` observes this to update the `NSStatusItem` label.
    static let analyticsMenuBarTitleChanged = Notification.Name(
        "com.token-tally.menuBarTitleChanged"
    )
}

// MARK: - PopoverView

/// Root SwiftUI view hosted inside `NSPopover` via `NSHostingController`.
///
/// Responsibilities:
/// - Own an `AnalyticsEnvironment` (settings + store) for the popover lifetime.
/// - Trigger a refresh when the popover appears.
/// - Switch over `StoreState` to show the appropriate content section.
/// - Show header controls (settings, quit) and a footer action row.
@MainActor
struct PopoverView: View {

    @ObservedObject private var env: AnalyticsEnvironment
    private let closePopover: @MainActor () -> Void

    init(closePopover: @escaping @MainActor () -> Void = {}) {
        env = AnalyticsEnvironment()
        self.closePopover = closePopover
    }

    init(
        environment: AnalyticsEnvironment,
        closePopover: @escaping @MainActor () -> Void = {}
    ) {
        env = environment
        self.closePopover = closePopover
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            headerBar
            Divider()
            contentArea
                .frame(maxWidth: .infinity)
        }
        .frame(width: 280)
        .onAppear {
            env.store.refreshOnPopoverOpen()
        }
    }

    // MARK: - Header bar

    private var headerBar: some View {
        HStack {
            Text("ToTally")
                .font(.headline)
            Spacer()
            // Compact spinner alongside the title when a background refresh is
            // running and we already have data to display (avoids showing the
            // spinner + full loading view simultaneously).
            if case .loading = env.store.state, env.store.lastSnapshot != nil {
                ProgressView()
                    .controlSize(.small)
            }

            Button(action: openSettings) {
                Image(systemName: "gear")
                    .imageScale(.medium)
            }
            .help("Settings")

            Button(action: quitApp) {
                Image(systemName: "power")
                    .imageScale(.medium)
            }
            .help("Quit ToTally")
        }
        .buttonStyle(.plain)
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 14)
        .padding(.top, 14)
        .padding(.bottom, 10)
    }

    // MARK: - Main content area

    @ViewBuilder
    private var contentArea: some View {
        switch env.store.state {

        case .idle:
            loadingPlaceholder

        case .loading:
            if let snapshot = env.store.lastSnapshot {
                // Prefer stale data over a blank loading screen.
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

            // 0. Degraded-schema banner: shown when the database schema is newer
            // than this build's max-known version but still within the read
            // window. The tray continues reading what it understands; the banner
            // tells the user to run `make install` to get a matching build.
            if snapshot.schemaIsDegraded {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.down.circle")
                        .imageScale(.small)
                    Text("Database schema is newer than this app — run `make install` to update ToTally")
                        .fixedSize(horizontal: false, vertical: true)
                }
                .font(.caption2)
                .foregroundStyle(.orange)
                .padding(.horizontal, 2)
            }

            // 1. Today summary.
            SummaryCard(
                title: "Today",
                bucket: snapshot.today,
                showTurns: true,
                backgroundChartValues: snapshot.intradayUsage.map(\.costUSD)
            )

            // 2. This week summary.
            SummaryCard(
                title: "Past 7 days",
                bucket: snapshot.week,
                showTurns: false,
                backgroundChartValues: Array(snapshot.dailyCost.suffix(7)).map(\.costUSD),
                backgroundChartTrimsZeroEdges: false,
                backgroundChartSmoothingWindow: 1
            )

            // 3. 7-day cost chart.
            if !snapshot.dailyCost.isEmpty {
                DailyCostChartView(points: snapshot.dailyCost)
            }

            // 4. Top models.
            if !snapshot.topModels.isEmpty {
                TopModelsView(models: snapshot.topModels)
            }

            // 5. Top repositories.
            if !snapshot.topRepos.isEmpty {
                TopReposView(repos: snapshot.topRepos)
            }

            // 6. Unpriced-messages caveat (reader expectation #4 from docs/schema.md).
            // Shown when messages with cost_source='unknown' exist in the week window so
            // users are not misled into interpreting a zero-cost entry as "free".
            if snapshot.unpricedMessages > 0 {
                HStack(spacing: 4) {
                    Image(systemName: "exclamationmark.circle")
                        .imageScale(.small)
                    Text("\(snapshot.unpricedMessages) unpriced message\(snapshot.unpricedMessages == 1 ? "" : "s") excluded from cost totals")
                        .fixedSize(horizontal: false, vertical: true)
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 2)
            }

            // 7. Footer actions.
            footerActions

        }
        .padding(12)
    }

    // MARK: - Footer actions

    private var footerActions: some View {
        HStack(spacing: 8) {
            Button(action: openExplorer) {
                Label("Open Explorer", systemImage: "globe")
            }
            .help("Open web analytics explorer")

            Spacer()
        }
        .buttonStyle(.plain)
        .font(.caption)
        .foregroundStyle(.secondary)
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

    // MARK: - Actions

    private func openSettings() {
        SettingsWindowController.show(settings: env.settings) {
            env.store.refresh()
        }
        closePopover()
    }

    private func openExplorer() {
        let dbPath = env.settings.databasePath
        let homeDirectory = FileManager.default.homeDirectoryForCurrentUser.path
        let installedCliPath = "\(homeDirectory)/.local/share/token-tally/bin/token-tally"

        // Prefer the absolute SEA binary installed by scripts/install-store.sh.
        // Menu bar apps launched by Finder/login services do not inherit the
        // user's interactive shell PATH, so `/usr/bin/env token-tally` is not
        // reliable even when `token-tally` works in Terminal.
        let process = Process()
        if FileManager.default.isExecutableFile(atPath: installedCliPath) {
            process.executableURL = URL(fileURLWithPath: installedCliPath)
            process.arguments = ["explore", "--db", dbPath]
        } else {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = ["token-tally", "explore", "--db", dbPath]
            var environment = ProcessInfo.processInfo.environment
            environment["PATH"] = "\(homeDirectory)/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
            process.environment = environment
        }

        // Fire-and-forget: the explorer server is intentionally long-lived
        // (it exits after its own idle timeout or on --stop). Redirect stdio
        // to /dev/null so the child inherits no open file descriptors from
        // the tray process. We do NOT call waitUntilExit().
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
        } catch {
            let alert = NSAlert()
            alert.messageText = "token-tally not found"
            alert.informativeText =
                "The token-tally CLI could not be launched.\n\n" +
                "Run 'make install' with the macOS tray component selected " +
                "to install it, then relaunch the app."
            alert.alertStyle = .warning
            alert.addButton(withTitle: "OK")
            alert.runModal()
        }
    }

    private func quitApp() {
        NSApplication.shared.terminate(nil)
    }
}
