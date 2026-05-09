import Foundation

/// Filesystem path helpers.
///
/// All functions accept tilde-containing strings (e.g. `~/.pi/analytics/events.db`)
/// and return expanded, absolute paths or URLs.
enum Paths {

    // MARK: Tilde expansion

    /// Expands a leading `~` to the current user's home directory.
    ///
    /// - Note: `NSString.expandingTildeInPath` handles `~` and `~/…` correctly
    ///   on macOS. Paths that do not start with `~` are returned unchanged.
    static func expandingTilde(_ path: String) -> String {
        (path as NSString).expandingTildeInPath
    }

    // MARK: Analytics folder

    /// Returns a `file://` URL for the directory that contains the given
    /// analytics database.
    ///
    /// Example:
    /// ```
    /// Paths.analyticsFolder(forDatabasePath: "~/.pi/analytics/events.db")
    /// // → file:///Users/alice/.pi/analytics/
    /// ```
    ///
    /// Used by the "Open Analytics Folder" button to reveal the folder in Finder.
    static func analyticsFolder(forDatabasePath path: String) -> URL {
        let expanded = expandingTilde(path)
        return URL(fileURLWithPath: expanded).deletingLastPathComponent()
    }

    // MARK: Existence checks

    /// Returns `true` when a regular file exists at the (possibly tilde-prefixed) path.
    static func fileExists(atPath path: String) -> Bool {
        var isDir: ObjCBool = false
        let exists = FileManager.default.fileExists(
            atPath: expandingTilde(path),
            isDirectory: &isDir
        )
        return exists && !isDir.boolValue
    }
}
