// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "LittleSpud",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "LittleSpud", targets: ["LittleSpud"])
    ],
    targets: [
        .executableTarget(
            name: "LittleSpud",
            path: "Sources/LittleSpud",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("CryptoKit"),
                .linkedFramework("UserNotifications"),
                .linkedFramework("WebKit")
            ]
        )
    ]
)
