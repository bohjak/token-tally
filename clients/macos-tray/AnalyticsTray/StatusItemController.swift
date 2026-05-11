import AppKit

/// Manages the `NSStatusItem` that appears in the macOS menu bar.
///
/// Responsibilities:
/// - Create and own the system status item.
/// - Route button-click events to `PopoverController`.
/// - Expose `setTitle(_:)` so `AnalyticsStore` updates can reach the label
///   without needing a direct reference to the underlying `NSStatusItem`.
@MainActor
final class StatusItemController {

    private let statusItem: NSStatusItem
    private let popoverController: PopoverController

    init(popoverController: PopoverController) {
        self.popoverController = popoverController

        // Variable-length so the label can grow/shrink with "Σ 284k · $1.42".
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        guard let button = statusItem.button else { return }

        // Placeholder until the first data load completes. We set this as a
        // plain title rather than via setTitle(_:) because setTitle uses
        // attributedTitle, and attributedTitle requires a font size derived
        // from the button's controlSize — which the system may not have
        // committed yet at this point in the init sequence.
        button.title = "Σ …"
        button.action = #selector(buttonClicked)
        button.target = self

        // Fire on mouse-down for a snappy feel. The PopoverController's event
        // monitor also fires on mouse-down for outside-click dismissal, so both
        // sides of the toggle are consistently fast.
        button.sendAction(on: .leftMouseDown)

        // PopoverView (inside AnalyticsEnvironment) posts this notification
        // whenever AnalyticsStore.menuBarTitle changes. Observing it here keeps
        // StatusItemController decoupled from the SwiftUI store lifecycle.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(menuBarTitleChanged),
            name: .analyticsMenuBarTitleChanged,
            object: nil
        )
    }

    /// Updates the menu bar label (e.g. "Σ 284k · $1.42").
    ///
    /// Sets `button.attributedTitle` with a monospaced-digit system font so
    /// all digits render at a fixed column width, preventing the label from
    /// jittering horizontally as digit counts change (e.g. "9k" → "10k").
    ///
    /// AppKit note: `title` and `attributedTitle` are mutually exclusive —
    /// setting one clears the other. We always use `attributedTitle` once real
    /// data is available so the font behaviour is consistent.
    func setTitle(_ title: String) {
        guard let button = statusItem.button else { return }
        // NSFont.monospacedDigitSystemFont applies tabular (fixed-width) number
        // spacing to the system font. See Formatters.menuBarAttributedTitle for
        // the same technique applied when building the title outside AppKit.
        let font = NSFont.monospacedDigitSystemFont(
            ofSize: NSFont.systemFontSize,
            weight: .regular
        )
        button.attributedTitle = NSAttributedString(
            string: title,
            attributes: [.font: font]
        )
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
}
