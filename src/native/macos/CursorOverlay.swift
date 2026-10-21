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

/// Only this process's one matched NSCursor hide/unhide is owned here. Global
/// cursor visibility cannot identify another application's hide count.
@MainActor struct CursorCounterBackend {
    let unsupportedReason: String?
    let ownsConnection: () -> Bool
    let setBackground: (Bool) -> Bool
    let property: () -> Bool?
    let hide: () -> Void
    let unhide: () -> Void
    let diagnostic: () -> [String: Any]

    static func native() -> CursorCounterBackend {
        typealias ConnectionFn = @convention(c) () -> Int32
        typealias OwnerFn = @convention(c) (Int32, UnsafeMutablePointer<pid_t>) -> Int32
        typealias SetFn = @convention(c) (Int32, Int32, CFString, CFTypeRef) -> Int32
        typealias CopyFn = @convention(c) (Int32, Int32, CFString, UnsafeMutablePointer<Unmanaged<CFTypeRef>?>) -> Int32
        func unsupported(_ reason: String) -> CursorCounterBackend {
            CursorCounterBackend(unsupportedReason: reason, ownsConnection: { false }, setBackground: { _ in false }, property: { nil }, hide: {}, unhide: {}, diagnostic: { ["supported": false, "reason": reason] })
        }
        let handle = UnsafeMutableRawPointer(bitPattern: -2)
        guard let connectionSymbol = dlsym(handle, "CGSMainConnectionID") ?? dlsym(handle, "_CGSDefaultConnection"),
              let ownerSymbol = dlsym(handle, "CGSConnectionGetPID"), let setterSymbol = dlsym(handle, "CGSSetConnectionProperty"),
              let copySymbol = dlsym(handle, "CGSCopyConnectionProperty") else { return unsupported("BACKGROUND_CURSOR_SPI_UNAVAILABLE") }
        let connection = unsafeBitCast(connectionSymbol, to: ConnectionFn.self), owner = unsafeBitCast(ownerSymbol, to: OwnerFn.self)
        let setter = unsafeBitCast(setterSymbol, to: SetFn.self), copy = unsafeBitCast(copySymbol, to: CopyFn.self), cid = connection()
        let owns = { () -> Bool in var pid: pid_t = 0; return cid > 0 && connection() == cid && owner(cid, &pid) == 0 && pid == getpid() }
        guard owns() else { return unsupported("BACKGROUND_CURSOR_CONNECTION_UNVERIFIED") }
        var last: [String: Any] = ["supported": true, "cid": cid, "property": NSNull(), "copyCode": NSNull(), "spi": true]
        // ABI and Copy ownership follow the original CGSInternal declaration.
        // No Get fallback or numeric truthiness is accepted.
        return CursorCounterBackend(unsupportedReason: nil, ownsConnection: owns, setBackground: { enabled in
            guard owns() else { return false }
            let code = setter(cid, cid, "SetsCursorInBackground" as CFString, enabled ? kCFBooleanTrue : kCFBooleanFalse)
            last["setCode"] = code; return code == 0
        }, property: {
            guard owns() else { last["property"] = NSNull(); return nil }
            var output: Unmanaged<CFTypeRef>?
            let code = copy(cid, cid, "SetsCursorInBackground" as CFString, &output); last["copyCode"] = code; last["property"] = NSNull()
            guard code == 0, let output else { return nil }
            let value = output.takeRetainedValue()
            guard CFGetTypeID(value) == CFBooleanGetTypeID(), owns() else { return nil }
            let result = CFBooleanGetValue((value as! CFBoolean)); last["property"] = result; return result
        }, hide: { NSCursor.hide() }, unhide: { NSCursor.unhide() }, diagnostic: { last })
    }
}

@MainActor final class SystemCursorSuppression {
    struct Owner: Equatable { let epoch: Int; let leaseOwnerId: String; let targetId: String }
    private let backend: CursorCounterBackend
    private(set) var phase: String
    private(set) var ownsHide = false
    private(set) var ownsProperty = false
    private(set) var owner: Owner?
    private var interruptedEpoch: Int?
    private var reason: String?
    var onTransition: (([String: Any]) -> Void)?
    init(backend: CursorCounterBackend) { self.backend = backend; phase = backend.unsupportedReason == nil ? "idle" : "unsupported"; reason = backend.unsupportedReason }
    var clear: Bool { !ownsHide && !ownsProperty }
    var available: Bool { phase != "unsupported" }
    func interrupted(_ epoch: Int) -> Bool { interruptedEpoch == epoch }
    func beginLease(_ epoch: Int) { if interruptedEpoch != epoch { interruptedEpoch = nil } }
    private func change(_ value: String, _ cause: String? = nil) {
        if phase == value && reason == cause { return }
        phase = value; reason = cause; onTransition?(snapshot)
    }
    var snapshot: [String: Any] {
        ["phase": phase, "supported": available, "ownedHideCount": ownsHide ? 1 : 0, "propertyOwned": ownsProperty,
         "epoch": owner?.epoch as Any? ?? NSNull(), "targetId": owner?.targetId as Any? ?? NSNull(),
         "reason": reason as Any? ?? NSNull(), "interruptedEpoch": interruptedEpoch as Any? ?? NSNull(), "backend": backend.diagnostic()]
    }
    @discardableResult func activate(_ next: Owner, eligible: () -> Bool) -> Bool {
        guard next.epoch >= 0, !next.leaseOwnerId.isEmpty, !next.targetId.isEmpty, available, !interrupted(next.epoch), eligible() else { return false }
        if owner == next && ownsHide {
            guard phase == "hidden" else { return false }
            guard backend.ownsConnection() else { _ = restore("connection-changed"); return false }
            return true
        }
        if !clear && !restore("owner-transition") { return false }
        guard backend.ownsConnection() else { change("unsupported", "BACKGROUND_CURSOR_CONNECTION_UNVERIFIED"); return false }
        guard eligible() else { return false }
        // This dedicated helper is the only user of this own-connection key.
        // An observed pre-existing true value is nevertheless not ours to
        // reset. An absent key may read unknown until the first own setter.
        guard backend.property() != true else { change("unsupported", "BACKGROUND_CURSOR_PROPERTY_ALREADY_SET"); return false }
        guard eligible() else { return false }
        owner = next; change("arming")
        // Retain possible property ownership even when a setter fails. No Hide
        // is allowed until the synchronous same-connection CFBoolean fence.
        ownsProperty = true
        guard backend.setBackground(true), backend.property() == true, backend.ownsConnection() else {
            if restore("property-before-hide-unconfirmed") { change("unsupported", "BACKGROUND_CURSOR_PROPERTY_UNCONFIRMED") }
            return false
        }
        guard eligible(), !interrupted(next.epoch) else { _ = restore("authorization-changed-before-hide"); return false }
        ownsHide = true; backend.hide()
        let stillEligible = eligible()
        guard stillEligible, ownsHide, owner == next, !interrupted(next.epoch) else { _ = restore("authorization-changed-after-hide"); return false }
        change("hidden")
        return true
    }
    @discardableResult func interrupt(_ epoch: Int, reason: String) -> Bool {
        if let owner, owner.epoch != epoch { return clear }
        interruptedEpoch = epoch
        return restore(reason)
    }
    @discardableResult func restore(_ cause: String, expectedOwner: Owner? = nil) -> Bool {
        if let expectedOwner, owner != expectedOwner { return clear }
        if clear { owner = nil; if phase != "unsupported" { change("idle") }; return true }
        change("restoring", cause)
        if ownsHide {
            guard backend.ownsConnection(), backend.property() == true else { change("blocked", "CURSOR_PRE_UNHIDE_UNCONFIRMED"); return false }
            // This invocation cannot be replayed, even if the subsequent
            // property reset or its readback fails.
            backend.unhide(); ownsHide = false
        }
        if ownsProperty {
            guard backend.ownsConnection(), backend.setBackground(false), backend.property() == false else { change("blocked", "CURSOR_PROPERTY_RESET_UNCONFIRMED"); return false }
            ownsProperty = false
        }
        owner = nil; change("idle"); return true
    }
}

/// This panel is a visual receipt of actual AI pointer input. It never receives
/// focus, hit tests, or input, and is separate from the user's real OS cursor.
@MainActor private final class AICursorPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

@MainActor enum AICursorGlyph {
    static let hotspot = CGPoint(x: 2, y: 3)

    static func path(at tip: CGPoint) -> NSBezierPath {
        let offset = CGPoint(x: tip.x - hotspot.x, y: tip.y - hotspot.y)
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: offset.x + x, y: offset.y + y) }
        // The same 18 × 20 paper-plane outline as the user-approved review and
        // preview SVG. The small tip, rather than the glow's bounds, is input.
        let arrow = NSBezierPath()
        arrow.move(to: p(3.1, 2.4))
        arrow.curve(to: p(1.8, 3.5), controlPoint1: p(2.3, 2), controlPoint2: p(1.6, 2.6))
        arrow.line(to: p(4, 16))
        arrow.curve(to: p(6, 16.3), controlPoint1: p(4.2, 17.1), controlPoint2: p(5.4, 17.3))
        arrow.line(to: p(9, 11.4)); arrow.line(to: p(14.4, 9.1))
        arrow.curve(to: p(14.5, 6.9), controlPoint1: p(15.5, 8.7), controlPoint2: p(15.6, 7.4))
        arrow.close()
        return arrow
    }

    static func draw(at tip: CGPoint) {
        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        let arrow = path(at: tip)
        let glow = NSShadow()
        glow.shadowColor = NSColor(srgbRed: 81 / 255, green: 84 / 255, blue: 90 / 255, alpha: 0.44)
        glow.shadowBlurRadius = 10; glow.shadowOffset = CGSize(width: 0, height: -1); glow.set()
        // A single composite shadow avoids drawing separate opaque halos for
        // the translucent fill and white outline. The broad, soft falloff has
        // no solid background or mouse-event surface.
        context.beginTransparencyLayer(auxiliaryInfo: nil)
        NSColor(srgbRed: 149 / 255, green: 153 / 255, blue: 158 / 255, alpha: 0.45).setFill(); arrow.fill()
        NSColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.96).setStroke()
        arrow.lineWidth = 1.25; arrow.lineJoinStyle = .round; arrow.lineCapStyle = .round; arrow.stroke()
        context.endTransparencyLayer()
    }
}

@MainActor private final class AICursorView: NSView {
    var tip = CGPoint.zero
    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func draw(_ dirtyRect: NSRect) { AICursorGlyph.draw(at: tip) }
}

@MainActor final class AICursorOverlay {
    private let suppression: SystemCursorSuppression
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
    private var restorationTimer: Timer?
    private var restorationStarted: TimeInterval?
    private var restorationGeneration: UInt64 = 0
    private var restorationFailureReported = false
    private var sessionInactive = false
    var isLeaseCurrent: ((Int) -> Bool)?
    var physicalLeaseOwner: ((Int) -> String?)?
    var onRestorationFailure: (() -> Void)?
    var onSuppressionTransition: (([String: Any]) -> Void)?

    convenience init(backend: CursorCounterBackend? = nil) { self.init(suppression: SystemCursorSuppression(backend: backend ?? .native())) }
    init(suppression: SystemCursorSuppression) {
        self.suppression = suppression
        suppression.onTransition = { [weak self] value in self?.onSuppressionTransition?(value) }
    }
    func beginLease(_ epoch: Int) { sessionInactive = !Self.sessionActive(); suppression.beginLease(epoch) }
    var restorationComplete: Bool { suppression.clear }
    var restorationBlocked: Bool { !suppression.clear && suppression.phase != "hidden" }
    @discardableResult func humanIntervened(_ epoch: Int) -> Bool {
        // A real intervention can arrive after the physical lease but before
        // the first posted point/panel. Latch that owner without requiring UI.
        guard isLeaseCurrent?(epoch) == true, let ownerId = physicalLeaseOwner?(epoch), !ownerId.isEmpty else { return suppression.clear }
        if let owner = suppression.owner, owner.epoch != epoch || owner.leaseOwnerId != ownerId { return suppression.clear }
        _ = suppression.interrupt(epoch, reason: "human-input")
        return hide()
    }

    func withdrawForPointerReadback(epoch: Int, targetId: String) {
        panel?.orderOut(nil)
        guard let owner = suppression.owner, owner.epoch == epoch, owner.targetId == targetId else { return }
        // Pending cursor-position delivery may postpone drawing, never the
        // restoration of a cursor whose visual replacement is now absent.
        maintainRestoration(suppression.restore("pointer-readback-mismatch", expectedOwner: owner))
    }

    /// Called only after CGEvent.post. A requested endpoint alone is never shown.
    func posted(_ requested: CGPoint, phase: String, epoch: Int, target: NativeTarget) {
        guard isLeaseCurrent?(epoch) == true, let ownerId = physicalLeaseOwner?(epoch), !ownerId.isEmpty, !suppression.interrupted(epoch) else { return }
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

    @discardableResult func hide() -> Bool {
        timer?.invalidate(); timer = nil
        for observer in workspaceObservers { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
        workspaceObservers.removeAll()
        panel?.orderOut(nil); panel?.close(); panel = nil; arrowView = nil
        target = nil; epoch = nil; postedPoints.removeAll(); pendingReadback = false; phase = "hidden"
        let restored = suppression.restore("overlay-hidden")
        maintainRestoration(restored)
        return restored
    }

    private func maintainRestoration(_ restored: Bool) {
        if restored {
            restorationGeneration &+= 1
            restorationTimer?.invalidate(); restorationTimer = nil; restorationStarted = nil; restorationFailureReported = false
            return
        }
        guard restorationTimer == nil, !restorationFailureReported else { return }
        restorationGeneration &+= 1; let generation = restorationGeneration, pendingOwner = suppression.owner
        restorationStarted = ProcessInfo.processInfo.systemUptime
        // This timer deliberately survives panel/target/visual-timer teardown.
        let source = Timer(timeInterval: 0.025, repeats: true) { [weak self] _ in MainActor.assumeIsolated {
            guard let self, self.restorationGeneration == generation else { return }
            if self.suppression.restore("pending-restoration", expectedOwner: pendingOwner) { self.maintainRestoration(true); return }
            if ProcessInfo.processInfo.systemUptime - (self.restorationStarted ?? 0) >= 0.5 {
                self.restorationTimer?.invalidate(); self.restorationTimer = nil; self.restorationFailureReported = true
                self.onRestorationFailure?()
            }
        } }
        restorationTimer = source; RunLoop.main.add(source, forMode: .common)
    }

    func desktopSnapshot() -> [String: Any] {
        refresh()
        return ["x": point.x, "y": point.y, "visible": panel?.isVisible == true,
            "actor": "ai", "phase": phase, "epoch": epoch as Any? ?? NSNull(),
            "targetId": target?.id as Any? ?? NSNull(), "coordinateSpace": "desktop", "systemCursorSuppression": suppression.snapshot]
    }

    func snapshot(target expected: NativeTarget, geometry: FrameGeometry) -> [String: Any] {
        refresh()
        let visible = panel?.isVisible == true && target?.id == expected.id && target?.frame == geometry.frame
        let local = Self.rasterPoint(point, geometry: geometry)
        var result: [String: Any] = ["x": local.x, "y": local.y, "visible": visible,
            "actor": "ai", "phase": visible ? phase : "hidden", "systemCursorSuppression": suppression.snapshot]
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
        CGRect(x: point.x - 18, y: point.y - 18, width: 48, height: 50).intersection(target)
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
        let watchedEpoch = epoch
        let source = Timer(timeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
        timer = source; RunLoop.main.add(source, forMode: .common)
        for name in [NSWorkspace.didActivateApplicationNotification, NSWorkspace.didTerminateApplicationNotification,
                     NSWorkspace.activeSpaceDidChangeNotification, NSWorkspace.screensDidSleepNotification, NSWorkspace.willSleepNotification,
                     NSWorkspace.sessionDidResignActiveNotification] {
            workspaceObservers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, self.epoch == watchedEpoch else { return }
                    if [NSWorkspace.screensDidSleepNotification, NSWorkspace.willSleepNotification, NSWorkspace.sessionDidResignActiveNotification].contains(name) {
                        self.sessionInactive = true
                        if let epoch = self.epoch { _ = self.suppression.interrupt(epoch, reason: "session-inactive") }
                        self.hide()
                    } else { self.refresh() }
                }
            })
        }
    }

    private func refresh() {
        guard let target, let epoch else { return }
        guard !sessionInactive, Self.sessionActive(), isLeaseCurrent?(epoch) == true, NSWorkspace.shared.frontmostApplication?.processIdentifier == target.pid,
              let actual = CGEvent(source: nil)?.location else { hide(); return }
        let matchesPosted = postedPoints.contains { hypot($0.x - actual.x, $0.y - actual.y) <= 1.5 }
        if !matchesPosted {
            // Event posting is asynchronous. Wait briefly for the real cursor,
            // but never draw at the requested future point during that interval.
            withdrawForPointerReadback(epoch: epoch, targetId: target.id)
            if !pendingReadback || ProcessInfo.processInfo.systemUptime - lastPostedAt > 0.12 { hide() }
            return
        }
        pendingReadback = false
        guard target.frame.contains(actual), targetOwnsVisiblePoint(target, point: actual) else { hide(); return }
        point = actual
        let clipped = Self.clippedFrame(at: actual, target: target.frame)
        guard !clipped.isNull, !clipped.isEmpty else { hide(); return }
        guard let ownerId = physicalLeaseOwner?(epoch), !ownerId.isEmpty else { hide(); return }
        do {
            _ = suppression.activate(.init(epoch: epoch, leaseOwnerId: ownerId, targetId: target.id)) { [weak self] in
                guard let self, !self.sessionInactive, Self.sessionActive(), self.isLeaseCurrent?(epoch) == true,
                      self.physicalLeaseOwner?(epoch) == ownerId, NSWorkspace.shared.frontmostApplication?.processIdentifier == target.pid,
                      let current = CGEvent(source: nil)?.location, hypot(current.x - actual.x, current.y - actual.y) <= 1.5 else { return false }
                return self.targetOwnsVisiblePoint(target, point: current)
            }
            maintainRestoration(suppression.clear || suppression.phase == "hidden")
            guard suppression.phase != "blocked" else { hide(); return }
        }
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

    private static func sessionActive() -> Bool {
        guard let state = CGSessionCopyCurrentDictionary() as? [String: Any],
              (state[kCGSessionOnConsoleKey as String] as? Bool) == true,
              let uid = state[kCGSessionUserIDKey as String] as? NSNumber, uid.uint32Value == getuid(),
              (state["CGSSessionScreenIsLocked"] as? Bool) != true else { return false }
        return true
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
