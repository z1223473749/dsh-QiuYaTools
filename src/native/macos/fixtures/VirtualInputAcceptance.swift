import AppKit
import ApplicationServices

@main struct VirtualInputAcceptance {
    @MainActor static func main() async throws {
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
        let geometry = FrameGeometry(frame: rect, pixelWidth: Int(rect.width), pixelHeight: Int(rect.height)), input = VirtualInput()
        let beforePID = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let beforeCursor = CGEvent(source: nil)!.location
        func focus() -> CFTypeRef? { var value: CFTypeRef?; AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute as CFString, &value); return value }
        let beforeFocus = focus()
        func focusPID(_ value: CFTypeRef?) -> Int {
            guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return -1 }
            var pid: pid_t = 0; AXUIElementGetPid(value as! AXUIElement, &pid); return Int(pid)
        }
        guard beforePID != nil, beforePID != target.pid, initial["keyWindow"] as? Bool == false else { throw ComputerError("FIXTURE_FOREGROUND", "The test fixture must remain in the background.") }
        func act(_ kind: String, _ pointName: String? = nil, text: String? = nil) throws {
            var action: [String: Any] = ["kind": kind]
            if let pointName, let p = initial[pointName] as? [String: Double] { action["x"] = p["x"]! - rect.minX; action["y"] = p["y"]! - rect.minY }
            if let text { action["text"] = text }
            _ = try input.act(target: target, geometry: geometry, action: action, checkpoint: {})
        }
        for _ in 0..<5 { try act("click", "button") }
        try act("click", "field"); try act("type", text: "virtual-input-verified")
        try act("move", "button")
        var unsupported = false
        do { _ = try input.act(target: target, geometry: geometry, action: ["kind": "drag", "x": 10, "y": 10, "toX": 20, "toY": 20], checkpoint: {}) }
        catch let error as ComputerError { unsupported = error.code == "VIRTUAL_INPUT_UNSUPPORTED" }
        var final = initial
        for _ in 0..<100 {
            final = try state()
            if final["clicks"] as? Int == 5 && final["text"] as? String == "virtual-input-verified" { break }
            try await Task.sleep(nanoseconds: 40_000_000)
        }
        let afterCursor = CGEvent(source: nil)!.location, afterFocus = focus()
        let report: [String: Any] = ["realAccessibilityActions": true, "buttonClicks": final["clicks"] ?? -1,
            "textVerified": final["text"] as? String == "virtual-input-verified", "unsupportedDragRejected": unsupported,
            "systemCursorUnchanged": beforeCursor == afterCursor,
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
        guard report["buttonClicks"] as? Int == 5, report["textVerified"] as? Bool == true, unsupported,
              report["systemCursorUnchanged"] as? Bool == true, report["foregroundApplicationUnchanged"] as? Bool == true,
              (report["keyboardFocusUnchanged"] as? Bool != false), report["fixtureRemainedBackground"] as? Bool == true,
              report["fixtureFieldEditorUnchanged"] as? Bool == true else { throw ComputerError("VIRTUAL_INPUT_ACCEPTANCE_FAILED", "Review the background acceptance report.") }
    }
}
