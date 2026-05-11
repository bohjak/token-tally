import Foundation
import Combine

// MARK: - StoreState

/// All possible states of `AnalyticsStore`.
///
/// The UI maps each case to a distinct view:
/// - `.idle` / `.loading` → show last-known data (or a spinner on first load)
/// - `.loaded` → normal summary + chart
/// - `.emptyDatabase` → "No usage data yet."
/// - `.missingDatabase` → "No ToTally analytics database found."
/// - `.schemaMismatch` → "Unsupported analytics database schema."
/// - `.queryError` → compact error text with a Refresh button
enum StoreState: Equatable {
    /// Before the first refresh attempt.
    case idle
    /// A refresh is in flight.
    case loading
    /// Latest snapshot loaded successfully.
    case loaded(UsageSnapshot)
    /// Database file does not exist at the configured path.
    case missingDatabase(path: String)
    /// Database exists and schema is valid, but contains no usage rows.
    case emptyDatabase
    /// Required tables or columns are absent from the schema.
    case schemaMismatch(detail: String)
    /// Open or query failure (not covered by the above specialised cases).
    case queryError(String)
}

// MARK: - AnalyticsStore

/// Observable state layer for all analytics data shown in the popover and menu bar.
///
/// **Thread safety:** every `@Published` mutation happens on the main actor.
/// SQLite work is dispatched to a detached background task so the main thread
/// is never blocked.
///
/// **Refresh triggers:**
/// 1. Popover opens → `refreshOnPopoverOpen()`
/// 2. User taps Refresh → `refresh()`
/// 3. Background timer → fires every `settings.refreshInterval` seconds
/// 4. Settings change (path or interval) → cancels timer, re-triggers immediately
@MainActor
final class AnalyticsStore: ObservableObject {

    // MARK: Published state

    /// Current store state. UI views switch over this to decide what to render.
    @Published private(set) var state: StoreState = .idle

    /// The most recently *successfully* loaded snapshot.
    ///
    /// Preserved across subsequent loads so the menu bar label and popover
    /// can continue showing stale-but-useful numbers while a refresh is in flight
    /// or after a transient error.
    @Published private(set) var lastSnapshot: UsageSnapshot?

    /// The string to display in `NSStatusItem`. Derived from `lastSnapshot` and
    /// `settings.menuBarDisplayMode`; updated after every state transition.
    ///
    /// `StatusItemController.setTitle(_:)` should observe this property.
    @Published private(set) var menuBarTitle: String = "Σ …"

    // MARK: Private

    private let settings: AppSettings
    private let timer = AnalyticsRefreshTimer()

    /// The task running the current refresh. Cancelled before starting a new one
    /// so rapid calls don't pile up parallel DB sessions.
    private var currentRefreshTask: Task<Void, Never>?

    /// Combine subscriptions watching settings changes.
    private var cancellables = Set<AnyCancellable>()

    // MARK: Init

    init(settings: AppSettings) {
        self.settings = settings
        subscribeToSettingsChanges()
        startTimer()
    }

    // MARK: Public API

    /// Trigger an immediate refresh, cancelling any in-flight refresh first.
    func refresh() {
        currentRefreshTask?.cancel()
        currentRefreshTask = Task { await performRefresh() }
    }

    /// Called when the popover becomes visible.
    ///
    /// Currently identical to `refresh()`. A minimum-interval guard can be
    /// added here if DB reads become expensive on very large databases.
    func refreshOnPopoverOpen() {
        refresh()
    }

    // MARK: Private — refresh

    private func performRefresh() async {
        guard !Task.isCancelled else { return }

        state = .loading
        updateMenuBarTitle()

        // Capture the path as a value so the detached task doesn't touch self.
        let path = settings.databasePath

        // Run the blocking SQLite work entirely off the main thread.
        // Task.detached does not inherit the caller's actor isolation.
        let result: Result<UsageSnapshot, Error> = await Task.detached(priority: .userInitiated) {
            Result { try AnalyticsQueries.loadSnapshot(databasePath: path) }
        }.value

        // Ignore the result if the task was cancelled while the DB was being read.
        guard !Task.isCancelled else { return }

        applyResult(result)
        updateMenuBarTitle()
    }

    private func applyResult(_ result: Result<UsageSnapshot, Error>) {
        switch result {
        case .success(let snapshot):
            lastSnapshot = snapshot
            // Report emptyDatabase only when *both* today and week are blank,
            // so a brand-new install with zero rows gets a clear message.
            state = (snapshot.today.isEmpty && snapshot.week.isEmpty)
                ? .emptyDatabase
                : .loaded(snapshot)

        case .failure(let error):
            guard let sqliteError = error as? SQLiteError else {
                state = .queryError(error.localizedDescription)
                return
            }
            switch sqliteError {
            case .missingDatabase(let p):
                state = .missingDatabase(path: p)
            case .schemaMismatch(let detail):
                state = .schemaMismatch(detail: detail)
            case .openFailed, .queryFailed:
                state = .queryError(sqliteError.localizedDescription)
            }
        }
    }

    // MARK: Private — menu bar title

    private func updateMenuBarTitle() {
        // Prefer last-known values so the label never flickers to "Σ …" during
        // a background refresh.
        if let snapshot = lastSnapshot {
            menuBarTitle = Formatters.menuBarTitle(
                tokens: snapshot.today.billableTokens,
                cost: snapshot.today.costUSD,
                mode: settings.menuBarDisplayMode
            )
            return
        }

        // No snapshot yet — show a placeholder appropriate to the current state.
        switch state {
        case .idle, .loading:
            menuBarTitle = "Σ …"
        case .missingDatabase, .emptyDatabase, .schemaMismatch, .queryError:
            // Error on first load (no previous snapshot to show).
            menuBarTitle = "Σ —"
        case .loaded:
            // Should not reach here because lastSnapshot is set before .loaded,
            // but handle gracefully.
            menuBarTitle = "Σ"
        }
    }

    // MARK: Private — timer

    private func startTimer() {
        Task {
            await timer.start(interval: settings.refreshInterval) { [weak self] in
                // The closure is @Sendable; self is @MainActor so the await hops
                // to the main actor automatically.
                await self?.performRefresh()
            }
        }
    }

    private func restartTimer() {
        Task { await timer.cancel() }
        startTimer()
    }

    // MARK: Private — settings observation

    private func subscribeToSettingsChanges() {
        // When the database path changes: cancel the current refresh, restart
        // the timer, and trigger an immediate refresh against the new path.
        settings.$databasePath
            .dropFirst()            // skip the initial value emitted on subscription
            .removeDuplicates()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                guard let self else { return }
                self.restartTimer()
                self.refresh()
            }
            .store(in: &cancellables)

        // When the refresh interval changes: just restart the timer at the new rate.
        settings.$refreshInterval
            .dropFirst()
            .removeDuplicates()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                self?.restartTimer()
            }
            .store(in: &cancellables)

        // When the display mode changes: recompute the menu bar title without a
        // full DB refresh (the underlying numbers haven't changed).
        settings.$menuBarDisplayMode
            .dropFirst()
            .removeDuplicates()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                self?.updateMenuBarTitle()
            }
            .store(in: &cancellables)
    }
}
