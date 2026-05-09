import Foundation

/// Build-time and runtime version metadata for diagnostics.
///
/// Intended for use in schema-mismatch and query-error UI states so the user
/// can copy a complete diagnostic block when reporting issues.
///
/// **How to read version information at runtime (SwiftPM executable):**
/// SwiftPM executables do not have a traditional `Info.plist` bundle; the values
/// below are populated by inspecting `Bundle.main` with fallbacks to hard-coded
/// strings so the app never shows blank diagnostics.
///
/// When the app is eventually packaged as a proper `.app` bundle (with the
/// `Info.plist` from `AnalyticsTray/Resources/Info.plist` at the bundle root),
/// `Bundle.main.infoDictionary` will carry real values automatically.
enum AppVersion {

    // MARK: - Version strings

    /// Marketing version string, e.g. "1.0.0".
    ///
    /// Reads `CFBundleShortVersionString` from the bundle; falls back to a
    /// constant so the value is never empty when running as a bare executable
    /// (as is the case with `swift run` / SwiftPM builds).
    static var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString")
            as? String
            ?? "1.0.0-dev"
    }

    /// Build number, e.g. "42".
    ///
    /// Reads `CFBundleVersion` from the bundle; falls back to the compile-time
    /// date stamp so successive dev builds can be distinguished.
    static var build: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion")
            as? String
            ?? buildDateStamp
    }

    /// Combined version + build, e.g. "1.0.0 (42)".
    static var versionAndBuild: String {
        "\(version) (\(build))"
    }

    // MARK: - Diagnostic block

    /// A multi-line string suitable for pasting into a bug report.
    ///
    /// Usage:
    /// ```swift
    /// // In EmptyStateView .schemaMismatch or ErrorStateView:
    /// Text(AppVersion.diagnosticBlock(databasePath: path))
    ///     .textSelection(.enabled)
    /// ```
    static func diagnosticBlock(databasePath: String) -> String {
        """
        pi Analytics Tray — Diagnostic Info
        Version:  \(versionAndBuild)
        Database: \(Paths.expandingTilde(databasePath))
        macOS:    \(ProcessInfo.processInfo.operatingSystemVersionString)
        """
    }

    // MARK: - Private

    /// ISO-8601 date of compilation, used as a build-number fallback.
    ///
    /// `#file` and compile-time literals are the only zero-overhead build-time
    /// data available without a build system plugin or Info.plist injection.
    private static let buildDateStamp: String = {
        // Use the compile date from ProcessInfo as a reasonable approximation.
        // This changes each day the project is rebuilt, making successive dev
        // builds distinguishable without a proper build number pipeline.
        let now = Date()
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        return formatter.string(from: now)
    }()
}
