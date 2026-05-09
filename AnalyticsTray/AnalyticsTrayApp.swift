import AppKit

/// Application entry point.
///
/// We use a static `main()` entry rather than SwiftUI's `App` protocol because:
/// - SwiftUI's App lifecycle creates a Dock icon and manages windows by default.
/// - Suppressing both reliably across macOS versions requires non-trivial workarounds.
/// - A pure AppKit entry gives us full control over `NSApplication` setup order.
///
/// The popover content is still SwiftUI — only the app lifecycle is AppKit.
@main
enum AnalyticsTrayApp {

    @MainActor
    static func main() {
        // Set accessory policy BEFORE NSApp.run() so no Dock icon ever flashes.
        // LSUIElement in Info.plist does the same for proper .app bundles;
        // this call handles `swift run` / direct executable invocation.
        NSApplication.shared.setActivationPolicy(.accessory)

        let delegate = AppDelegate()
        NSApplication.shared.delegate = delegate

        // Blocks until the app terminates. `delegate` stays alive on this stack
        // frame for the duration, satisfying the strong-reference requirement
        // (NSApplication.delegate is a weak reference).
        NSApplication.shared.run()
    }
}
