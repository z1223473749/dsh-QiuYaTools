// Test-only interaction with exact temporary Harness windows. No production imports.
import AppKit
import CoreGraphics
import CoreImage
import Darwin
import Foundation
import ScreenCaptureKit
import Vision
import CoreText

private struct Failure: Error { let code: String; var diagnostic: [String: Any]? = nil }
private func fail(_ code: String, diagnostic: [String: Any]? = nil) -> Failure { Failure(code: code, diagnostic: diagnostic) }
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
private struct AXPhysicalHit {
    let copyResult: Int32
    let elementAvailable: Bool
    let pidResult: Int32?
    let pid: pid_t?
}
private func axPhysicalHit(_ point: CGPoint, diagnosticOnly: Bool = false) -> AXPhysicalHit {
    var element: AXUIElement?
    let system = AXUIElementCreateSystemWide()
    if diagnosticOnly { AXUIElementSetMessagingTimeout(system, 0.1) }
    let copied = AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &element)
    guard copied == .success, let element else { return AXPhysicalHit(copyResult: copied.rawValue, elementAvailable: false, pidResult: nil, pid: nil) }
    if diagnosticOnly { AXUIElementSetMessagingTimeout(element, 0.1) }
    var pid: pid_t = 0
    let hitWindow = attribute(element, kAXWindowAttribute).flatMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil } ?? element
    let result = AXUIElementGetPid(hitWindow, &pid)
    return AXPhysicalHit(copyResult: copied.rawValue, elementAvailable: true, pidResult: result.rawValue, pid: result == .success ? pid : nil)
}
private func systemWindowOwner(_ pid: pid_t) -> Bool {
    // A diagnostic label only. This broad label never controls input guards.
    if pid == 0 { return true }
    var path = [CChar](repeating: 0, count: 4096)
    guard pid > 0, proc_pidpath(pid, &path, UInt32(path.count)) > 0 else { return false }
    return String(cString: path).hasPrefix("/System/Library/")
}
private func verifiedWindowServer(_ pid: pid_t) -> Bool {
    guard pid > 0 else { return false }
    func path() -> String? {
        var buffer = [CChar](repeating: 0, count: 4096)
        guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return nil }
        return String(validatingUTF8: buffer)
    }
    guard let executablePath = path() else { return false }
    var executable = stat()
    guard stat(executablePath, &executable) == 0, executable.st_uid == 0, (executable.st_mode & S_IFMT) == S_IFREG else { return false }
    let trustedPaths = ["/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer",
                        "/System/Library/PrivateFrameworks/SkyLight.framework/Versions/A/Resources/WindowServer"]
    let trusted = trustedPaths.contains { candidate in
        var system = stat()
        return stat(candidate, &system) == 0 && system.st_uid == 0 && (system.st_mode & S_IFMT) == S_IFREG &&
            executable.st_dev == system.st_dev && executable.st_ino == system.st_ino
    }
    // BSD birth metadata for WindowServer can be denied across user IDs even
    // when the kernel's executable path is readable. Re-read that path instead
    // of caching a bare PID: the owner must still execute this root-owned exact
    // protected system inode, never merely claim a process or window name.
    return trusted && path() == executablePath
}
private func systemCursorWindow(_ row: [String: Any], verifyOwner: (pid_t) -> Bool = verifiedWindowServer) -> Bool {
    guard let layer = row[kCGWindowLayer as String] as? NSNumber, layer.int64Value == Int64(CGWindowLevelForKey(.cursorWindow)),
          let owner = row[kCGWindowOwnerPID as String] as? NSNumber, owner.int64Value > 0, owner.int64Value <= Int64(Int32.max) else { return false }
    return verifyOwner(owner.int32Value)
}
private func firstPhysicalWindow(_ rows: [[String: Any]], point: CGPoint,
                                 verifyCursorOwner: (pid_t) -> Bool = verifiedWindowServer) -> [String: Any]? {
    rows.first { value in
        guard ((value[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0) > 0,
              (try? bounds(value).contains(point)) == true else { return false }
        // The actual system cursor is a CG window but does not intercept
        // clicks. Exclude only the SDK cursor level AND verified WindowServer
        // executable identity; system/high-layer/third-party overlays remain.
        return !systemCursorWindow(value, verifyOwner: verifyCursorOwner)
    }
}
private func physicalDiagnostic(_ point: CGPoint, binding: Binding, rows: [[String: Any]], ax: AXPhysicalHit,
                                isSystem: (pid_t) -> Bool = systemWindowOwner) -> [String: Any] {
    var projected = [[String: Any]]()
    for row in rows {
        guard let rect = try? bounds(row), rect.contains(point),
              [rect.minX, rect.minY, rect.width, rect.height].allSatisfy({ $0.isFinite }) else { continue }
        let id = (row[kCGWindowNumber as String] as? NSNumber)?.uint32Value
        let pid = (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
        let tag: String
        if id == binding.previewWindowId && pid == binding.preview.pid { tag = "ownedPreview" }
        else if id == binding.targetWindowId && pid == binding.target.pid { tag = "ownedTarget" }
        else if let pid, isSystem(pid) { tag = "system" }
        else { tag = "other" }
        let alpha = (row[kCGWindowAlpha as String] as? NSNumber)?.doubleValue
        projected.append(["id": id as Any? ?? NSNull(), "pid": pid as Any? ?? NSNull(),
                          "layer": (row[kCGWindowLayer as String] as? NSNumber)?.intValue as Any? ?? NSNull(),
                          "alpha": alpha.flatMap { $0.isFinite ? $0 : nil } as Any? ?? NSNull(), "bounds": jsonRect(rect), "tag": tag])
        if projected.count == 8 { break }
    }
    return ["schemaVersion": 1, "point": ["x": point.x, "y": point.y],
            "previewWindowId": binding.previewWindowId, "previewPid": binding.preview.pid,
            "targetWindowId": binding.targetWindowId, "targetPid": binding.target.pid,
            "containsPointWindows": projected, "limit": 8, "order": "CGWindowList-front-to-back",
            "axHitPid": ax.pid as Any? ?? NSNull(), "axHitResult": ax.copyResult,
            "axPidResult": ax.pidResult as Any? ?? NSNull()]
}
private func writeDiagnostic(_ value: [String: Any], to path: String) throws {
    let bytes = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    guard bytes.count <= 16384 else { throw fail("physical-diagnostic-too-large") }
    let descriptor = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode_t(0o600))
    guard descriptor >= 0 else { throw fail("physical-diagnostic-write-failed") }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    defer { try? handle.close() }
    do { try handle.write(contentsOf: bytes); try handle.write(contentsOf: Data([10])) }
    catch { throw fail("physical-diagnostic-write-failed") }
}
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
        for key in [kAXChildrenAttribute, "AXChildrenInNavigationOrder", "AXContents"] {
            for child in (attribute(node, key) as? [AXUIElement] ?? []).prefix(120) { walk(child, depth + 1) }
        }
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
private func footerText(_ image: CGImage, region: CGRect = CGRect(x: 0, y: 0, width: 1, height: 0.18)) throws -> [String] {
    let recognition = VNRecognizeTextRequest()
    recognition.recognitionLevel = .accurate; recognition.recognitionLanguages = ["zh-Hans", "en-US"]
    recognition.regionOfInterest = region
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([recognition])
    return (recognition.results ?? []).compactMap { $0.topCandidates(1).first?.string }
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
    private var accessibilityActivation: [String: Int32] = [:]
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
    func nodes() async throws -> (CGRect, [AXUIElement]) {
        _ = try validate()
        let application = AXUIElementCreateApplication(binding.preview.pid)
        AXUIElementSetMessagingTimeout(application, 0.25)
        // WebKit lazily publishes its HTML AX tree when an accessibility
        // client requests it. This is confined to the already-pinned test
        // owner and never grants permissions or changes system settings.
        for key in ["AXManualAccessibility", "AXEnhancedUserInterface"] {
            accessibilityActivation[key] = AXUIElementSetAttributeValue(application, key as CFString, kCFBooleanTrue).rawValue
        }
        var last: (CGRect, [AXUIElement])?
        for _ in 0..<60 {
            let (preview, _) = try validate()
            guard let preview else { throw fail("owned-preview-retired") }
            let elements = visit(try axWindow(binding.preview, preview))
            last = (preview, elements)
            if elements.contains(where: { named($0, "暂停") }) { return last! }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        guard let last else { throw fail("owned-preview-ax-not-ready") }
        return last
    }
    func physicalHit(_ point: CGPoint) throws -> pid_t {
        let rows = windowRows()
        let hit = firstPhysicalWindow(rows, point: point)
        guard (hit?[kCGWindowNumber as String] as? NSNumber)?.uint32Value == binding.previewWindowId,
              (hit?[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == binding.preview.pid else {
            throw fail("owned-preview-physical-point-obscured", diagnostic: physicalDiagnostic(point, binding: binding, rows: rows, ax: axPhysicalHit(point, diagnosticOnly: true)))
        }
        let ax = axPhysicalHit(point)
        guard ax.copyResult == AXError.success.rawValue, ax.elementAvailable else {
            throw fail("physical-ax-hit-unavailable", diagnostic: physicalDiagnostic(point, binding: binding, rows: rows, ax: ax))
        }
        guard ax.pidResult == AXError.success.rawValue, ax.pid == binding.preview.pid else {
            throw fail("physical-ax-hit-owner-mismatch", diagnostic: physicalDiagnostic(point, binding: binding, rows: rows, ax: ax))
        }
        return ax.pid!
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
    func screenshot(_ path: String) async throws -> [String] {
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
        guard let image = NSBitmapImageRep(data: data)?.cgImage else { throw fail("owned-preview-image-unreadable") }
        let text = try footerText(image)
        _ = try validate()
        return text
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
        let (frame, elements) = try await nodes()
        var result: [String: Any] = ["binding": try encoded(binding), "previewFrame": jsonRect(frame), "inputEmpty": emptyInput(), "accessibilityActivation": accessibilityActivation]
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
        if let output = command["output"] as? String {
            result["recognizedText"] = try await screenshot(output)
            result["recognitionRegion"] = "exact-owned-preview-bottom-18-percent"
        }
        return result
    }
}
private func encoded<T: Encodable>(_ value: T) throws -> Any { try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) }

@main @MainActor private struct Main {
    static func main() async {
        var diagnosticOutput: String?
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
                guard let pixels = CGContext(data: nil, width: 400, height: 100, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw fail("ocr-self-test-context") }
                pixels.setFillColor(CGColor(gray: 0, alpha: 1)); pixels.fill(CGRect(x: 0, y: 0, width: 400, height: 100))
                let font = CTFontCreateWithName("Helvetica" as CFString, 48, nil)
                let text = NSAttributedString(string: "38 ms", attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font, NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 1, alpha: 1)])
                pixels.textPosition = CGPoint(x: 20, y: 25); CTLineDraw(CTLineCreateWithAttributedString(text), pixels)
                guard let image = pixels.makeImage(), try footerText(image, region: CGRect(x: 0, y: 0, width: 1, height: 1)).contains(where: { $0.range(of: #"\d+\s*ms"#, options: .regularExpression) != nil }) else { throw fail("visible-latency-ocr-self-test-failed") }
                // Pure projection tests: never inspect real system windows or
                // query AX, activate applications, or send native input.
                let own = Identity(pid: 81, birthMicros: "1", executable: "/private-test-secret", parentPid: 80)
                let target = Identity(pid: 82, birthMicros: "1", executable: "/private-target-secret", parentPid: 80)
                let binding = Binding(ancestor: own, preview: own, target: target, previewWindowId: 1, targetWindowId: 2, previewTitle: "PRIVATE-TITLE")
                var rows = [[String: Any]]()
                for i in 1...12 {
                    let pid = i == 1 ? 81 : i == 2 ? 82 : i == 3 ? 0 : 90
                    var value: [String: Any] = [kCGWindowNumber as String: NSNumber(value: i), kCGWindowOwnerPID as String: NSNumber(value: pid)]
                    value[kCGWindowLayer as String] = NSNumber(value: 20 - i)
                    value[kCGWindowAlpha as String] = NSNumber(value: i == 1 ? 0 : 1)
                    value[kCGWindowBounds as String] = CGRect(x: 0, y: 0, width: 50, height: 50).dictionaryRepresentation
                    value[kCGWindowName as String] = "PRIVATE-TITLE"; value[kCGWindowOwnerName as String] = "PRIVATE-CONTENT"
                    rows.append(value)
                }
                let diagnostic = physicalDiagnostic(CGPoint(x: 25, y: 25), binding: binding, rows: rows,
                    ax: AXPhysicalHit(copyResult: 0, elementAvailable: true, pidResult: 0, pid: 81), isSystem: { $0 == 0 })
                guard let projected = diagnostic["containsPointWindows"] as? [[String: Any]], projected.count == 8,
                      projected[0]["tag"] as? String == "ownedPreview", projected[1]["tag"] as? String == "ownedTarget",
                      projected[2]["tag"] as? String == "system", projected[3]["tag"] as? String == "other",
                      projected.allSatisfy({ Set($0.keys) == Set(["id", "pid", "layer", "alpha", "bounds", "tag"]) }),
                      !String(data: try JSONSerialization.data(withJSONObject: diagnostic), encoding: .utf8)!.contains("PRIVATE"),
                      !String(data: try JSONSerialization.data(withJSONObject: diagnostic), encoding: .utf8)!.contains("secret") else { throw fail("physical-diagnostic-projection-self-test-failed") }
                var previewRow = rows[0]; previewRow[kCGWindowAlpha as String] = 1
                var cursor = rows[3]
                cursor[kCGWindowNumber as String] = 91; cursor[kCGWindowOwnerPID as String] = 700
                cursor[kCGWindowLayer as String] = CGWindowLevelForKey(.cursorWindow)
                let point = CGPoint(x: 25, y: 25), trusted: (pid_t) -> Bool = { $0 == 700 }
                func selectedId(_ values: [[String: Any]], verify: (pid_t) -> Bool = trusted) -> UInt32? {
                    (firstPhysicalWindow(values, point: point, verifyCursorOwner: verify)?[kCGWindowNumber as String] as? NSNumber)?.uint32Value
                }
                guard selectedId([cursor, previewRow]) == 1, selectedId([cursor, previewRow], verify: { _ in false }) == 91 else { throw fail("system-cursor-owner-fence-self-test-failed") }
                var otherSystem = cursor; otherSystem[kCGWindowLayer as String] = CGWindowLevelForKey(.floatingWindow)
                guard selectedId([otherSystem, previewRow]) == 91 else { throw fail("other-system-layer-was-ignored") }
                var overlay = cursor; overlay[kCGWindowNumber as String] = 92; overlay[kCGWindowOwnerPID as String] = 701
                guard selectedId([overlay, cursor, previewRow]) == 92 else { throw fail("real-overlay-before-preview-was-ignored") }
                var missing = cursor; missing.removeValue(forKey: kCGWindowLayer as String)
                guard selectedId([missing, previewRow]) == 91 else { throw fail("unknown-cursor-layer-was-ignored") }
                let directory = FileManager.default.temporaryDirectory.appendingPathComponent("qiuya-preview-diagnostic-" + UUID().uuidString)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
                defer { try? FileManager.default.removeItem(at: directory) }
                let file = directory.appendingPathComponent("diagnostic.json")
                try writeDiagnostic(diagnostic, to: file.path)
                let original = try Data(contentsOf: file)
                do { try writeDiagnostic(["unexpected": true], to: file.path); throw fail("physical-diagnostic-overwrite-accepted") }
                catch let error as Failure { guard error.code == "physical-diagnostic-write-failed" else { throw error } }
                guard try Data(contentsOf: file) == original else { throw fail("physical-diagnostic-existing-evidence-changed") }
                try emit(["ok": true, "result": ["projection": true, "outsideRejected": true, "identityRetirement": true, "visibleLatencyRecognition": true, "inputEventsPosted": 0, "activationCalls": 0]]); return
            }
            guard CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--request", let bytes = CommandLine.arguments[2].data(using: .utf8), bytes.count <= 16384,
                  let request = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], let op = request["op"] as? String,
                  ["bind", "observe", "button", "click-composer", "type-footer", "close", "retirement"].contains(op) else { throw fail("invalid-owned-preview-request") }
            if let supplied = request["diagnosticOutput"] {
                guard let path = supplied as? String, path.hasPrefix("/"), path.utf8.count <= 4096, !path.contains("\0"), path.hasSuffix(".json"),
                      URL(fileURLWithPath: path).standardizedFileURL.path == path else { throw fail("invalid-physical-diagnostic-output") }
                diagnosticOutput = path
            }
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
            var response: [String: Any] = ["ok": false, "error": code]
            if let diagnostic = (error as? Failure)?.diagnostic {
                response["diagnostic"] = diagnostic
                if let diagnosticOutput {
                    do { try writeDiagnostic(["ok": false, "error": code, "diagnostic": diagnostic], to: diagnosticOutput); response["diagnosticOutputWritten"] = true }
                    catch { response["diagnosticOutputWritten"] = false; response["diagnosticOutputError"] = "physical-diagnostic-write-failed" }
                }
            }
            try? emit(response); FileHandle.standardError.write(Data((code + "\n").utf8)); exit(1)
        }
    }
    static func emit(_ value: [String: Any]) throws { FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])); FileHandle.standardOutput.write(Data([10])) }
}
