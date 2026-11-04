import AppKit
import ApplicationServices

/// Opt-in acceptance against one explicitly named, already-open browser tab.
/// It never launches a browser or injects system input.
@main struct BrowserTabVirtualAcceptance {
    @MainActor static func main() async throws {
        NSApplication.shared.setActivationPolicy(.accessory)
        let args = CommandLine.arguments
        guard args.count == 4, AXIsProcessTrusted() else { throw ComputerError("ACCEPTANCE_ARGUMENTS", "Expected browser bundle ID, exact tab title and report path; existing Accessibility permission is required.") }
        func read(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
            AXUIElementSetMessagingTimeout(element, 0.05)
            var value: CFTypeRef?
            return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
        }
        func rect(_ element: AXUIElement) -> CGRect? {
            guard let p = read(element, kAXPositionAttribute), let s = read(element, kAXSizeAttribute),
                  CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
            var position = CGPoint.zero, size = CGSize.zero
            guard AXValueGetValue(p as! AXValue, .cgPoint, &position), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
            return CGRect(origin: position, size: size)
        }
        var remaining = 4096
        func tabs(_ element: AXUIElement, depth: Int = 0) -> [AXUIElement] {
            remaining -= 1
            guard remaining > 0, depth < 24 else { return [] }
            if read(element, kAXRoleAttribute) as? String == kAXRadioButtonRole,
               read(element, kAXTitleAttribute) as? String == args[2] { return [element] }
            return (read(element, kAXChildrenAttribute) as? [AXUIElement] ?? []).prefix(256).flatMap { tabs($0, depth: depth + 1) }
        }
        var matches: [(NSRunningApplication, AXUIElement, AXUIElement)] = []
        for app in NSWorkspace.shared.runningApplications where app.bundleIdentifier == args[1] {
            for window in read(AXUIElementCreateApplication(app.processIdentifier), kAXWindowsAttribute) as? [AXUIElement] ?? [] {
                for tab in tabs(window) { matches.append((app, window, tab)) }
            }
        }
        guard matches.count == 1, let (app, window, tab) = matches.first,
              let frame = rect(window), let tabFrame = rect(tab) else { throw ComputerError("ACCEPTANCE_TARGET", "Exactly one matching browser tab is required.") }
        let rows = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
        let windows = rows.filter {
            ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == app.processIdentifier &&
            ($0[kCGWindowBounds as String] as? [String: Any]).flatMap { CGRect(dictionaryRepresentation: $0 as CFDictionary) } == frame
        }
        guard windows.count == 1, let id = (windows[0][kCGWindowNumber as String] as? NSNumber)?.uint32Value else { throw ComputerError("ACCEPTANCE_TARGET", "Browser window identity is ambiguous.") }
        let target = NativeTarget(id: "virtual-browser-acceptance", appId: args[1], title: args[2], pid: app.processIdentifier, windowId: id, frame: frame, scale: 1)
        let geometry = FrameGeometry(frame: frame, pixelWidth: Int(frame.width), pixelHeight: Int(frame.height))
        let input = NativeInput()
        try input.lease(1)
        defer { try? input.shutdownCleanup() }
        func focus() -> CFTypeRef? { read(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute) }
        let beforePID = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let beforeCursor = CGEvent(source: nil)!.location, beforeFocus = focus(), beforeClipboard = NSPasteboard.general.changeCount
        let selectedBefore = (read(tab, kAXValueAttribute) as? NSNumber)?.boolValue
        let point = CGPoint(x: tabFrame.midX, y: tabFrame.midY)
        var follows = true
        for dx in [-3.0, 3.0, 0.0] {
            let requested = CGPoint(x: point.x + dx, y: point.y)
            _ = try await input.act(epoch: 1, target: target, geometry: geometry, action: ["kind": "move", "x": requested.x - frame.minX, "y": requested.y - frame.minY])
            let state = input.aiCursorState
            follows = follows && state["x"] as? CGFloat == requested.x && state["y"] as? CGFloat == requested.y && state["phase"] as? String == "virtual"
        }
        let result = try await input.act(epoch: 1, target: target, geometry: geometry, action: ["kind": "click", "x": point.x - frame.minX, "y": point.y - frame.minY])
        try await Task.sleep(nanoseconds: 80_000_000)
        let afterFocus = focus(), afterCursor = CGEvent(source: nil)!.location
        let cursor = input.aiCursorState
        let selectedAfter = (read(tab, kAXValueAttribute) as? NSNumber)?.boolValue == true
        let noDesktopLease = input.inputState["ownerId"] is NSNull
        try input.release(1)
        let released = input.aiCursorState["visible"] as? Bool == false && input.aiCursor(target: target, geometry: geometry)["visible"] as? Bool == false
        let report: [String: Any] = ["tabTitle": args[2], "selectedBefore": selectedBefore as Any? ?? NSNull(), "selectedAfter": selectedAfter,
            "delivery": result["delivery"] as Any? ?? NSNull(), "pointerFollowsRequestedPoints": follows, "desktopPointerVisible": cursor["visible"] as Any? ?? NSNull(),
            "systemCursorUnchanged": beforeCursor == afterCursor, "foregroundApplicationUnchanged": beforePID == NSWorkspace.shared.frontmostApplication?.processIdentifier,
            "clipboardUnchanged": beforeClipboard == NSPasteboard.general.changeCount, "keyboardFocusReadbackAvailable": beforeFocus != nil && afterFocus != nil,
            "keyboardFocusUnchanged": beforeFocus != nil && afterFocus != nil ? CFEqual(beforeFocus!, afterFocus!) as Any : NSNull(),
            "noPhysicalDesktopLease": noDesktopLease, "pointerHiddenOnRelease": released]
        let url = URL(fileURLWithPath: args[3])
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys, .prettyPrinted])
        try data.write(to: url, options: .atomic)
        print(String(data: data, encoding: .utf8)!)
        guard selectedAfter, follows, result["delivery"] as? String == "virtual", noDesktopLease, released,
              report["systemCursorUnchanged"] as? Bool == true, report["foregroundApplicationUnchanged"] as? Bool == true,
              report["clipboardUnchanged"] as? Bool == true, report["keyboardFocusUnchanged"] as? Bool != false else {
            throw ComputerError("ACCEPTANCE_FAILED", "Review the browser virtual-input acceptance report.")
        }
    }
}
