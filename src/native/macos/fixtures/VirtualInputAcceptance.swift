import AppKit
import ApplicationServices

@main struct VirtualInputAcceptance {
    @MainActor static func main() async throws {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        app.finishLaunching()
        guard AXIsProcessTrusted() else { throw ComputerError("ACCESSIBILITY_REQUIRED", "The acceptance process requires existing Accessibility permission; no permission prompt is issued.") }
        let args = CommandLine.arguments, fixture = Process()
        fixture.executableURL = URL(fileURLWithPath: args[1]); fixture.arguments = [args[2]]
        fixture.standardOutput = FileHandle.nullDevice; fixture.standardError = FileHandle.nullDevice
        try fixture.run()
        defer { if fixture.isRunning { fixture.terminate() } }
        func state() throws -> [String: Any] { try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: args[2]))) as! [String: Any] }
        var initial: [String: Any]?
        for _ in 0..<100 {
            if let value = try? state() { initial = value; break }
            try await Task.sleep(nanoseconds: 40_000_000)
        }
        try await Task.sleep(nanoseconds: 250_000_000)
        initial = try state()
        guard let initial, let bounds = initial["bounds"] as? [String: Any], let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary), let id = initial["windowId"] as? Int else { throw ComputerError("FIXTURE_UNAVAILABLE", "Background fixture did not become available.") }
        let target = NativeTarget(id: "virtual-fixture", appId: "fixture.virtual", title: "fixture", pid: fixture.processIdentifier, windowId: CGWindowID(id), frame: rect, scale: 1)
        let geometry = FrameGeometry(frame: rect, pixelWidth: Int(rect.width), pixelHeight: Int(rect.height)), input = NativeInput()
        var nativeEpoch = 0
        defer { try? input.shutdownCleanup() }
        let beforePID = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let beforeCursor = CGEvent(source: nil)!.location
        var externalInputEvents = 0, ownedInjectedEvents = 0
        let monitor = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDown, .rightMouseDown, .leftMouseDragged, .keyDown]) { event in
            guard let source = event.cgEvent?.getIntegerValueField(.eventSourceUnixProcessID) else { return }
            if source == getpid() { ownedInjectedEvents += 1 } else { externalInputEvents += 1 }
        }
        defer { if let monitor { NSEvent.removeMonitor(monitor) } }
        func focus() -> CFTypeRef? { var value: CFTypeRef?; AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute as CFString, &value); return value }
        let beforeFocus = focus()
        func focusPID(_ value: CFTypeRef?) -> Int {
            guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return -1 }
            var pid: pid_t = 0; AXUIElementGetPid(value as! AXUIElement, &pid); return Int(pid)
        }
        guard beforePID != nil, beforePID != target.pid, initial["keyWindow"] as? Bool == false else { throw ComputerError("FIXTURE_FOREGROUND", "The test fixture must remain in the background.") }
        func act(_ kind: String, _ pointName: String? = nil, text: String? = nil) async throws {
            var action: [String: Any] = ["kind": kind]
            if let pointName, let p = initial[pointName] as? [String: Double] { action["x"] = p["x"]! - rect.minX; action["y"] = p["y"]! - rect.minY }
            if let text { action["text"] = text }
            nativeEpoch += 1; try input.lease(nativeEpoch)
            defer { try? input.release(nativeEpoch, preserveVirtualState: true) }
            _ = try await input.act(epoch: nativeEpoch, target: target, geometry: geometry, action: action)
        }
        for _ in 0..<5 { try await act("click", "button") }
        var ambiguousRejected = false
        do { try await act("click", "ambiguous") }
        catch let error as ComputerError { ambiguousRejected = error.code == "VIRTUAL_INPUT_UNSUPPORTED" }
        try await act("click", "field"); try await act("type", text: "virtual-input-verified")
        try await act("move", "button")
        var unsupported = false
        do { try await act("drag") }
        catch let error as ComputerError { unsupported = error.code == "VIRTUAL_INPUT_UNSUPPORTED" }
        var final = initial
        for _ in 0..<100 {
            final = try state()
            if final["clicks"] as? Int == 5 && final["text"] as? String == "virtual-input-verified" { break }
            try await Task.sleep(nanoseconds: 40_000_000)
        }
        // Let the listen-only event monitor drain concurrent user events before
        // deciding whether a desktop-position comparison is applicable.
        try await Task.sleep(nanoseconds: 50_000_000)
        input.endVirtualInput(nativeEpoch)
        let virtualStateCleared = input.aiCursorState["visible"] as? Bool == false && input.aiCursor(target: target, geometry: geometry)["visible"] as? Bool == false
        let afterCursor = CGEvent(source: nil)!.location, afterFocus = focus()
        let report: [String: Any] = ["realAccessibilityActions": true, "perActionNativeLeases": nativeEpoch, "virtualStateClearedOnTaskEnd": virtualStateCleared, "buttonClicks": final["clicks"] ?? -1,
            "overlappingStructuralGroup": final["overlappingStructuralGroup"] as? Bool == true,
            "overlappingActionableControlsRejected": ambiguousRejected,
            "textVerified": final["text"] as? String == "virtual-input-verified", "unsupportedDragRejected": unsupported,
            "systemCursorUnchanged": beforeCursor == afterCursor,
            "externalInputEvents": externalInputEvents, "ownedInjectedEvents": ownedInjectedEvents,
            "desktopStateComparisonApplicable": externalInputEvents == 0,
            "beforeCursor": ["x": beforeCursor.x, "y": beforeCursor.y], "afterCursor": ["x": afterCursor.x, "y": afterCursor.y],
            "foregroundApplicationUnchanged": beforePID == NSWorkspace.shared.frontmostApplication?.processIdentifier,
            "beforeFocusAvailable": beforeFocus != nil, "afterFocusAvailable": afterFocus != nil, "beforeFocusPID": focusPID(beforeFocus), "afterFocusPID": focusPID(afterFocus),
            "keyboardFocusUnchanged": beforeFocus != nil && afterFocus != nil ? CFEqual(beforeFocus!, afterFocus!) as Any : NSNull(),
            "keyboardFocusReadback": beforeFocus != nil && afterFocus != nil ? "available" : "unavailable",
            "fixtureRemainedBackground": final["keyWindow"] as? Bool == false,
            "fixtureFieldEditorUnchanged": final["fieldEditorActive"] as? Bool == initial["fieldEditorActive"] as? Bool,
            "syntheticGlobalInputCalls": 0]
        let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: URL(fileURLWithPath: args[3]), options: .atomic)
        print(String(data: data, encoding: .utf8)!)
        let desktopStable = report["systemCursorUnchanged"] as? Bool == true && report["foregroundApplicationUnchanged"] as? Bool == true && report["keyboardFocusUnchanged"] as? Bool != false
        guard report["buttonClicks"] as? Int == 5, report["textVerified"] as? Bool == true, unsupported, ambiguousRejected, virtualStateCleared,
              ownedInjectedEvents == 0, desktopStable || externalInputEvents > 0, report["fixtureRemainedBackground"] as? Bool == true,
              report["fixtureFieldEditorUnchanged"] as? Bool == true else { throw ComputerError("VIRTUAL_INPUT_ACCEPTANCE_FAILED", "Review the background acceptance report.") }
    }
}
