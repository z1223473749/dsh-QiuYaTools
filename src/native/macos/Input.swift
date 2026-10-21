import AppKit
import ApplicationServices
import Foundation

/// A revocation is synchronous and cannot be undone by a delayed lease/release.
final class EpochFence {
    private(set) var highest = -1
    private(set) var active: Int?
    func lease(_ epoch: Int) throws {
        guard epoch > highest else { throw ComputerError("STALE_EPOCH", "The control lease is stale.") }
        highest = epoch; active = epoch
    }
    func release(_ epoch: Int) {
        if let current = active, current <= epoch { active = nil }
        highest = max(highest, epoch)
    }
    func check(_ epoch: Int) throws {
        guard active == epoch else { throw ComputerError("STALE_EPOCH", "Control was paused, released, or transferred.") }
    }
}

@MainActor final class NativeInput {
    let fence = EpochFence()
    private let eventSource = CGEventSource(stateID: .hidSystemState)
    private var heldMouse: CGMouseButton?
    private var heldKeys = Set<CGKeyCode>()
    private var lastPoint = CGPoint.zero
    private var lastPid: pid_t?
    private var desktopLease: DesktopLeaseGuard?
    private(set) var leaseActor = NativeLeaseActor.ai
    private lazy var aiPointer: AICursorOverlay = {
        let overlay = AICursorOverlay()
        overlay.isLeaseCurrent = { [weak self] epoch in self?.fence.active == epoch && self?.leaseActor == .ai }
        return overlay
    }()
    var preparePointerRegion: (([CGPoint]) throws -> Void)?
    var prepareFocus: (() -> Void)?
    private(set) var busy = false
    var inputState: [String: Any] { ["mouseHeld": heldMouse != nil, "keysHeld": heldKeys.count, "ownerId": desktopLease?.ownerId as Any? ?? NSNull(),
        "leftButtonDown": CGEventSource.buttonState(.combinedSessionState, button: .left)] }

    func releaseHeldInput() throws {
        if heldMouse != nil || !heldKeys.isEmpty {
            guard AXIsProcessTrusted(), CGPreflightPostEventAccess() else { throw ComputerError("INPUT_CLEANUP_FAILED", "Input permission was revoked before owned input could be released.") }
        }
        if let button = heldMouse {
            let type: CGEventType = button == .left ? .leftMouseUp : button == .right ? .rightMouseUp : .otherMouseUp
            guard let event = CGEvent(mouseEventSource: eventSource, mouseType: type, mouseCursorPosition: lastPoint, mouseButton: button) else { throw ComputerError("INPUT_CLEANUP_FAILED", "The owned mouse release could not be created.") }
            postPointer(event)
            for _ in 0..<20 {
                if !CGEventSource.buttonState(.combinedSessionState, button: button) { break }
                usleep(10_000)
            }
            guard !CGEventSource.buttonState(.combinedSessionState, button: button) else { throw ComputerError("INPUT_CLEANUP_FAILED", "The owned mouse release is not confirmed. Control remains blocked.") }
            heldMouse = nil
        }
        for code in heldKeys {
            guard let event = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: false) else { throw ComputerError("INPUT_CLEANUP_FAILED", "The owned key release could not be created.") }
            event.flags = []
            if let pid = lastPid { event.postToPid(pid) }
        }
        heldKeys.removeAll()
        if desktopLease?.ownerId != nil { try desktopLease?.record(keys: [], mouse: nil, targetPid: nil) }
    }

    func lease(_ epoch: Int, actor: NativeLeaseActor = .ai) throws {
        guard epoch > fence.highest else { throw ComputerError("STALE_EPOCH", "The control lease is stale.") }
        if desktopLease == nil { desktopLease = try DesktopLeaseGuard() }
        try desktopLease!.acquire()
        do { try fence.lease(epoch) } catch { try? desktopLease?.release(); throw error }
        aiPointer.hide(); leaseActor = actor
    }
    func release(_ epoch: Int) throws {
        let wasActive = fence.active.map { $0 <= epoch } ?? false
        fence.release(epoch)
        if wasActive || (fence.active == nil && desktopLease?.ownerId != nil) {
            aiPointer.hide()
            try releaseHeldInput()
            try desktopLease?.release()
        }
    }

    func act(epoch: Int, target: NativeTarget, geometry: FrameGeometry, action: [String: Any]) async throws -> [String: Any] {
        var ownsInput = false
        do {
            let result = try await performAct(epoch: epoch, target: target, geometry: geometry, action: action, started: { ownsInput = true })
            try releaseHeldInput()
            aiPointer.settled(epoch: epoch)
            return result
        } catch {
            if fence.active == epoch { aiPointer.hide() }
            if ownsInput { do { try releaseHeldInput() } catch { fence.release(epoch); throw error } }
            throw error
        }
    }

    func hideAICursor() { aiPointer.hide() }
    var aiCursorState: [String: Any] { aiPointer.desktopSnapshot() }
    func aiCursor(target: NativeTarget, geometry: FrameGeometry) -> [String: Any] { aiPointer.snapshot(target: target, geometry: geometry) }

    private func performAct(epoch: Int, target: NativeTarget, geometry: FrameGeometry, action: [String: Any], started: () -> Void) async throws -> [String: Any] {
        try fence.check(epoch)
        guard AXIsProcessTrusted(), CGPreflightPostEventAccess() else { throw ComputerError("ACCESSIBILITY_REQUIRED", "Enable Accessibility for QiuYaTools Computer in System Settings.") }
        guard !busy else { throw ComputerError("INPUT_BUSY", "Another input action is still settling.") }
        guard target.frame == geometry.frame else { throw ComputerError("GEOMETRY_CHANGED", "The window moved or resized. Observe it again before acting.") }
        guard let kind = action["kind"] as? String, ["click", "move", "drag", "scroll", "type", "key"].contains(kind) else { throw ComputerError("INVALID_ACTION", "Unsupported action kind.") }
        // Validate the whole action before changing application focus or posting any input.
        var start: CGPoint?; var destination: CGPoint?
        if ["click", "move", "drag", "scroll"].contains(kind) {
            guard let x = finiteNumber(action["x"]), let y = finiteNumber(action["y"]) else { throw ComputerError("INVALID_COORDINATES", "This action requires screenshot x and y.") }
            start = try geometry.point(x: x, y: y)
        }
        if kind == "drag" {
            guard let x = finiteNumber(action["toX"]), let y = finiteNumber(action["toY"]) else { throw ComputerError("INVALID_COORDINATES", "Drag requires screenshot toX and toY.") }
            destination = try geometry.point(x: x, y: y)
        }
        let buttonName = action["button"] as? String ?? "left"
        guard ["left", "right", "middle"].contains(buttonName) else { throw ComputerError("INVALID_ACTION", "Unsupported mouse button.") }
        let button: CGMouseButton = buttonName == "right" ? .right : buttonName == "middle" ? .center : .left
        let text = action["text"] as? String
        if kind == "type", text == nil || text!.utf16.count > 100_000 { throw ComputerError("INVALID_ACTION", "Text is missing or exceeds 100000 UTF-16 units.") }
        let key = kind == "key" ? try parseKey(action["key"] as? String) : nil
        let dx = finiteNumber(action["deltaX"]) ?? 0; let dy = finiteNumber(action["deltaY"]) ?? 0
        guard abs(dx) <= 20_000, abs(dy) <= 20_000 else { throw ComputerError("INVALID_ACTION", "Scroll delta is too large.") }
        busy = true
        started()
        defer { busy = false }
        prepareFocus?()
        if let point = start { try preparePointerRegion?(destination.map { [point, $0] } ?? [point]) }
        guard let application = NSRunningApplication(processIdentifier: target.pid), !application.isTerminated else { throw ComputerError("TARGET_GONE", "The target application exited.") }
        application.activate(options: [.activateIgnoringOtherApps])
        raiseWindow(target)
        try await Task.sleep(nanoseconds: 80_000_000)
        try check(epoch, target, geometry)
        lastPid = target.pid
        // Record the entire action's possible downs before the first injected down.
        // Keeping this superset until completion avoids an fsync for every typed character.
        let keys: Set<CGKeyCode> = kind == "type" ? [0] : key.map { [$0.0] } ?? []
        try desktopLease?.record(keys: keys, mouse: ["click", "drag"].contains(kind) ? button : nil, targetPid: target.pid)
        switch kind {
        case "click":
            try mouse(.mouseMoved, start!, .left, epoch, target, geometry)
            try mouse(button == .left ? .leftMouseDown : button == .right ? .rightMouseDown : .otherMouseDown, start!, button, epoch, target, geometry)
            heldMouse = button
            try await Task.sleep(nanoseconds: 35_000_000)
            try mouse(button == .left ? .leftMouseUp : button == .right ? .rightMouseUp : .otherMouseUp, start!, button, epoch, target, geometry)
            heldMouse = nil
        case "move": try mouse(.mouseMoved, start!, .left, epoch, target, geometry)
        case "drag":
            try mouse(.mouseMoved, start!, .left, epoch, target, geometry)
            try mouse(button == .left ? .leftMouseDown : button == .right ? .rightMouseDown : .otherMouseDown, start!, button, epoch, target, geometry)
            heldMouse = button
            for step in 1...24 {
                try await Task.sleep(nanoseconds: 16_000_000)
                let progress = Double(step) / 24
                let point = CGPoint(x: start!.x + (destination!.x - start!.x) * progress, y: start!.y + (destination!.y - start!.y) * progress)
                try mouse(button == .left ? .leftMouseDragged : button == .right ? .rightMouseDragged : .otherMouseDragged, point, button, epoch, target, geometry)
            }
            try mouse(button == .left ? .leftMouseUp : button == .right ? .rightMouseUp : .otherMouseUp, destination!, button, epoch, target, geometry)
            heldMouse = nil
        case "scroll":
            try mouse(.mouseMoved, start!, .left, epoch, target, geometry)
            try check(epoch, target, geometry)
            // Protocol follows browser wheel semantics: positive is right/down.
            guard let event = CGEvent(scrollWheelEvent2Source: eventSource, units: .pixel, wheelCount: 2, wheel1: Int32(-dy), wheel2: Int32(-dx), wheel3: 0) else { throw ComputerError("EVENT_FAILED", "Could not create a scroll event.") }
            postPointer(event)
        case "type":
            // Use Unicode events, never the user's clipboard. Split on Characters so
            // surrogate pairs and composed graphemes are not broken between events.
            for character in text! {
                let units = Array(String(character).utf16)
                try check(epoch, target, geometry)
                guard let down = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: true),
                      let up = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: false) else { throw ComputerError("EVENT_FAILED", "Could not create a text event.") }
                down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                down.flags = []; up.flags = []
                down.postToPid(target.pid); heldKeys.insert(0)
                try check(epoch, target, geometry)
                up.postToPid(target.pid); heldKeys.remove(0)
                try await Task.sleep(nanoseconds: 1_000_000)
            }
        case "key":
            let combination = key!
            try check(epoch, target, geometry)
            guard let down = CGEvent(keyboardEventSource: eventSource, virtualKey: combination.0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: eventSource, virtualKey: combination.0, keyDown: false) else { throw ComputerError("EVENT_FAILED", "Could not create a key event.") }
            down.flags = combination.1; up.flags = []
            down.postToPid(target.pid); heldKeys.insert(combination.0)
            try await Task.sleep(nanoseconds: 25_000_000)
            try check(epoch, target, geometry)
            up.postToPid(target.pid); heldKeys.remove(combination.0)
        default: break
        }
        try await Task.sleep(nanoseconds: 50_000_000)
        return ["performed": true, "kind": kind, "epoch": epoch, "targetId": target.id]
    }

    private func mouse(_ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton, _ epoch: Int, _ target: NativeTarget, _ geometry: FrameGeometry) throws {
        try check(epoch, target, geometry)
        guard let event = CGEvent(mouseEventSource: eventSource, mouseType: type, mouseCursorPosition: point, mouseButton: button) else { throw ComputerError("EVENT_FAILED", "Could not create a mouse event.") }
        lastPoint = point
        event.setIntegerValueField(.mouseEventClickState, value: 1)
        postPointer(event)
        if leaseActor == .ai {
            let pressed = [.leftMouseDown, .rightMouseDown, .otherMouseDown, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged].contains(type)
            aiPointer.posted(point, phase: pressed ? "pressed" : "moving", epoch: epoch, target: target)
        }
    }

    private func postPointer(_ event: CGEvent) {
        event.post(tap: .cghidEventTap)
    }

    private func check(_ epoch: Int, _ target: NativeTarget, _ geometry: FrameGeometry) throws {
        try fence.check(epoch)
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == target.pid else { aiPointer.hide(); throw ComputerError("FOCUS_CHANGED", "The target application lost focus; input stopped.") }
        guard let info = CGWindowListCopyWindowInfo(.optionIncludingWindow, target.windowId) as? [[String: Any]],
              let item = info.first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == target.windowId }),
              let bounds = item[kCGWindowBounds as String] as? [String: Any],
              let current = CGRect(dictionaryRepresentation: bounds as CFDictionary),
              abs(current.minX - geometry.frame.minX) < 1, abs(current.minY - geometry.frame.minY) < 1,
              abs(current.width - geometry.frame.width) < 1, abs(current.height - geometry.frame.height) < 1 else {
            aiPointer.hide()
            throw ComputerError("GEOMETRY_CHANGED", "The window moved or resized. Observe it again before acting.")
        }
    }
}

func raiseWindow(_ target: NativeTarget) {
    let app = AXUIElementCreateApplication(target.pid)
    AXUIElementSetMessagingTimeout(app, 0.2)
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success, let windows = value as? [AXUIElement] else { return }
    for window in windows {
        var position: CFTypeRef?; var size: CFTypeRef?
        AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &position)
        AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &size)
        guard let position, let size, CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { continue }
        var p = CGPoint.zero; var s = CGSize.zero
        AXValueGetValue(position as! AXValue, .cgPoint, &p); AXValueGetValue(size as! AXValue, .cgSize, &s)
        if abs(p.x - target.frame.minX) < 3, abs(p.y - target.frame.minY) < 3, abs(s.width - target.frame.width) < 3, abs(s.height - target.frame.height) < 3 {
            AXUIElementPerformAction(window, kAXRaiseAction as CFString)
            AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
            AXUIElementSetAttributeValue(window, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            AXUIElementSetAttributeValue(app, kAXFocusedWindowAttribute as CFString, window)
            return
        }
    }
}

func parseKey(_ raw: String?) throws -> (CGKeyCode, CGEventFlags) {
    guard let raw, !raw.isEmpty, raw.utf8.count <= 100 else { throw ComputerError("INVALID_KEY", "A supported key or shortcut is required.") }
    let parts = raw.uppercased().split(separator: "+").map(String.init)
    var flags: CGEventFlags = []
    for modifier in parts.dropLast() {
        switch modifier {
        case "CMD", "COMMAND", "META", "SUPER": flags.insert(.maskCommand)
        case "CTRL", "CONTROL": flags.insert(.maskControl)
        case "ALT", "OPTION": flags.insert(.maskAlternate)
        case "SHIFT": flags.insert(.maskShift)
        default: throw ComputerError("INVALID_KEY", "Unsupported shortcut modifier.")
        }
    }
    let codes: [String: CGKeyCode] = ["A":0,"S":1,"D":2,"F":3,"H":4,"G":5,"Z":6,"X":7,"C":8,"V":9,"B":11,"Q":12,"W":13,"E":14,"R":15,"Y":16,"T":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"=":24,"9":25,"7":26,"-":27,"8":28,"0":29,
        "]":30,"O":31,"U":32,"[":33,"I":34,"P":35,"ENTER":36,"RETURN":36,"L":37,"J":38,"'":39,"K":40,";":41,"BACKSLASH":42,",":43,"/":44,"N":45,"M":46,".":47,"TAB":48,"SPACE":49,"BACKSPACE":51,"ESC":53,"ESCAPE":53,"DELETE":117,"HOME":115,"END":119,"PAGEUP":116,"PAGEDOWN":121,"LEFT":123,"RIGHT":124,"DOWN":125,"UP":126,"F1":122,"F2":120,"F3":99,"F4":118,"F5":96,"F6":97,"F7":98,"F8":100,"F9":101,"F10":109,"F11":103,"F12":111]
    let aliases = ["ARROWLEFT": "LEFT", "ARROWRIGHT": "RIGHT", "ARROWUP": "UP", "ARROWDOWN": "DOWN", " ": "SPACE", "PAGE UP": "PAGEUP", "PAGE DOWN": "PAGEDOWN"]
    guard let name = parts.last, let code = codes[aliases[name] ?? name] else { throw ComputerError("INVALID_KEY", "Unsupported key name.") }
    return (code, flags)
}
