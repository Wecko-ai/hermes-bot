// swift-tools-version: 6.0
// The dictation helper of the desktop app. scripts/build-dictation.cjs compiles it with swiftc for the package;
// this manifest exists for the tests of its pure parts: `swift test --package-path native/dictation`.
import PackageDescription

let package = Package(
    name: "HermesBotDictation",
    platforms: [.macOS(.v13)],
    targets: [
        .target(name: "DictationCore"),
        .executableTarget(name: "hermesbot-dictation", dependencies: ["DictationCore"]),
        .testTarget(name: "DictationCoreTests", dependencies: ["DictationCore"]),
    ],
    swiftLanguageModes: [.v5]
)
