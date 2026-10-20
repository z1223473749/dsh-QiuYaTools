import AppKit
import Foundation

/// stdout is a protocol channel: diagnostics and target contents never go to logs.
enum Wire {
    private static let lock = NSLock()
    static func send(_ value: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(value), let data = try? JSONSerialization.data(withJSONObject: value) else { return }
        lock.lock(); defer { lock.unlock() }
        FileHandle.standardOutput.write(data + Data([10]))
    }
    static func success(_ id: Any, _ result: [String: Any] = [:]) { send(["requestId": id, "ok": true, "result": result]) }
    static func failure(_ id: Any, _ error: Error) {
        let issue = error as? ComputerError ?? ComputerError("NATIVE_FAILURE", "The native operation failed.")
        send(["requestId": id, "ok": false, "error": ["code": issue.code, "message": issue.message]])
    }
}

func requestIdentifier(_ value: Any?) -> Any? {
    if let text = value as? String, !text.isEmpty, text.utf8.count <= 256,
       !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) { return text }
    return integer(value)
}

struct ComputerError: Error {
    let code: String
    let message: String
    init(_ code: String, _ message: String) { self.code = code; self.message = message }
}

func integer(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue,
          number.doubleValue >= 0, number.doubleValue <= 9_007_199_254_740_991 else { return nil }
    return number.intValue
}

func finiteNumber(_ value: Any?) -> Double? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { return nil }
    return number.doubleValue
}

struct NativeTarget {
    let id: String
    let appId: String
    let title: String
    let pid: pid_t
    let windowId: CGWindowID
    let frame: CGRect
    let scale: Double
    var json: [String: Any] {
        ["id": id, "appId": appId, "title": title, "pid": Int(pid), "x": frame.minX, "y": frame.minY,
         "width": frame.width, "height": frame.height, "scale": scale]
    }
}

/// Mapping is derived from the returned raster dimensions, including downscaling.
struct FrameGeometry {
    let frame: CGRect
    let pixelWidth: Int
    let pixelHeight: Int
    func point(x: Double, y: Double) throws -> CGPoint {
        guard x.isFinite, y.isFinite, x >= 0, y >= 0, x < Double(pixelWidth), y < Double(pixelHeight),
              pixelWidth > 0, pixelHeight > 0 else { throw ComputerError("INVALID_COORDINATES", "Coordinates must be inside the latest screenshot.") }
        return CGPoint(x: frame.minX + x * frame.width / Double(pixelWidth), y: frame.minY + y * frame.height / Double(pixelHeight))
    }
}
