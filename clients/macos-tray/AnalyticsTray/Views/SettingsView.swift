import SwiftUI
import ServiceManagement

/// Settings UI for ToTally.
///
/// All changes take effect immediately - `AppSettings`'s `@Published` `didSet`
/// observers persist each value to `UserDefaults` and notify `AnalyticsStore`
/// to restart its refresh timer or reload from the new database path.
///
/// Launch-at-login registration via `SMAppService` is best-effort: the toggle
/// reverts and an informative error is shown if registration fails (common when
/// running an unsigned build outside `/Applications`).
struct SettingsView: View {

    @ObservedObject var settings: AppSettings
    let onRefresh: @MainActor () -> Void

    init(settings: AppSettings, onRefresh: @escaping @MainActor () -> Void = {}) {
        self.settings = settings
        self.onRefresh = onRefresh
    }

    // MARK: - Local state

    /// True when `settings.databasePath` points to an existing file.
    @State private var pathIsValid = true

    /// Non-nil when the last launch-at-login toggle attempt failed.
    @State private var launchAtLoginError: String? = nil

    /// Past-7-days messages whose cost is unknown, loaded from the configured database.
    @State private var unpricedMessages: Int64? = nil

    // MARK: - Refresh interval presets

    private struct RefreshPreset: Identifiable {
        let id: TimeInterval   // doubles as the tag value
        let label: String
    }

    private let refreshPresets: [RefreshPreset] = [
        RefreshPreset(id: 30,   label: "30 seconds"),
        RefreshPreset(id: 60,   label: "1 minute"),
        RefreshPreset(id: 300,  label: "5 minutes"),
        RefreshPreset(id: 900,  label: "15 minutes"),
        RefreshPreset(id: 1800, label: "30 minutes"),
    ]

    // MARK: - Body

    var body: some View {
        Form {
            databaseSection
            refreshSection
            displaySection
            accountingSection
            startupSection
            resetSection
        }
        .formStyle(.grouped)
        // NSHostingController does not always derive a useful intrinsic height
        // for macOS Form content inside an AppKit-created settings window. Use
        // an explicit size so the window does not open as an empty shell.
        .frame(width: 420, height: 540)
        .onAppear {
            validatePath()
            reloadAccountingStatus()
        }
        .onChange(of: settings.databasePath) { _, _ in
            validatePath()
            reloadAccountingStatus()
        }
    }

    // MARK: - Sections

    private var databaseSection: some View {
        Section {
            // Path row: text field + Browse button side by side.
            HStack(spacing: 6) {
                TextField("Database path", text: $settings.databasePath)
                    // Validate immediately when the user commits (Return key).
                    .onSubmit { validatePath() }
                    .truncationMode(.head)

                Button("Browse...") { browseForDatabase() }
            }

            Button("Open Analytics Folder") { openAnalyticsFolder() }

            // Inline warning, shown only when the path is invalid.
            if !pathIsValid {
                Label {
                    Text("No database found at this path.")
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        } header: {
            Text("Database")
        } footer: {
            Text("Default: \(AppSettings.defaultDatabasePath)")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    private var refreshSection: some View {
        Section("Refresh") {
            Picker("Interval", selection: $settings.refreshInterval) {
                ForEach(refreshPresets) { preset in
                    Text(preset.label).tag(preset.id)
                }
            }

            Button("Refresh Now") { onRefresh() }
        }
    }

    private var displaySection: some View {
        Section("Menu bar") {
            // Radio-group gives a familiar macOS Preferences feel for mutually
            // exclusive single-column options.
            Picker("Display", selection: $settings.menuBarDisplayMode) {
                ForEach(MenuBarDisplayMode.allCases) { mode in
                    Text(mode.displayName).tag(mode)
                }
            }
            .pickerStyle(.radioGroup)
        }
    }

    private var accountingSection: some View {
        Section {
            if let count = unpricedMessages {
                if count > 0 {
                    Label {
                        Text(
                            count == 1
                                ? "1 message in the past 7 days has unknown cost and is not included in totals."
                                : "\(count) messages in the past 7 days have unknown cost and are not included in totals."
                        )
                    } icon: {
                        Image(systemName: "info.circle")
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                } else {
                    Label("All messages in the past 7 days have known costs.", systemImage: "checkmark.circle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else {
                Text("Cost-source status is unavailable for the current database path.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Accounting")
        } footer: {
            Text("Messages with unknown cost are excluded from displayed cost totals.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    private var startupSection: some View {
        Section {
            // Use a manual Binding so we can intercept the set: path, attempt
            // SMAppService registration, and only write back to settings on
            // success. On failure the toggle reverts to the old value without
            // any flag or re-entrancy guard needed.
            Toggle(
                "Launch at login",
                isOn: Binding(
                    get: { settings.launchAtLogin },
                    set: { newValue in attemptSetLaunchAtLogin(newValue) }
                )
            )

            // Error banner - shown only after a failed registration attempt.
            if let error = launchAtLoginError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    // Prevent the text from collapsing to one clipped line.
                    .fixedSize(horizontal: false, vertical: true)
            }
        } header: {
            Text("Startup")
        } footer: {
            Text(
                "Launch at login requires the app to be installed as a " +
                "signed .app bundle in /Applications."
            )
            .font(.caption2)
            .foregroundStyle(.tertiary)
        }
    }

    private var resetSection: some View {
        Section {
            Button("Reset to Defaults", role: .destructive) {
                settings.resetToDefaults()
                launchAtLoginError = nil
                validatePath()
                reloadAccountingStatus()
            }
        }
    }

    // MARK: - Path validation

    private func validatePath() {
        pathIsValid = Paths.fileExists(atPath: settings.databasePath)
    }

    private func reloadAccountingStatus() {
        guard pathIsValid else {
            unpricedMessages = nil
            return
        }

        let now = Date()
        let todayStart = Calendar.current.startOfDay(for: now)
        let weekStart = Calendar.current.date(byAdding: .day, value: -6, to: todayStart) ?? todayStart
        let weekMillis = AnalyticsQueries.milliseconds(since1970: weekStart)

        do {
            let bucket = try AnalyticsQueries.usageBucket(
                databasePath: settings.databasePath,
                since: weekMillis
            )
            unpricedMessages = bucket.unpricedMessages
        } catch {
            unpricedMessages = nil
        }
    }

    // MARK: - File browser

    /// Opens a standard Open panel so the user can pick a SQLite .db file.
    private func browseForDatabase() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.message = "Select the ToTally analytics SQLite database"
        panel.prompt = "Select"

        // Start the panel in the directory of the current path (or home dir
        // when the path does not exist yet).
        let expanded = Paths.expandingTilde(settings.databasePath)
        let parentDir = URL(fileURLWithPath: expanded).deletingLastPathComponent()
        if FileManager.default.fileExists(atPath: parentDir.path) {
            panel.directoryURL = parentDir
        }

        if panel.runModal() == .OK, let url = panel.url {
            settings.databasePath = url.path
        }
    }

    private func openAnalyticsFolder() {
        let url = Paths.analyticsFolder(forDatabasePath: settings.databasePath)
        NSWorkspace.shared.open(url)
    }

    // MARK: - Launch at login

    /// Attempts to register or unregister the app as a login item via
    /// `SMAppService`. On failure the toggle reverts and a message is shown;
    /// the app continues to function normally.
    private func attemptSetLaunchAtLogin(_ enable: Bool) {
        do {
            if enable {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            // Only commit to settings after a successful system call. On failure
            // we never write, so the Toggle's get: returns the unchanged old value
            // and the control reverts automatically.
            settings.launchAtLogin = enable
            launchAtLoginError = nil
        } catch {
            let action = enable ? "enable" : "disable"
            launchAtLoginError = Self.launchAtLoginErrorMessage(
                action: action,
                underlying: error
            )
            // settings.launchAtLogin is intentionally NOT updated on failure.
        }
    }

    private static func launchAtLoginErrorMessage(action: String, underlying error: Error) -> String {
        "Could not \(action) launch at login. " +
        "Make sure the app is installed as a signed bundle in /Applications. " +
        "(\(error.localizedDescription))"
    }
}

// MARK: - Preview
// #Preview is only available inside Xcode; omitted here so swift build succeeds.
// To preview: open the package in Xcode, uncomment:
//   #Preview { SettingsView(settings: AppSettings()) }
