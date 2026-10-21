import AppKit
import ApplicationServices
import Darwin
import Foundation

enum NativeLeaseActor: String {
    case ai, human
    static func parse(_ value: Any?) throws -> NativeLeaseActor {
        guard let value else { return .ai }
        guard let raw = value as? String, let actor = NativeLeaseActor(rawValue: raw) else {
            throw ComputerError("INVALID_ACTOR", "The input lease actor must be ai or human.")
        }
        return actor
    }
}

/// This panel is a visual receipt of actual AI pointer input. It never receives
/// focus, hit tests, or input, and is separate from the user's real OS cursor.
@MainActor private final class AICursorPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

@MainActor private final class AICursorView: NSView {
    var tip = CGPoint(x: 10, y: 10)
    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func draw(_ dirtyRect: NSRect) {
        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }
        let arrow = NSBezierPath()
        let points: [CGPoint] = [.zero, CGPoint(x: 0, y: 29), CGPoint(x: 8, y: 22),
            CGPoint(x: 16, y: 38), CGPoint(x: 23, y: 34), CGPoint(x: 15, y: 20), CGPoint(x: 29, y: 20)]
        arrow.move(to: tip)
        for point in points.dropFirst() { arrow.line(to: CGPoint(x: tip.x + point.x, y: tip.y + point.y)) }
        arrow.close()
        let glow = NSShadow()
        glow.shadowColor = NSColor(calibratedWhite: 0.22, alpha: 0.42)
        glow.shadowBlurRadius = 7; glow.shadowOffset = .zero; glow.set()
        NSColor(calibratedWhite: 0.57, alpha: 0.96).setFill(); arrow.fill()
        NSColor.white.setStroke(); arrow.lineWidth = 2; arrow.lineJoinStyle = .round; arrow.stroke()
    }
}

@MainActor final class AICursorOverlay {
    private var panel: AICursorPanel?
    private var arrowView: AICursorView?
    private var timer: Timer?
    private var workspaceObservers: [NSObjectProtocol] = []
    private var target: NativeTarget?
    private var epoch: Int?
    private var postedPoints: [CGPoint] = []
    private var lastPostedAt = ProcessInfo.processInfo.systemUptime
    private var phase = "hidden"
    private var point = CGPoint.zero
    private var pendingReadback = false
    var isLeaseCurrent: ((Int) -> Bool)?

    /// Called only after CGEvent.post. A requested endpoint alone is never shown.
    func posted(_ requested: CGPoint, phase: String, epoch: Int, target: NativeTarget) {
        if self.epoch != epoch || self.target?.id != target.id || self.target?.frame != target.frame {
            hide()
            self.epoch = epoch; self.target = target
        }
        self.phase = phase
        postedPoints.append(requested)
        if postedPoints.count > 32 { postedPoints.removeFirst(postedPoints.count - 32) }
        lastPostedAt = ProcessInfo.processInfo.systemUptime
        pendingReadback = true
        beginWatching()
        refresh()
    }

    func settled(epoch: Int) {
        guard self.epoch == epoch else { return }
        phase = "idle"
        // Old points must not resurrect a cursor after a human moves away.
        if let last = postedPoints.last { postedPoints = [last] }
        refresh()
    }

    func hide() {
        timer?.invalidate(); timer = nil
        for observer in workspaceObservers { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
        workspaceObservers.removeAll()
        panel?.orderOut(nil); panel?.close(); panel = nil; arrowView = nil
        target = nil; epoch = nil; postedPoints.removeAll(); pendingReadback = false; phase = "hidden"
    }

    func desktopSnapshot() -> [String: Any] {
        refresh()
        return ["x": point.x, "y": point.y, "visible": panel?.isVisible == true,
            "actor": "ai", "phase": phase, "epoch": epoch as Any? ?? NSNull(),
            "targetId": target?.id as Any? ?? NSNull(), "coordinateSpace": "desktop"]
    }

    func snapshot(target expected: NativeTarget, geometry: FrameGeometry) -> [String: Any] {
        refresh()
        let visible = panel?.isVisible == true && target?.id == expected.id && target?.frame == geometry.frame
        let local = Self.rasterPoint(point, geometry: geometry)
        var result: [String: Any] = ["x": local.x, "y": local.y, "visible": visible,
            "actor": "ai", "phase": visible ? phase : "hidden"]
        if let epoch { result["epoch"] = epoch }
        return result
    }

    static func rasterPoint(_ point: CGPoint, geometry: FrameGeometry) -> CGPoint {
        guard geometry.frame.width > 0, geometry.frame.height > 0 else { return .zero }
        return CGPoint(x: (point.x - geometry.frame.minX) * Double(geometry.pixelWidth) / geometry.frame.width,
            y: (point.y - geometry.frame.minY) * Double(geometry.pixelHeight) / geometry.frame.height)
    }

    static func clippedFrame(at point: CGPoint, target: CGRect) -> CGRect {
        // Clip both the arrow and its glow to the authorized target bounds.
        CGRect(x: point.x - 10, y: point.y - 10, width: 50, height: 58).intersection(target)
    }

    static func isSystemCursorWindow(layer: CGWindowLevel?, ownerPID: pid_t?,
        verifyOwner: (pid_t) -> Bool = verifiedWindowServer) -> Bool {
        guard layer == CGWindowLevelForKey(.cursorWindow), let ownerPID, ownerPID > 0 else { return false }
        return verifyOwner(ownerPID)
    }

    nonisolated private static func verifiedWindowServer(_ pid: pid_t) -> Bool {
        // WindowServer's real cursor is also a CG window, above the target. Only
        // this exact system executable at the exact cursor layer is excluded;
        // another application's floating or cursor-level window still occludes.
        func processPath() -> String? {
            var buffer = [CChar](repeating: 0, count: 4096)
            guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return nil }
            return String(validatingUTF8: buffer)
        }
        guard let path = processPath() else { return false }
        var executable = stat()
        guard stat(path, &executable) == 0, executable.st_uid == 0,
              (executable.st_mode & S_IFMT) == S_IFREG else { return false }
        let systemPaths = ["/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer",
            "/System/Library/PrivateFrameworks/SkyLight.framework/Versions/A/Resources/WindowServer"]
        let trusted = systemPaths.contains { path in
            var system = stat()
            return stat(path, &system) == 0 && system.st_uid == 0 && (system.st_mode & S_IFMT) == S_IFREG &&
                executable.st_dev == system.st_dev && executable.st_ino == system.st_ino
        }
        // Re-read instead of caching a bare PID, which could have been reused.
        return trusted && processPath() == path
    }

    private func beginWatching() {
        guard timer == nil else { return }
        let source = Timer(timeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
        timer = source; RunLoop.main.add(source, forMode: .common)
        for name in [NSWorkspace.didActivateApplicationNotification, NSWorkspace.didTerminateApplicationNotification,
                     NSWorkspace.activeSpaceDidChangeNotification, NSWorkspace.screensDidSleepNotification] {
            workspaceObservers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    if name == NSWorkspace.screensDidSleepNotification { self?.hide() } else { self?.refresh() }
                }
            })
        }
    }

    private func refresh() {
        guard let target, let epoch else { return }
        guard isLeaseCurrent?(epoch) == true, NSWorkspace.shared.frontmostApplication?.processIdentifier == target.pid,
              let actual = CGEvent(source: nil)?.location else { hide(); return }
        let matchesPosted = postedPoints.contains { hypot($0.x - actual.x, $0.y - actual.y) <= 1.5 }
        if !matchesPosted {
            // Event posting is asynchronous. Wait briefly for the real cursor,
            // but never draw at the requested future point during that interval.
            panel?.orderOut(nil)
            if !pendingReadback || ProcessInfo.processInfo.systemUptime - lastPostedAt > 0.12 { hide() }
            return
        }
        pendingReadback = false
        guard target.frame.contains(actual), targetOwnsVisiblePoint(target, point: actual) else { hide(); return }
        point = actual
        let clipped = Self.clippedFrame(at: actual, target: target.frame)
        guard !clipped.isNull, !clipped.isEmpty else { hide(); return }
        if panel == nil {
            let view = AICursorView(frame: .zero)
            let overlay = AICursorPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            overlay.title = "QiuYaTools AI pointer"
            overlay.isOpaque = false; overlay.backgroundColor = .clear; overlay.hasShadow = false
            overlay.ignoresMouseEvents = true; overlay.hidesOnDeactivate = false; overlay.isReleasedWhenClosed = false
            overlay.isFloatingPanel = true; overlay.level = .floating
            overlay.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
            overlay.contentView = view; overlay.setAccessibilityElement(false); view.setAccessibilityElement(false)
            panel = overlay; arrowView = view
        }
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        panel?.setFrame(CGRect(x: clipped.minX, y: primaryHeight - clipped.maxY, width: clipped.width, height: clipped.height), display: false)
        arrowView?.tip = CGPoint(x: actual.x - clipped.minX, y: actual.y - clipped.minY)
        arrowView?.needsDisplay = true
        panel?.orderFrontRegardless()
    }

    private func targetOwnsVisiblePoint(_ target: NativeTarget, point: CGPoint) -> Bool {
        guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return false }
        let ownId = panel.map { CGWindowID($0.windowNumber) }
        var targetValid = false
        var firstCovering: CGWindowID?
        for item in windows {
            guard let id = (item[kCGWindowNumber as String] as? NSNumber)?.uint32Value, id != ownId,
                  let bounds = item[kCGWindowBounds as String] as? [String: Any], let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { continue }
            if id == target.windowId {
                targetValid = (item[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == target.pid &&
                    abs(rect.minX - target.frame.minX) < 1 && abs(rect.minY - target.frame.minY) < 1 &&
                    abs(rect.width - target.frame.width) < 1 && abs(rect.height - target.frame.height) < 1
            }
            if Self.isSystemCursorWindow(layer: (item[kCGWindowLayer as String] as? NSNumber)?.int32Value,
                ownerPID: (item[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value) { continue }
            if firstCovering == nil, rect.contains(point), (item[kCGWindowAlpha as String] as? NSNumber)?.doubleValue != 0 { firstCovering = id }
        }
        return targetValid && firstCovering == target.windowId
    }
}
