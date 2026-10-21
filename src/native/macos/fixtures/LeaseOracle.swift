import AppKit
import CoreGraphics
import Darwin
import Foundation

// Test-only, input-free observer. It never activates a window or posts an event.
// SIGKILL is limited to a recorded PID/birth/path and explicit disposable executables.
struct OracleFailure: Error { let message: String }
let allowedExecutables: Set<String> = Set(CommandLine.arguments.enumerated().compactMap { index, value in
    guard index > 1, CommandLine.arguments[index - 1] == "--allowed-executable" else { return nil }
    return URL(fileURLWithPath: value).resolvingSymlinksInPath().path
})

func identity(_ pid: pid_t) throws -> [String: Any] {
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else {
        throw OracleFailure(message: "Process identity is unavailable: \(pid)")
    }
    var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    guard proc_pidpath(pid, &path, UInt32(path.count)) > 0 else {
        throw OracleFailure(message: "Process executable is unavailable: \(pid)")
    }
    return ["pid": Int(pid), "parentPid": Int(info.pbi_ppid),
            "startSeconds": String(info.pbi_start_tvsec), "startMicroseconds": String(info.pbi_start_tvusec),
            "executablePath": URL(fileURLWithPath: String(cString: path)).resolvingSymlinksInPath().path]
}

func matches(_ actual: [String: Any], _ expected: [String: Any]) -> Bool {
    (actual["pid"] as? Int) == (expected["pid"] as? Int)
        && (actual["startSeconds"] as? String) == (expected["startSeconds"] as? String)
        && (actual["startMicroseconds"] as? String) == (expected["startMicroseconds"] as? String)
        && (actual["executablePath"] as? String) == (expected["executablePath"] as? String)
}

func snapshot(_ command: [String: Any]) -> [String: Any] {
    // Deliver pending workspace notifications despite the CLI's blocking stdin loop.
    // This pumps no application window and never changes activation.
    RunLoop.current.run(until: Date().addingTimeInterval(0.002))
    let session = CGSessionCopyCurrentDictionary() as? [String: Any]
    let application = NSWorkspace.shared.frontmostApplication
    let keys = (0..<128).filter { CGEventSource.keyState(.combinedSessionState, key: CGKeyCode($0)) }
    var result: [String: Any] = [
        "monotonicNs": String(DispatchTime.now().uptimeNanoseconds), "sessionExists": session != nil,
        "screenLocked": (session?["CGSSessionScreenIsLocked"] as? Bool) == true,
        "leftButtonDown": CGEventSource.buttonState(.combinedSessionState, button: .left),
        "rightButtonDown": CGEventSource.buttonState(.combinedSessionState, button: .right),
        "middleButtonDown": CGEventSource.buttonState(.combinedSessionState, button: .center),
        "keysDown": keys, "foregroundPid": Int(application?.processIdentifier ?? 0),
        "foregroundBundleId": application?.bundleIdentifier as Any? ?? NSNull(),
    ]
    if let pid = command["fixturePid"] as? Int {
        result["fixtureIdentity"] = (try? identity(pid_t(pid))) as Any? ?? NSNull()
        let windowId = (command["windowId"] as? NSNumber)?.uint32Value
        let options: CGWindowListOption = windowId == nil ? [.optionOnScreenOnly, .excludeDesktopElements] : .optionIncludingWindow
        let windows = CGWindowListCopyWindowInfo(options, windowId ?? kCGNullWindowID) as? [[String: Any]] ?? []
        result["fixtureWindows"] = windows.compactMap { window -> [String: Any]? in
            guard (window[kCGWindowOwnerPID as String] as? NSNumber)?.intValue == pid else { return nil }
            return ["id": window[kCGWindowNumber as String] as Any? ?? NSNull(),
                    "ownerPid": pid, "onScreen": window[kCGWindowIsOnscreen as String] as Any? ?? NSNull(),
                    "layer": window[kCGWindowLayer as String] as Any? ?? NSNull(),
                    "bounds": window[kCGWindowBounds as String] as Any? ?? NSNull()]
        }
    }
    return result
}

func operation(_ command: [String: Any]) throws -> [String: Any] {
    switch command["op"] as? String {
    case "snapshot": return snapshot(command)
    case "identity":
        guard let pid = command["pid"] as? Int, pid > 0 else { throw OracleFailure(message: "Invalid test PID") }
        do { return ["identity": try identity(pid_t(pid))] }
        catch {
            if Darwin.kill(pid_t(pid), 0) != 0 && errno == ESRCH { return ["identity": NSNull()] }
            throw error // An unreadable live process must never be reported as gone.
        }
    case "killOwned":
        guard let expected = command["identity"] as? [String: Any], let pid = expected["pid"] as? Int, pid > 1,
              let path = expected["executablePath"] as? String, allowedExecutables.contains(path) else {
            throw OracleFailure(message: "The executable is outside the disposable allowlist")
        }
        let actual = try identity(pid_t(pid))
        guard matches(actual, expected) else { throw OracleFailure(message: "Recorded process identity changed; no signal sent") }
        let before = snapshot(command)
        if command["requireLeftHeld"] as? Bool == true {
            guard before["sessionExists"] as? Bool == true, before["screenLocked"] as? Bool == false,
                  let fixturePid = command["fixturePid"] as? Int, before["foregroundPid"] as? Int == fixturePid,
                  before["leftButtonDown"] as? Bool == true else {
                throw OracleFailure(message: "The owned foreground drag is not OS-held; no signal sent")
            }
        }
        let leftImmediatelyBeforeSignal = CGEventSource.buttonState(.combinedSessionState, button: .left)
        if command["requireLeftHeld"] as? Bool == true && !leftImmediatelyBeforeSignal {
            throw OracleFailure(message: "The OS button was released before the controlled crash; no signal sent")
        }
        guard matches(try identity(pid_t(pid)), expected) else { throw OracleFailure(message: "Process identity changed before signal") }
        let signalAt = String(DispatchTime.now().uptimeNanoseconds)
        guard Darwin.kill(pid_t(pid), SIGKILL) == 0 else { throw OracleFailure(message: "Pinned SIGKILL failed: \(errno)") }
        return ["signalled": true, "identity": actual, "before": before,
                "leftImmediatelyBeforeSignal": leftImmediatelyBeforeSignal, "signalAtMonotonicNs": signalAt]
    default: throw OracleFailure(message: "Unknown read-only test operation")
    }
}

func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { exit(2) }
    FileHandle.standardOutput.write(data + Data([10]))
}
if let index = CommandLine.arguments.firstIndex(of: "--one-shot"), index + 1 < CommandLine.arguments.count {
    do {
        guard let data = CommandLine.arguments[index + 1].data(using: .utf8), data.count <= 65_536,
              let command = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw OracleFailure(message: "Invalid one-shot request") }
        emit(["ok": true, "result": try operation(command), "observerIdentity": try identity(getpid())])
        exit(0)
    } catch { emit(["ok": false, "error": (error as? OracleFailure)?.message ?? String(describing: error)]); exit(1) }
}
emit(["event": "ready", "identity": (try? identity(getpid())) as Any? ?? NSNull(), "postsInput": false, "activatesWindows": false])
while let line = readLine() {
    guard line.utf8.count <= 65_536, let data = line.data(using: .utf8),
          let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
    let requestId = command["requestId"] as Any? ?? NSNull()
    do { emit(["requestId": requestId, "ok": true, "result": try operation(command)]) }
    catch { emit(["requestId": requestId, "ok": false, "error": (error as? OracleFailure)?.message ?? String(describing: error)]) }
}
