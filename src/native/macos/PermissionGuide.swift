import AppKit
import ApplicationServices
import Darwin
import Foundation
import Security

/// The authorization identity comes from the actual executable and authenticated
/// process ancestry, never a client-supplied path, environment variable or name.
struct PermissionGuideApplication {
    static let bundleIdentifier = "com.qiuya.tools.computer-use"
    static let appName = "QiuYaTools Computer"
    static let hostBundleIdentifier = "com.deepseek.dsh"
    static let hostTeamIdentifier = "NAN929V4UM"
    // Accept only the official Harness Developer ID Application identity. A
    // different Apple developer can reuse a bundle identifier; an Apple anchor
    // alone does not prove that developer is DeepSeek. A changed official Team
    // requires an explicit reviewed policy update, never a permissive fallback.
    static let hostSigningRequirement = [
        "identifier \"\(hostBundleIdentifier)\"",
        "anchor apple generic",
        "certificate 1[field.1.2.840.113635.100.6.2.6] exists",
        "certificate leaf[field.1.2.840.113635.100.6.1.13] exists",
        "certificate leaf[subject.OU] = \"\(hostTeamIdentifier)\"",
    ].joined(separator: " and ")
    enum Kind: String { case host, companion }
    let kind: Kind
    let name: String
    let identifier: String
    let bundleURL: URL
    let executableURL: URL

    static func validated(bundleURL: URL, executableURL: URL) throws -> Self {
        try validatedBundle(bundleURL: bundleURL, executableURL: executableURL, kind: .companion)
    }

    private static func validatedBundle(bundleURL: URL, executableURL: URL, kind: Kind) throws -> Self {
        guard bundleURL.isFileURL, executableURL.isFileURL else { throw invalidApplication() }
        let application = bundleURL.resolvingSymlinksInPath().standardizedFileURL
        let executable = executableURL.resolvingSymlinksInPath().standardizedFileURL
        let expectedIdentifier = kind == .host ? hostBundleIdentifier : bundleIdentifier
        guard application.pathExtension.lowercased() == "app",
              let bundle = Bundle(url: application), bundle.bundleIdentifier == expectedIdentifier,
              bundle.object(forInfoDictionaryKey: "CFBundlePackageType") as? String == "APPL",
              let bundledExecutable = bundle.executableURL?.resolvingSymlinksInPath().standardizedFileURL,
              bundledExecutable == executable,
              executable.deletingLastPathComponent() == application.appendingPathComponent("Contents/MacOS", isDirectory: true),
              FileManager.default.isExecutableFile(atPath: executable.path) else { throw invalidApplication() }
        let name = NativeApplicationCatalog.displayName(bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
            ?? bundle.object(forInfoDictionaryKey: "CFBundleName") as? String ?? application.deletingPathExtension().lastPathComponent)
        guard !name.isEmpty else { throw invalidApplication() }
        return Self(kind: kind, name: name, identifier: expectedIdentifier, bundleURL: application, executableURL: executable)
    }

    private static func executableURL(_ pid: Int32) throws -> URL {
        // proc_pidpath's documented maximum is 4 * MAXPATHLEN. That macro is
        // not imported into Swift by every macOS SDK.
        var path = [CChar](repeating: 0, count: 4096)
        let length = path.withUnsafeMutableBufferPointer { proc_pidpath(pid, $0.baseAddress, UInt32($0.count)) }
        guard length > 0 else { throw invalidApplication() }
        return URL(fileURLWithPath: String(cString: path)).resolvingSymlinksInPath().standardizedFileURL
    }

    /// Explicit hosted mode never falls back to the companion. If its live
    /// parent cannot be proved, the UI must report an unknown authorization app.
    static func current(owner: MacProcessIdentity? = nil, hosted: Bool = false) throws -> Self {
        guard hosted else { return try validated(bundleURL: Bundle.main.bundleURL, executableURL: executableURL(getpid())) }
        guard let owner, parentIsCurrent(owner: owner, actual: MacProcessIdentity.read(owner.pid), parentPid: getppid()) else { throw invalidApplication() }
        let executable = try executableURL(owner.pid)
        let bundle = executable.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let application = try validatedHost(bundleURL: bundle, executableURL: executable, pid: owner.pid)
        // A directory or Info.plist with the right visible name cannot nominate
        // an authorization app. Validate the live parent's signed code identity.
        guard parentIsCurrent(owner: owner, actual: MacProcessIdentity.read(owner.pid), parentPid: getppid()),
              try executableURL(owner.pid) == executable else { throw invalidApplication() }
        return application
    }

    static func validatedHost(bundleURL: URL, executableURL: URL, pid: Int32) throws -> Self {
        let application = try validatedBundle(bundleURL: bundleURL, executableURL: executableURL, kind: .host)
        guard try self.executableURL(pid) == application.executableURL,
              signedHost(pid: pid, executable: application.executableURL) else { throw invalidApplication() }
        return application
    }

    static func parentIsCurrent(owner: MacProcessIdentity, actual: MacProcessIdentity?, parentPid: Int32) -> Bool {
        parentPid == owner.pid && actual == owner
    }

    static func trustedHostRequirement() -> SecRequirement? {
        var requirement: SecRequirement?
        guard SecRequirementCreateWithString(hostSigningRequirement as CFString, SecCSFlags(rawValue: 0), &requirement) == errSecSuccess else { return nil }
        return requirement
    }

    private static func signedHost(pid: Int32, executable: URL) -> Bool {
        var running: SecCode?, staticCode: SecStaticCode?, rawInformation: CFDictionary?
        let flags = SecCSFlags(rawValue: 0)
        guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid as String: NSNumber(value: pid)] as CFDictionary, flags, &running) == errSecSuccess,
              let running,
              let requirement = trustedHostRequirement(),
              SecCodeCheckValidity(running, flags, requirement) == errSecSuccess,
              SecCodeCopyStaticCode(running, flags, &staticCode) == errSecSuccess, let staticCode,
              SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &rawInformation) == errSecSuccess,
              let information = rawInformation as? [String: Any],
              information[kSecCodeInfoIdentifier as String] as? String == hostBundleIdentifier,
              information[kSecCodeInfoTeamIdentifier as String] as? String == hostTeamIdentifier,
              let signedExecutable = information[kSecCodeInfoMainExecutable as String] as? URL,
              signedExecutable.resolvingSymlinksInPath().standardizedFileURL == executable else { return false }
        return true
    }

    private static func invalidApplication() -> ComputerError {
        ComputerError("PERMISSION_APP_UNAVAILABLE", "无法确认当前权限所属的应用，请从 Harness 中重新打开电脑操控设置后重试。")
    }

    var metadata: [String: Any] { ["kind": kind.rawValue, "appName": name, "bundleIdentifier": identifier] }

    // NSURL implements the native public.file-url pasteboard contract used by
    // System Settings. A text path or a copied replacement app is never used.
    var pasteboardURL: NSURL { bundleURL as NSURL }
}

@MainActor struct PermissionGuideContent {
    let kind: String
    let label: String
    let purpose: String

    static func validated(_ rawKind: Any?) throws -> Self {
        let (kind, _) = try NativeApplicationCatalog.settingsURL(rawKind)
        switch kind {
        case "screenRecording": return Self(kind: kind, label: "屏幕录制", purpose: "读取你授权应用的画面。")
        case "accessibility": return Self(kind: kind, label: "辅助功能", purpose: "读取界面、点击和输入，完成你的任务。")
        case "inputMonitoring": return Self(kind: kind, label: "输入监控", purpose: "检测你的手动操作，及时让出控制。")
        default: throw ComputerError("INVALID_PERMISSION_KIND", "请选择支持的系统权限。")
        }
    }

    @MainActor func isGranted() -> Bool {
        switch kind {
        case "screenRecording": return CGPreflightScreenCaptureAccess()
        case "accessibility": return AXIsProcessTrusted() && CGPreflightPostEventAccess()
        case "inputMonitoring": return CGPreflightListenEventAccess()
        default: return false
        }
    }
}

@MainActor private final class PermissionGuidePanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// AppKit coordinates only. The card attaches outside System Settings when
/// there is room; otherwise it rests just inside that window's upper edge.
enum PermissionGuidePlacement {
    static func clamped(_ frame: CGRect, to visibleFrame: CGRect, margin: CGFloat = 12) -> CGRect {
        let inset = max(0, min(margin, min(visibleFrame.width, visibleFrame.height) / 4))
        let area = visibleFrame.insetBy(dx: inset, dy: inset)
        let width = min(max(1, frame.width), area.width), height = min(max(1, frame.height), area.height)
        return CGRect(x: min(max(frame.minX, area.minX), area.maxX - width),
                      y: min(max(frame.minY, area.minY), area.maxY - height), width: width, height: height)
    }
    static func frame(size: CGSize, beside settings: CGRect, in visibleFrame: CGRect, gap: CGFloat = 12) -> CGRect {
        let sides = [CGRect(x: settings.maxX + gap, y: settings.maxY - size.height - gap, width: size.width, height: size.height),
                     CGRect(x: settings.minX - gap - size.width, y: settings.maxY - size.height - gap, width: size.width, height: size.height)]
        for side in sides {
            let candidate = clamped(side, to: visibleFrame)
            if candidate == side && !candidate.intersects(settings) { return candidate }
        }
        return clamped(CGRect(x: settings.maxX - size.width - gap, y: settings.maxY - size.height - 56,
                              width: size.width, height: size.height), to: visibleFrame)
    }
}

/// A stopped guide cannot be revived by an already queued timer or drag-end
/// callback. An explicit new open is the only way to begin a new lifetime.
struct PermissionGuideLifetime {
    private(set) var revision: UInt64 = 0
    private(set) var active = false
    mutating func begin() -> UInt64 { revision &+= 1; active = true; return revision }
    mutating func end() { revision &+= 1; active = false }
    func accepts(_ revision: UInt64? = nil) -> Bool { active && (revision == nil || revision == self.revision) }
}

@MainActor private final class PermissionApplicationDragView: NSView, NSDraggingSource {
    private let icon: NSImage
    private let appName: String
    private let source: () throws -> PermissionGuideApplication
    private let onFailure: () -> Void
    private let onDragEnded: () -> Void
    private weak var dragWindow: NSWindow?
    private(set) var isDragging = false

    init(application: PermissionGuideApplication, source: @escaping () throws -> PermissionGuideApplication, onFailure: @escaping () -> Void, onDragEnded: @escaping () -> Void) {
        icon = NSWorkspace.shared.icon(forFile: application.bundleURL.path)
        appName = application.name
        self.source = source; self.onFailure = onFailure; self.onDragEnded = onDragEnded
        super.init(frame: .zero)
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel("拖动 \(appName) 到系统权限列表")
        setAccessibilityHelp("按住应用图标并拖入系统设置的应用列表，再打开应用右侧的开关。")
        toolTip = "按住图标，将 \(appName) 拖入系统设置的应用列表。"
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .openHand) }
    override func draw(_ dirtyRect: NSRect) {
        let area = bounds.insetBy(dx: 0.5, dy: 0.5)
        NSColor.controlBackgroundColor.setFill(); NSBezierPath(roundedRect: area, xRadius: 12, yRadius: 12).fill()
        NSColor.separatorColor.setStroke(); NSBezierPath(roundedRect: area, xRadius: 12, yRadius: 12).stroke()
        icon.draw(in: NSRect(x: 20, y: (bounds.height - 48) / 2, width: 48, height: 48))
        let title = appName as NSString
        let style = NSMutableParagraphStyle(); style.lineBreakMode = .byTruncatingTail
        title.draw(in: NSRect(x: 82, y: bounds.midY + 1, width: bounds.width - 94, height: 22),
                   withAttributes: [.font: NSFont.systemFont(ofSize: 14, weight: .semibold), .foregroundColor: NSColor.labelColor, .paragraphStyle: style])
        ("按住并拖入系统设置" as NSString).draw(at: NSPoint(x: 82, y: bounds.midY - 20), withAttributes: [.font: NSFont.systemFont(ofSize: 12), .foregroundColor: NSColor.secondaryLabelColor])
    }
    override func mouseDown(with event: NSEvent) {
        do {
            // Revalidate at the start of every drag, including after an update.
            let application = try source()
            let item = NSDraggingItem(pasteboardWriter: application.pasteboardURL)
            let origin = convert(event.locationInWindow, from: nil)
            item.setDraggingFrame(NSRect(x: origin.x - 24, y: origin.y - 24, width: 48, height: 48), contents: icon)
            let session = beginDraggingSession(with: [item], event: event, source: self)
            session.animatesToStartingPositionsOnCancelOrFail = true
        } catch { restoreMouseRouting(); onFailure() }
    }
    func draggingSession(_ session: NSDraggingSession, willBeginAt screenPoint: NSPoint) {
        dragWindow = window; isDragging = true
        // A floating guide may overlap the list on a narrow display. It must
        // not become the drop target or intercept a drop meant for Settings.
        dragWindow?.ignoresMouseEvents = true
    }
    func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) {
        restoreMouseRouting(); onDragEnded()
    }
    func restoreMouseRouting() {
        dragWindow?.ignoresMouseEvents = false
        dragWindow = nil; isDragging = false
    }
    override func viewWillMove(toWindow newWindow: NSWindow?) {
        if newWindow !== window { restoreMouseRouting() }
        super.viewWillMove(toWindow: newWindow)
    }
    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
        context == .outsideApplication ? .copy : []
    }
    func ignoreModifierKeys(for session: NSDraggingSession) -> Bool { true }
}

/// One compact, nonactivating application card. It follows System Settings only
/// while that app is visible and active, without changing a permission or
/// taking focus from the system list. The existing Harness settings own all
/// descriptions and permission checks.
@MainActor final class PermissionGuideController: NSObject, NSWindowDelegate {
    private let application: () throws -> PermissionGuideApplication
    private var panel: NSPanel?
    private var content: PermissionGuideContent?
    private weak var dragView: PermissionApplicationDragView?
    private var followTimer: Timer?
    private var lifetime = PermissionGuideLifetime()

    init(application: @escaping () throws -> PermissionGuideApplication = { try PermissionGuideApplication.current() }) {
        self.application = application
        super.init()
    }

    var permissionOwner: [String: Any]? { (try? application())?.metadata }

    var status: [String: Any] {
        var value: [String: Any] = ["shown": panel?.isVisible == true]
        if let owner = permissionOwner { value["appName"] = owner["appName"] }
        if let content { value["kind"] = content.kind }
        return value
    }

    func open(_ rawKind: Any?) throws -> [String: Any] {
        // Reject unknown kinds and non-app/test executables before any window,
        // Finder activation or System Settings action can occur.
        let next = try PermissionGuideContent.validated(rawKind)
        let application = try application()
        let result = try NativeApplicationCatalog.openSystemSettings(next.kind)
        guard result["opened"] as? Bool == true else {
            throw ComputerError("SETTINGS_OPEN_FAILED", "无法打开系统权限设置，请稍后重试。")
        }
        // Rebuild the card from the freshly proved identity, including after a
        // host update. Existing timers and drag callbacks are fenced by close.
        close()
        content = next
        makePanel(application)
        startFollowing()
        // Ready describes a successfully initialized guide. A cold Settings
        // launch can become visible later; status.shown always stays truthful.
        return ["opened": true, "guideReady": true, "kind": next.kind, "supported": true,
                "appName": application.name]
    }

    private func makePanel(_ application: PermissionGuideApplication) {
        let window = PermissionGuidePanel(contentRect: NSRect(x: 0, y: 0, width: 320, height: 84),
                                         styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        // The title remains accessibility metadata; there is no visible header.
        window.title = "QiuYaTools 电脑操控授权应用"
        window.isReleasedWhenClosed = false; window.delegate = self
        window.level = .floating; window.isFloatingPanel = true; window.hidesOnDeactivate = false
        window.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        window.backgroundColor = .clear; window.isOpaque = false; window.hasShadow = true
        window.isMovableByWindowBackground = false
        let drag = PermissionApplicationDragView(application: application, source: self.application, onFailure: { [weak self] in
            self?.close()
        }, onDragEnded: { [weak self] in self?.followSettings() })
        drag.frame = NSRect(x: 0, y: 0, width: 320, height: 84)
        drag.autoresizingMask = [.width, .height]
        dragView = drag
        window.contentView = drag; panel = window
    }
    private func settingsFrame() -> CGRect? {
        let pids = Set(NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.systempreferences").map { $0.processIdentifier })
        guard !pids.isEmpty,
              let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
              let primaryHeight = NSScreen.screens.first?.frame.maxY else { return nil }
        // Window geometry is public WindowServer metadata. This does not read
        // a screenshot, use Accessibility, or inspect window titles/content.
        for row in windows {
            guard let pid = row[kCGWindowOwnerPID as String] as? NSNumber, pids.contains(pid.int32Value),
                  row[kCGWindowLayer as String] as? Int == 0,
                  let bounds = row[kCGWindowBounds as String] as? [String: Any],
                  let quartz = CGRect(dictionaryRepresentation: bounds as CFDictionary),
                  [quartz.minX, quartz.minY, quartz.width, quartz.height].allSatisfy({ $0.isFinite }),
                  quartz.width >= 300, quartz.height >= 200 else { continue }
            return CGRect(x: quartz.minX, y: primaryHeight - quartz.maxY, width: quartz.width, height: quartz.height)
        }
        return nil
    }
    private func followSettings(revision: UInt64? = nil) {
        guard lifetime.accepts(revision), let panel, content != nil, dragView?.isDragging != true else { return }
        guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.apple.systempreferences",
              let settings = settingsFrame(),
              let screen = NSScreen.screens.max(by: { a, b in
                  func overlap(_ rect: CGRect) -> CGFloat { let value = rect.intersection(settings); return value.isNull ? 0 : value.width * value.height }
                  return overlap(a.visibleFrame) < overlap(b.visibleFrame)
              }) else { panel.orderOut(nil); panel.ignoresMouseEvents = false; return }
        let next = PermissionGuidePlacement.frame(size: panel.frame.size, beside: settings, in: screen.visibleFrame)
        if panel.frame != next { panel.setFrame(next, display: true) }
        if !panel.isVisible { panel.orderFrontRegardless() }
    }
    private func startFollowing() {
        followTimer?.invalidate()
        let revision = lifetime.begin()
        let timer = Timer(timeInterval: 0.4, repeats: true) { [weak self] timer in
            MainActor.assumeIsolated {
                guard let self else { timer.invalidate(); return }
                self.followSettings(revision: revision)
            }
        }
        followTimer = timer; RunLoop.main.add(timer, forMode: .common)
        followSettings()
    }
    func windowWillClose(_ notification: Notification) {
        lifetime.end(); content = nil
        followTimer?.invalidate(); followTimer = nil
        dragView?.restoreMouseRouting(); panel?.ignoresMouseEvents = false
    }
    func close() {
        // Fence callbacks before closing the AppKit window: closing during a
        // native drag can synchronously or later deliver its endedAt callback.
        lifetime.end(); content = nil
        followTimer?.invalidate(); followTimer = nil
        dragView?.restoreMouseRouting(); panel?.ignoresMouseEvents = false; panel?.close()
    }
}
