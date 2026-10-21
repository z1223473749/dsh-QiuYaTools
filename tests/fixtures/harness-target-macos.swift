// Test-only preparation of one exact window owned by this disposable Host.
// No screenshots, AX contents, keyboard or mouse events are read or posted.
import AppKit
import ApplicationServices
import Darwin
import Foundation

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
    let target: Identity
    let targetWindowId: UInt32
    let profileRoot: String
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
private func descendant(_ child: Identity, of ancestor: Identity, lookup: (pid_t) throws -> Identity = identity) -> Bool {
    var current = child
    for _ in 0..<32 {
        if current == ancestor { return true }
        guard current.parentPid > 1, let parent = try? lookup(current.parentPid),
              let parentBorn = UInt64(parent.birthMicros), let childBorn = UInt64(current.birthMicros), parentBorn <= childBorn else { return false }
        current = parent
    }
    return false
}
private func canonical(_ value: String) -> String { URL(fileURLWithPath: value).resolvingSymlinksInPath().path }
private func profileScoped(_ binding: Binding) -> Bool {
    binding.profileRoot.hasPrefix("/") && URL(fileURLWithPath: binding.profileRoot).lastPathComponent == "qiuya-harness-home" &&
    URL(fileURLWithPath: binding.profileRoot).deletingLastPathComponent().lastPathComponent.hasPrefix("qiuya-harness-e2e-") &&
    binding.target.executable.hasPrefix(binding.profileRoot + "/profiles/web/") &&
    binding.target.executable.hasSuffix("/QiuYaTools Sessions.app/Contents/MacOS/qiuya-session-window")
}
private func validate(_ binding: Binding) throws {
    guard profileScoped(binding), canonical(binding.profileRoot) == binding.profileRoot,
          try identity(binding.ancestor.pid) == binding.ancestor, try identity(binding.target.pid) == binding.target,
          descendant(binding.target, of: binding.ancestor) else { throw fail("target-outside-isolated-harness") }
}
private func jsonRect(_ value: CGRect) -> [String: Double] { ["x": value.minX, "y": value.minY, "width": value.width, "height": value.height] }
private struct Window: Equatable {
    let id: UInt32
    let pid: Int32
    let frame: CGRect
    let layer: Int
    let alpha: Double
    let onscreen: Bool
    let labelMatches: Bool
    var visible: Bool { layer == 0 && onscreen && alpha > 0 }
    var json: [String: Any] { ["id": id, "pid": pid, "bounds": jsonRect(frame), "layer": layer, "alpha": alpha, "onscreen": onscreen, "labelMatches": labelMatches] }
}
private struct Snapshot {
    let selected: Window?
    let matchingCount: Int
    let owned: [Window]
    let foregroundPid: Int32?
    let frontNormalWindowId: UInt32?
    func ready(_ binding: Binding, foreground: Bool) -> Bool {
        guard let selected, selected.id == binding.targetWindowId, selected.pid == binding.target.pid, selected.labelMatches,
              selected.visible, matchingCount == 1 else { return false }
        return !foreground || foregroundPid == binding.target.pid && frontNormalWindowId == binding.targetWindowId
    }
    var json: [String: Any] { ["selected": selected?.json as Any? ?? NSNull(), "matchingCount": matchingCount,
                             "ownedWindows": owned.prefix(16).map(\.json), "ownedWindowCount": owned.count,
                             "foregroundPid": foregroundPid as Any? ?? NSNull(), "frontNormalWindowId": frontNormalWindowId as Any? ?? NSNull()] }
}
private func inspect(_ binding: Binding, label: String) throws -> Snapshot {
    try validate(binding)
    guard let rows = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { throw fail("owned-window-list-unavailable") }
    var owned = [Window](), firstNormal: UInt32?
    for value in rows {
        guard let id = (value[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
              let pid = (value[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
              let layer = (value[kCGWindowLayer as String] as? NSNumber)?.intValue,
              let alpha = (value[kCGWindowAlpha as String] as? NSNumber)?.doubleValue,
              let onscreen = value[kCGWindowIsOnscreen as String] as? Bool else { continue }
        if firstNormal == nil && layer == 0 && onscreen && alpha > 0 { firstNormal = id }
        guard pid == binding.target.pid else { continue }
        guard let bounds = value[kCGWindowBounds as String] as? [String: Any], let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary),
              [frame.minX, frame.minY, frame.width, frame.height, alpha].allSatisfy(\.isFinite), frame.width > 0, frame.height > 0 else { throw fail("owned-window-geometry-unavailable") }
        owned.append(Window(id: id, pid: pid, frame: frame, layer: layer, alpha: alpha, onscreen: onscreen,
                            labelMatches: (value[kCGWindowName as String] as? String)?.contains(label) == true))
    }
    try validate(binding)
    return Snapshot(selected: owned.first { $0.id == binding.targetWindowId }, matchingCount: owned.filter { $0.layer == 0 && $0.labelMatches }.count,
                    owned: owned, foregroundPid: NSWorkspace.shared.frontmostApplication?.processIdentifier, frontNormalWindowId: firstNormal)
}
private func stableWindow(_ binding: Binding, foreground: Bool, timeout: Double = 8,
                          now: () -> Double = { ProcessInfo.processInfo.systemUptime },
                          sleep: () -> Void = { RunLoop.current.run(until: Date().addingTimeInterval(0.1)) },
                          read: () throws -> Snapshot, onSample: (Snapshot) -> Void) throws -> Snapshot {
    let deadline = now() + timeout
    var previous: Window?, since = now(), count = 0
    while now() < deadline {
        let current = try read(); onSample(current)
        if current.ready(binding, foreground: foreground) {
            if previous != current.selected { previous = current.selected; since = now(); count = 0 }
            count += 1
            if count >= 3 && now() - since >= 0.2 { return current }
        } else { previous = nil; since = now(); count = 0 }
        sleep()
    }
    throw fail("owned-target-stable-readiness-timeout")
}
private func selectedAXWindow(_ binding: Binding, frame: CGRect) throws -> AXUIElement {
    let app = AXUIElementCreateApplication(binding.target.pid); AXUIElementSetMessagingTimeout(app, 0.05)
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success,
          let windows = value as? [AXUIElement], windows.count <= 32 else { throw fail("owned-ax-windows-unavailable") }
    let deadline = ProcessInfo.processInfo.systemUptime + 3
    var matching = [AXUIElement]()
    for window in windows {
        guard ProcessInfo.processInfo.systemUptime < deadline else { throw fail("owned-ax-window-budget") }
        AXUIElementSetMessagingTimeout(window, 0.05)
        var windowPid: pid_t = 0
        guard AXUIElementGetPid(window, &windowPid) == .success, windowPid == binding.target.pid else { continue }
        var position: CFTypeRef?, dimensions: CFTypeRef?
        guard AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &position) == .success,
              AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &dimensions) == .success,
              let position, let dimensions, CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(dimensions) == AXValueGetTypeID() else { continue }
        var point = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(dimensions as! AXValue, .cgSize, &size) else { continue }
        if abs(point.x - frame.minX) < 1, abs(point.y - frame.minY) < 1, abs(size.width - frame.width) < 1, abs(size.height - frame.height) < 1 { matching.append(window) }
    }
    guard matching.count == 1 else { throw fail("owned-ax-cg-window-not-unique") }
    try validate(binding)
    return matching[0]
}
private func encoded<T: Encodable>(_ value: T) throws -> Any { try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) }
private func emit(_ value: [String: Any]) throws { FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) }

@main @MainActor private struct HarnessTargetEvidence {
    static func main() {
        var diagnostic: [String: Any] = ["inputEventsPosted": 0, "activationCalls": 0, "raiseCalls": 0]
        do {
            if CommandLine.arguments.dropFirst() == ["--self-test"] {
                let ancestor = Identity(pid: 80, birthMicros: "10", executable: "/own/host", parentPid: 1)
                let target = Identity(pid: 81, birthMicros: "11", executable: "/tmp/qiuya-harness-e2e-own/qiuya-harness-home/profiles/web/plugin/QiuYaTools Sessions.app/Contents/MacOS/qiuya-session-window", parentPid: 80)
                let binding = Binding(ancestor: ancestor, target: target, targetWindowId: 11, profileRoot: "/tmp/qiuya-harness-e2e-own/qiuya-harness-home")
                guard profileScoped(binding), descendant(target, of: ancestor, lookup: { _ in ancestor }),
                      !descendant(target, of: ancestor, lookup: { _ in Identity(pid: 80, birthMicros: "12", executable: "/reused", parentPid: 1) }) else { throw fail("selftest-ownership-fence") }
                let outside = Identity(pid: 81, birthMicros: "11", executable: binding.profileRoot + "-other/profiles/web/plugin/QiuYaTools Sessions.app/Contents/MacOS/qiuya-session-window", parentPid: 80)
                guard !profileScoped(Binding(ancestor: ancestor, target: outside, targetWindowId: 11, profileRoot: binding.profileRoot)),
                      !descendant(target, of: ancestor, lookup: { _ in Identity(pid: 80, birthMicros: "10", executable: "/different-host", parentPid: 1) }) else { throw fail("selftest-profile-or-host-executable-fence") }
                let hidden = Window(id: 11, pid: 81, frame: CGRect(x: 0, y: 0, width: 600, height: 400), layer: 0, alpha: 1, onscreen: false, labelMatches: true)
                let visible = Window(id: 11, pid: 81, frame: hidden.frame, layer: 0, alpha: 1, onscreen: true, labelMatches: true)
                var clock = 0.0, reads = 0
                let result = try stableWindow(binding, foreground: false, timeout: 1, now: { clock }, sleep: { clock += 0.1 }, read: {
                    reads += 1; return Snapshot(selected: reads < 3 ? hidden : visible, matchingCount: 1, owned: [], foregroundPid: nil, frontNormalWindowId: nil)
                }, onSample: { _ in })
                guard result.selected == visible, reads >= 5 else { throw fail("selftest-offscreen-to-stable") }
                clock = 0; var rejected = false
                do { _ = try stableWindow(binding, foreground: false, timeout: 0.5, now: { clock }, sleep: { clock += 0.1 }, read: {
                    Snapshot(selected: visible, matchingCount: 2, owned: [], foregroundPid: 81, frontNormalWindowId: 11)
                }, onSample: { _ in }) } catch { rejected = true }
                guard rejected, !Snapshot(selected: visible, matchingCount: 1, owned: [], foregroundPid: 81, frontNormalWindowId: 22).ready(binding, foreground: true) else { throw fail("selftest-duplicate-or-wrong-front") }
                let projection = try JSONSerialization.data(withJSONObject: result.json)
                guard !String(decoding: projection, as: UTF8.self).contains("executable") else { throw fail("selftest-content-projection") }
                try emit(["ok": true, "result": ["ownership": true, "stableOffscreenTransition": true, "duplicateAndWrongFrontRejected": true, "metadataOnly": true,
                                                   "inputEventsPosted": 0, "activationCalls": 0, "raiseCalls": 0]]); return
            }
            guard CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--request", let data = CommandLine.arguments[2].data(using: .utf8),
                  let request = try JSONSerialization.jsonObject(with: data) as? [String: Any], let op = request["op"] as? String,
                  ["bind", "wait", "activate"].contains(op), let label = request["label"] as? String, label.hasPrefix("E2E:Alpha-"), label.utf8.count < 160 else { throw fail("invalid-owned-target-request") }
            let binding: Binding
            if op == "bind" {
                guard let ancestorPid = request["ancestorPid"] as? Int32, let targetPid = request["targetPid"] as? Int32,
                      let targetWindowId = request["targetWindowId"] as? UInt32, let profileRoot = request["profileRoot"] as? String,
                      let executable = request["targetExecutable"] as? String else { throw fail("invalid-owned-target-binding") }
                let ancestor = try identity(ancestorPid), target = try identity(targetPid)
                guard target.executable == canonical(executable) else { throw fail("unexpected-target-executable") }
                binding = Binding(ancestor: ancestor, target: target, targetWindowId: targetWindowId, profileRoot: canonical(profileRoot))
            } else {
                guard let value = request["binding"] else { throw fail("missing-owned-target-binding") }
                binding = try JSONDecoder().decode(Binding.self, from: JSONSerialization.data(withJSONObject: value))
            }
            let initial = try inspect(binding, label: label); diagnostic["before"] = initial.json; diagnostic["binding"] = try encoded(binding)
            if op == "bind" {
                guard initial.selected?.labelMatches == true, initial.matchingCount == 1 else { throw fail("owned-target-not-unique") }
                try emit(["ok": true, "result": diagnostic]); return
            }
            if op == "activate" {
                guard AXIsProcessTrusted(), let selected = initial.selected, selected.layer == 0, selected.labelMatches, initial.matchingCount == 1 else { throw fail("owned-target-activation-preflight") }
                let window = try selectedAXWindow(binding, frame: selected.frame)
                let current = try inspect(binding, label: label)
                guard current.selected == initial.selected else { throw fail("owned-target-changed-before-activation") }
                guard let app = NSRunningApplication(processIdentifier: binding.target.pid), !app.isTerminated else { throw fail("owned-target-process-exited") }
                diagnostic["activationCalls"] = 1; diagnostic["activationAccepted"] = app.activate(options: [])
                try validate(binding)
                diagnostic["raiseCalls"] = 1; diagnostic["raiseResult"] = AXUIElementPerformAction(window, kAXRaiseAction as CFString).rawValue
            }
            var samples = [[String: Any]]()
            defer { diagnostic["samples"] = samples }
            let final = try stableWindow(binding, foreground: op == "activate", read: { try inspect(binding, label: label) }, onSample: { if samples.count < 85 { samples.append($0.json) }; diagnostic["samples"] = samples })
            diagnostic["after"] = final.json; diagnostic["stableOnscreen"] = true
            try emit(["ok": true, "result": diagnostic])
        } catch {
            try? emit(["ok": false, "error": (error as? Failure)?.code ?? "owned-target-evidence-failed", "diagnostic": diagnostic])
        }
    }
}
