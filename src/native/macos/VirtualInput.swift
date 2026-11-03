import AppKit
import ApplicationServices

/// Background semantic input. This path never posts CGEvents, activates an app,
/// changes AX focus, hides/warps the system cursor, or acquires a desktop lease.
@MainActor final class VirtualInput {
    private var point: CGPoint?
    private var targetId: String?
    private var textAnchor: AXUIElement?
    private var anchorWindow: AXUIElement?
    private var deadline: TimeInterval = 0
    private func unsupported() -> ComputerError { ComputerError("VIRTUAL_INPUT_UNSUPPORTED", "The selected control does not support this background action. Request owner permission for physical input.") }
    private func read(_ element: AXUIElement, _ name: String) throws -> CFTypeRef? {
        guard ProcessInfo.processInfo.systemUptime < deadline else { throw unsupported() }
        AXUIElementSetMessagingTimeout(element, 0.02)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }
    private func rect(_ element: AXUIElement) throws -> CGRect? {
        guard let p = try read(element, kAXPositionAttribute), CFGetTypeID(p) == AXValueGetTypeID(),
              let s = try read(element, kAXSizeAttribute), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
        var origin = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(p as! AXValue, .cgPoint, &origin), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
        return CGRect(origin: origin, size: size)
    }
    private func window(_ target: NativeTarget) throws -> AXUIElement {
        let app = AXUIElementCreateApplication(target.pid)
        guard let windows = try read(app, kAXWindowsAttribute) as? [AXUIElement], windows.count <= 128 else { throw unsupported() }
        let matches = try windows.filter { try rect($0) == target.frame }
        guard matches.count == 1 else { throw unsupported() }
        // Geometry is only used when the selected process has exactly one CG
        // window at that frame, so same-position siblings cannot be confused.
        let cg = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
        let siblings = cg.filter { row in
            guard (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == target.pid,
                  let bounds = row[kCGWindowBounds as String] as? [String: Any], let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return false }
            return frame == target.frame
        }
        guard siblings.count == 1, (siblings[0][kCGWindowNumber as String] as? NSNumber)?.uint32Value == target.windowId else { throw unsupported() }
        return matches[0]
    }
    private func path(_ root: AXUIElement, at point: CGPoint) throws -> [AXUIElement] {
        var current = root, result = [root], visited = Set<CFHashCode>()
        for _ in 0..<24 {
            guard visited.insert(CFHash(current)).inserted else { throw unsupported() }
            let children = try read(current, kAXChildrenAttribute) as? [AXUIElement] ?? []
            guard children.count <= 256 else { throw unsupported() }
            let hits = try children.filter { try rect($0)?.contains(point) == true }
            guard hits.count <= 1 else { throw unsupported() }
            guard let child = hits.first else { return result }
            result.append(child); current = child
        }
        throw unsupported()
    }
    private func settable(_ element: AXUIElement, _ attribute: String) -> Bool {
        var value = DarwinBoolean(false)
        return AXUIElementIsAttributeSettable(element, attribute as CFString, &value) == .success && value.boolValue
    }
    private func mutate(_ element: AXUIElement, _ operation: () -> AXError) throws {
        let remaining = deadline - ProcessInfo.processInfo.systemUptime
        guard remaining > 0 else { throw unsupported() }
        // Native controls may acknowledge AXPress after their click animation.
        // A read-sized timeout can report failure after the action was applied.
        AXUIElementSetMessagingTimeout(element, Float(min(0.5, remaining)))
        let result = operation()
        // Once a mutation has been dispatched, a timeout is not proof of failure.
        guard result == .success else { throw ComputerError("VIRTUAL_INPUT_UNCONFIRMED", "The background action result is unconfirmed. Inspect the application; do not replay it with physical input.") }
    }
    func snapshot(target: NativeTarget, geometry: FrameGeometry) -> [String: Any]? {
        guard targetId == target.id, let point, target.frame.contains(point) else { return nil }
        return ["x": (point.x - target.frame.minX) * Double(geometry.pixelWidth) / target.frame.width,
                "y": (point.y - target.frame.minY) * Double(geometry.pixelHeight) / target.frame.height, "visible": true, "actor": "ai", "phase": "virtual"]
    }
    func hide() { point = nil; targetId = nil; clearAnchor() }
    func clearAnchor() { textAnchor = nil; anchorWindow = nil }
    func act(target: NativeTarget, geometry: FrameGeometry, action: [String: Any], checkpoint: () throws -> Void) throws -> [String: Any] {
        try checkpoint()
        guard AXIsProcessTrusted() else { throw ComputerError("ACCESSIBILITY_REQUIRED", "Accessibility permission is required.") }
        guard target.frame == geometry.frame else { throw ComputerError("GEOMETRY_CHANGED", "Observe the target again.") }
        deadline = ProcessInfo.processInfo.systemUptime + 0.8
        let kind = action["kind"] as? String ?? ""
        guard action["holdMs"] == nil, action["inputMode"] as? String != "compatibility" else { throw unsupported() }
        if kind == "move" || kind == "click" || kind == "scroll" {
            guard let x = finiteNumber(action["x"]), let y = finiteNumber(action["y"]) else { throw unsupported() }
            let next = try geometry.point(x: x, y: y)
            if targetId != target.id { clearAnchor() }
            point = next; targetId = target.id
        }
        if kind == "move" { return ["performed": true, "delivery": "virtual", "kind": kind] }
        let root = try window(target)
        if kind == "type" {
            guard targetId == target.id, let element = textAnchor, let oldWindow = anchorWindow, CFEqual(root, oldWindow),
                  let owner = try read(element, kAXWindowAttribute), CFEqual(owner, root),
                  let text = action["text"] as? String else { throw unsupported() }
            // Replace the control's existing selection without changing global
            // keyboard focus. No fallback to keystrokes or clipboard paste.
            if settable(element, kAXSelectedTextAttribute) {
                try checkpoint(); try mutate(element) { AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute as CFString, text as CFString) }
            } else {
                guard settable(element, kAXValueAttribute), let value = try read(element, kAXValueAttribute) as? String else { throw unsupported() }
                var range = CFRange(location: 0, length: 0)
                if !value.isEmpty {
                    guard let raw = try read(element, kAXSelectedTextRangeAttribute), CFGetTypeID(raw) == AXValueGetTypeID(), AXValueGetValue(raw as! AXValue, .cfRange, &range),
                          range.location >= 0, range.length >= 0, range.location + range.length <= (value as NSString).length else { throw unsupported() }
                }
                let next = (value as NSString).replacingCharacters(in: NSRange(location: range.location, length: range.length), with: text)
                try checkpoint(); try mutate(element) { AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, next as CFString) }
            }
        } else if kind == "click" {
            guard action["button"] == nil || action["button"] as? String == "left", let point else { throw unsupported() }
            let elements = try path(root, at: point)
            clearAnchor()
            var dispatched = false
            for element in elements.reversed() {
                let role = try read(element, kAXRoleAttribute) as? String
                if settable(element, kAXSelectedTextAttribute) || settable(element, kAXValueAttribute) && role.map({ [kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole].contains($0) }) == true {
                    // A background click must locate its own caret. Keeping an
                    // unrelated old caret would insert text at the wrong place.
                    guard let value = try read(element, kAXValueAttribute) as? String else { throw unsupported() }
                    if !value.isEmpty {
                        guard settable(element, kAXSelectedTextRangeAttribute) else { throw unsupported() }
                        var position = point, rawRange: CFTypeRef?
                        guard let parameter = AXValueCreate(.cgPoint, &position),
                              AXUIElementCopyParameterizedAttributeValue(element, kAXRangeForPositionParameterizedAttribute as CFString, parameter, &rawRange) == .success,
                              let rawRange, CFGetTypeID(rawRange) == AXValueGetTypeID() else { throw unsupported() }
                        var range = CFRange(location: 0, length: 0)
                        guard AXValueGetValue(rawRange as! AXValue, .cfRange, &range), range.location >= 0, range.location <= (value as NSString).length else { throw unsupported() }
                        range.length = 0
                        guard let caret = AXValueCreate(.cfRange, &range) else { throw unsupported() }
                        try checkpoint()
                        guard try rect(root) == target.frame, try rect(element)?.contains(point) == true else { throw unsupported() }
                        try mutate(element) { AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, caret) }
                    }
                    textAnchor = element; anchorWindow = root; dispatched = true; break
                }
                var names: CFArray?
                if AXUIElementCopyActionNames(element, &names) == .success, (names as? [String] ?? []).contains(kAXPressAction) {
                    try checkpoint()
                    guard try rect(root) == target.frame, try rect(element)?.contains(point) == true else { throw unsupported() }
                    try mutate(element) { AXUIElementPerformAction(element, kAXPressAction as CFString) }; dispatched = true; break
                }
            }
            guard dispatched else { throw unsupported() }
        } else if kind == "scroll" {
            guard let point else { throw unsupported() }
            let dx = finiteNumber(action["deltaX"]) ?? 0, dy = finiteNumber(action["deltaY"]) ?? 0
            // Accessibility scrolling is discrete. Only a single supported axis
            // is issued, so partial multi-axis input cannot become a retry.
            guard (dx == 0) != (dy == 0) else { throw unsupported() }
            let name = dx != 0 ? (dx > 0 ? "AXScrollRightByPage" : "AXScrollLeftByPage") : (dy > 0 ? "AXScrollDownByPage" : "AXScrollUpByPage")
            var dispatched = false
            for element in try path(root, at: point).reversed() {
                var names: CFArray?
                if AXUIElementCopyActionNames(element, &names) == .success, (names as? [String] ?? []).contains(name) {
                    try checkpoint(); try mutate(element) { AXUIElementPerformAction(element, name as CFString) }; dispatched = true; break
                }
            }
            guard dispatched else { throw unsupported() }
        } else { throw unsupported() }
        return ["performed": true, "delivery": "virtual", "kind": kind]
    }
}
