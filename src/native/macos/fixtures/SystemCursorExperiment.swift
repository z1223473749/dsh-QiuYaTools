// Test-only background cursor-hide experiment. Never loaded by the plugin.
// --self-test uses fake calls only; --probe reads; --fixture/--hider require an
// explicit GUI gate in the Node runner. No CGEvent posting or cursor warping.
import AppKit
import ApplicationServices
import Darwin
import Foundation
import ImageIO

private struct ExperimentIssue: Error { let code: String }
private func issue(_ code: String) -> ExperimentIssue { ExperimentIssue(code: code) }
private func identity(_ pid: pid_t) throws -> [String: Any] {
    var bsd = proc_bsdinfo(), unique = [UInt64](repeating: 0, count: 7), path = [CChar](repeating: 0, count: 4096)
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsd, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size,
          unique.withUnsafeMutableBytes({ proc_pidinfo(pid, 17, 0, $0.baseAddress, Int32($0.count)) }) == 56,
          proc_pidpath(pid, &path, UInt32(path.count)) > 0 else { throw issue("identity-unavailable") }
    var after = proc_bsdinfo()
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size,
          after.pbi_start_tvsec == bsd.pbi_start_tvsec, after.pbi_start_tvusec == bsd.pbi_start_tvusec else { throw issue("identity-changed") }
    return ["pid": Int(pid), "startSeconds": String(bsd.pbi_start_tvsec), "startMicroseconds": String(bsd.pbi_start_tvusec), "uniqueId": String(unique[2]), "parentPid": Int(bsd.pbi_ppid), "parentUniqueId": String(unique[3]), "executablePath": URL(fileURLWithPath: String(cString: path)).resolvingSymlinksInPath().path]
}
private func same(_ a: [String: Any], _ b: [String: Any]) -> Bool {
    (a["pid"] as? Int) == (b["pid"] as? Int) && ["startSeconds", "startMicroseconds", "uniqueId", "executablePath"].allSatisfy { (a[$0] as? String) == (b[$0] as? String) }
}
private func expected(_ value: Any?) throws -> [String: Any] {
    guard let value = value as? [String: Any], let pid = value["pid"] as? Int32, same(try identity(pid), value) else { throw issue("owner-identity-changed") }; return value
}
private func emit(_ value: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(value), let bytes = try? JSONSerialization.data(withJSONObject: value, options: .sortedKeys) else { exit(2) }
    FileHandle.standardOutput.write(bytes + Data([10]))
}
private typealias VisibilityFn = @convention(c) () -> UInt32
private func visibility() -> [String: Any] {
    let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGCursorIsVisible")
    let value: Any = symbol.map { unsafeBitCast($0, to: VisibilityFn.self)() != 0 } ?? NSNull()
    return ["value": value, "source": "dlsym-CGCursorIsVisible", "deprecatedUnsupportedDiagnostic": true, "spiDiagnosticOnly": true]
}
private func sessionActive() -> Bool {
    guard let state = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
    return (state["CGSSessionScreenIsLocked"] as? Bool) != true && (state[kCGSessionOnConsoleKey as String] as? Bool) == true
}
private func cursorWindows(_ cursor: CGPoint) -> [[String: Any]] {
    let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    return rows.compactMap { row in
        guard (row[kCGWindowLayer as String] as? NSNumber)?.int32Value == CGWindowLevelForKey(.cursorWindow),
              let raw = row[kCGWindowBounds as String] as? [String: Any], let rect = CGRect(dictionaryRepresentation: raw as CFDictionary), rect.contains(cursor) else { return nil }
        let pid = (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? 0
        var known = false
        if let process = try? identity(pid), let path = process["executablePath"] as? String {
            var actual = stat()
            if stat(path, &actual) == 0, actual.st_uid == 0 {
                for reference in ["/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer", "/System/Library/PrivateFrameworks/SkyLight.framework/Versions/A/Resources/WindowServer"] {
                    var trusted = stat()
                    if stat(reference, &trusted) == 0, trusted.st_uid == 0, trusted.st_dev == actual.st_dev, trusted.st_ino == actual.st_ino, let after = try? identity(pid), same(process, after) { known = true }
                }
            }
        }
        return ["id": row[kCGWindowNumber as String] as Any? ?? NSNull(), "ownerPid": Int(pid), "ownerVerification": known ? "verified-WindowServer-executable" : "unknown", "layer": CGWindowLevelForKey(.cursorWindow), "alpha": row[kCGWindowAlpha as String] as Any? ?? NSNull(), "x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height]
    }
}
private func probe(_ command: [String: Any]) throws -> [String: Any] {
    if command["op"] as? String == "identity" {
        guard let pid = command["pid"] as? Int32 else { throw issue("invalid-pid") }
        do { return ["identity": try identity(pid)] } catch { if kill(pid, 0) != 0 && errno == ESRCH { return ["identity": NSNull()] }; throw error }
    }
    if command["op"] as? String == "compare" {
        guard let a = command["a"] as? String, let b = command["b"] as? String, let crop = command["crop"] as? [String: Int], a.hasPrefix("/"), b.hasPrefix("/"), a.hasSuffix(".png"), b.hasSuffix(".png") else { throw issue("invalid-own-images") }
        func image(_ path: String) throws -> NSBitmapImageRep {
            let attributes = try FileManager.default.attributesOfItem(atPath: path)
            guard let count = attributes[.size] as? Int, count > 0, count <= 16 * 1024 * 1024,
                  let value = NSBitmapImageRep(data: try Data(contentsOf: URL(fileURLWithPath: path))), value.pixelsWide <= 6400, value.pixelsHigh <= 4800 else { throw issue("invalid-image") }; return value
        }
        let first = try image(a), second = try image(b)
        guard first.pixelsWide == second.pixelsWide, first.pixelsHigh == second.pixelsHigh, let x = crop["x"], let y = crop["y"], let width = crop["width"], let height = crop["height"], x >= 0, y >= 0, width > 0, height > 0, width <= 160, height <= 160, x + width <= first.pixelsWide, y + height <= first.pixelsHigh else { throw issue("invalid-comparison-crop") }
        var changed = 0, maximum = 0.0, sum = 0.0
        for row in y..<(y + height) { for column in x..<(x + width) {
            guard let a = first.colorAt(x: column, y: row)?.usingColorSpace(.sRGB), let b = second.colorAt(x: column, y: row)?.usingColorSpace(.sRGB) else { throw issue("pixel-unreadable") }
            let deltas = [abs(a.redComponent-b.redComponent), abs(a.greenComponent-b.greenComponent), abs(a.blueComponent-b.blueComponent)].map { Double($0) * 255 }
            let delta = deltas.max()!; if delta > 8 { changed += 1 }; maximum = max(maximum, delta); sum += deltas.reduce(0,+)
        } }
        return ["pixels": width * height, "changedPixelsOver8": changed, "maxChannelDelta": maximum, "meanAbsChannelDelta": sum / Double(width * height * 3)]
    }
    guard command["op"] as? String == "snapshot" else { throw issue("invalid-probe-operation") }
    for owner in command["identities"] as? [[String: Any]] ?? [] { _ = try expected(owner) }
    RunLoop.current.run(until: Date().addingTimeInterval(0.002))
    let cursor = CGEvent(source: nil)?.location ?? .zero
    return ["visibility": visibility(), "cursorWindows": cursorWindows(cursor), "cursor": ["x": cursor.x, "y": cursor.y], "sessionActive": sessionActive(), "screenRecording": CGPreflightScreenCaptureAccess(), "foregroundPid": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0, "leftButtonDown": CGEventSource.buttonState(.combinedSessionState, button: .left), "rightButtonDown": CGEventSource.buttonState(.combinedSessionState, button: .right), "middleButtonDown": CGEventSource.buttonState(.combinedSessionState, button: .center), "keysHeldCount": (0..<128).filter { CGEventSource.keyState(.combinedSessionState, key: CGKeyCode($0)) }.count]
}

// No unconditional Show: it belongs only to this process's successful Hide.
private final class BalancedHide {
    let setBackground: (Bool) -> Int32, hide: () -> Int32, show: () -> Int32
    let connectionEvidence: [String: Any]
    private(set) var owned = false, background = false, hides = 0, shows = 0
    init(connectionEvidence: [String: Any] = [:], setBackground: @escaping (Bool) -> Int32, hide: @escaping () -> Int32, show: @escaping () -> Int32) { self.connectionEvidence = connectionEvidence; self.setBackground = setBackground; self.hide = hide; self.show = show }
    func acquire() throws {
        if owned { return }
        guard setBackground(true) == 0 else { throw issue("background-property-failed") }; background = true
        guard hide() == 0 else { try? restore(); throw issue("hide-rejected") }; owned = true; hides += 1
    }
    func restore() throws {
        if owned { guard show() == 0 else { throw issue("show-unconfirmed") }; owned = false; shows += 1 }
        if background { guard setBackground(false) == 0 else { throw issue("property-reset-unconfirmed") }; background = false }
    }
    var snapshot: [String: Any] { ["ownedHideCount": owned ? 1 : 0, "backgroundPropertyOwned": background, "successfulHideCalls": hides, "successfulShowCalls": shows, "connection": connectionEvidence] }
    static func native() throws -> BalancedHide {
        typealias ConnectionFn = @convention(c) () -> Int32
        typealias PropertyFn = @convention(c) (Int32, Int32, CFString, CFTypeRef) -> Int32
        let handle = UnsafeMutableRawPointer(bitPattern: -2)
        let main = dlsym(handle, "CGSMainConnectionID"), fallback = dlsym(handle, "_CGSDefaultConnection")
        guard main != nil || fallback != nil, let setter = dlsym(handle, "CGSSetConnectionProperty") else { throw issue("background-SPI-unavailable") }
        // Read both IDs for falsifiable evidence. Keep the previous symbol
        // priority unchanged; only the hider activation policy is varied.
        let mainId = main.map { unsafeBitCast($0, to: ConnectionFn.self)() }, fallbackId = fallback.map { unsafeBitCast($0, to: ConnectionFn.self)() }
        let cid = mainId ?? fallbackId ?? 0, set = unsafeBitCast(setter, to: PropertyFn.self)
        guard cid > 0 else { throw issue("connection-unavailable") }
        let evidence: [String: Any] = ["CGSMainConnectionID": mainId as Any? ?? NSNull(), "_CGSDefaultConnection": fallbackId as Any? ?? NSNull(), "selectedSymbol": main != nil ? "CGSMainConnectionID" : "_CGSDefaultConnection", "selectedId": cid, "spiDiagnosticOnly": true]
        return BalancedHide(connectionEvidence: evidence, setBackground: { enabled in set(cid, cid, "SetsCursorInBackground" as CFString, enabled ? kCFBooleanTrue : kCFBooleanFalse) }, hide: { Int32(CGDisplayHideCursor(CGMainDisplayID()).rawValue) }, show: { Int32(CGDisplayShowCursor(CGMainDisplayID()).rawValue) })
    }
}
@MainActor private final class ExperimentCanvas: NSView {
    var tip = CGPoint.zero
    override var isFlipped: Bool { true }
    override func draw(_ dirty: NSRect) { NSColor(srgbRed: 0.045, green: 0.045, blue: 0.045, alpha: 1).setFill(); bounds.fill(); AICursorGlyph.draw(at: tip) }
}
@MainActor private final class ExperimentApp: NSObject, NSApplicationDelegate {
    let fixture: Bool
    var window: NSWindow?, canvas: ExperimentCanvas?, balance: BalancedHide?, pinnedFixture: [String: Any]?, windowId: UInt32?
    let parent: [String: Any], started = ProcessInfo.processInfo.systemUptime
    var timer: Timer?, ending = false, pointer: CGPoint?
    init(fixture: Bool) throws { self.fixture = fixture; parent = try identity(getppid()) }
    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            if fixture {
                let cursor = CGEvent(source: nil)?.location ?? .zero, primary = NSScreen.screens.first?.frame.height ?? 0, appPoint = CGPoint(x: cursor.x, y: primary-cursor.y)
                let screen = NSScreen.screens.first(where: { $0.frame.contains(appPoint) }) ?? NSScreen.main!
                let w = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 640, height: 480), styleMask: [.titled, .closable], backing: .buffered, defer: false)
                w.title = "QiuYaTools isolated cursor visibility fixture"; w.isReleasedWhenClosed = false
                let area = screen.visibleFrame, x = max(area.minX, min(appPoint.x - w.frame.width/2, area.maxX-w.frame.width)), y = max(area.minY, min(appPoint.y - w.frame.height/2, area.maxY-w.frame.height))
                w.setFrameOrigin(CGPoint(x: x, y: y)); let view = ExperimentCanvas(frame: CGRect(x: 0, y: 0, width: 640, height: 480)); w.contentView = view
                let local = w.convertPoint(fromScreen: appPoint); view.tip = CGPoint(x: local.x, y: view.bounds.height-local.y)
                guard view.tip.x >= 40, view.tip.y >= 40, view.tip.x < view.bounds.width-50, view.tip.y < view.bounds.height-50 else { throw issue("cursor-outside-safe-fixture-region") }
                canvas = view; window = w; pointer = cursor; w.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
            } else { balance = try .native() }
            emit(["event": "ready", "role": fixture ? "fixture" : "hider", "identity": try identity(getpid()), "activationPolicy": NSApp.activationPolicy() == .accessory ? "accessory" : NSApp.activationPolicy() == .regular ? "regular" : "prohibited", "connection": balance?.connectionEvidence as Any? ?? NSNull(), "windowId": window.map { $0.windowNumber } as Any? ?? NSNull(), "pointer": pointer.map { ["x": $0.x, "y": $0.y] } as Any? ?? NSNull()])
            timer = Timer.scheduledTimer(withTimeInterval: 0.025, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.watch() } }
            DispatchQueue.global().async { [weak self] in
                while let line = readLine() {
                    guard line.utf8.count < 16384, let data = line.data(using: .utf8), let input = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                    DispatchQueue.main.async { self?.handle(input) }
                }
                DispatchQueue.main.async { self?.finish("stdin-eof") }
            }
        } catch { emit(["event": "failed", "code": (error as? ExperimentIssue)?.code ?? "startup-failed"]); finish("startup-failed", code: 1) }
    }
    func safeFixture() throws {
        guard sessionActive(), let pinnedFixture, let pid = pinnedFixture["pid"] as? Int32, let windowId, same(try identity(pid), pinnedFixture), NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { throw issue("fixture-authorization-lost") }
        let cursor = CGEvent(source: nil)?.location ?? .zero
        guard let pointer, hypot(cursor.x-pointer.x,cursor.y-pointer.y) < 1.5 else { throw issue("cursor-moved-by-user") }
        let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        guard windows.contains(where: { row in guard (row[kCGWindowNumber as String] as? NSNumber)?.uint32Value == windowId, (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid, let raw = row[kCGWindowBounds as String] as? [String: Any], let frame = CGRect(dictionaryRepresentation: raw as CFDictionary) else { return false }; return frame.contains(cursor) }), !CGEventSource.buttonState(.combinedSessionState, button: .left), !CGEventSource.buttonState(.combinedSessionState, button: .right), !CGEventSource.buttonState(.combinedSessionState, button: .center), (0..<128).allSatisfy({ !CGEventSource.keyState(.combinedSessionState, key: CGKeyCode($0)) }) else { throw issue("fixture-region-or-input-changed") }
    }
    func handle(_ input: [String: Any]) {
        let id = input["requestId"] as Any? ?? NSNull()
        do {
            switch input["op"] as? String {
            case "hide":
                guard !fixture else { throw issue("fixture-never-hides-cursor") }
                pinnedFixture = try expected(input["fixture"]); windowId = input["windowId"] as? UInt32
                if pointer == nil { pointer = CGEvent(source: nil)?.location }; try safeFixture(); try balance!.acquire()
            case "show": try balance?.restore()
            case "snapshot": break
            case "quit": emit(["requestId": id, "ok": true]); finish("explicit-quit"); return
            default: throw issue("operation-not-allowed")
            }
            emit(["requestId": id, "ok": true, "result": ["balance": balance?.snapshot as Any? ?? NSNull(), "visibility": visibility()]])
        } catch { emit(["requestId": id, "ok": false, "error": ["code": (error as? ExperimentIssue)?.code ?? "operation-failed"]]) }
    }
    func watch() {
        guard !ending else { return }
        guard let parentPid = parent["pid"] as? Int else { finish("parent-identity-unavailable", code: 1); return }
        if ProcessInfo.processInfo.systemUptime-started > (fixture ? 120 : 15) || (try? identity(pid_t(parentPid))).map({ same($0,parent) }) != true { finish("parent-retired-or-lifetime"); return }
        if balance?.owned == true { do { try safeFixture() } catch { finish("fixture-safety-changed") } }
    }
    func finish(_ reason: String, code: Int32 = 0) {
        guard !ending else { return }; ending = true; timer?.invalidate()
        var result = code
        do { try balance?.restore() } catch { result = 1 }
        emit(["event": "cleanup", "reason": reason, "balance": balance?.snapshot as Any? ?? NSNull(), "exitCode": result]); window?.close(); Darwin.exit(result)
    }
}
@main private struct SystemCursorExperiment {
    @MainActor static func main() throws {
        if CommandLine.arguments.contains("--self-test") {
            var calls = [String](), failShow = false, failReset = false
            let b = BalancedHide(setBackground: { enabled in calls.append(enabled ? "enable" : "disable"); return !enabled && failReset ? 1 : 0 }, hide: { calls.append("hide"); return 0 }, show: { calls.append("show"); return failShow ? 1 : 0 })
            try b.acquire(); try b.acquire(); precondition(calls == ["enable","hide"] && b.owned)
            failShow = true; do { try b.restore(); preconditionFailure() } catch { precondition(b.owned && b.background && calls.last == "show") }
            failShow = false; failReset = true; do { try b.restore(); preconditionFailure() } catch { precondition(!b.owned && b.background && b.shows == 1) }
            failReset = false; let oldShows = b.shows; try b.restore(); try b.restore(); precondition(!b.background && b.shows == oldShows)
            var hides = 0
            let absent = BalancedHide(setBackground: { _ in 1 }, hide: { hides += 1; return 0 }, show: { preconditionFailure() })
            do { try absent.acquire(); preconditionFailure() } catch { precondition(hides == 0 && !absent.owned) }
            var failedCalls = [String]()
            let failed = BalancedHide(setBackground: { enabled in failedCalls.append(enabled ? "enable" : "disable"); return 0 }, hide: { failedCalls.append("hide"); return 1 }, show: { preconditionFailure() })
            do { try failed.acquire(); preconditionFailure() } catch { precondition(!failed.owned && !failed.background && failedCalls == ["enable","hide","disable"]) }
            let own = try identity(getpid()), detached = try JSONSerialization.jsonObject(with: JSONSerialization.data(withJSONObject: own))
            _ = try expected(detached)
            emit(["passed": true, "checks": 7, "actualCursorCalls": 0, "AppKitWindowsCreated": 0, "identityReadback": true]); return
        }
        if CommandLine.arguments.contains("--probe") {
            emit(["event":"ready", "role":"probe", "identity": try identity(getpid())])
            while let line = readLine() { guard line.utf8.count < 65536, let data = line.data(using:.utf8), let command = try? JSONSerialization.jsonObject(with:data) as? [String:Any] else { continue }; let id = command["requestId"] as Any? ?? NSNull(); do { emit(["requestId":id,"ok":true,"result":try probe(command)]) } catch { emit(["requestId":id,"ok":false,"error":["code":(error as? ExperimentIssue)?.code ?? "probe-failed"]]) } }; return
        }
        guard CommandLine.arguments.contains("--fixture") || CommandLine.arguments.contains("--hider") else { throw issue("explicit-role-required") }
        let fixture = CommandLine.arguments.contains("--fixture"), app = NSApplication.shared, delegate = try ExperimentApp(fixture: fixture)
        app.setActivationPolicy(fixture ? .regular : .accessory); app.delegate = delegate; app.run()
    }
}
