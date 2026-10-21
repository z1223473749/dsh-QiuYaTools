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
@main struct CursorObserver {
    static func emit(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: .sortedKeys) else { exit(2) }
        FileHandle.standardOutput.write(data + Data([10]))
    }
    @MainActor static func main() async {
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
        config.showsCursor = false; config.queueDepth = 1; config.scalesToFit = true; config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
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
        }
        return ["owner": owner.json, "windowId": number, "x": crop.minX, "y": crop.minY, "width": crop.width, "height": crop.height,
            "pixelWidth": bitmap.pixelsWide, "pixelHeight": bitmap.pixelsHigh, "bytes": bytes.count, "analysis": analysis,
            "method": command["composited"] as? Bool == true ? "independent SCK display-sourceRect cropped to owned fixture; real OS cursor excluded" : "independent SCK owned-window capture; real OS cursor excluded"]
    }
}
