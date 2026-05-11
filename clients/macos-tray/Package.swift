// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "AnalyticsTray",
    platforms: [
        // macOS 14: available on the target development machine and required
        // for the Swift Testing framework bundled with Command Line Tools.
        .macOS(.v14)
    ],
    targets: [
        .executableTarget(
            name: "AnalyticsTray",
            path: "AnalyticsTray",
            exclude: [
                // SwiftPM does not allow Info.plist as a regular bundled resource.
                // The file is kept in the source tree for reference and for use
                // when the app is eventually packaged as a proper .app bundle
                // (where it lives at the bundle root, not in Resources/).
                // The programmatic setActivationPolicy(.accessory) call in
                // AnalyticsTrayApp.main() handles the no-Dock-icon requirement
                // when running via `swift run` or as a bare executable.
                "Resources/Info.plist",
                "Resources/AppIcon.md"
            ]
        ),
        .testTarget(
            name: "AnalyticsTrayTests",
            dependencies: ["AnalyticsTray"],
            path: "AnalyticsTrayTests",
            exclude: ["Fixtures"],
            swiftSettings: [
                .unsafeFlags(["-F", "/Library/Developer/CommandLineTools/Library/Developer/Frameworks"])
            ],
            linkerSettings: [
                .unsafeFlags(["-F/Library/Developer/CommandLineTools/Library/Developer/Frameworks", "-framework", "Testing", "-Xlinker", "-rpath", "-Xlinker", "/Library/Developer/CommandLineTools/Library/Developer/Frameworks"])
            ]
        )
    ]
)
