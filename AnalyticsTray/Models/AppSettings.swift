import Foundation

// MARK: - MenuBarDisplayMode

/// Controls what the `NSStatusItem` label shows.
enum MenuBarDisplayMode: String, CaseIterable, Identifiable {
    /// "π 284k · $1.42" — tokens and cost (default).
    case combinedTokensCost
    /// "π 284k" — tokens only.
    case tokensOnly
    /// "π" — icon only; no numbers.
    case iconOnly

    var id: String { rawValue }

    /// Human-readable label used in the Settings UI.
    var displayName: String {
        switch self {
        case .combinedTokensCost: return "Tokens + cost"
        case .tokensOnly:         return "Tokens only"
        case .iconOnly:           return "Icon only"
        }
    }
}

// MARK: - AppSettings

/// Persisted user preferences. Backed by `UserDefaults`.
///
/// This class is `ObservableObject` so SwiftUI views in the Settings UI (T7)
/// can drive themselves from it. `AnalyticsStore` (T4) reads its values
/// directly; when the user changes `databasePath` or `refreshInterval` the
/// store should be notified to cancel and restart the refresh cycle.
///
/// All keys are namespaced under `"com.pi.analyticstray."` to avoid collisions
/// with other apps that share the same default `UserDefaults` suite.
final class AppSettings: ObservableObject {

    // MARK: UserDefaults keys

    private enum Key {
        static let databasePath      = "com.pi.analyticstray.databasePath"
        static let refreshInterval   = "com.pi.analyticstray.refreshInterval"
        static let menuBarDisplayMode = "com.pi.analyticstray.menuBarDisplayMode"
        static let launchAtLogin     = "com.pi.analyticstray.launchAtLogin"
    }

    // MARK: Defaults

    /// The path as stored in defaults (may contain `~`).
    static let defaultDatabasePath = "~/.pi/analytics/events.db"
    static let defaultRefreshInterval: TimeInterval = 60
    static let defaultMenuBarDisplayMode: MenuBarDisplayMode = .combinedTokensCost
    static let defaultLaunchAtLogin = false

    // MARK: Published properties

    /// Path to the SQLite database (tilde-containing paths are accepted).
    /// Changing this should trigger a store refresh; T4 / T7 handle that.
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
    }

    // MARK: Reset

    /// Resets all settings to their defaults and removes persisted values.
    func resetToDefaults() {
        [Key.databasePath, Key.refreshInterval,
         Key.menuBarDisplayMode, Key.launchAtLogin].forEach {
            UserDefaults.standard.removeObject(forKey: $0)
        }
        databasePath = AppSettings.defaultDatabasePath
        refreshInterval = AppSettings.defaultRefreshInterval
        menuBarDisplayMode = AppSettings.defaultMenuBarDisplayMode
        launchAtLogin = AppSettings.defaultLaunchAtLogin
    }
}
