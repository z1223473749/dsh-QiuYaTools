// Test-only read/compare oracle. No cursor mutation, input injection, window,
// process signal, application activation or permission request exists here.
import AppKit
import Darwin
import Foundation

private struct ProbeIssue: Error { let code: String }
private func require(_ condition: Bool, _ code: String) throws { if !condition { throw ProbeIssue(code: code) } }
private func compare(_ command: [String: Any]) throws -> [String: Any] {
    guard let a = command["a"] as? String, let b = command["b"] as? String,
          let crop = command["crop"] as? [String: Int], let x = crop["x"], let y = crop["y"],
          let width = crop["width"], let height = crop["height"] else { throw ProbeIssue(code: "INVALID_IMAGE_PAIR") }
    func image(_ path: String) throws -> NSBitmapImageRep {
        try require(path.hasPrefix("/") && path.hasSuffix(".png"), "INVALID_OWN_IMAGE")
        let attributes = try FileManager.default.attributesOfItem(atPath: path)
        guard let size = attributes[.size] as? NSNumber, size.intValue > 0, size.intValue <= 16 * 1024 * 1024,
              let bitmap = NSBitmapImageRep(data: try Data(contentsOf: URL(fileURLWithPath: path))),
              bitmap.pixelsWide <= 6400, bitmap.pixelsHigh <= 4800 else { throw ProbeIssue(code: "INVALID_BITMAP") }
        return bitmap
    }
    let first = try image(a), second = try image(b)
    try require(first.pixelsWide == second.pixelsWide && first.pixelsHigh == second.pixelsHigh && x >= 0 && y >= 0 && width > 0 && height > 0 && width <= 160 && height <= 160 && x + width <= first.pixelsWide && y + height <= first.pixelsHigh, "INVALID_CROP")
    var changed = 0, maximum = 0.0, sum = 0.0
    for row in y..<(y + height) { for column in x..<(x + width) {
        guard let aa = first.colorAt(x: column, y: row)?.usingColorSpace(.sRGB),
              let bb = second.colorAt(x: column, y: row)?.usingColorSpace(.sRGB) else { throw ProbeIssue(code: "UNREADABLE_PIXEL") }
        let delta = [abs(aa.redComponent - bb.redComponent), abs(aa.greenComponent - bb.greenComponent), abs(aa.blueComponent - bb.blueComponent)].map { Double($0) * 255 }
        let peak = delta.max()!; if peak > 8 { changed += 1 }; maximum = max(maximum, peak); sum += delta.reduce(0, +)
    } }
    return ["pixels": width * height, "changedPixelsOver8": changed, "maxChannelDelta": maximum, "meanAbsChannelDelta": sum / Double(width * height * 3)]
}

private func leaseAudit() throws -> [String: Any] {
    let directory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/QiuYaTools/computer-lease")
    let lockPath = directory.appendingPathComponent("desktop.lock").path
    let fd = Darwin.open(lockPath, O_RDWR | O_CLOEXEC | O_NOFOLLOW)
    var free = false, lockExists = true
    if fd < 0 {
        guard errno == ENOENT else { throw ProbeIssue(code: "LOCK_READ_UNAVAILABLE") }
        free = true; lockExists = false
    } else {
        defer { Darwin.close(fd) }
        var info = stat()
        try require(fstat(fd, &info) == 0 && info.st_uid == getuid() && (info.st_mode & S_IFMT) == S_IFREG, "LOCK_IDENTITY_INVALID")
        if flock(fd, LOCK_EX | LOCK_NB) == 0 { free = true; try require(flock(fd, LOCK_UN) == 0, "LOCK_AUDIT_RELEASE_FAILED") }
        else { try require(errno == EWOULDBLOCK, "LOCK_AUDIT_UNAVAILABLE") }
    }
    let journalPath = directory.appendingPathComponent("owned-input.json").path
    var info = stat(); let exists = lstat(journalPath, &info) == 0
    if !exists { try require(errno == ENOENT, "JOURNAL_READ_UNAVAILABLE") }
    if exists { try require(info.st_uid == getuid() && (info.st_mode & S_IFMT) == S_IFREG && info.st_size <= 16384, "JOURNAL_IDENTITY_INVALID") }
    // Do not copy journal IDs, paths or another owner's input state. Presence
    // and mutual exclusion suffice for the before/after retirement oracle.
    return ["lockExists": lockExists, "leaseFree": free, "journalPresent": exists]
}

@main struct ProductionCursorProbe {
    static func emit(_ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { exit(2) }
        FileHandle.standardOutput.write(data + Data([10]))
    }
    static func main() throws {
        if CommandLine.arguments.contains("--self-test") {
            let directory = URL(fileURLWithPath: CommandLine.arguments.last!, isDirectory: true)
            let a = directory.appendingPathComponent("probe-self-test-a.png"), b = directory.appendingPathComponent("probe-self-test-b.png")
            defer { try? FileManager.default.removeItem(at: a); try? FileManager.default.removeItem(at: b) }
            var bytes = [UInt8](repeating: 0, count: 48 * 50 * 4)
            for index in stride(from: 3, to: bytes.count, by: 4) { bytes[index] = 255 }
            func writeImage(_ path: URL) throws {
                let provider = CGDataProvider(data: Data(bytes) as CFData)!
                let image = CGImage(width: 48, height: 50, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: 48 * 4,
                    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue),
                    provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
                try NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])!.write(to: path)
            }
            try writeImage(a)
            let payload: [String: Any] = ["a": a.path, "b": a.path, "crop": ["x": 0, "y": 0, "width": 48, "height": 50]]
            try require(try compare(payload)["changedPixelsOver8"] as? Int == 0, "EQUAL_PIXELS_FAILED")
            for y in 10..<20 { for x in 10..<20 {
                let index = y * 48 * 4 + x * 4
                bytes[index] = 255; bytes[index + 1] = 255; bytes[index + 2] = 255
            } }
            try writeImage(b)
            var changed = payload; changed["b"] = b.path
            try require(try compare(changed)["changedPixelsOver8"] as? Int == 100, "PIXEL_DIFFERENCE_FAILED")
            emit(["passed": true, "checks": 2, "actualCursorCalls": 0, "actualCGEventPosts": 0, "AppKitWindowsCreated": 0]); return
        }
        emit(["event": "ready", "postsInput": false, "changesCursor": false])
        while let line = readLine() {
            guard line.utf8.count <= 16384, let data = line.data(using: .utf8), let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            let requestId = command["requestId"] as Any? ?? NSNull()
            do {
                let result: [String: Any]
                switch command["op"] as? String {
                case "compare": result = try compare(command)
                case "leaseAudit": result = try leaseAudit()
                default: throw ProbeIssue(code: "UNKNOWN_READ_ONLY_OPERATION")
                }
                emit(["requestId": requestId, "ok": true, "result": result])
            } catch { emit(["requestId": requestId, "ok": false, "error": (error as? ProbeIssue)?.code ?? "PROBE_READ_FAILED"]) }
        }
    }
}
