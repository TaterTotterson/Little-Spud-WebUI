import AppKit
import CryptoKit
import Foundation
import UserNotifications
@preconcurrency import WebKit

private let appDisplayName = "Little Spud"
private let executableName = "LittleSpud"

private struct NativeNotificationPayload {
    let title: String
    let body: String
    let tag: String
    let url: String?
}

private final class LocalNotificationManager: NSObject, UNUserNotificationCenterDelegate {
    var onOpenApp: (() -> Void)?

    private let center = UNUserNotificationCenter.current()

    func configure() {
        center.delegate = self
    }

    func deliver(_ payload: NativeNotificationPayload) {
        center.getNotificationSettings { [weak self] settings in
            guard let self else { return }
            switch settings.authorizationStatus {
            case .authorized, .provisional:
                self.addNotification(payload)
            case .notDetermined:
                self.center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
                    if granted {
                        self.addNotification(payload)
                    }
                }
            case .denied, .ephemeral:
                return
            @unknown default:
                return
            }
        }
    }

    private func addNotification(_ payload: NativeNotificationPayload) {
        let content = UNMutableNotificationContent()
        content.title = payload.title.isEmpty ? appDisplayName : payload.title
        content.body = payload.body
        content.sound = .default
        if let url = payload.url {
            content.userInfo = ["url": url]
        }

        let identifier = payload.tag.isEmpty ? "little-spud-\(UUID().uuidString)" : payload.tag
        let request = UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
        center.add(request)
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        DispatchQueue.main.async { [onOpenApp] in
            onOpenApp?()
            completionHandler()
        }
    }
}

private final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?

    init(_ target: WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}

private final class LittleSpudWindowController: NSWindowController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private let webView: WKWebView
    private let bootView = NSView()
    private let bootLogoView = NSImageView()
    private let bootStatusLabel = NSTextField(labelWithString: "Loading Little Spud...")
    private let statusLabel = NSTextField(labelWithString: "")
    private let notificationHandler: (NativeNotificationPayload) -> Void

    init(notificationHandler: @escaping (NativeNotificationPayload) -> Void) {
        self.notificationHandler = notificationHandler

        let contentController = WKUserContentController()
        let nativeScript = """
        window.__littleSpudNative = { platform: "macOS", notifications: true };
        """
        contentController.addUserScript(WKUserScript(source: nativeScript, injectionTime: .atDocumentStart, forMainFrameOnly: false))

        let configuration = WKWebViewConfiguration()
        configuration.userContentController = contentController
        configuration.websiteDataStore = .default()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true

        webView = WKWebView(frame: .zero, configuration: configuration)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1120, height: 780),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = appDisplayName
        window.minSize = NSSize(width: 390, height: 620)
        window.center()
        window.isReleasedWhenClosed = false

        super.init(window: window)

        contentController.add(WeakScriptMessageHandler(self), name: "littleSpudNotify")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true

        let container = NSView(frame: window.contentView?.bounds ?? .zero)
        container.translatesAutoresizingMaskIntoConstraints = false
        webView.translatesAutoresizingMaskIntoConstraints = false
        bootView.translatesAutoresizingMaskIntoConstraints = false
        bootLogoView.translatesAutoresizingMaskIntoConstraints = false
        bootStatusLabel.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        webView.isHidden = true
        bootView.wantsLayer = true
        bootView.layer?.backgroundColor = NSColor(red: 0.03, green: 0.026, blue: 0.022, alpha: 1).cgColor
        bootLogoView.image = bundledImage(named: "LittleSpudBootLogo", withExtension: "png")
        bootLogoView.imageAlignment = .alignCenter
        bootLogoView.imageScaling = .scaleProportionallyUpOrDown
        bootStatusLabel.alignment = .center
        bootStatusLabel.textColor = NSColor(red: 1.0, green: 0.58, blue: 0.10, alpha: 1)
        bootStatusLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        statusLabel.alignment = .center
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.font = .systemFont(ofSize: 14)
        statusLabel.lineBreakMode = .byWordWrapping
        statusLabel.maximumNumberOfLines = 4

        container.addSubview(webView)
        container.addSubview(bootView)
        bootView.addSubview(bootLogoView)
        bootView.addSubview(bootStatusLabel)
        container.addSubview(statusLabel)
        window.contentView = container

        let bootLogoAspect = bootLogoView.heightAnchor.constraint(equalTo: bootLogoView.widthAnchor, multiplier: 0.5625)
        bootLogoAspect.priority = .defaultHigh
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            webView.topAnchor.constraint(equalTo: container.topAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            bootView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            bootView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            bootView.topAnchor.constraint(equalTo: container.topAnchor),
            bootView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            bootLogoView.centerXAnchor.constraint(equalTo: bootView.centerXAnchor),
            bootLogoView.centerYAnchor.constraint(equalTo: bootView.centerYAnchor, constant: -26),
            bootLogoView.widthAnchor.constraint(lessThanOrEqualToConstant: 560),
            bootLogoView.widthAnchor.constraint(lessThanOrEqualTo: bootView.widthAnchor, multiplier: 0.72),
            bootLogoView.heightAnchor.constraint(lessThanOrEqualToConstant: 315),
            bootLogoAspect,
            bootStatusLabel.leadingAnchor.constraint(equalTo: bootView.leadingAnchor, constant: 24),
            bootStatusLabel.trailingAnchor.constraint(equalTo: bootView.trailingAnchor, constant: -24),
            bootStatusLabel.topAnchor.constraint(equalTo: bootLogoView.bottomAnchor, constant: 22),
            statusLabel.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 24),
            statusLabel.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -24),
            statusLabel.centerYAnchor.constraint(equalTo: container.centerYAnchor)
        ])

        loadBundledWebUI()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func loadBundledWebUI() {
        guard
            let webRoot = Bundle.main.resourceURL?.appendingPathComponent("WebUI", isDirectory: true),
            FileManager.default.fileExists(atPath: webRoot.appendingPathComponent("index.html").path)
        else {
            showStatus("Little Spud WebUI is missing from the app bundle.")
            return
        }

        showBootStatus("Loading Little Spud...")
        webView.loadFileURL(webRoot.appendingPathComponent("index.html"), allowingReadAccessTo: webRoot)
    }

    func reloadWebUI() {
        if webView.url == nil {
            loadBundledWebUI()
        } else {
            webView.reload()
        }
    }

    private func showStatus(_ message: String) {
        webView.isHidden = true
        bootView.isHidden = true
        statusLabel.isHidden = false
        statusLabel.stringValue = message
    }

    private func showBootStatus(_ message: String) {
        webView.isHidden = true
        statusLabel.isHidden = true
        bootView.isHidden = false
        bootStatusLabel.stringValue = message
    }

    private func showWebUI() {
        bootView.isHidden = true
        statusLabel.isHidden = true
        webView.isHidden = false
    }

    private func bundledImage(named name: String, withExtension fileExtension: String) -> NSImage? {
        guard let url = Bundle.main.url(forResource: name, withExtension: fileExtension) else {
            return nil
        }
        return NSImage(contentsOf: url)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "littleSpudNotify" else { return }
        let payload = message.body as? [String: Any]
        let title = String(describing: payload?["title"] ?? appDisplayName)
        let body = String(describing: payload?["body"] ?? "")
        let tag = String(describing: payload?["tag"] ?? "")
        let url = payload?["url"] as? String
        notificationHandler(NativeNotificationPayload(title: title, body: body, tag: tag, url: url))
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showStatus(error.localizedDescription)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        showWebUI()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showStatus(error.localizedDescription)
    }

    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        decisionHandler(.grant)
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url {
            NSWorkspace.shared.open(url)
        }
        return nil
    }
}

private struct UpdateManifest: Decodable, Equatable {
    let version: String
    let build: Int
    let url: URL
    let sha256: String
    let notes: String?
}

private enum UpdateState: Equatable {
    case idle
    case checking
    case current
    case available(UpdateManifest)
    case downloading(UpdateManifest)
    case installing(UpdateManifest)
    case failed(String)

    var isBusy: Bool {
        switch self {
        case .checking, .downloading, .installing:
            return true
        case .idle, .current, .available, .failed:
            return false
        }
    }
}

private final class UpdateManager {
    var onStateChange: ((UpdateState) -> Void)?

    private let updatesRoot: URL
    private var availableManifest: UpdateManifest?

    private(set) var state: UpdateState = .idle {
        didSet {
            DispatchQueue.main.async { [state, onStateChange] in
                onStateChange?(state)
            }
        }
    }

    init() {
        updatesRoot = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".littlespud", isDirectory: true)
            .appendingPathComponent("updates", isDirectory: true)
    }

    func checkForUpdates(manual: Bool) {
        guard !state.isBusy else { return }
        state = .checking

        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            do {
                let manifest = try self.fetchManifest()
                if self.isNewerThanCurrent(manifest) {
                    self.availableManifest = manifest
                    self.state = .available(manifest)
                } else {
                    self.availableManifest = nil
                    self.state = manual ? .current : .idle
                }
            } catch {
                self.state = manual ? .failed(error.localizedDescription) : .idle
            }
        }
    }

    func installAvailableUpdate() {
        let manifest: UpdateManifest?
        switch state {
        case .available(let current):
            manifest = current
        case .failed, .current, .idle, .checking, .downloading, .installing:
            manifest = availableManifest
        }

        guard let manifest else { return }
        state = .downloading(manifest)

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let newApp = try self.prepareUpdate(manifest)
                self.state = .installing(manifest)
                try self.launchInstaller(newApp: newApp)
                DispatchQueue.main.async {
                    NSApp.terminate(nil)
                }
            } catch {
                self.state = .failed(error.localizedDescription)
            }
        }
    }

    private func fetchManifest() throws -> UpdateManifest {
        guard let url = manifestURL() else {
            throw LittleSpudError("No update manifest URL is configured.")
        }

        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(executableName, forHTTPHeaderField: "User-Agent")

        let data = try loadData(from: request)
        return try JSONDecoder().decode(UpdateManifest.self, from: data)
    }

    private func manifestURL() -> URL? {
        if let raw = ProcessInfo.processInfo.environment["LITTLE_SPUD_UPDATE_MANIFEST_URL"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !raw.isEmpty,
           let url = URL(string: raw) {
            return url
        }

        if let raw = Bundle.main.object(forInfoDictionaryKey: "LittleSpudUpdateManifestURL") as? String {
            return URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return nil
    }

    private func isNewerThanCurrent(_ manifest: UpdateManifest) -> Bool {
        let currentVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        let versionComparison = compareVersion(manifest.version, to: currentVersion)
        if versionComparison != .orderedSame {
            return versionComparison == .orderedDescending
        }

        let currentBuild = buildNumber(from: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String)
        return manifest.build > currentBuild
    }

    private func compareVersion(_ lhs: String, to rhs: String) -> ComparisonResult {
        let left = versionParts(lhs)
        let right = versionParts(rhs)
        for index in 0..<max(left.count, right.count) {
            let leftPart = index < left.count ? left[index] : 0
            let rightPart = index < right.count ? right[index] : 0
            if leftPart > rightPart { return .orderedDescending }
            if leftPart < rightPart { return .orderedAscending }
        }
        return .orderedSame
    }

    private func versionParts(_ raw: String) -> [Int] {
        raw.split { !$0.isNumber }.compactMap { Int($0) }
    }

    private func buildNumber(from raw: String?) -> Int {
        versionParts(raw ?? "0").first ?? 0
    }

    private func prepareUpdate(_ manifest: UpdateManifest) throws -> URL {
        try FileManager.default.createDirectory(at: updatesRoot, withIntermediateDirectories: true)

        let archiveName = "LittleSpud-\(safePathComponent(versionLabel(manifest.version))).zip"
        let archiveURL = updatesRoot.appendingPathComponent(archiveName)
        let extractDir = updatesRoot.appendingPathComponent("staging-\(UUID().uuidString)", isDirectory: true)

        try downloadFile(from: manifest.url, to: archiveURL)
        try verifySHA256(of: archiveURL, expected: manifest.sha256)
        try FileManager.default.createDirectory(at: extractDir, withIntermediateDirectories: true)
        try runCheckedProcess(executable: "/usr/bin/ditto", arguments: ["-x", "-k", archiveURL.path, extractDir.path])

        let newApp = try findExtractedApp(in: extractDir)
        guard FileManager.default.fileExists(atPath: newApp.appendingPathComponent("Contents/MacOS/\(executableName)").path) else {
            throw LittleSpudError("Downloaded update did not contain the Little Spud executable.")
        }
        return newApp
    }

    private func verifySHA256(of url: URL, expected rawExpected: String) throws {
        let expected = rawExpected.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let hex = CharacterSet(charactersIn: "0123456789abcdef")
        guard expected.count == 64, expected.unicodeScalars.allSatisfy({ hex.contains($0) }) else {
            throw LittleSpudError("Update manifest is missing a valid SHA-256 hash.")
        }

        let actual = try sha256Hex(of: url)
        guard actual == expected else {
            throw LittleSpudError("Downloaded update did not match the manifest SHA-256.")
        }
    }

    private func sha256Hex(of url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }

        var hasher = SHA256()
        while true {
            let chunk = try handle.read(upToCount: 1024 * 1024) ?? Data()
            if chunk.isEmpty { break }
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private func findExtractedApp(in directory: URL) throws -> URL {
        let preferred = directory.appendingPathComponent("\(appDisplayName).app", isDirectory: true)
        if FileManager.default.fileExists(atPath: preferred.path) {
            return preferred
        }

        guard let enumerator = FileManager.default.enumerator(
            at: directory,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else {
            throw LittleSpudError("Could not inspect extracted update.")
        }

        for case let url as URL in enumerator where url.pathExtension == "app" {
            return url
        }
        throw LittleSpudError("Downloaded update did not contain a macOS app.")
    }

    private func launchInstaller(newApp: URL) throws {
        let targetApp = try currentAppURL()
        let scriptURL = try writeInstallerScript()

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = [scriptURL.path, "\(getpid())", newApp.path, targetApp.path]
        try process.run()
    }

    private func currentAppURL() throws -> URL {
        let bundleURL = Bundle.main.bundleURL.standardizedFileURL
        guard bundleURL.pathExtension == "app" else {
            throw LittleSpudError("\(appDisplayName) is not running from an app bundle.")
        }
        return bundleURL
    }

    private func writeInstallerScript() throws -> URL {
        try FileManager.default.createDirectory(at: updatesRoot, withIntermediateDirectories: true)
        let scriptURL = updatesRoot.appendingPathComponent("install-update-\(UUID().uuidString).sh")
        let script = """
        #!/bin/sh
        set -eu

        APP_PID="$1"
        NEW_APP="$2"
        TARGET_APP="$3"
        SCRIPT_PATH="$0"
        WAIT_COUNT=0

        while kill -0 "$APP_PID" 2>/dev/null && [ "$WAIT_COUNT" -lt 150 ]; do
          sleep 0.2
          WAIT_COUNT=$((WAIT_COUNT + 1))
        done

        TARGET_PARENT="$(dirname "$TARGET_APP")"
        TARGET_NAME="$(basename "$TARGET_APP")"
        STAGED="${TARGET_PARENT}/.${TARGET_NAME}.updating"
        BACKUP="${TARGET_PARENT}/.${TARGET_NAME}.previous"
        NEW_PARENT="$(dirname "$NEW_APP")"

        rm -rf "$STAGED"
        ditto "$NEW_APP" "$STAGED"
        rm -rf "$BACKUP"
        if [ -d "$TARGET_APP" ]; then
          mv "$TARGET_APP" "$BACKUP"
        fi
        mv "$STAGED" "$TARGET_APP"
        xattr -dr com.apple.quarantine "$TARGET_APP" 2>/dev/null || true
        open "$TARGET_APP"
        rm -rf "$NEW_PARENT"
        rm -f "$SCRIPT_PATH"
        """

        try script.write(to: scriptURL, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: scriptURL.path)
        return scriptURL
    }

    private func safePathComponent(_ raw: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "._-"))
        let value = raw.unicodeScalars.map { allowed.contains($0) ? String($0) : "-" }.joined()
        return value.isEmpty ? "update" : value
    }

    private func versionLabel(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.lowercased().hasPrefix("v") {
            return trimmed
        }
        return "v\(trimmed)"
    }

    private func loadData(from request: URLRequest) throws -> Data {
        let semaphore = DispatchSemaphore(value: 0)
        var result: Result<Data, Error>?
        let task = URLSession.shared.dataTask(with: request) { data, response, error in
            if let error {
                result = .failure(error)
            } else if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                result = .failure(LittleSpudError("Update request failed with HTTP \(http.statusCode)."))
            } else {
                result = .success(data ?? Data())
            }
            semaphore.signal()
        }
        task.resume()
        semaphore.wait()

        guard let result else {
            throw LittleSpudError("Update request did not complete.")
        }
        return try result.get()
    }

    private func downloadFile(from url: URL, to destination: URL) throws {
        let semaphore = DispatchSemaphore(value: 0)
        var result: Result<URL, Error>?
        let task = URLSession.shared.downloadTask(with: url) { location, _, error in
            if let error {
                result = .failure(error)
            } else if let location {
                result = .success(location)
            } else {
                result = .failure(LittleSpudError("Download finished without a file."))
            }
            semaphore.signal()
        }
        task.resume()
        semaphore.wait()

        guard let result else {
            throw LittleSpudError("Download did not complete.")
        }
        let tempURL = try result.get()
        if FileManager.default.fileExists(atPath: destination.path) {
            try FileManager.default.removeItem(at: destination)
        }
        try FileManager.default.copyItem(at: tempURL, to: destination)
    }

    private func runCheckedProcess(executable: String, arguments: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardOutput = Pipe()
        process.standardError = Pipe()
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw LittleSpudError("\(executable) exited with status \(process.terminationStatus).")
        }
    }
}

private final class AppDelegate: NSObject, NSApplicationDelegate {
    private let notifications = LocalNotificationManager()
    private let updater = UpdateManager()
    private var statusItem: NSStatusItem?
    private var updateMenuItem: NSMenuItem?
    private var checkUpdatesMenuItem: NSMenuItem?
    private var windowController: LittleSpudWindowController?
    private var updateMenuResetTimer: Timer?
    private var updateCheckTimer: Timer?
    private let automaticUpdateInterval: TimeInterval = 12 * 60 * 60
    private let lastAutomaticUpdateCheckKey = "LittleSpudLastAutomaticUpdateCheck"

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        notifications.configure()
        notifications.onOpenApp = { [weak self] in
            self?.showWindow()
        }
        updater.onStateChange = { [weak self] state in
            self?.refreshUpdateMenu(for: state)
        }

        configureStatusItem()
        showWindow()
        startAutomaticUpdateChecks()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        updateCheckTimer?.invalidate()
        updateMenuResetTimer?.invalidate()
        return .terminateNow
    }

    private func configureStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let image = makeMenuBarIcon()
        image.isTemplate = true
        item.button?.image = image
        item.button?.imagePosition = .imageOnly
        item.button?.title = ""
        item.button?.toolTip = appDisplayName

        let menu = NSMenu()
        let update = NSMenuItem(title: "Update Available", action: #selector(installUpdate), keyEquivalent: "")
        update.target = self
        update.isHidden = true
        menu.addItem(update)
        menu.addItem(NSMenuItem(title: "Open Little Spud", action: #selector(openLittleSpud), keyEquivalent: "o"))
        menu.addItem(NSMenuItem(title: "Reload", action: #selector(reloadLittleSpud), keyEquivalent: "r"))
        menu.addItem(NSMenuItem.separator())
        let checkUpdates = NSMenuItem(title: "Check for Updates...", action: #selector(checkForUpdates), keyEquivalent: "")
        checkUpdates.target = self
        menu.addItem(checkUpdates)
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Quit Little Spud", action: #selector(quit), keyEquivalent: "q"))

        item.menu = menu
        statusItem = item
        updateMenuItem = update
        checkUpdatesMenuItem = checkUpdates
        refreshUpdateMenu(for: updater.state)
    }

    private func makeMenuBarIcon() -> NSImage {
        let size = NSSize(width: 18, height: 18)
        let image = NSImage(size: size)
        image.lockFocus()
        NSColor.black.setFill()

        let body = NSBezierPath(ovalIn: NSRect(x: 4.1, y: 2.5, width: 9.8, height: 11.5))
        body.fill()

        let stem = NSBezierPath(roundedRect: NSRect(x: 8.15, y: 12.1, width: 1.7, height: 3.2), xRadius: 0.85, yRadius: 0.85)
        stem.fill()

        let leftLeaf = NSBezierPath()
        leftLeaf.move(to: NSPoint(x: 8.9, y: 14.4))
        leftLeaf.curve(to: NSPoint(x: 3.6, y: 16.1), controlPoint1: NSPoint(x: 7.1, y: 16.9), controlPoint2: NSPoint(x: 4.3, y: 16.8))
        leftLeaf.curve(to: NSPoint(x: 8.4, y: 13.6), controlPoint1: NSPoint(x: 4.5, y: 13.6), controlPoint2: NSPoint(x: 7.0, y: 13.2))
        leftLeaf.close()
        leftLeaf.fill()

        let rightLeaf = NSBezierPath()
        rightLeaf.move(to: NSPoint(x: 9.1, y: 14.4))
        rightLeaf.curve(to: NSPoint(x: 14.4, y: 16.1), controlPoint1: NSPoint(x: 10.9, y: 16.9), controlPoint2: NSPoint(x: 13.7, y: 16.8))
        rightLeaf.curve(to: NSPoint(x: 9.6, y: 13.6), controlPoint1: NSPoint(x: 13.5, y: 13.6), controlPoint2: NSPoint(x: 11.0, y: 13.2))
        rightLeaf.close()
        rightLeaf.fill()

        image.unlockFocus()
        image.size = size
        return image
    }

    private func startAutomaticUpdateChecks() {
        updateCheckTimer?.invalidate()
        scheduleAutomaticUpdateCheck(after: automaticUpdateCheckDelay())
    }

    private func automaticUpdateCheckDelay() -> TimeInterval {
        let lastCheck = UserDefaults.standard.double(forKey: lastAutomaticUpdateCheckKey)
        guard lastCheck > 0 else { return 6 }

        let elapsed = Date().timeIntervalSince1970 - lastCheck
        guard elapsed >= 0 else { return automaticUpdateInterval }
        if elapsed >= automaticUpdateInterval { return 6 }
        return max(6, automaticUpdateInterval - elapsed)
    }

    private func scheduleAutomaticUpdateCheck(after delay: TimeInterval) {
        updateCheckTimer?.invalidate()
        updateCheckTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            self?.runAutomaticUpdateCheck()
        }
    }

    private func runAutomaticUpdateCheck() {
        if updater.state.isBusy {
            scheduleAutomaticUpdateCheck(after: 60)
            return
        }

        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: lastAutomaticUpdateCheckKey)
        updater.checkForUpdates(manual: false)
        scheduleAutomaticUpdateCheck(after: automaticUpdateInterval)
    }

    private func refreshUpdateMenu(for state: UpdateState) {
        updateMenuResetTimer?.invalidate()
        checkUpdatesMenuItem?.isEnabled = true
        checkUpdatesMenuItem?.title = "Check for Updates..."

        switch state {
        case .idle:
            hideUpdateItem()
        case .checking:
            hideUpdateItem()
            checkUpdatesMenuItem?.title = "Checking for Updates..."
            checkUpdatesMenuItem?.isEnabled = false
        case .current:
            hideUpdateItem()
            checkUpdatesMenuItem?.title = "Little Spud is Up to Date"
            resetCheckUpdateTitleSoon()
        case .available(let manifest):
            showOrangeUpdateItem("Update Available: \(manifest.version)", enabled: true)
        case .downloading(let manifest):
            showOrangeUpdateItem("Downloading Little Spud \(manifest.version)...", enabled: false)
            checkUpdatesMenuItem?.isEnabled = false
        case .installing(let manifest):
            showOrangeUpdateItem("Installing Little Spud \(manifest.version)...", enabled: false)
            checkUpdatesMenuItem?.isEnabled = false
        case .failed:
            hideUpdateItem()
            checkUpdatesMenuItem?.title = "Update Check Failed"
            resetCheckUpdateTitleSoon()
        }
    }

    private func showOrangeUpdateItem(_ title: String, enabled: Bool) {
        guard let updateMenuItem else { return }
        updateMenuItem.isHidden = false
        updateMenuItem.isEnabled = enabled
        updateMenuItem.attributedTitle = NSAttributedString(
            string: title,
            attributes: [
                .foregroundColor: NSColor.systemOrange,
                .font: NSFont.menuFont(ofSize: NSFont.systemFontSize)
            ]
        )
    }

    private func hideUpdateItem() {
        updateMenuItem?.isHidden = true
        updateMenuItem?.isEnabled = false
        updateMenuItem?.attributedTitle = nil
        updateMenuItem?.title = "Update Available"
    }

    private func resetCheckUpdateTitleSoon() {
        updateMenuResetTimer = Timer.scheduledTimer(withTimeInterval: 4.0, repeats: false) { [weak self] _ in
            self?.checkUpdatesMenuItem?.title = "Check for Updates..."
        }
    }

    private func resourceImage(named name: String, withExtension ext: String) -> NSImage? {
        guard let url = Bundle.main.url(forResource: name, withExtension: ext) else {
            return nil
        }
        return NSImage(contentsOf: url)
    }

    @objc private func openLittleSpud() {
        showWindow()
    }

    @objc private func reloadLittleSpud() {
        showWindow()
        windowController?.reloadWebUI()
    }

    @objc private func checkForUpdates() {
        updater.checkForUpdates(manual: true)
    }

    @objc private func installUpdate() {
        updater.installAvailableUpdate()
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    private func showWindow() {
        if windowController == nil {
            windowController = LittleSpudWindowController { [weak self] payload in
                self?.notifications.deliver(payload)
            }
        }
        windowController?.showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}

private struct LittleSpudError: LocalizedError {
    let message: String

    init(_ message: String) {
        self.message = message
    }

    var errorDescription: String? {
        message
    }
}

let app = NSApplication.shared
private let delegate = AppDelegate()
app.delegate = delegate
app.run()
