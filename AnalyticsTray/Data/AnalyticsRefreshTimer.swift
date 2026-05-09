import Foundation

/// Fires a repeating async callback at a configurable interval.
///
/// Implemented as an actor so its internal task reference is safe to mutate
/// from concurrent callers. In practice, `AnalyticsStore` (the sole owner)
/// always calls `start` and `cancel` from `@MainActor`, but the actor
/// isolation provides a clean concurrency contract and avoids `@MainActor`
/// leaking into this utility type.
///
/// Uses a `Task` sleep loop rather than `Timer` so that:
/// - Cancellation is immediate and structured.
/// - The callback can be any `async` function (including `@MainActor` ones).
/// - No run-loop scheduling concerns.
actor AnalyticsRefreshTimer {

    private var timerTask: Task<Void, Never>?

    // MARK: - Public API

    /// Start (or restart) the repeating timer with `interval` seconds between fires.
    ///
    /// If a timer is already running it is cancelled first.
    /// `onFire` is awaited from inside the task loop; if it is `@MainActor`-
    /// isolated the Swift runtime hops to the main actor automatically.
    func start(interval: TimeInterval, onFire: @escaping @Sendable () async -> Void) {
        timerTask?.cancel()
        timerTask = Task {
            while !Task.isCancelled {
                // Sleep first so the caller decides whether to fire immediately.
                try? await Task.sleep(for: .seconds(interval))
                guard !Task.isCancelled else { break }
                await onFire()
            }
        }
    }

    /// Cancel the running timer. Safe to call when no timer is active.
    func cancel() {
        timerTask?.cancel()
        timerTask = nil
    }
}
