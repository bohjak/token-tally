import Foundation

// MARK: - TopListsPeriod

/// Controls the time window used for the "Top Models" and "Top Repos" sections
/// in the tray popover.
enum TopListsPeriod: String, CaseIterable, Identifiable {
    /// Show data for calendar today (since local midnight).
    case today
    /// Show data for the rolling 7-day window (today + 6 prior days).
    case week7

    var id: String { rawValue }

    /// Human-readable label used in the Settings UI.
    var displayName: String {
        switch self {
        case .today: return "Today"
        case .week7: return "Past 7 days"
        }
    }

    /// Short label shown next to the section heading in the popover
    /// (e.g. "TOP MODELS · TODAY").
    var sectionLabel: String {
        switch self {
        case .today: return "Today"
        case .week7: return "7 days"
        }
    }
}

// MARK: - MenuBarDisplayMode

/// Controls what the `NSStatusItem` label shows.
enum MenuBarDisplayMode: String, CaseIterable, Identifiable {
    /// "Σ 0.28M · $1.42" — tokens and cost (default).
    case combinedTokensCost
    /// "Σ 0.28M" — tokens only.
    case tokensOnly
    /// "Σ $1.42" — cost only.
    case costOnly
    /// "Σ" — icon only; no numbers.
    case iconOnly

    var id: String { rawValue }

    /// Human-readable label used in the Settings UI.
    var displayName: String {
        switch self {
        case .combinedTokensCost: return "Tokens + cost"
        case .tokensOnly:         return "Tokens only"
        case .costOnly:           return "Cost only"
        case .iconOnly:           return "Icon only"
        }
    }
}

// MARK: - AppSettings

/// Persisted user preferences for ToTally. Backed by `UserDefaults`.
///
/// All keys are namespaced under `"com.token-tally."` to avoid collisions
/// with other apps that share the default `UserDefaults` suite.
///
/// `AnalyticsStore` reads `databasePath`, `refreshInterval`, and
/// `menuBarDisplayMode` directly. Changing `databasePath` or `refreshInterval`
/// triggers a store restart.
final class AppSettings: ObservableObject {

    // MARK: UserDefaults keys

    private enum Key {
        static let databasePath       = "com.token-tally.databasePath"
        static let refreshInterval    = "com.token-tally.refreshInterval"
        static let menuBarDisplayMode = "com.token-tally.menuBarDisplayMode"
        static let launchAtLogin      = "com.token-tally.launchAtLogin"
        static let topListsPeriod     = "com.token-tally.topListsPeriod"
    }

    // MARK: Defaults

    /// Central ToTally database path, XDG-aware (honors `$XDG_DATA_HOME`).
    /// Computed so it reflects the runtime environment, not a build-time constant.
    static var defaultDatabasePath: String { AnalyticsQueries.defaultDatabasePath() }

    static let defaultRefreshInterval: TimeInterval = 60
    static let defaultMenuBarDisplayMode: MenuBarDisplayMode = .combinedTokensCost

    /// Launch at login is enabled by default — ToTally is only useful as a
    /// persistent menu bar presence and has no value if it doesn't auto-start.
    /// Users can disable it from Settings.
    static let defaultLaunchAtLogin = true
    static let defaultTopListsPeriod: TopListsPeriod = .week7

    // MARK: Published properties

    /// Path to the SQLite database (tilde-containing paths are accepted).
    /// Changing this triggers a store refresh via the AnalyticsStore subscriber.
    @Published var databasePath: String {
        didSet { UserDefaults.standard.set(databasePath, forKey: Key.databasePath) }
    }

    /// How often (in seconds) the background timer refreshes data.
    @Published var refreshInterval: TimeInterval {
        didSet { UserDefaults.standard.set(refreshInterval, forKey: Key.refreshInterval) }
    }

    /// What the menu bar label shows.
    @Published var menuBarDisplayMode: MenuBarDisplayMode {
        didSet {
            UserDefaults.standard.set(menuBarDisplayMode.rawValue, forKey: Key.menuBarDisplayMode)
        }
    }

    /// Whether the app registers itself as a login item.
    /// Registration is best-effort; failures are handled by the caller.
    @Published var launchAtLogin: Bool {
        didSet { UserDefaults.standard.set(launchAtLogin, forKey: Key.launchAtLogin) }
    }

    /// Time window used for the "Top Models" and "Top Repos" sections in the popover.
    @Published var topListsPeriod: TopListsPeriod {
        didSet {
            UserDefaults.standard.set(topListsPeriod.rawValue, forKey: Key.topListsPeriod)
        }
    }

    // MARK: Init

    init() {
        // Load persisted values, falling back to defaults for missing keys.
        databasePath = UserDefaults.standard.string(forKey: Key.databasePath)
            ?? AppSettings.defaultDatabasePath

        let storedInterval = UserDefaults.standard.double(forKey: Key.refreshInterval)
        // double(forKey:) returns 0 when the key is absent.
        refreshInterval = storedInterval > 0
            ? storedInterval
            : AppSettings.defaultRefreshInterval

        if let raw = UserDefaults.standard.string(forKey: Key.menuBarDisplayMode),
           let mode = MenuBarDisplayMode(rawValue: raw) {
            menuBarDisplayMode = mode
        } else {
            menuBarDisplayMode = AppSettings.defaultMenuBarDisplayMode
        }

        launchAtLogin = UserDefaults.standard.object(forKey: Key.launchAtLogin) != nil
            ? UserDefaults.standard.bool(forKey: Key.launchAtLogin)
            : AppSettings.defaultLaunchAtLogin

        if let raw = UserDefaults.standard.string(forKey: Key.topListsPeriod),
           let period = TopListsPeriod(rawValue: raw) {
            topListsPeriod = period
        } else {
            topListsPeriod = AppSettings.defaultTopListsPeriod
        }

        // Remove the retired harness filter preference so old installations do
        // not keep stale settings that no longer have UI.
        UserDefaults.standard.removeObject(forKey: "com.token-tally.enabledHarnesses")
    }

    // MARK: Reset

    /// Resets all settings to their defaults and removes persisted values.
    func resetToDefaults() {
        [Key.databasePath, Key.refreshInterval,
         Key.menuBarDisplayMode, Key.launchAtLogin, Key.topListsPeriod].forEach {
            UserDefaults.standard.removeObject(forKey: $0)
        }
        UserDefaults.standard.removeObject(forKey: "com.token-tally.enabledHarnesses")
        databasePath = AppSettings.defaultDatabasePath
        refreshInterval = AppSettings.defaultRefreshInterval
        menuBarDisplayMode = AppSettings.defaultMenuBarDisplayMode
        launchAtLogin = AppSettings.defaultLaunchAtLogin
        topListsPeriod = AppSettings.defaultTopListsPeriod
    }
}
