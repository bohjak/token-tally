import AppKit

/// AppKit application delegate.
///
/// Owns the two long-lived controllers for the app's lifetime and wires them
/// together. Nothing else in the app needs to reach into this class directly.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {

    // Strong references kept here so the controllers live for the app's lifetime.
    private var statusItemController: StatusItemController?
    private var popoverController: PopoverController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Belt-and-suspenders: reinforce the accessory policy set in main().
        // Some macOS versions reset it between pre-run setup and delegate launch.
        NSApp.setActivationPolicy(.accessory)

        let pc = PopoverController()
        let sc = StatusItemController(popoverController: pc)

        popoverController = pc
        statusItemController = sc

        // Kick off the first read after the status item observer is installed,
        // so today's menu bar label is populated before the popover is opened.
        pc.refreshOnStartup()
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Close the popover cleanly before exit so the event monitor is removed.
        popoverController?.close()
    }
}
