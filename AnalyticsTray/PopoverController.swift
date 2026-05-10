import AppKit
import SwiftUI

/// Manages the `NSPopover` that expands from the status bar item.
///
/// Responsibilities:
/// - Create and configure the popover.
/// - Host the SwiftUI `PopoverView` inside it via `NSHostingController`.
/// - Expose `toggle / show / close` for `StatusItemController`.
/// - Install a global event monitor while visible to dismiss on outside clicks,
///   while correctly ignoring clicks on the status bar button itself (so that
///   clicking the button while the popover is open closes it without immediately
///   reopening it).
@MainActor
final class PopoverController {

    private let popover = NSPopover()
    private let environment = AnalyticsEnvironment()

    /// Weak reference to the button we're anchored to; used by the event
    /// monitor to distinguish "click on our button" from "click elsewhere".
    private weak var anchorButton: NSStatusBarButton?

    /// Token returned by `addGlobalMonitorForEvents`; nil when popover is hidden.
    private var eventMonitor: Any?

    init() {
        // Let the hosted SwiftUI view drive the final height. A narrow default
        // keeps first layout deterministic without imposing the fixed-height
        // clipping that the custom NSPanel version introduced.
        popover.contentSize = NSSize(width: 280, height: 320)

        // .applicationDefined: we own open/close logic entirely.
        // .transient would auto-close but causes a double-open quirk when
        // clicking the status bar button while the popover is shown.
        popover.behavior = .applicationDefined
        popover.animates = true

        // Embed the SwiftUI view with the long-lived environment. The same
        // environment is also used for startup refreshes before the popover is
        // opened for the first time.
        popover.contentViewController = NSHostingController(
            rootView: PopoverView(environment: environment) { [weak self] in
                self?.close()
            }
        )
    }

    // MARK: - Public interface

    var isShown: Bool { popover.isShown }

    /// Start loading analytics before the user opens the popover.
    func refreshOnStartup() {
        environment.refreshOnStartup()
    }

    /// Toggle the popover: open if closed, close if open.
    func toggle(relativeTo button: NSStatusBarButton) {
        if popover.isShown {
            close()
        } else {
            show(relativeTo: button)
        }
    }

    /// Open the popover anchored below the given status bar button.
    func show(relativeTo button: NSStatusBarButton) {
        anchorButton = button
        keepStatusItemHighlighted(button)
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        installEventMonitor()
    }

    /// Close the popover and tear down the event monitor.
    func close() {
        anchorButton?.highlight(false)
        popover.performClose(nil)
        removeEventMonitor()
    }

    private func keepStatusItemHighlighted(_ button: NSStatusBarButton) {
        button.highlight(true)

        // The status button action fires on mouse-down for responsiveness.
        // AppKit clears the native pressed highlight on mouse-up after the
        // action has already run, so re-apply the native highlight afterward.
        DispatchQueue.main.async { [weak button, weak self] in
            guard let self, self.popover.isShown else { return }
            button?.highlight(true)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak button, weak self] in
            guard let self, self.popover.isShown else { return }
            button?.highlight(true)
        }
    }

    // MARK: - Event monitor

    /// Installs a global mouse-down monitor so clicking anywhere outside the
    /// popover closes it.
    ///
    /// The monitor explicitly skips clicks that land on the status bar button
    /// itself, letting the button's own action handler call `toggle()` to close.
    /// Without this check, clicking the button would both close (here) and
    /// reopen (in the action handler) the popover — a visible flicker.
    private func installEventMonitor() {
        guard eventMonitor == nil else { return }

        eventMonitor = NSEvent.addGlobalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown]
        ) { [weak self] _ in
            // NSEvent global monitors always dispatch on the main thread.
            MainActor.assumeIsolated {
                guard let self else { return }

                // If the click lands on the status bar button, bail out —
                // the button action will call toggle() → close() itself.
                if let btn = self.anchorButton,
                   let window = btn.window {
                    // Convert button bounds from view-local → window → screen.
                    let inWindow = btn.convert(btn.bounds, to: nil)
                    let inScreen = window.convertToScreen(inWindow)
                    if inScreen.contains(NSEvent.mouseLocation) {
                        return
                    }
                }

                self.close()
            }
        }
    }

    private func removeEventMonitor() {
        if let monitor = eventMonitor {
            NSEvent.removeMonitor(monitor)
            eventMonitor = nil
        }
    }

    // No deinit: PopoverController lives for the full app lifetime.
    // AppDelegate.applicationWillTerminate calls close(), which removes the
    // event monitor. The OS cleans up the NSPopover reference on process exit.
}
