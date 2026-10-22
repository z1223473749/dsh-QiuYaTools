import AppKit
import ApplicationServices
import Foundation

final class FocusActivationResult {
    var accepted = false
    var axSettableResult: Int32?
    var axFrontmostResult: Int32?
    var raiseResult: Int32?
}

struct FocusPreparationSample {
    let frontmostPid: pid_t?
    let frontmostWindowId: CGWindowID?
}

/// Injectable boundaries keep the cancellation, deadline and consecutive-read
/// contract testable without activating an application or querying real AX.
@MainActor struct FocusPreparationBackend {
    var now: @MainActor () -> TimeInterval
    var frontmost: @MainActor () -> pid_t?
    var request: @MainActor (_ deadline: TimeInterval, _ result: FocusActivationResult) async throws -> Void
    var sample: @MainActor () throws -> FocusPreparationSample
    var sleep: @MainActor (_ nanoseconds: UInt64) async throws -> Void
    var diagnostics: @MainActor () -> [String: Any] = { [:] }
}

@MainActor enum BoundedFocusPreparation {
    static func run(targetPid: pid_t, targetWindowId: CGWindowID, backend: FocusPreparationBackend, checkpoint: () throws -> Void,
                    record: ([String: Any]) -> Void) async throws {
        let begin = backend.now(), deadline = begin + 0.5
        let result = FocusActivationResult(), before = backend.frontmost()
        var after = before
        var phase = "request", samples = 0, consecutive = 0
        var receipt: [String: Any] {
            var value: [String: Any] = ["targetPid": Int(targetPid), "beforePid": before as Any? ?? NSNull(), "afterPid": after as Any? ?? NSNull(),
             "activationAccepted": result.accepted, "settledMs": max(0, Int(((backend.now() - begin) * 1000).rounded())),
             "axSettableResult": result.axSettableResult as Any? ?? NSNull(),
             "axFrontmostResult": result.axFrontmostResult as Any? ?? NSNull(), "raiseResult": result.raiseResult as Any? ?? NSNull(),
             "inputPosted": false, "preparationPhase": phase, "readinessSamples": samples, "consecutiveReadinessSamples": consecutive]
            value.merge(backend.diagnostics()) { original, _ in original }
            return value
        }
        record(receipt)
        defer { after = backend.frontmost(); record(receipt) }
        try Task.checkCancellation(); try checkpoint()
        try await backend.request(deadline, result)
        try Task.checkCancellation(); try checkpoint()
        phase = "readiness"
        while backend.now() < deadline {
            try Task.checkCancellation(); try checkpoint()
            samples += 1
            let sample = try backend.sample()
            after = sample.frontmostPid
            try checkpoint()
            if backend.now() >= deadline { break }
            if after == targetPid && sample.frontmostWindowId == targetWindowId { consecutive += 1 } else { consecutive = 0 }
            record(receipt)
            if consecutive >= 2 { phase = "ready"; return }
            let remaining = deadline - backend.now()
            if remaining <= 0 { break }
            try await backend.sleep(max(1, UInt64((min(0.01, remaining) * 1_000_000_000).rounded(.up))))
        }
        throw ComputerError("FOCUS_CHANGED", "The target application did not become ready for input; input stopped.")
    }
}

/// CG metadata only: no AX text, title or content is needed to identify the
/// selected normal-level window and its position in WindowServer's front order.
struct FocusWindowState: Equatable {
    let windowId: CGWindowID
    let pid: pid_t
    let frame: CGRect
    var layer: Int32 = 0
    var onscreen = true
    var alpha = 1.0
    var normalVisible: Bool { layer == CGWindowLevelForKey(.normalWindow) && onscreen && alpha.isFinite && alpha > 0 }
}

/// Every action uses its actual input destination. CG stacking alone does
/// not identify keyboard focus, and unrelated surfaces do not own a pointer point.
enum FocusInputRoute {
    case pointer(CGPoint)
    case keyboard
    var kind: String { if case .pointer = self { return "pointer" }; return "keyboard" }
}

enum ExactWindowFocus {
    static func sameGeometry(_ a: CGRect, _ b: CGRect) -> Bool {
        abs(a.minX-b.minX) < 1 && abs(a.minY-b.minY) < 1 && abs(a.width-b.width) < 1 && abs(a.height-b.height) < 1
    }
    static func validate(target: NativeTarget, geometry: FrameGeometry, windows: [FocusWindowState]) throws {
        let normal = windows.filter(\.normalVisible)
        guard let selected = normal.first(where: { $0.windowId == target.windowId }), selected.pid == target.pid,
              sameGeometry(selected.frame, geometry.frame) else {
            throw ComputerError("GEOMETRY_CHANGED", "The selected window moved, changed owner, or became unavailable. Observe it again before acting.")
        }
        guard normal.filter({ $0.pid == target.pid && sameGeometry($0.frame, geometry.frame) }).count == 1 else {
            throw ComputerError("FOCUS_CHANGED", "Overlapping app windows have the same geometry; input stopped. Separate the selected window before continuing.")
        }
    }
    static func sameOrderedPrefix(_ before: [FocusWindowState], _ after: [FocusWindowState], selected: CGWindowID) -> Bool {
        let a = before.filter(\.normalVisible), b = after.filter(\.normalVisible)
        guard let ai = a.firstIndex(where: { $0.windowId == selected }), let bi = b.firstIndex(where: { $0.windowId == selected }), ai == bi else { return false }
        return Array(a.prefix(ai+1)) == Array(b.prefix(bi+1))
    }
}

/// Shared selected-window identity checks surround both public routing reads.
/// The complete ordered CG prefix must remain exact, including subpixel bounds.
enum ExactInputIdentity {
    static func check(target: NativeTarget, geometry: FrameGeometry, before: [FocusWindowState], after: [FocusWindowState],
                      beforePid: pid_t?, afterPid: pid_t?, processIdentityCurrent: Bool) throws {
        guard processIdentityCurrent else { throw ComputerError("TARGET_GONE", "The target application exited or its process identity changed.") }
        try ExactWindowFocus.validate(target: target, geometry: geometry, windows: before)
        try ExactWindowFocus.validate(target: target, geometry: geometry, windows: after)
        guard beforePid == target.pid, afterPid == target.pid, ExactWindowFocus.sameOrderedPrefix(before, after, selected: target.windowId) else {
            throw ComputerError("FOCUS_CHANGED", "Window input identity could not be verified; input stopped.")
        }
    }
}

@MainActor struct PointerRoutingBackend {
    var primaryMaxY: () -> Double?
    var windowAt: (CGPoint) -> CGWindowID?
}
@MainActor enum ExactPointerRouting {
    static func appKitPoint(_ point: CGPoint, primaryMaxY: Double) -> CGPoint? {
        guard point.x.isFinite, point.y.isFinite, primaryMaxY.isFinite else { return nil }
        let result = CGPoint(x: point.x, y: primaryMaxY-point.y)
        return result.y.isFinite ? result : nil
    }
    static func check(point: CGPoint, selected: CGWindowID, frame: CGRect, backend: PointerRoutingBackend) throws {
        guard selected > 0, frame.contains(point), let top = backend.primaryMaxY(), let appKit = appKitPoint(point, primaryMaxY: top),
              backend.windowAt(appKit) == selected else {
            throw ComputerError("FOCUS_CHANGED", "The selected window lost foreground input; input stopped.")
        }
    }
    static var native: PointerRoutingBackend {
        // Public global mouseDown routing requires an initialized AppKit connection.
        // Unknown or different CG surfaces are refused, including AX-invisible ones.
        _ = NSApplication.shared
        return PointerRoutingBackend(primaryMaxY: { NSScreen.screens.first.map { Double($0.frame.maxY) } }, windowAt: { point -> CGWindowID? in
            let number = NSWindow.windowNumber(at: point, belowWindowWithWindowNumber: 0)
            guard number > 0, number <= Int(UInt32.max) else { return nil }; return CGWindowID(number)
        })
    }
}

struct KeyboardFocusSnapshot {
    let pid: pid_t
    let frame: CGRect
    let isWindow: Bool
    let identityStable: Bool
}

/// A non-key window can be ordered in front of another key window in the same
/// process. Each normal key down/up requires a readable, stable focused AX root.
enum ExactKeyboardFocus {
    static func check(target: NativeTarget, geometry: FrameGeometry, before: [FocusWindowState], after: [FocusWindowState],
                      beforePid: pid_t?, afterPid: pid_t?, focused: KeyboardFocusSnapshot?, processIdentityCurrent: Bool) throws {
        try ExactInputIdentity.check(target: target, geometry: geometry, before: before, after: after,
            beforePid: beforePid, afterPid: afterPid, processIdentityCurrent: processIdentityCurrent)
        guard let focused, focused.pid == target.pid, focused.isWindow, focused.identityStable,
              [focused.frame.minX, focused.frame.minY, focused.frame.width, focused.frame.height].allSatisfy(\.isFinite),
              focused.frame.width > 0, focused.frame.height > 0, ExactWindowFocus.sameGeometry(focused.frame, geometry.frame) else {
            throw ComputerError("FOCUS_CHANGED", "The selected window does not own keyboard focus; input stopped.")
        }
    }
}

private struct FocusProcessBirth: Equatable {
    let seconds: UInt64
    let microseconds: UInt64
    init?(_ pid: pid_t) {
        var value = proc_bsdinfo()
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &value, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size,
              value.pbi_uid == getuid() else { return nil }
        seconds = value.pbi_start_tvsec; microseconds = value.pbi_start_tvusec
    }
}

/// Bounded, metadata-only action diagnostics. No AX values, titles, paths or
/// UI text are retained; these counters never participate in authorization.
@MainActor private final class FocusIdentityDiagnostics {
    var metadataSamples = 0, routeChecks = 0
    var route = "metadata", routeStage = "not-requested", routeAccepted = false
    var routeSeconds: TimeInterval = 0
    var keyboardSamples = 0, keyboardAccepted = false, keyboardStage = "not-requested", keyboardAXError: Int32?
    var snapshot: [String: Any] {
        ["metadataSamples": metadataSamples, "inputRoute": route, "inputRouteChecks": routeChecks,
         "inputRouteAccepted": routeAccepted, "inputRouteStage": routeStage,
         "inputRouteMs": max(0, Int((routeSeconds * 1000).rounded())),
         "keyboardFocusSamples": keyboardSamples, "keyboardFocusAccepted": keyboardAccepted,
         "keyboardFocusStage": keyboardStage, "keyboardAXError": keyboardAXError as Any? ?? NSNull()]
    }
}

/// One identity is captured before preparation and retained through every
/// normal input post. Owned key/button cleanup deliberately has its own path.
@MainActor struct NativeFocusIdentity {
    let target: NativeTarget
    let geometry: FrameGeometry
    let application: NSRunningApplication
    private let birth: FocusProcessBirth
    private let diagnostics = FocusIdentityDiagnostics()
    var diagnosticSnapshot: [String: Any] { diagnostics.snapshot }
    init(target: NativeTarget, geometry: FrameGeometry) throws {
        guard let birth = FocusProcessBirth(target.pid), let app = NSRunningApplication(processIdentifier: target.pid), !app.isTerminated else {
            throw ComputerError("TARGET_GONE", "The target application exited.")
        }
        self.target = target; self.geometry = geometry; self.birth = birth; application = app
    }
    private var processIdentityCurrent: Bool { FocusProcessBirth(target.pid) == birth && !application.isTerminated }
    func validateMetadata() throws {
        diagnostics.metadataSamples += 1
        guard processIdentityCurrent else { throw ComputerError("TARGET_GONE", "The target application exited or its process identity changed.") }
        try ExactWindowFocus.validate(target: target, geometry: geometry, windows: currentWindows())
        guard processIdentityCurrent else { throw ComputerError("TARGET_GONE", "The target application exited or its process identity changed.") }
    }
    func sample(route: FocusInputRoute, requireReady: Bool = false, proofDeadline: TimeInterval? = nil) throws -> FocusPreparationSample {
        let begin = ProcessInfo.processInfo.systemUptime, deadline = min(begin + 0.06, proofDeadline ?? .infinity)
        diagnostics.metadataSamples += 1; diagnostics.routeChecks += 1
        diagnostics.route = route.kind; diagnostics.routeAccepted = false; diagnostics.routeStage = "metadata"
        diagnostics.keyboardAccepted = false
        defer { diagnostics.routeSeconds += max(0, ProcessInfo.processInfo.systemUptime-begin) }
        guard processIdentityCurrent else { throw ComputerError("TARGET_GONE", "The target application exited or its process identity changed.") }
        let windows = try currentWindows(), foreground = NSWorkspace.shared.frontmostApplication?.processIdentifier
        try ExactWindowFocus.validate(target: target, geometry: geometry, windows: windows)
        do {
            guard foreground == target.pid else { throw ComputerError("FOCUS_CHANGED", "The selected window lost foreground input; input stopped.") }
            var focused: KeyboardFocusSnapshot?
            switch route {
            case .pointer(let point):
                diagnostics.routeStage = "pointer-route"
                try ExactPointerRouting.check(point: point, selected: target.windowId, frame: geometry.frame, backend: ExactPointerRouting.native)
            case .keyboard:
                diagnostics.routeStage = "keyboard-root"
                focused = keyboardFocus(deadline: deadline)
            }
            diagnostics.routeStage = "metadata-recheck"
            let after = try currentWindows(), afterPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
            switch route {
            case .pointer:
                try ExactInputIdentity.check(target: target, geometry: geometry, before: windows, after: after,
                    beforePid: foreground, afterPid: afterPid, processIdentityCurrent: processIdentityCurrent)
            case .keyboard:
                try ExactKeyboardFocus.check(target: target, geometry: geometry, before: windows, after: after,
                    beforePid: foreground, afterPid: afterPid, focused: focused, processIdentityCurrent: processIdentityCurrent)
            }
            guard ProcessInfo.processInfo.systemUptime < deadline else {
                diagnostics.routeStage = "deadline"
                throw ComputerError("FOCUS_CHANGED", "Window input identity could not be verified; input stopped.")
            }
            diagnostics.routeStage = "checked"; diagnostics.routeAccepted = true
            if case .keyboard = route { diagnostics.keyboardAccepted = true }
            return FocusPreparationSample(frontmostPid: afterPid, frontmostWindowId: target.windowId)
        } catch let error as ComputerError where error.code == "FOCUS_CHANGED" && !requireReady {
            // Readiness can wait for a pending route/focus change within 500 ms.
            // Every normal post requires readiness immediately and fails closed.
            return FocusPreparationSample(frontmostPid: NSWorkspace.shared.frontmostApplication?.processIdentifier, frontmostWindowId: nil)
        }
    }
    private func keyboardFocus(deadline: TimeInterval) -> KeyboardFocusSnapshot? {
        diagnostics.keyboardSamples += 1; diagnostics.keyboardAccepted = false; diagnostics.keyboardAXError = nil
        func read(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
            let remaining = deadline - ProcessInfo.processInfo.systemUptime
            guard remaining > 0 else { diagnostics.keyboardStage = "deadline"; return nil }
            AXUIElementSetMessagingTimeout(element, Float(min(0.01, remaining)))
            var result: CFTypeRef?
            let error = AXUIElementCopyAttributeValue(element, attribute as CFString, &result)
            diagnostics.keyboardAXError = error.rawValue
            guard ProcessInfo.processInfo.systemUptime < deadline else { diagnostics.keyboardStage = "deadline"; return nil }
            guard error == .success else { return nil }
            return result
        }
        func element(_ value: CFTypeRef?) -> AXUIElement? {
            guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }; return (value as! AXUIElement)
        }
        let app = AXUIElementCreateApplication(target.pid)
        diagnostics.keyboardStage = "focused-window"
        guard let focused = element(read(app, kAXFocusedWindowAttribute)) else { return nil }
        var owner: pid_t = 0
        guard AXUIElementGetPid(focused, &owner) == .success, owner == target.pid else { diagnostics.keyboardStage = "owner"; return nil }
        diagnostics.keyboardStage = "geometry"
        guard let position = read(focused, kAXPositionAttribute), let size = read(focused, kAXSizeAttribute),
              CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero, dimensions = CGSize.zero
        guard AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else { return nil }
        diagnostics.keyboardStage = "role"
        guard let role = read(focused, kAXRoleAttribute) as? String else { return nil }
        diagnostics.keyboardStage = "root-recheck"
        guard let current = element(read(app, kAXFocusedWindowAttribute)), ProcessInfo.processInfo.systemUptime < deadline else { return nil }
        diagnostics.keyboardStage = "checked"
        return KeyboardFocusSnapshot(pid: owner, frame: CGRect(origin: point, size: dimensions), isWindow: role == kAXWindowRole as String, identityStable: CFEqual(focused, current))
    }
    private func currentWindows() throws -> [FocusWindowState] {
        guard let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            throw ComputerError("FOCUS_CHANGED", "Window input identity could not be verified; input stopped.")
        }
        var windows = [FocusWindowState]()
        for row in rows {
            // All potentially input-owning normal windows must be understood;
            // malformed metadata cannot silently expose a lower window.
            guard let layer = row[kCGWindowLayer as String] as? NSNumber else { throw ComputerError("FOCUS_CHANGED", "Window input identity could not be verified; input stopped.") }
            guard layer.int32Value == CGWindowLevelForKey(.normalWindow) else { continue }
            guard let id = row[kCGWindowNumber as String] as? NSNumber, let pid = row[kCGWindowOwnerPID as String] as? NSNumber,
                  let alpha = row[kCGWindowAlpha as String] as? NSNumber, alpha.doubleValue.isFinite,
                  let onscreen = row[kCGWindowIsOnscreen as String] as? Bool,
                  let bounds = row[kCGWindowBounds as String] as? [String: Any], let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary),
                  frame.minX.isFinite, frame.minY.isFinite, frame.width.isFinite, frame.height.isFinite, frame.width > 0, frame.height > 0 else {
                throw ComputerError("FOCUS_CHANGED", "Window input identity could not be verified; input stopped.")
            }
            windows.append(FocusWindowState(windowId: id.uint32Value, pid: pid.int32Value, frame: frame, layer: layer.int32Value, onscreen: onscreen, alpha: alpha.doubleValue))
        }
        return windows
    }

}

@MainActor extension FocusPreparationBackend {
    static func native(identity: NativeFocusIdentity, route: FocusInputRoute, checkpoint: @escaping () throws -> Void) throws -> FocusPreparationBackend {
        let target = identity.target, geometry = identity.geometry, application = identity.application
        var readinessDeadline: TimeInterval?
        func validate() throws {
            try checkpoint()
            // Activation may change the foreground window. Validate only the
            // pinned identity here; route-specific readiness follows the request.
            try identity.validateMetadata()
        }
        return FocusPreparationBackend(now: { ProcessInfo.processInfo.systemUptime },
            frontmost: { NSWorkspace.shared.frontmostApplication?.processIdentifier }, request: { deadline, result in
                readinessDeadline = deadline
                @MainActor func ready() throws {
                    try validate()
                    guard ProcessInfo.processInfo.systemUptime < deadline else { throw ComputerError("FOCUS_CHANGED", "The target application did not become ready for input; input stopped.") }
                }
                // AX calls are individually bounded. Yield between them so a
                // human event or release can invalidate the preparation. A
                // synchronous AX call already in progress cannot be cancelled.
                @MainActor func turn() async throws { await Task.yield(); try Task.checkCancellation(); try ready() }
                try ready()
                result.accepted = application.activate(options: [])
                await Task.yield(); try ready()
                let app = AXUIElementCreateApplication(target.pid)
                AXUIElementSetMessagingTimeout(app, 0.03)
                var settable = DarwinBoolean(false)
                let query = AXUIElementIsAttributeSettable(app, kAXFrontmostAttribute as CFString, &settable)
                result.axSettableResult = query.rawValue
                try await turn()
                if query == .success && settable.boolValue {
                    result.axFrontmostResult = AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue).rawValue
                    try await turn()
                }
                var windowsValue: CFTypeRef?
                let windowsResult = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windowsValue)
                try await turn()
                if windowsResult == .success, let windows = windowsValue as? [AXUIElement], windows.count <= 32 {
                    var matching = [AXUIElement]()
                    for window in windows {
                        try ready(); AXUIElementSetMessagingTimeout(window, 0.03)
                        var position: CFTypeRef?, size: CFTypeRef?
                        let positionResult = AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &position)
                        try await turn()
                        let sizeResult = AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &size)
                        try await turn()
                        guard positionResult == .success, sizeResult == .success, let position, let size,
                              CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { continue }
                        var point = CGPoint.zero, dimensions = CGSize.zero
                        guard AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else { continue }
                        if abs(point.x - geometry.frame.minX) < 1, abs(point.y - geometry.frame.minY) < 1,
                           abs(dimensions.width - geometry.frame.width) < 1, abs(dimensions.height - geometry.frame.height) < 1 { matching.append(window) }
                    }
                    // The public AX API exposes no CGWindowID. Refuse to pick
                    // between overlapping, identically sized app windows.
                    guard matching.count <= 1 else { throw ComputerError("FOCUS_CHANGED", "The selected accessibility window is ambiguous; input stopped.") }
                    if matching.count == 1 {
                        let window = matching[0]
                        result.raiseResult = AXUIElementPerformAction(window, kAXRaiseAction as CFString).rawValue
                        try await turn()
                        _ = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
                        try await turn()
                        _ = AXUIElementSetAttributeValue(window, kAXFocusedAttribute as CFString, kCFBooleanTrue)
                        try await turn()
                        _ = AXUIElementSetAttributeValue(app, kAXFocusedWindowAttribute as CFString, window)
                        try await turn()
                    }
                }
            }, sample: { try checkpoint(); return try identity.sample(route: route, proofDeadline: readinessDeadline) },
            sleep: { try await Task.sleep(nanoseconds: $0) }, diagnostics: { identity.diagnosticSnapshot })
    }
}
