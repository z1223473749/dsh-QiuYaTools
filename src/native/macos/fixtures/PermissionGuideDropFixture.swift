import AppKit
import Foundation

// An isolated native drag destination. A success receipt is written only by
// AppKit's real performDragOperation callback after reading public.file-url.
// This fixture never requests TCC access, captures a screen or injects input.
private let expectedBundleIdentifier = "com.qiuya.tools.computer-use"

private struct FixtureOptions {
    let expectedApp: URL
    let report: URL
    let timeout: TimeInterval

    static func parse(_ arguments: [String]) throws -> FixtureOptions {
        var values: [String: String] = [:]
        var index = 0
        while index < arguments.count {
            let key = arguments[index]
            guard ["--expected-app", "--report", "--timeout"].contains(key), values[key] == nil,
                  index + 1 < arguments.count else { throw FixtureFailure.invalidArguments }
            values[key] = arguments[index + 1]
            index += 2
        }
        guard let expected = values["--expected-app"], expected.hasPrefix("/"),
              let report = values["--report"], report.hasPrefix("/"),
              let timeout = TimeInterval(values["--timeout"] ?? "120"), timeout.isFinite,
              timeout >= 1, timeout <= 300 else { throw FixtureFailure.invalidArguments }
        let app = URL(fileURLWithPath: expected, isDirectory: true).standardizedFileURL.resolvingSymlinksInPath()
        let output = URL(fileURLWithPath: report).standardizedFileURL.resolvingSymlinksInPath()
        var directory: ObjCBool = false
        guard app.pathExtension.lowercased() == "app",
              FileManager.default.fileExists(atPath: app.path, isDirectory: &directory), directory.boolValue,
              Bundle(url: app)?.bundleIdentifier == expectedBundleIdentifier,
              !output.path.hasPrefix(app.path + "/") else { throw FixtureFailure.invalidArguments }
        return FixtureOptions(expectedApp: app, report: output, timeout: timeout)
    }
}

private enum FixtureFailure: Error { case invalidArguments }

private struct VerifiedDrop {
    let offeredFileCount: Int
    let appName: String
    let bundleIdentifier: String
}

private final class PermissionDropZone: NSView {
    private let expectedApp: URL
    private let accepted: (VerifiedDrop) throws -> Void
    private let heading = NSTextField(labelWithString: "将授权引导窗口中的应用拖到这里")
    private let caption = NSTextField(labelWithString: "仅验证真实应用文件，不会修改系统权限")
    private let icon = NSImageView()
    private var hovering = false
    private var passed = false

    init(frame: NSRect, expectedApp: URL, accepted: @escaping (VerifiedDrop) throws -> Void) {
        self.expectedApp = expectedApp
        self.accepted = accepted
        super.init(frame: frame)
        registerForDraggedTypes([.fileURL])
        icon.image = NSImage(systemSymbolName: "square.and.arrow.down", accessibilityDescription: "应用文件接收区")
        icon.contentTintColor = NSColor(calibratedRed: 0.06, green: 0.45, blue: 0.51, alpha: 1)
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.frame = NSRect(x: (frame.width - 36) / 2, y: 103, width: 36, height: 36)
        heading.font = .systemFont(ofSize: 14, weight: .medium)
        heading.alignment = .center
        heading.frame = NSRect(x: 12, y: 66, width: frame.width - 24, height: 24)
        caption.font = .systemFont(ofSize: 12)
        caption.textColor = .secondaryLabelColor
        caption.alignment = .center
        caption.frame = NSRect(x: 12, y: 39, width: frame.width - 24, height: 20)
        addSubview(icon)
        addSubview(heading)
        addSubview(caption)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("权限引导应用文件接收区")
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let shape = NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 14, yRadius: 14)
        let tint = NSColor(calibratedRed: 0.06, green: 0.45, blue: 0.51, alpha: 1)
        (hovering || passed ? tint.withAlphaComponent(0.08) : NSColor.white).setFill()
        shape.fill()
        (hovering || passed ? tint : NSColor(calibratedWhite: 0.79, alpha: 1)).setStroke()
        shape.lineWidth = hovering ? 2 : 1
        if !passed { shape.setLineDash([6, 4], count: 2, phase: 0) }
        shape.stroke()
    }

    private func verified(_ sender: NSDraggingInfo) -> VerifiedDrop? {
        let pasteboard = sender.draggingPasteboard
        guard let items = pasteboard.pasteboardItems, items.count == 1,
              items[0].types.contains(.fileURL), pasteboard.types?.contains(.fileURL) == true,
              let objects = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]),
              objects.count == 1, let offered = objects[0] as? NSURL, offered.isFileURL else { return nil }
        let canonical = URL(fileURLWithPath: (offered as URL).path, isDirectory: true).standardizedFileURL.resolvingSymlinksInPath()
        guard canonical == expectedApp, let bundle = Bundle(url: canonical),
              let identifier = bundle.bundleIdentifier, identifier == expectedBundleIdentifier else { return nil }
        let appName = bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
            ?? bundle.object(forInfoDictionaryKey: "CFBundleName") as? String
            ?? canonical.deletingPathExtension().lastPathComponent
        return VerifiedDrop(offeredFileCount: objects.count, appName: appName, bundleIdentifier: identifier)
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        hovering = verified(sender) != nil
        needsDisplay = true
        return hovering ? .copy : []
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation { draggingEntered(sender) }

    override func draggingExited(_ sender: NSDraggingInfo?) {
        hovering = false
        needsDisplay = true
    }

    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool { verified(sender) != nil }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard let drop = verified(sender) else { return false }
        do {
            try accepted(drop)
            passed = true
            hovering = false
            heading.stringValue = "已确认真实应用文件拖入"
            caption.stringValue = "QiuYaTools Computer · 文件类型与应用身份匹配"
            icon.image = NSImage(systemSymbolName: "checkmark.circle", accessibilityDescription: "拖拽验收成功")
            needsDisplay = true
            return true
        } catch {
            hovering = false
            heading.stringValue = "验收记录未能保存，请重试"
            needsDisplay = true
            return false
        }
    }
}

private final class PermissionDropApplication: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let options: FixtureOptions
    private var window: NSWindow?
    private var timeout: Timer?
    private var passed = false
    var exitCode: Int32 = 2

    init(options: FixtureOptions) { self.options = options }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 440, height: 260))
        content.wantsLayer = true
        content.layer?.backgroundColor = NSColor(calibratedWhite: 0.97, alpha: 1).cgColor
        let title = NSTextField(labelWithString: "QiuYaTools 权限拖拽验收")
        title.font = .systemFont(ofSize: 16, weight: .semibold)
        title.frame = NSRect(x: 24, y: 217, width: 392, height: 24)
        let zone = PermissionDropZone(frame: NSRect(x: 24, y: 24, width: 392, height: 178), expectedApp: options.expectedApp) { [weak self] drop in
            guard let self else { throw FixtureFailure.invalidArguments }
            let receipt: [String: Any] = ["passed": true, "offeredFileCount": drop.offeredFileCount,
                "appName": drop.appName, "bundleIdentifier": drop.bundleIdentifier, "fileURLTypeVerified": true]
            let data = try JSONSerialization.data(withJSONObject: receipt, options: [.prettyPrinted, .sortedKeys])
            try FileManager.default.createDirectory(at: self.options.report.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: self.options.report, options: .atomic)
            self.passed = true
            self.exitCode = 0
        }
        content.addSubview(title)
        content.addSubview(zone)
        let window = NSWindow(contentRect: content.bounds, styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "QiuYaTools 权限拖拽验收"
        window.contentView = content
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.center()
        self.window = window
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        timeout = Timer.scheduledTimer(withTimeInterval: options.timeout, repeats: false) { [weak self] _ in
            guard let self else { return }
            self.exitCode = self.passed ? 0 : 3
            NSApp.terminate(nil)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) {
        timeout?.invalidate()
        // AppKit terminate() exits directly; it need not return from app.run()
        // to the exit below. Preserve timeout/early-close failure codes here.
        // Only performDragOperation's successfully written receipt sets zero.
        exit(exitCode)
    }
}

do {
    let options = try FixtureOptions.parse(Array(CommandLine.arguments.dropFirst()))
    let app = NSApplication.shared
    let delegate = PermissionDropApplication(options: options)
    app.setActivationPolicy(.regular)
    app.delegate = delegate
    app.run()
    exit(delegate.exitCode)
} catch {
    FileHandle.standardError.write(Data("PERMISSION_GUIDE_DROP_FIXTURE_INVALID_ARGUMENTS\n".utf8))
    exit(2)
}
