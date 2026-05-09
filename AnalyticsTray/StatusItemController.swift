import AppKit

/// Manages the `NSStatusItem` that appears in the macOS menu bar.
///
/// Responsibilities:
/// - Create and own the system status item.
/// - Route button-click events to `PopoverController`.
/// - Expose `setTitle(_:)` so later tasks (T4, T5) can update the label
///   with real data without knowing about the underlying `NSStatusItem`.
@MainActor
final class StatusItemController {

    private let statusItem: NSStatusItem
    private let popoverController: PopoverController

    init(popoverController: PopoverController) {
        self.popoverController = popoverController

        // Variable-length so the label can grow/shrink with "π 284k · $1.42".
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        guard let button = statusItem.button else { return }

        // Placeholder until real data loads (set by AnalyticsStore in T4).
        button.title = "π …"
        button.action = #selector(buttonClicked)
        button.target = self

        // Fire on mouse-down for a snappy feel. The PopoverController's event
        // monitor also fires on mouse-down for outside-click dismissal, so both
        // sides of the toggle are consistently fast.
        button.sendAction(on: .leftMouseDown)

        // PopoverView owns AnalyticsStore in the MVP. Observe its title-change
        // notifications so the status item can update without tightly coupling
        // AppKit setup to the SwiftUI store lifecycle.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(menuBarTitleChanged),
            name: .analyticsMenuBarTitleChanged,
            object: nil
        )
    }

    /// Update the menu bar label (e.g. "π 284k · $1.42").
    /// Must be called from the main actor; T4's AnalyticsStore is @MainActor.
    func setTitle(_ title: String) {
        statusItem.button?.title = title
    }

    @objc private func buttonClicked(_ sender: NSStatusBarButton) {
        popoverController.toggle(relativeTo: sender)
    }

    @objc private func menuBarTitleChanged(_ notification: Notification) {
        guard let title = notification.userInfo?["title"] as? String else { return }
        setTitle(title)
    }

    // No deinit: StatusItemController lives for the full app lifetime.
    // The OS removes the status item automatically on process exit.
    // If future tasks need to dynamically hide the item, call
    // NSStatusBar.system.removeStatusItem(statusItem) from a @MainActor method.
}
