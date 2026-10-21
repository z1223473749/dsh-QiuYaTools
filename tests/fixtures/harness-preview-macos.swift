// Test-only interaction with exact temporary Harness windows. No production imports.
import AppKit
import CoreGraphics
import CoreImage
import Darwin
import Foundation
import ScreenCaptureKit

private struct Failure: Error { let code: String }
private func fail(_ code: String) -> Failure { Failure(code: code) }
private struct Identity: Codable, Equatable {
    let pid: Int32
    let birthMicros: String
    let executable: String
    let parentPid: Int32
}
private struct Binding: Codable {
    let ancestor: Identity
    let preview: Identity
    let target: Identity
    let previewWindowId: UInt32
    let targetWindowId: UInt32
    let previewTitle: String
}
private func identity(_ pid: pid_t) throws -> Identity {
    var info = proc_bsdinfo()
    guard pid > 1, proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size,
          info.pbi_uid == getuid() else { throw fail("owned-process-unavailable") }
    var buffer = [CChar](repeating: 0, count: 4096)
    guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { throw fail("owned-process-path-unavailable") }
    return Identity(pid: pid, birthMicros: String(info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec),
                    executable: URL(fileURLWithPath: String(cString: buffer)).resolvingSymlinksInPath().path, parentPid: Int32(info.pbi_ppid))
}
private func retirement(_ expected: Identity) throws -> [String: Any] {
    var info = proc_bsdinfo(); errno = 0
    let count = proc_pidinfo(expected.pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)), code = errno
    if count <= 0 && code == ESRCH { return ["expected": try encoded(expected), "retired": true, "state": "gone"] }
    guard count == MemoryLayout<proc_bsdinfo>.size else { throw fail("owned-retirement-state-unavailable") }
    let born = String(info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec)
    // Reparenting after Host exit is not retirement. A helper with the same
    // PID + birth remains live even if its parent or executable has changed.
    let same = born == expected.birthMicros
    var result: [String: Any] = ["expected": try encoded(expected), "currentBirthMicros": born,
                                 "currentParentPid": info.pbi_ppid, "retired": !same,
                                 "state": same ? "same-process-still-live" : "pid-reused"]
    if let current = try? identity(expected.pid) { result["current"] = try encoded(current) }
    return result
}
private func descendant(_ child: Identity, of ancestor: Identity) -> Bool {
    var current = child
    for _ in 0..<32 {
        if current == ancestor { return true }
        guard current.parentPid > 1, let parent = try? identity(current.parentPid),
              let parentBorn = UInt64(parent.birthMicros), let childBorn = UInt64(current.birthMicros), parentBorn <= childBorn else { return false }
        current = parent
    }
    return false
}
private func windowRows() -> [[String: Any]] { CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? [] }
private func bounds(_ row: [String: Any]) throws -> CGRect {
    guard let value = row[kCGWindowBounds as String] as? [String: Any], let rect = CGRect(dictionaryRepresentation: value as CFDictionary), rect.width > 0, rect.height > 0 else { throw fail("window-geometry-unavailable") }
    return rect
}
private func row(_ id: UInt32, _ pid: Int32) -> [String: Any]? {
    windowRows().first { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == id && ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid && (($0[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0) > 0 }
}
private func jsonRect(_ value: CGRect) -> [String: Double] { ["x": value.minX, "y": value.minY, "width": value.width, "height": value.height] }
private func project(_ point: CGPoint, from target: CGRect, into canvas: CGRect) throws -> CGPoint {
    guard target.width > 0, target.height > 0, canvas.width > 0, canvas.height > 0,
          [target.minX, target.minY, target.width, target.height, canvas.minX, canvas.minY, canvas.width, canvas.height].allSatisfy({ $0.isFinite }),
          point.x.isFinite, point.y.isFinite, target.contains(point) else { throw fail("invalid-canvas-projection") }
    return CGPoint(x: canvas.minX + (point.x - target.minX) * canvas.width / target.width,
                   y: canvas.minY + (point.y - target.minY) * canvas.height / target.height)
}
private func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var result: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success ? result : nil
}
private func rectangle(_ element: AXUIElement) -> CGRect? {
    guard let p = attribute(element, kAXPositionAttribute), let s = attribute(element, kAXSizeAttribute),
          CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero, size = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size), size.width > 0, size.height > 0 else { return nil }
    return CGRect(origin: point, size: size)
}
private func named(_ element: AXUIElement, _ label: String) -> Bool {
    [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute, "AXPlaceholderValue"].contains { attribute(element, $0) as? String == label }
}
private func visit(_ root: AXUIElement) -> [AXUIElement] {
    var values: [AXUIElement] = [], seen = Set<CFHashCode>()
    let deadline = Date().addingTimeInterval(1.5)
    func walk(_ node: AXUIElement, _ depth: Int) {
        guard depth < 16, values.count < 600, Date() < deadline, seen.insert(CFHash(node)).inserted else { return }
        values.append(node)
        for child in (attribute(node, kAXChildrenAttribute) as? [AXUIElement] ?? []).prefix(120) { walk(child, depth + 1) }
    }
    walk(root, 0); return values
}
private func axWindow(_ owner: Identity, _ frame: CGRect) throws -> AXUIElement {
    let app = AXUIElementCreateApplication(owner.pid); AXUIElementSetMessagingTimeout(app, 0.25)
    let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement] ?? []
    let matching = windows.filter { element in
        guard let rect = rectangle(element) else { return false }
        return abs(rect.minX - frame.minX) < 4 && abs(rect.minY - frame.minY) < 4 && abs(rect.width - frame.width) < 4 && abs(rect.height - frame.height) < 4
    }
    guard matching.count == 1 else { throw fail("owned-ax-window-not-unique") }
    return matching[0]
}
private func one(_ nodes: [AXUIElement], roles: Set<String>, label: String) throws -> AXUIElement {
    let values = nodes.filter { roles.contains(attribute($0, kAXRoleAttribute) as? String ?? "") && named($0, label) && rectangle($0) != nil }
    guard values.count == 1 else { throw fail("owned-preview-control-not-unique") }
    return values[0]
}
private func emptyInput() -> Bool {
    !CGEventSource.buttonState(.combinedSessionState, button: .left) && !CGEventSource.buttonState(.combinedSessionState, button: .right)
        && !CGEventSource.buttonState(.combinedSessionState, button: .center)
        && !(0..<128).contains { CGEventSource.keyState(.combinedSessionState, key: CGKeyCode($0)) }
}
private final class FrameWriter: NSObject, SCStreamOutput, @unchecked Sendable {
    private let lock = NSLock(); private var bytes: Data?
    var data: Data? { lock.lock(); defer { lock.unlock() }; return bytes }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid, let buffer = sampleBuffer.imageBuffer,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let status = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: status) == .complete else { return }
        lock.lock(); defer { lock.unlock() }; guard bytes == nil else { return }
        let image = CIImage(cvPixelBuffer: buffer), context = CIContext(options: [.cacheIntermediates: false])
        if let cg = context.createCGImage(image, from: image.extent) { bytes = NSBitmapImageRep(cgImage: cg).representation(using: .jpeg, properties: [.compressionFactor: 0.8]) }
    }
}

@MainActor private final class Interactor {
    let binding: Binding
    init(_ binding: Binding) { self.binding = binding }
    func validate(requirePreview: Bool = true) throws -> (CGRect?, CGRect) {
        guard try identity(binding.ancestor.pid) == binding.ancestor,
              try identity(binding.preview.pid) == binding.preview, descendant(binding.preview, of: binding.ancestor),
              try identity(binding.target.pid) == binding.target, descendant(binding.target, of: binding.ancestor),
              let target = row(binding.targetWindowId, binding.target.pid) else { throw fail("owned-window-identity-changed") }
        let preview = row(binding.previewWindowId, binding.preview.pid)
        if requirePreview && preview == nil { throw fail("owned-preview-retired") }
        if let preview {
            guard preview[kCGWindowName as String] as? String == binding.previewTitle,
                  (preview[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0 > 0 else { throw fail("owned-preview-not-floating") }
        }
        return (try preview.map(bounds), try bounds(target))
    }
    func nodes() throws -> (CGRect, [AXUIElement]) {
        let (preview, _) = try validate()
        guard let preview else { throw fail("owned-preview-retired") }
        return (preview, visit(try axWindow(binding.preview, preview)))
    }
    func physicalHit(_ point: CGPoint) throws -> pid_t {
        let hit = windowRows().first { value in
            guard ((value[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0) > 0 else { return false }
            return (try? bounds(value).contains(point)) == true
        }
        guard (hit?[kCGWindowNumber as String] as? NSNumber)?.uint32Value == binding.previewWindowId,
              (hit?[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == binding.preview.pid else { throw fail("owned-preview-physical-point-obscured") }
        var element: AXUIElement?
        guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &element) == .success,
              let element else { throw fail("physical-ax-hit-unavailable") }
        var hitPid: pid_t = 0
        let hitWindow = attribute(element, kAXWindowAttribute).flatMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil } ?? element
        guard AXUIElementGetPid(hitWindow, &hitPid) == .success, hitPid == binding.preview.pid else { throw fail("physical-ax-hit-owner-mismatch") }
        return hitPid
    }
    func click(_ point: CGPoint) async throws -> [String: Any] {
        _ = try validate()
        guard emptyInput(), point.x.isFinite, point.y.isFinite else { throw fail("input-not-empty-before-click") }
        let hitPid = try physicalHit(point)
        let source = CGEventSource(stateID: .combinedSessionState)
        guard let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left),
              let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
              let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else { throw fail("fixture-cgevent-unavailable") }
        move.post(tap: .cghidEventTap)
        try await Task.sleep(nanoseconds: 40_000_000)
        _ = try validate(); _ = try physicalHit(point)
        guard emptyInput() else { throw fail("input-changed-before-click") }
        down.setIntegerValueField(.mouseEventClickState, value: 1); up.setIntegerValueField(.mouseEventClickState, value: 1)
        down.post(tap: .cghidEventTap)
        defer { up.post(tap: .cghidEventTap) }
        try await Task.sleep(nanoseconds: 35_000_000)
        return ["clicked": true, "x": point.x, "y": point.y, "hitWindowId": binding.previewWindowId, "hitPid": hitPid,
                "mouseSource": "CGEvent HID tap OS-synthetic; not hardware"]
    }
    func screenshot(_ path: String) async throws {
        guard path.hasPrefix("/"), CGPreflightScreenCaptureAccess() else { throw fail("owned-screenshot-permission-or-path") }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        guard let window = content.windows.first(where: { $0.windowID == binding.previewWindowId && $0.owningApplication?.processID == binding.preview.pid }) else { throw fail("owned-preview-capture-unavailable") }
        let config = SCStreamConfiguration(); config.width = min(1600, Int(window.frame.width * 2)); config.height = Int(Double(config.width) * window.frame.height / window.frame.width)
        config.scalesToFit = true; config.showsCursor = false
        if #available(macOS 14.0, *) { config.ignoreShadowsSingleWindow = true }
        let writer = FrameWriter(), stream = SCStream(filter: SCContentFilter(desktopIndependentWindow: window), configuration: config, delegate: nil)
        try stream.addStreamOutput(writer, type: .screen, sampleHandlerQueue: DispatchQueue(label: "qiuya.harness.preview-frame")); try await stream.startCapture()
        for _ in 0..<100 { if writer.data != nil { break }; try await Task.sleep(nanoseconds: 30_000_000) }
        try await stream.stopCapture(); _ = try validate()
        guard let data = writer.data else { throw fail("owned-preview-capture-timeout") }
        try data.write(to: URL(fileURLWithPath: path), options: .atomic)
    }
    func run(_ command: [String: Any]) async throws -> [String: Any] {
        let op = command["op"] as? String ?? ""
        if op == "close" {
            let start = Date(), (preview, _) = try validate(requirePreview: false)
            if preview == nil { return ["closed": true, "alreadyClosed": true, "binding": try encoded(binding)] }
            let window = try axWindow(binding.preview, preview!)
            guard let close = attribute(window, kAXCloseButtonAttribute), CFGetTypeID(close) == AXUIElementGetTypeID(), let rect = rectangle(close as! AXUIElement) else { throw fail("owned-preview-close-button-unavailable") }
            let receipt = try await click(CGPoint(x: rect.midX, y: rect.midY))
            for _ in 0..<100 { if row(binding.previewWindowId, binding.preview.pid) == nil { return ["closed": true, "alreadyClosed": false, "elapsedMs": Date().timeIntervalSince(start) * 1000, "click": receipt] }; try await Task.sleep(nanoseconds: 20_000_000) }
            throw fail("owned-preview-did-not-retire")
        }
        let (frame, elements) = try nodes()
        var result: [String: Any] = ["binding": try encoded(binding), "previewFrame": jsonRect(frame), "inputEmpty": emptyInput()]
        switch op {
        case "observe":
            result["labels"] = elements.flatMap { node in [kAXRoleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute].compactMap { attribute(node, $0) as? String }.filter { !$0.isEmpty }.map { String($0.prefix(200)) } }
            if let canvas = try? one(elements, roles: ["AXImage"], label: "实时电脑画面"), let rect = rectangle(canvas) { result["canvas"] = jsonRect(rect) }
        case "button":
            guard let label = command["label"] as? String, ["暂停", "接管", "继续", "停止", "输入", "Enter"].contains(label),
                  let rect = rectangle(try one(elements, roles: ["AXButton"], label: label)) else { throw fail("invalid-preview-button") }
            result["click"] = try await click(CGPoint(x: rect.midX, y: rect.midY)); result["pressed"] = true; result["label"] = label
        case "click-composer":
            let (_, targetFrame) = try validate()
            let targets = visit(try axWindow(binding.target, targetFrame)).filter { node in
                guard attribute(node, kAXRoleAttribute) as? String == "AXTextArea", let rect = rectangle(node), rect.width > 100, rect.height > 18,
                      rect.midY > targetFrame.minY + targetFrame.height * 0.45, targetFrame.contains(CGPoint(x: rect.midX, y: rect.midY)) else { return false }
                return (attribute(node, kAXEnabledAttribute) as? Bool) != false
            }
            guard targets.count == 1, let composer = rectangle(targets[0]), let canvas = rectangle(try one(elements, roles: ["AXImage"], label: "实时电脑画面")) else { throw fail("owned-composer-or-canvas-not-unique") }
            let point = try project(CGPoint(x: composer.midX, y: composer.midY), from: targetFrame, into: canvas)
            result["targetFrame"] = jsonRect(targetFrame); result["targetComposer"] = jsonRect(composer); result["canvas"] = jsonRect(canvas)
            result["click"] = try await click(point)
        case "type-footer":
            guard let text = command["text"] as? String, !text.isEmpty, text.utf16.count <= 256 else { throw fail("invalid-fixture-text") }
            let input = try one(elements, roles: ["AXTextField", "AXTextArea"], label: "接管后输入文字")
            guard let rect = rectangle(input), (attribute(input, kAXValueAttribute) as? String ?? "").isEmpty else { throw fail("fixture-footer-not-empty") }
            result["click"] = try await click(CGPoint(x: rect.midX, y: rect.midY))
            func focused() -> Bool {
                guard let value = attribute(AXUIElementCreateApplication(binding.preview.pid), kAXFocusedUIElementAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { return false }
                return CFEqual(value, input)
            }
            for _ in 0..<100 { if focused() { break }; try await Task.sleep(nanoseconds: 10_000_000) }
            guard focused(), emptyInput() else { throw fail("own-preview-footer-did-not-focus") }
            let source = CGEventSource(stateID: .combinedSessionState)
            for character in text {
                _ = try validate(); guard focused() else { throw fail("own-preview-footer-lost-focus") }
                let units = Array(String(character).utf16)
                guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true), let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else { throw fail("fixture-unicode-event-unavailable") }
                down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units); up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                down.flags = []; up.flags = []; down.postToPid(binding.preview.pid); up.postToPid(binding.preview.pid)
                try await Task.sleep(nanoseconds: 3_000_000)
            }
            let start = Date(); var observations = 0, actual = ""
            repeat {
                observations += 1; actual = attribute(input, kAXValueAttribute) as? String ?? ""
                if actual == text { break }; try await Task.sleep(nanoseconds: 50_000_000)
            } while Date().timeIntervalSince(start) < 5
            guard actual == text, emptyInput() else { throw fail("footer-unicode-value-not-confirmed") }
            result["textValue"] = actual; result["observations"] = observations; result["elapsedMs"] = Date().timeIntervalSince(start) * 1000
            result["keyboardSource"] = "CGEvent postToPid Unicode OS-synthetic; not IME"
        default: throw fail("unsupported-owned-preview-operation")
        }
        if let output = command["output"] as? String { try await screenshot(output) }
        return result
    }
}
private func encoded<T: Encodable>(_ value: T) throws -> Any { try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) }

@main @MainActor private struct Main {
    static func main() async {
        do {
            if CommandLine.arguments.dropFirst() == ["--self-test"] {
                let p = try project(CGPoint(x: -50, y: 250), from: CGRect(x: -250, y: 50, width: 400, height: 400), into: CGRect(x: 100, y: 500, width: 200, height: 200))
                guard p == CGPoint(x: 200, y: 600) else { throw fail("projection-self-test-failed") }
                do { _ = try project(CGPoint(x: 999, y: 999), from: CGRect(x: 0, y: 0, width: 200, height: 200), into: CGRect(x: 0, y: 0, width: 400, height: 400)); throw fail("out-of-bounds-was-accepted") } catch let error as Failure { guard error.code == "invalid-canvas-projection" else { throw error } }
                let child = Process(); child.executableURL = URL(fileURLWithPath: "/bin/sleep"); child.arguments = ["0.25"]
                try child.run(); let born = try identity(child.processIdentifier)
                guard try retirement(born)["retired"] as? Bool == false else { throw fail("live-identity-was-retired") }
                let reparented = Identity(pid: born.pid, birthMicros: born.birthMicros, executable: born.executable, parentPid: 1)
                guard try retirement(reparented)["retired"] as? Bool == false else { throw fail("reparenting-was-counted-as-retirement") }
                child.waitUntilExit()
                guard try retirement(born)["retired"] as? Bool == true else { throw fail("exited-identity-was-live") }
                try emit(["ok": true, "result": ["projection": true, "outsideRejected": true, "identityRetirement": true, "inputEventsPosted": 0, "activationCalls": 0]]); return
            }
            guard CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--request", let bytes = CommandLine.arguments[2].data(using: .utf8), bytes.count <= 16384,
                  let request = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], let op = request["op"] as? String,
                  ["bind", "observe", "button", "click-composer", "type-footer", "close", "retirement"].contains(op) else { throw fail("invalid-owned-preview-request") }
            if op == "retirement" {
                guard let value = request["binding"] else { throw fail("missing-owned-binding") }
                let binding = try JSONDecoder().decode(Binding.self, from: JSONSerialization.data(withJSONObject: value))
                let states = try [binding.ancestor, binding.preview, binding.target].map(retirement)
                try emit(["ok": true, "result": ["states": states, "allRetired": states.allSatisfy { $0["retired"] as? Bool == true }, "inputEventsPosted": 0, "signalsSent": 0]]); return
            }
            _ = NSApplication.shared; NSApp.setActivationPolicy(.prohibited)
            guard AXIsProcessTrusted(), CGPreflightPostEventAccess() else { throw fail("fixture-accessibility-or-post-events-permission") }
            let result: [String: Any]
            if op == "bind" {
                guard let ancestorPid = request["ancestorPid"] as? Int32, let targetPid = request["targetPid"] as? Int32,
                      let targetWindowId = request["targetWindowId"] as? UInt32,
                      let previewPath = request["previewExecutable"] as? String, let targetPath = request["targetExecutable"] as? String,
                      let title = request["previewTitle"] as? String, title == "QiuYaTools · 电脑操控",
                      previewPath.hasPrefix("/"), targetPath.hasPrefix("/"), previewPath.contains("QiuYaTools Computer.app/Contents/MacOS/qiuya-computer"),
                      targetPath.contains("QiuYaTools Sessions.app/Contents/MacOS/qiuya-session-window") else { throw fail("invalid-owned-binding-request") }
                let ancestor = try identity(ancestorPid), target = try identity(targetPid)
                guard target.executable == URL(fileURLWithPath: targetPath).resolvingSymlinksInPath().path, descendant(target, of: ancestor) else { throw fail("target-outside-isolated-harness") }
                let candidates = windowRows().compactMap { value -> (Identity, UInt32)? in
                    guard value[kCGWindowName as String] as? String == title, let pid = (value[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
                          let id = (value[kCGWindowNumber as String] as? NSNumber)?.uint32Value, let process = try? identity(pid),
                          process.executable == URL(fileURLWithPath: previewPath).resolvingSymlinksInPath().path, descendant(process, of: ancestor) else { return nil }
                    return (process, id)
                }
                guard candidates.count == 1 else { throw fail("owned-floating-preview-not-unique") }
                let binding = Binding(ancestor: ancestor, preview: candidates[0].0, target: target, previewWindowId: candidates[0].1, targetWindowId: targetWindowId, previewTitle: title)
                _ = try Interactor(binding).validate(); result = ["binding": try encoded(binding)]
            } else {
                guard let value = request["binding"] else { throw fail("missing-owned-binding") }
                let binding = try JSONDecoder().decode(Binding.self, from: JSONSerialization.data(withJSONObject: value))
                result = try await Interactor(binding).run(request)
            }
            try emit(["ok": true, "result": result])
        } catch {
            let code = (error as? Failure)?.code ?? "owned-preview-observer-failed"
            try? emit(["ok": false, "error": code]); FileHandle.standardError.write(Data((code + "\n").utf8)); exit(1)
        }
    }
    static func emit(_ value: [String: Any]) throws { FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])); FileHandle.standardOutput.write(Data([10])) }
}
