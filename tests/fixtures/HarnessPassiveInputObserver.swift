import AppKit
import ApplicationServices
import CoreImage
import CoreMedia
import Darwin
import Foundation
import ScreenCaptureKit

// Independent, input-free evidence. No permission request, activation, event
// injection, remote ObjC reflection, or process signal exists in this observer.
private struct CursorIdentity: Codable {
    let pid: Int32
    let startSeconds: String
    let startMicroseconds: String
    let executablePath: String
    let uniqueId: String
    let parentPid: Int32
    let parentUniqueId: String
    var json: [String: Any] { ["pid": pid, "startSeconds": startSeconds, "startMicroseconds": startMicroseconds,
        "executablePath": executablePath, "uniqueId": uniqueId, "parentPid": parentPid, "parentUniqueId": parentUniqueId] }
}
private func failure(_ message: String) -> NSError { NSError(domain: message, code: 1) }
private func identity(_ pid: Int32) throws -> CursorIdentity {
    var bsd = proc_bsdinfo(), ids = [UInt64](repeating: 0, count: 7), path = [CChar](repeating: 0, count: 4096)
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsd, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size,
          bsd.pbi_uid == getuid(), ids.withUnsafeMutableBytes({ proc_pidinfo(pid, 17, 0, $0.baseAddress, Int32($0.count)) }) == 56,
          ids[2] > 0, proc_pidpath(pid, &path, UInt32(path.count)) > 0 else { throw failure("identity-unavailable") }
    var after = proc_bsdinfo()
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size,
          after.pbi_start_tvsec == bsd.pbi_start_tvsec, after.pbi_start_tvusec == bsd.pbi_start_tvusec else { throw failure("identity-changed") }
    return CursorIdentity(pid: pid, startSeconds: String(bsd.pbi_start_tvsec), startMicroseconds: String(bsd.pbi_start_tvusec),
        executablePath: URL(fileURLWithPath: String(cString: path)).resolvingSymlinksInPath().path, uniqueId: String(ids[2]),
        parentPid: Int32(bsd.pbi_ppid), parentUniqueId: String(ids[3]))
}
private func same(_ a: CursorIdentity, _ b: CursorIdentity) -> Bool {
    a.pid == b.pid && a.startSeconds == b.startSeconds && a.startMicroseconds == b.startMicroseconds && a.uniqueId == b.uniqueId && a.executablePath == b.executablePath
}
private func expected(_ raw: Any?) throws -> CursorIdentity {
    guard let raw, JSONSerialization.isValidJSONObject(raw), let value = try? JSONDecoder().decode(CursorIdentity.self, from: JSONSerialization.data(withJSONObject: raw)),
          same(try identity(value.pid), value) else { throw failure("pinned-identity-changed") }
    return value
}
private func windowInfo(_ info: [String: Any]) -> [String: Any]? {
    guard let bounds = info[kCGWindowBounds as String] as? [String: Any], let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return nil }
    return ["id": info[kCGWindowNumber as String] as Any? ?? NSNull(), "pid": info[kCGWindowOwnerPID as String] as Any? ?? NSNull(),
        "title": info[kCGWindowName as String] as? String ?? "", "layer": info[kCGWindowLayer as String] as Any? ?? NSNull(),
        "alpha": info[kCGWindowAlpha as String] as Any? ?? NSNull(), "onScreen": info[kCGWindowIsOnscreen as String] as Any? ?? NSNull(),
        "x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height]
}

// This deliberately tests visible properties, not a duplicate production path:
// a thin white contour in 18×20, translucent grey interior on the black fixture,
// a dim halo outside that box, and no bright traditional long tail below it.
private func smallArrowAnalysis(_ bitmap: NSBitmapImageRep, crop: CGRect, probe: [String: Double]) -> [String: Any]? {
    guard let tipX = probe["tipX"], let tipY = probe["tipY"],
          let x = probe["x"], let y = probe["y"], let width = probe["width"], let height = probe["height"] else { return nil }
    let scaleX = Double(bitmap.pixelsWide) / crop.width, scaleY = Double(bitmap.pixelsHigh) / crop.height
    let minX = max(0, Int(floor(x * scaleX))), minY = max(0, Int(floor(y * scaleY)))
    let maxX = min(bitmap.pixelsWide, Int(ceil((x + width) * scaleX))), maxY = min(bitmap.pixelsHigh, Int(ceil((y + height) * scaleY)))
    guard minX < maxX, minY < maxY else { return nil }
    let background: [[Double]] = [(tipX - 16, tipY - 16), (tipX + 26, tipY - 16),
        (tipX - 16, tipY + 28), (tipX + 26, tipY + 28)].compactMap { point in
        let column = Int((point.0 * scaleX).rounded()), row = Int((point.1 * scaleY).rounded())
        guard column >= 0, column < bitmap.pixelsWide, row >= 0, row < bitmap.pixelsHigh,
              let c = bitmap.colorAt(x: column, y: row)?.usingColorSpace(.sRGB) else { return nil }
        return [Double(c.redComponent) * 255, Double(c.greenComponent) * 255, Double(c.blueComponent) * 255]
    }
    guard background.count == 4 else { return nil }
    let backgroundRGB = (0..<3).map { channel in background.map { $0[channel] }.reduce(0, +) / 4 }
    let backgroundSpread = (0..<3).map { channel in background.map { $0[channel] }.max()! - background.map { $0[channel] }.min()! }.max()!
    var outline = 0, halo = 0, brightOutside = 0
    for row in minY..<maxY { for column in minX..<maxX {
        guard let color = bitmap.colorAt(x: column, y: row)?.usingColorSpace(.sRGB) else { continue }
        let r = Double(color.redComponent) * 255, g = Double(color.greenComponent) * 255, b = Double(color.blueComponent) * 255
        let localX = (Double(column) + 0.5) / scaleX - tipX + 2, localY = (Double(row) + 0.5) / scaleY - tipY + 3
        let inGlyph = localX >= 0 && localX < 18 && localY >= 0 && localY < 20
        if inGlyph && min(r, g, b) > 225 { outline += 1 }
        if !inGlyph {
            if max(r, g, b) > 160 { brightOutside += 1 }
            let delta = [r - backgroundRGB[0], g - backgroundRGB[1], b - backgroundRGB[2]]
            if delta.max()! >= 2 && delta.max()! <= 60 && delta.max()! - delta.min()! < 25 { halo += 1 }
        }
    } }
    let samples: [[String: Any]] = [(5.3, 6.3), (5.8, 9.5), (8.0, 7.5)].map { point in
        let centerX = tipX - 2 + point.0, centerY = tipY - 3 + point.1
        let a = max(0, Int(floor((centerX - 0.35) * scaleX))), b = max(0, Int(floor((centerY - 0.35) * scaleY)))
        let c = min(bitmap.pixelsWide, Int(ceil((centerX + 0.35) * scaleX))), d = min(bitmap.pixelsHigh, Int(ceil((centerY + 0.35) * scaleY)))
        var channels = [Double](repeating: 0, count: 3), count = 0
        if a < c, b < d { for row in b..<d { for column in a..<c {
            if let color = bitmap.colorAt(x: column, y: row)?.usingColorSpace(.sRGB) {
                channels[0] += Double(color.redComponent) * 255; channels[1] += Double(color.greenComponent) * 255
                channels[2] += Double(color.blueComponent) * 255; count += 1
            }
        } } }
        return ["glyphX": point.0, "glyphY": point.1, "rgb": count > 0 ? channels.map { $0 / Double(count) } : [], "pixels": count]
    }
    let area = scaleX * scaleY
    return ["viewBox": [18, 20], "hotspot": [2, 3], "outlineArea": Double(outline) / area,
        "softGreyHaloArea": Double(halo) / area, "brightAreaOutsideGlyph": Double(brightOutside) / area,
        "bodySamples": samples, "backgroundRGB": backgroundRGB, "backgroundSpread": backgroundSpread,
        "requiresFlatNearBlackBackground": true, "scaleX": scaleX, "scaleY": scaleY]
}
private final class CursorFrame: NSObject, SCStreamOutput, @unchecked Sendable {
    let lock = NSLock()
    var image: CGImage?
    func take() -> CGImage? { lock.lock(); defer { lock.unlock() }; return image }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete,
              let buffer = sampleBuffer.imageBuffer else { return }
        let value = CIImage(cvPixelBuffer: buffer)
        guard let result = CIContext(options: [.cacheIntermediates: false]).createCGImage(value, from: value.extent) else { return }
        lock.lock(); if image == nil { image = result }; lock.unlock()
    }
}
// Test-carrier-only passive trace. The projector never reads key codes, Unicode,
// titles, process identities, or input data from a CGEvent.
private struct TraceVirtualEvent {
    let type: UInt32
    let sourcePID: Int64
    let sourceUserData: Int64
    let timestampNanoseconds: UInt64
    let observedUTC: String
    let observedUptime: Double
    let mouseX: Double?
    let mouseY: Double?
    let mouseButton: Int64?
    var mouseDeltaX: Double? = nil
    var mouseDeltaY: Double? = nil
}
private struct TraceWindowLedger {
    static let maximumEvents = 128
    static let maximumWindowSeconds = 0.5
    let ownPID: Int64
    let openedUptime: Double
    var rows: [[String: Any]] = []
    var overflow = false
    var closedReason: String?
    static func category(_ type: UInt32) -> String? {
        switch type {
        case 1: return "leftMouseDown"
        case 2: return "leftMouseUp"
        case 3: return "rightMouseDown"
        case 4: return "rightMouseUp"
        case 5: return "mouseMoved"
        case 6: return "leftMouseDragged"
        case 7: return "rightMouseDragged"
        case 10: return "keyDown"
        case 11: return "keyUp"
        case 12: return "flagsChanged"
        case 22: return "scrollWheel"
        case 25: return "otherMouseDown"
        case 26: return "otherMouseUp"
        case 27: return "otherMouseDragged"
        default: return nil
        }
    }
    static func isMouse(_ type: UInt32) -> Bool { [1,2,3,4,5,6,7,25,26,27].contains(type) }
    mutating func append(_ event: TraceVirtualEvent) {
        guard closedReason == nil else { return }
        guard event.observedUptime.isFinite, event.observedUptime >= openedUptime,
              event.observedUptime <= openedUptime + Self.maximumWindowSeconds else { closedReason = "fixed-focus-window-expired"; return }
        guard let category = Self.category(event.type) else { return }
        guard rows.count < Self.maximumEvents else { overflow = true; closedReason = "event-bound-reached"; return }
        var row: [String: Any] = ["type": category, "observedUTC": event.observedUTC,
            "observedUptimeSeconds": event.observedUptime, "eventTimestampNanoseconds": String(event.timestampNanoseconds),
            "sourcePID": event.sourcePID, "sourceUserData": String(event.sourceUserData),
            "sourceRelation": event.sourcePID == ownPID ? "own" : "other"]
        if Self.isMouse(event.type), let x = event.mouseX, let y = event.mouseY, x.isFinite, y.isFinite {
            row["x"] = x; row["y"] = y
            if let button = event.mouseButton { row["button"] = button }
            if let dx = event.mouseDeltaX, let dy = event.mouseDeltaY, dx.isFinite, dy.isFinite { row["deltaX"] = dx; row["deltaY"] = dy }
        }
        rows.append(row)
        // This is a trace boundary, never an authorization or an input oracle.
        // Preserve the first observed owned event; observe no later action input.
        if event.sourcePID == ownPID { closedReason = "first-owned-event-boundary" }
    }
}
private final class PassiveFocusTrace: @unchecked Sendable {
    private let lock = NSLock()
    private let ready = DispatchSemaphore(value: 0)
    private let done = DispatchSemaphore(value: 0)
    private var ledger: TraceWindowLedger
    private var stopRequested = false
    private var startupError: String?
    private var tapCreated = false
    private var tapInvalidated = false
    private var workerRetired = false
    private var worker: Thread?
    private var failureCode: String?
    private var stoppedReply: [String: Any]?
    let traceId: String
    let openedUTC: String
    let openedUptime: Double
    init(traceId: String, ownPID: Int64) {
        self.traceId = traceId
        self.openedUTC = ISO8601DateFormatter().string(from: Date())
        self.openedUptime = ProcessInfo.processInfo.systemUptime
        self.ledger = TraceWindowLedger(ownPID: ownPID, openedUptime: openedUptime)
    }
    func start() throws -> [String: Any] {
        // This preflight does not prompt for TCC or fall back to active taps.
        guard CGPreflightListenEventAccess() else { throw failure("trace-listen-permission-unavailable") }
        let thread = Thread { [self] in run() }; thread.name = "qiuya.test.listen-only-focus"; worker = thread; thread.start()
        guard ready.wait(timeout: .now() + 2) == .success else { requestStop(); throw failure("trace-ready-timeout") }
        lock.lock(); let error = startupError; let created = tapCreated; lock.unlock()
        if let error { throw failure(error) }
        guard created else { throw failure("trace-tap-unavailable") }
        guard ProcessInfo.processInfo.systemUptime < openedUptime + TraceWindowLedger.maximumWindowSeconds else { requestStop(); throw failure("trace-started-too-late") }
        return ["traceId": traceId, "ready": true, "mode": "listenOnly", "postsInput": false,
            "openedUTC": openedUTC, "openedUptimeSeconds": openedUptime,
            "maximumWindowMs": 500, "maximumEvents": TraceWindowLedger.maximumEvents,
            "windowEndsAt": "first-owned-event-or-fixed-deadline-or-explicit-stop"]
    }
    private func requestStop() { lock.lock(); stopRequested = true; lock.unlock() }
    private func run() {
        let callback: CGEventTapCallBack = { _, type, event, pointer in
            guard let pointer else { return Unmanaged.passUnretained(event) }
            let owner = Unmanaged<PassiveFocusTrace>.fromOpaque(pointer).takeUnretainedValue()
            owner.observe(type, event)
            // Listen-only: always return the same unmodified event.
            return Unmanaged.passUnretained(event)
        }
        let types: [CGEventType] = [.leftMouseDown,.leftMouseUp,.rightMouseDown,.rightMouseUp,.mouseMoved,.leftMouseDragged,.rightMouseDragged,
            .keyDown,.keyUp,.flagsChanged,.scrollWheel,.otherMouseDown,.otherMouseUp,.otherMouseDragged]
        let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .tailAppendEventTap,
            options: .listenOnly, eventsOfInterest: mask, callback: callback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()) else {
            lock.lock(); startupError = "trace-listen-tap-create-failed"; workerRetired = true; lock.unlock(); ready.signal(); done.signal(); return
        }
        guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
            CFMachPortInvalidate(tap)
            lock.lock(); startupError = "trace-run-loop-source-failed"; tapInvalidated = true; workerRetired = true; lock.unlock(); ready.signal(); done.signal(); return
        }
        let loop = CFRunLoopGetCurrent()
        CFRunLoopAddSource(loop, source, .commonModes); CGEvent.tapEnable(tap: tap, enable: true)
        lock.lock(); tapCreated = true; lock.unlock(); ready.signal()
        while true {
            lock.lock()
            if ProcessInfo.processInfo.systemUptime >= openedUptime + TraceWindowLedger.maximumWindowSeconds, ledger.closedReason == nil { ledger.closedReason = "fixed-focus-window-expired" }
            let finished = stopRequested || ledger.closedReason != nil
            lock.unlock()
            if finished { break }
            CFRunLoopRunInMode(.defaultMode, 0.005, true)
        }
        CGEvent.tapEnable(tap: tap, enable: false); CFRunLoopRemoveSource(loop, source, .commonModes); CFMachPortInvalidate(tap)
        lock.lock(); tapInvalidated = true; workerRetired = true; lock.unlock(); done.signal()
    }
    private func observe(_ type: CGEventType, _ event: CGEvent) {
        lock.lock(); defer { lock.unlock() }
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput { failureCode = "trace-listen-tap-disabled"; ledger.closedReason = "tap-disabled"; return }
        let mouse = TraceWindowLedger.isMouse(type.rawValue)
        ledger.append(TraceVirtualEvent(type: type.rawValue,
            sourcePID: event.getIntegerValueField(.eventSourceUnixProcessID),
            sourceUserData: event.getIntegerValueField(.eventSourceUserData),
            timestampNanoseconds: event.timestamp,
            observedUTC: ISO8601DateFormatter().string(from: Date()), observedUptime: ProcessInfo.processInfo.systemUptime,
            mouseX: mouse ? event.location.x : nil, mouseY: mouse ? event.location.y : nil,
            mouseButton: mouse ? event.getIntegerValueField(.mouseEventButtonNumber) : nil,
            mouseDeltaX: mouse ? event.getDoubleValueField(.mouseEventDeltaX) : nil,
            mouseDeltaY: mouse ? event.getDoubleValueField(.mouseEventDeltaY) : nil))
    }
    func stop() throws -> [String: Any] {
        lock.lock(); let prior = stoppedReply; lock.unlock(); if let prior { return prior }
        requestStop()
        guard done.wait(timeout: .now() + 2) == .success else { throw failure("trace-worker-retirement-unconfirmed") }
        let exitDeadline = ProcessInfo.processInfo.systemUptime + 2
        while worker?.isFinished == false && ProcessInfo.processInfo.systemUptime < exitDeadline { Thread.sleep(forTimeInterval: 0.001) }
        guard worker?.isFinished == true else { throw failure("trace-thread-natural-exit-unconfirmed") }
        lock.lock(); defer { lock.unlock() }
        if ledger.closedReason == nil { ledger.closedReason = "explicit-stop" }
        let result: [String: Any] = ["traceId": traceId, "mode": "listenOnly", "postsInput": false,
            "openedUTC": openedUTC, "openedUptimeSeconds": openedUptime,
            "stoppedUTC": ISO8601DateFormatter().string(from: Date()), "stoppedUptimeSeconds": ProcessInfo.processInfo.systemUptime,
            "maximumWindowMs": 500, "maximumEvents": TraceWindowLedger.maximumEvents,
            "events": ledger.rows, "overflow": ledger.overflow,
            "closedReason": ledger.closedReason ?? "unknown", "failure": failureCode as Any? ?? NSNull(),
            "workerRetired": workerRetired, "tapCreated": tapCreated, "tapInvalidated": tapInvalidated,
            "permissionsRequested": false, "scope": "act-call preparation until first own source event; not physical-human attribution or action proof"]
        stoppedReply = result; return result
    }
}
private enum PassiveTraceService {
    static var active: PassiveFocusTrace?
    static func start(_ command: [String: Any]) throws -> [String: Any] {
        guard active == nil, let traceId = command["traceId"] as? String, UUID(uuidString: traceId) != nil,
              let action = command["action"] as? String, ["click","type","key","move"].contains(action),
              let epoch = command["epoch"] as? Int, epoch == 1,
              let number = command["windowId"] as? UInt32 else { throw failure("invalid-trace-start") }
        let helper = try expected(command["identity"]), target = try expected(command["targetIdentity"])
        guard helper.pid != target.pid, helper.parentPid == target.parentPid,
              helper.parentUniqueId == target.parentUniqueId else { throw failure("trace-owned-sibling-binding-required") }
        let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        guard windows.contains(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == number && ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == target.pid }) else { throw failure("trace-owned-window-not-current") }
        let trace = PassiveFocusTrace(traceId: traceId, ownPID: Int64(helper.pid)); active = trace
        do { return try trace.start() } catch { _ = try? trace.stop(); active = nil; throw error }
    }
    static func stop(_ command: [String: Any]) throws -> [String: Any] {
        guard let trace = active, command["traceId"] as? String == trace.traceId else { throw failure("invalid-trace-stop") }
        let result = try trace.stop(); active = nil; return result
    }
    static func shutdown() { if let trace = active { _ = try? trace.stop(); active = nil } }
}
private func traceProjectorSelfTest() throws -> [String: Any] {
    var checks = 0
    func check(_ value: @autoclosure () -> Bool) throws { guard value() else { throw failure("trace-pure-self-test-failed") }; checks += 1 }
    func event(_ type: UInt32, _ pid: Int64 = 77, _ time: Double = 10.01) -> TraceVirtualEvent {
        TraceVirtualEvent(type: type, sourcePID: pid, sourceUserData: -987654321, timestampNanoseconds: 123456789,
            observedUTC: "2026-10-23T00:00:00Z", observedUptime: time, mouseX: 11, mouseY: -22, mouseButton: 0)
    }
    var keyboard = TraceWindowLedger(ownPID: 99, openedUptime: 10)
    for type: UInt32 in [10,11,12] { keyboard.append(event(type)) }
    try check(keyboard.rows.count == 3)
    for row in keyboard.rows {
        try check(Set(row.keys) == Set(["type","observedUTC","observedUptimeSeconds","eventTimestampNanoseconds","sourcePID","sourceUserData","sourceRelation"]))
        try check(row["sourceRelation"] as? String == "other")
    }
    var mouse = TraceWindowLedger(ownPID: 99, openedUptime: 10); mouse.append(event(5))
    try check(mouse.rows[0]["x"] as? Double == 11 && mouse.rows[0]["y"] as? Double == -22)
    try check(mouse.rows[0]["button"] as? Int64 == 0)
    var owned = TraceWindowLedger(ownPID: 99, openedUptime: 10); owned.append(event(5,99)); owned.append(event(1))
    try check(owned.rows.count == 1 && owned.closedReason == "first-owned-event-boundary")
    try check(owned.rows[0]["sourceRelation"] as? String == "own")
    var bound = TraceWindowLedger(ownPID: 99, openedUptime: 10)
    for _ in 0..<129 { bound.append(event(10)) }
    try check(bound.rows.count == 128 && bound.overflow && bound.closedReason == "event-bound-reached")
    var expiry = TraceWindowLedger(ownPID: 99, openedUptime: 10); expiry.append(event(5,77,10.501)); expiry.append(event(5))
    try check(expiry.rows.isEmpty && expiry.closedReason == "fixed-focus-window-expired")
    var zero = TraceWindowLedger(ownPID: 99, openedUptime: 10); zero.append(event(10,0))
    try check(zero.rows[0]["sourceRelation"] as? String == "other")
    var unknown = TraceWindowLedger(ownPID: 99, openedUptime: 10); unknown.append(event(99))
    try check(unknown.rows.isEmpty && unknown.closedReason == nil)
    var nan = TraceWindowLedger(ownPID: 99, openedUptime: 10); nan.append(event(5,77,.nan))
    try check(nan.rows.isEmpty && nan.closedReason == "fixed-focus-window-expired")
    var delta = TraceWindowLedger(ownPID: 99, openedUptime: 10)
    var deltaEvent = event(5,0); deltaEvent.mouseDeltaX = 0; deltaEvent.mouseDeltaY = -2; delta.append(deltaEvent)
    try check(delta.rows[0]["sourceRelation"] as? String == "other" && delta.rows[0]["deltaX"] as? Double == 0 && delta.rows[0]["deltaY"] as? Double == -2)
    var flagEvent = event(12,0); flagEvent.mouseDeltaX = 88; flagEvent.mouseDeltaY = 99; delta.append(flagEvent)
    try check(delta.rows[1]["deltaX"] == nil && delta.rows[1]["deltaY"] == nil && delta.rows[1]["x"] == nil && delta.rows[1]["y"] == nil)
    let encoded = try JSONSerialization.data(withJSONObject: keyboard.rows)
    let text = String(decoding: encoded, as: UTF8.self)
    try check(!text.contains("keyCode") && !text.contains("Unicode") && !text.contains("characters"))
    return ["passed": true, "checks": checks, "virtualEventsOnly": true, "actualCGEventTapCreations": 0,
        "actualInputPosts": 0, "AppKitWindowsCreated": 0, "permissionRequests": 0]
}

@main struct CursorObserver {
    static func emit(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: .sortedKeys) else { exit(2) }
        FileHandle.standardOutput.write(data + Data([10]))
    }
    @MainActor static func main() async {
        if CommandLine.arguments.contains("--input-trace-self-test") {
            do { emit(try traceProjectorSelfTest()) } catch { emit(["passed": false]); exit(1) }; return
        }
        defer { PassiveTraceService.shutdown() }
        do {
            emit(["event": "ready", "identity": try identity(getpid()).json, "postsInput": false, "activatesWindows": false])
            for try await line in FileHandle.standardInput.bytes.lines {
                guard line.utf8.count <= 65536, let data = line.data(using: .utf8), let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                let id = command["requestId"] as Any? ?? NSNull()
                do { emit(["requestId": id, "ok": true, "result": try await operation(command)]) }
                catch { emit(["requestId": id, "ok": false, "error": (error as NSError).domain]) }
            }
        } catch { emit(["event": "observerFailed", "error": (error as NSError).domain]); exit(1) }
    }
    @MainActor static func operation(_ command: [String: Any]) async throws -> [String: Any] {
        switch command["op"] as? String {
        case "identity":
            guard let pid = command["pid"] as? Int32 else { throw failure("invalid-pid") }
            do { return ["identity": try identity(pid).json] }
            catch { if kill(pid, 0) != 0 && errno == ESRCH { return ["identity": NSNull()] }; throw error }
        case "snapshot":
            let pinned = try (command["identities"] as? [Any] ?? []).map(expected)
            let pids = Set(pinned.map { $0.pid }), app = NSWorkspace.shared.frontmostApplication
            let session = CGSessionCopyCurrentDictionary() as? [String: Any], cursor = CGEvent(source: nil)?.location ?? .zero
            let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
            let windows = raw.filter { pids.contains(($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? 0) }.compactMap(windowInfo)
            for value in pinned { guard same(try identity(value.pid), value) else { throw failure("snapshot-owner-changed") } }
            return ["windows": windows, "foregroundPid": app?.processIdentifier ?? 0, "foregroundBundleId": app?.bundleIdentifier as Any? ?? NSNull(),
                "sessionExists": session != nil, "screenLocked": (session?["CGSSessionScreenIsLocked"] as? Bool) == true,
                "screenRecording": CGPreflightScreenCaptureAccess(), "cursor": ["x": cursor.x, "y": cursor.y],
                "leftButtonDown": CGEventSource.buttonState(.combinedSessionState, button: .left), "rightButtonDown": CGEventSource.buttonState(.combinedSessionState, button: .right),
                "middleButtonDown": CGEventSource.buttonState(.combinedSessionState, button: .center), "keysDown": (0..<128).filter { CGEventSource.keyState(.combinedSessionState, key: CGKeyCode($0)) }]
        case "children", "findHelper", "allChildren":
            let parent = try expected(command["identity"]), capacity = proc_listallpids(nil, 0)
            guard capacity > 0, capacity < 65536 else { throw failure("inventory-unavailable") }
            var pids = [Int32](repeating: 0, count: Int(capacity) + 1024)
            let count = pids.withUnsafeMutableBytes { proc_listallpids($0.baseAddress, Int32($0.count)) }
            guard count > 0, count < pids.count else { throw failure("inventory-truncated") }
            let path = command["op"] as? String == "findHelper" ? command["helperPath"] as? String : parent.executablePath
            guard let path, path.hasPrefix("/") else { throw failure("invalid-helper-path") }
            var found: [CursorIdentity] = []
            for pid in pids.prefix(Int(count)) {
                do {
                    var candidate = proc_bsdinfo()
                    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &candidate, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size, candidate.pbi_ppid == parent.pid else { continue }
                    let value = try identity(pid)
                    if value.parentPid == parent.pid, value.parentUniqueId == parent.uniqueId,
                       command["op"] as? String == "allChildren" || value.executablePath == path { found.append(value) }
                } catch {
                    var child = proc_bsdinfo()
                    if proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &child, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size,
                       child.pbi_ppid == parent.pid { throw failure("own-child-identity-unavailable") }
                }
            }
            guard same(try identity(parent.pid), parent) else { throw failure("parent-changed") }
            return ["identities": found.map { $0.json }]
        case "inputTraceStart": return try PassiveTraceService.start(command)
        case "inputTraceStop": return try PassiveTraceService.stop(command)
        case "capture": return try await capture(command)
        default: throw failure("unsupported-observer-operation")
        }
    }
    @MainActor static func capture(_ command: [String: Any]) async throws -> [String: Any] {
        let owner = try expected(command["identity"])
        guard let number = command["windowId"] as? UInt32, let output = command["output"] as? String, output.hasPrefix("/") else { throw failure("invalid-capture") }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        guard let selected = content.windows.first(where: { $0.windowID == number && $0.owningApplication?.processID == owner.pid }) else { throw failure("owned-window-not-found") }
        let config = SCStreamConfiguration(), crop = selected.frame
        let filter: SCContentFilter
        if command["composited"] as? Bool == true {
            guard let display = content.displays.first(where: { $0.frame.contains(crop) }) else { throw failure("fixture-not-contained-by-one-display") }
            filter = SCContentFilter(display: display, excludingWindows: [])
            config.sourceRect = CGRect(x: crop.minX - display.frame.minX, y: crop.minY - display.frame.minY, width: crop.width, height: crop.height)
            let scale = Double(display.width) / display.frame.width
            config.width = Int((crop.width * scale).rounded()); config.height = Int((crop.height * scale).rounded())
        } else {
            filter = SCContentFilter(desktopIndependentWindow: selected)
            config.width = Int((crop.width * 2).rounded()); config.height = Int((crop.height * 2).rounded())
            if #available(macOS 14.0, *) { config.ignoreShadowsSingleWindow = true }
        }
        guard config.width > 0, config.height > 0, config.width <= 3200, config.height <= 2400 else { throw failure("capture-size-bound") }
        config.showsCursor = command["includeRealCursor"] as? Bool == true
        config.queueDepth = 1; config.scalesToFit = true; config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        let frame = CursorFrame(), stream = SCStream(filter: filter, configuration: config, delegate: nil)
        try stream.addStreamOutput(frame, type: .screen, sampleHandlerQueue: DispatchQueue(label: "qiuya.test.cursor-frame"))
        try await stream.startCapture()
        for _ in 0..<120 { if frame.take() != nil { break }; try await Task.sleep(nanoseconds: 25_000_000) }
        try await stream.stopCapture()
        guard let image = frame.take(), same(try identity(owner.pid), owner) else { throw failure("capture-timeout-or-owner-changed") }
        let bitmap = NSBitmapImageRep(cgImage: image)
        guard let bytes = bitmap.representation(using: .png, properties: [:]) else { throw failure("png-encoding") }
        try bytes.write(to: URL(fileURLWithPath: output), options: .atomic)
        var analysis: [String: Any] = [:]
        if let probe = command["probe"] as? [String: Double], let x = probe["x"], let y = probe["y"], let width = probe["width"], let height = probe["height"], width > 0, height > 0 {
            let scaleX = Double(bitmap.pixelsWide) / crop.width, scaleY = Double(bitmap.pixelsHigh) / crop.height
            let minX = max(0, Int(floor(x * scaleX))), minY = max(0, Int(floor(y * scaleY)))
            let maxX = min(bitmap.pixelsWide, Int(ceil((x + width) * scaleX))), maxY = min(bitmap.pixelsHigh, Int(ceil((y + height) * scaleY)))
            var white = 0, grey = 0, svgGrey = 0, count = 0
            if minX < maxX, minY < maxY {
                for row in minY..<maxY { for column in minX..<maxX {
                    guard let color = bitmap.colorAt(x: column, y: row)?.usingColorSpace(.sRGB) else { continue }
                    let r = Double(color.redComponent) * 255, g = Double(color.greenComponent) * 255, b = Double(color.blueComponent) * 255
                    if min(r, g, b) > 230 { white += 1 }
                    if max(r, g, b) - min(r, g, b) < 20, min(r, g, b) > 70, max(r, g, b) < 225 { grey += 1 }
                    if abs(r - 165) < 22, abs(g - 168) < 22, abs(b - 173) < 22 { svgGrey += 1 }
                    count += 1
                } }
            }
            analysis = ["whitePixels": white, "greyPixels": grey, "svgGreyPixels": svgGrey, "pixels": count,
                "bitmapRect": ["x": minX, "y": minY, "width": maxX - minX, "height": maxY - minY], "logicalProbe": probe]
            analysis["approvedSmallArrow"] = smallArrowAnalysis(bitmap, crop: crop, probe: probe)
        }
        return ["owner": owner.json, "windowId": number, "x": crop.minX, "y": crop.minY, "width": crop.width, "height": crop.height,
            "pixelWidth": bitmap.pixelsWide, "pixelHeight": bitmap.pixelsHigh, "bytes": bytes.count, "analysis": analysis,
            "includesRealOSCursor": config.showsCursor,
            "method": command["composited"] as? Bool == true ? "independent SCK display-sourceRect cropped to owned fixture" : "independent SCK owned-window capture"]
    }
}
