import AppKit
import SwiftUI

/// Owns and presents the Settings window.
///
/// Usage — call `SettingsWindowController.show(settings:)` from any `@MainActor`
/// context (e.g. the popover footer button). The window is created lazily on
/// first call and reused on subsequent calls so the user's in-progress edits
/// are not lost if they close and reopen settings quickly.
///
/// The window is standard (titled, closable, not resizable). Because the
/// settings are live-updated via `AppSettings`'s `@Published` properties, no
/// Save/Cancel flow is needed — changes take effect immediately and persist to
/// `UserDefaults` via `AppSettings`'s `didSet` observers.
@MainActor
final class SettingsWindowController: NSWindowController, NSWindowDelegate {

    // MARK: - Shared instance

    /// Retained for the app lifetime after first creation.
    private static var shared: SettingsWindowController?

    /// Show the Settings window, creating it if necessary.
    ///
    /// - Parameter settings: The shared `AppSettings` instance that backs
    ///   `AnalyticsStore`. Must be the same object already held by
    ///   `AnalyticsEnvironment` so settings changes propagate immediately.
    static func show(settings: AppSettings) {
        if shared == nil {
            shared = SettingsWindowController(settings: settings)
        }
        shared?.showWindow(nil)
        shared?.window?.makeKeyAndOrderFront(nil)
        // Bring the app to the foreground. For an accessory-mode app this is
        // necessary to put the settings window in front of other apps.
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: - Init

    private init(settings: AppSettings) {
        let rootView = SettingsView(settings: settings)
        let hostingController = NSHostingController(rootView: rootView)

        // Create the window. isReleasedWhenClosed = false keeps the window (and
        // the SwiftUI view hierarchy) alive after the user closes it, so that
        // reopening settings restores the previous scroll position / state.
        let window = NSWindow(contentViewController: hostingController)
        window.title = "pi Analytics — Settings"
        // Title, close button, but no miniaturize/zoom/resize handles.
        window.styleMask = [.titled, .closable]
        window.contentMinSize = NSSize(width: 420, height: 460)
        window.setContentSize(NSSize(width: 420, height: 460))
        window.isReleasedWhenClosed = false
        window.center()

        super.init(window: window)
        window.delegate = self
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("SettingsWindowController must be created with init(settings:)")
    }

    // MARK: - NSWindowDelegate

    /// When the user closes the settings window, clear the shared instance so
    /// the next call to `show(settings:)` recreates a fresh window centered on
    /// screen rather than restoring a stale position.
    ///
    /// Note: because `isReleasedWhenClosed = false` the underlying NSWindow is
    /// *not* deallocated — this just drops our strong reference so Swift ARC
    /// cleans it up.
    func windowWillClose(_ notification: Notification) {
        SettingsWindowController.shared = nil
    }
}
