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
struct FocusWindowState {
    let windowId: CGWindowID
    let pid: pid_t
    let frame: CGRect
    var layer: Int32 = 0
    var onscreen = true
    var alpha = 1.0
    var normalVisible: Bool { layer == CGWindowLevelForKey(.normalWindow) && onscreen && alpha.isFinite && alpha > 0 }
}

/// A normal-layer CG surface can be an AppKit child component. Treat it as
/// part of the selected window only with public AX hit/window association;
/// its size, name, PID or location alone is never sufficient.
struct FocusWindowComponentProof {
    let windowId: CGWindowID
    let pid: pid_t
    let componentFrame: CGRect
    let focusedPid: pid_t
    let focusedFrame: CGRect
    let hitPid: pid_t
    let hitWindowPid: pid_t
    let hitFrame: CGRect
    let hitWindowIsFocused: Bool
    let hitIsTopLevel: Bool
}

enum ExactWindowFocus {
    static func sameGeometry(_ a: CGRect, _ b: CGRect) -> Bool {
        abs(a.minX - b.minX) < 1 && abs(a.minY - b.minY) < 1 && abs(a.width - b.width) < 1 && abs(a.height - b.height) < 1
    }
    static func provesComponent(_ component: FocusWindowState, selected: FocusWindowState, proof: FocusWindowComponentProof) -> Bool {
        let outer = selected.frame, inner = component.frame
        return component.pid == selected.pid && proof.windowId == component.windowId && proof.pid == component.pid && proof.componentFrame == inner &&
            inner.minX > outer.minX && inner.minY > outer.minY && inner.maxX < outer.maxX && inner.maxY < outer.maxY &&
            proof.focusedPid == selected.pid && proof.hitPid == selected.pid && proof.hitWindowPid == selected.pid &&
            sameGeometry(proof.focusedFrame, outer) && proof.hitWindowIsFocused && !proof.hitIsTopLevel &&
            [proof.hitFrame.minX, proof.hitFrame.minY, proof.hitFrame.width, proof.hitFrame.height].allSatisfy(\.isFinite) &&
            proof.hitFrame.width > 0 && proof.hitFrame.height > 0 && inner.contains(proof.hitFrame) &&
            proof.hitFrame.contains(CGPoint(x: inner.midX, y: inner.midY))
    }
    static func sample(target: NativeTarget, geometry: FrameGeometry, frontmostPid: pid_t?, windows: [FocusWindowState], components: [FocusWindowComponentProof] = [], requireFrontmost: Bool = false) throws -> FocusPreparationSample {
        let normal = windows.filter(\.normalVisible)
        guard let selected = normal.first(where: { $0.windowId == target.windowId }), selected.pid == target.pid,
              sameGeometry(selected.frame, geometry.frame) else {
            throw ComputerError("GEOMETRY_CHANGED", "The selected window moved, changed owner, or became unavailable. Observe it again before acting.")
        }
        let matching = normal.filter { $0.pid == target.pid && sameGeometry($0.frame, geometry.frame) }
        guard matching.count == 1 else {
            throw ComputerError("FOCUS_CHANGED", "Overlapping app windows have the same geometry; input stopped. Separate the selected window before continuing.")
        }
        var frontWindowId = normal.first?.windowId
        if frontmostPid == target.pid, let index = normal.firstIndex(where: { $0.windowId == target.windowId }), index > 0 && index <= 3 {
            let blockers = normal.prefix(index)
            if blockers.allSatisfy({ component in components.contains { provesComponent(component, selected: selected, proof: $0) } }) { frontWindowId = target.windowId }
        }
        let sample = FocusPreparationSample(frontmostPid: frontmostPid, frontmostWindowId: frontWindowId)
        if requireFrontmost && (sample.frontmostPid != target.pid || sample.frontmostWindowId != target.windowId) {
            throw ComputerError("FOCUS_CHANGED", "The selected window lost foreground input; input stopped.")
        }
        return sample
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
    var metadataSamples = 0, proofCalls = 0, acceptedProofs = 0
    var proofSeconds: TimeInterval = 0
    var lastStage = "not-requested", lastAXError: Int32?
    var snapshot: [String: Any] {
        ["metadataSamples": metadataSamples, "componentProofCalls": proofCalls,
         "componentProofMs": max(0, Int((proofSeconds * 1000).rounded())),
         "acceptedComponentProofs": acceptedProofs, "componentProofStage": lastStage,
         "componentAXError": lastAXError as Any? ?? NSNull()]
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
    func sample(requireFrontmost: Bool = false, includeComponentProofs: Bool = true) throws -> FocusPreparationSample {
        diagnostics.metadataSamples += 1
        guard FocusProcessBirth(target.pid) == birth, !application.isTerminated else { throw ComputerError("TARGET_GONE", "The target application exited or its process identity changed.") }
        var windows = try currentWindows()
        let foreground = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let initial = try ExactWindowFocus.sample(target: target, geometry: geometry, frontmostPid: foreground, windows: windows)
        var proofs = [FocusWindowComponentProof]()
        let normal = windows.filter(\.normalVisible)
        if foreground == target.pid, initial.frontmostWindowId != target.windowId,
           let index = normal.firstIndex(where: { $0.windowId == target.windowId }), index > 0 && index <= 3 {
            let selected = normal[index], blockers = Array(normal.prefix(index))
            if blockers.allSatisfy({ $0.pid == target.pid && selected.frame.contains($0.frame) }) {
                if includeComponentProofs { proofs = componentProofs(blockers, selected: selected) }
                if includeComponentProofs { diagnostics.acceptedProofs = blockers.filter { component in proofs.contains { ExactWindowFocus.provesComponent(component, selected: selected, proof: $0) } }.count }
                // Public AX calls are synchronous. Never reuse a proof after
                // its CG surface or the front order changed during those reads.
                windows = try currentWindows()
            }
        }
        let result = try ExactWindowFocus.sample(target: target, geometry: geometry, frontmostPid: NSWorkspace.shared.frontmostApplication?.processIdentifier, windows: windows, components: proofs, requireFrontmost: requireFrontmost)
        guard FocusProcessBirth(target.pid) == birth, !application.isTerminated else { throw ComputerError("TARGET_GONE", "The target application exited or its process identity changed.") }
        return result
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
    private func componentProofs(_ components: [FocusWindowState], selected: FocusWindowState) -> [FocusWindowComponentProof] {
        let begin = ProcessInfo.processInfo.systemUptime, deadline = begin + 0.06
        diagnostics.proofCalls += 1; diagnostics.acceptedProofs = 0; diagnostics.lastAXError = nil
        defer { diagnostics.proofSeconds += max(0, ProcessInfo.processInfo.systemUptime - begin) }
        func read(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
            guard ProcessInfo.processInfo.systemUptime < deadline else { return nil }
            AXUIElementSetMessagingTimeout(element, 0.01)
            var value: CFTypeRef?
            let result = AXUIElementCopyAttributeValue(element, name as CFString, &value)
            diagnostics.lastAXError = result.rawValue
            guard result == .success,
                  ProcessInfo.processInfo.systemUptime < deadline else { return nil }
            return value
        }
        func element(_ value: CFTypeRef?) -> AXUIElement? {
            guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }; return (value as! AXUIElement)
        }
        func rect(_ value: AXUIElement) -> CGRect? {
            guard let position = read(value, kAXPositionAttribute), let size = read(value, kAXSizeAttribute),
                  CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
            var point = CGPoint.zero, dimensions = CGSize.zero
            guard AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &dimensions),
                  [point.x, point.y, dimensions.width, dimensions.height].allSatisfy(\.isFinite), dimensions.width > 0, dimensions.height > 0 else { return nil }
            return CGRect(origin: point, size: dimensions)
        }
        func pid(_ value: AXUIElement) -> pid_t? {
            var result: pid_t = 0; return AXUIElementGetPid(value, &result) == .success ? result : nil
        }
        let app = AXUIElementCreateApplication(target.pid)
        diagnostics.lastStage = "focused-window"
        guard let focused = element(read(app, kAXFocusedWindowAttribute)) else { return [] }
        diagnostics.lastStage = "focused-window-geometry"
        guard let focusedFrame = rect(focused),
              let focusedPid = pid(focused), focusedPid == target.pid, ExactWindowFocus.sameGeometry(focusedFrame, selected.frame) else { return [] }
        let system = AXUIElementCreateSystemWide(); AXUIElementSetMessagingTimeout(system, 0.01)
        var proofs = [FocusWindowComponentProof]()
        for component in components {
            guard ProcessInfo.processInfo.systemUptime < deadline else { return [] }
            var hit: AXUIElement?
            diagnostics.lastStage = "component-hit"
            let hitResult = AXUIElementCopyElementAtPosition(system, Float(component.frame.midX), Float(component.frame.midY), &hit)
            diagnostics.lastAXError = hitResult.rawValue
            guard hitResult == .success, let hit else { return [] }
            diagnostics.lastStage = "component-window"
            guard let hitWindow = element(read(hit, kAXWindowAttribute)) else { return [] }
            diagnostics.lastStage = "component-geometry"
            guard let hitFrame = rect(hit),
                  let hitPid = pid(hit), let hitWindowPid = pid(hitWindow),
                  let currentFocus = element(read(app, kAXFocusedWindowAttribute)), CFEqual(currentFocus, focused),
                  ProcessInfo.processInfo.systemUptime < deadline else { return [] }
            proofs.append(FocusWindowComponentProof(windowId: component.windowId, pid: component.pid, componentFrame: component.frame,
                focusedPid: focusedPid, focusedFrame: focusedFrame, hitPid: hitPid, hitWindowPid: hitWindowPid, hitFrame: hitFrame,
                hitWindowIsFocused: CFEqual(hitWindow, focused), hitIsTopLevel: CFEqual(hit, hitWindow)))
        }
        diagnostics.lastStage = "complete"
        return proofs
    }
}

@MainActor extension FocusPreparationBackend {
    static func native(identity: NativeFocusIdentity, checkpoint: @escaping () throws -> Void) throws -> FocusPreparationBackend {
        let target = identity.target, geometry = identity.geometry, application = identity.application
        func validate() throws {
            try checkpoint()
            // Activation preparation checks identity, geometry and ambiguity;
            // it does not consume the returned foreground-window decision.
            // Avoid repeated AX proofs here so the bounded request leaves time
            // for the two strict readiness samples and per-input checks below.
            _ = try identity.sample(includeComponentProofs: false)
        }
        return FocusPreparationBackend(now: { ProcessInfo.processInfo.systemUptime },
            frontmost: { NSWorkspace.shared.frontmostApplication?.processIdentifier }, request: { deadline, result in
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
            }, sample: { try checkpoint(); return try identity.sample() },
            sleep: { try await Task.sleep(nanoseconds: $0) }, diagnostics: { identity.diagnosticSnapshot })
    }
}
