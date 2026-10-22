// Test-only, read-only process/window evidence. Never injects input or signals.
// ABI facts: Apple XNU bsd/sys/proc_info_private.h (flavors 17 and 20),
// osfmk/mach/coalition.h (resource=0, jetsam=1); local SDK libproc.h/resource.h.
// responsibility_get_pid_responsible_for_pid is a dynamically checked SPI,
// also declared by Chromium base/process/process_info_mac.cc. Missing access
// is evidence of an unverified resource boundary, never an empty/green total.
import AppKit
import CoreImage
import CoreMedia
import Darwin
import Foundation
import ScreenCaptureKit

// Cryptex/firmlink paths can name the same system binary. Compare file
// identity with the exact public framework executables, never basename alone.
private let systemWebKitFiles: [(kind: String, device: dev_t, inode: ino_t)] = ["WebContent", "Networking", "GPU"].compactMap { kind in
    let name = "com.apple.WebKit.\(kind)"
    let path = "/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/\(name).xpc/Contents/MacOS/\(name)"
    var value = stat()
    guard stat(path, &value) == 0, value.st_uid == 0, (value.st_mode & S_IFMT) == S_IFREG else { return nil }
    return (kind, value.st_dev, value.st_ino)
}

private struct Identity: Codable {
    var pid: Int32
    var birthMicros: String
    var uniqueId: String
    var path: String
    var role: String?
}
private struct ViewAssociation: Decodable {
    let native: Identity
    let process: Identity
    let kind: String
}
private struct ProcessRow {
    var bsd: proc_bsdinfo
    var identity: Identity
    var parentUniqueId: String
    var resourceCoalitionId: String?
    var jetsamCoalitionId: String?
    var responsiblePid: Int32?
    var residentBytes: UInt64?
    var physicalFootprintBytes: UInt64?
    var userTime: UInt64?
    var systemTime: UInt64?
    var errors: [String]
    var kind: String? {
        var file = stat()
        guard stat(identity.path, &file) == 0, file.st_uid == 0, (file.st_mode & S_IFMT) == S_IFREG else { return nil }
        return systemWebKitFiles.first { $0.device == file.st_dev && $0.inode == file.st_ino }?.kind
    }
    var json: [String: Any] {
        var result: [String: Any] = ["pid": identity.pid, "parentPid": bsd.pbi_ppid,
            "birthMicros": identity.birthMicros, "uniqueId": identity.uniqueId,
            "parentUniqueId": parentUniqueId, "path": identity.path,
            "name": URL(fileURLWithPath: identity.path).lastPathComponent, "role": identity.role ?? "descendant", "errors": errors]
        result["resourceCoalitionId"] = resourceCoalitionId
        result["jetsamCoalitionId"] = jetsamCoalitionId
        result["responsiblePid"] = responsiblePid
        result["residentBytes"] = residentBytes
        result["physicalFootprintBytes"] = physicalFootprintBytes
        result["userTimeNs"] = userTime
        result["systemTimeNs"] = systemTime
        result["webKitKind"] = kind
        return result
    }
}

private typealias ResponsiblePid = @convention(c) (Int32) -> Int32
private let responsible: ResponsiblePid? = {
    guard let library = dlopen(nil, RTLD_LAZY), let symbol = dlsym(library, "responsibility_get_pid_responsible_for_pid") else { return nil }
    return unsafeBitCast(symbol, to: ResponsiblePid.self)
}()
private func failure(_ text: String) -> NSError { NSError(domain: text, code: 1) }
private func bsd(_ pid: Int32) -> proc_bsdinfo? {
    var value = proc_bsdinfo()
    return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &value, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size ? value : nil
}
private func birth(_ value: proc_bsdinfo) -> String { String(value.pbi_start_tvsec * 1_000_000 + value.pbi_start_tvusec) }
private func unique(_ pid: Int32) -> [UInt64]? {
    var buffer = [UInt64](repeating: 0, count: 7)
    let count = buffer.withUnsafeMutableBytes { proc_pidinfo(pid, 17, 0, $0.baseAddress, Int32($0.count)) }
    return count == 56 && buffer[2] > 0 ? buffer : nil
}
private func row(_ pid: Int32, excluded: ((String) -> Void)? = nil) -> ProcessRow? {
    guard let first = bsd(pid) else { excluded?("bsd-unavailable:\(errno)"); return nil }
    guard first.pbi_uid == getuid() else { excluded?("different-real-uid:\(first.pbi_uid)"); return nil }
    guard let ids = unique(pid) else { excluded?("unique-identity-unavailable:\(errno)"); return nil }
    var pathBuffer = [CChar](repeating: 0, count: 4096)
    guard proc_pidpath(pid, &pathBuffer, UInt32(pathBuffer.count)) > 0 else { excluded?("executable-path-unavailable:\(errno)"); return nil }
    let path = String(cString: pathBuffer)
    var coalition = [UInt64](repeating: 0, count: 5)
    let coalitionBytes = coalition.withUnsafeMutableBytes { proc_pidinfo(pid, 20, 0, $0.baseAddress, Int32($0.count)) }
    var usage = rusage_info_v0()
    let memory = withUnsafeMutablePointer(to: &usage) { pointer in
        pointer.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V0, $0) }
    }
    let responsibility = responsible?(pid)
    guard let after = bsd(pid), birth(first) == birth(after), unique(pid)?[2] == ids[2] else { excluded?("identity-changed-during-read"); return nil }
    var errors: [String] = []
    if coalitionBytes != 40 { errors.append("coalition-unavailable") }
    if memory != 0 { errors.append("rusage-unavailable") }
    return ProcessRow(bsd: after, identity: Identity(pid: pid, birthMicros: birth(after), uniqueId: String(ids[2]), path: path),
        parentUniqueId: String(ids[3]), resourceCoalitionId: coalitionBytes == 40 ? String(coalition[0]) : nil,
        jetsamCoalitionId: coalitionBytes == 40 ? String(coalition[1]) : nil,
        responsiblePid: responsibility != nil && responsibility! > 0 ? responsibility : nil,
        residentBytes: memory == 0 ? usage.ri_resident_size : nil,
        physicalFootprintBytes: memory == 0 ? usage.ri_phys_footprint : nil,
        userTime: memory == 0 ? usage.ri_user_time : nil, systemTime: memory == 0 ? usage.ri_system_time : nil, errors: errors)
}
// A candidate name is only a diagnostic selection. It never grants ownership or
// changes the strict ProcessRow.kind/responsibility/coalition adoption rules.
private func webKitDiagnostic(_ pid: Int32, _ live: ProcessRow?, _ exclusion: String?) -> [String: Any]? {
    let first = bsd(pid), firstUnique = unique(pid)
    var pathBuffer = [CChar](repeating: 0, count: 4096)
    errno = 0; let pathBytes = proc_pidpath(pid, &pathBuffer, UInt32(pathBuffer.count)); let pathError = errno
    let path = pathBytes > 0 ? String(cString: pathBuffer) : nil
    var nameBuffer = [CChar](repeating: 0, count: 65)
    errno = 0; let nameBytes = proc_name(pid, &nameBuffer, 64); let nameError = errno
    let name = nameBytes > 0 ? String(cString: nameBuffer) : nil
    guard (path.map { URL(fileURLWithPath: $0).lastPathComponent.contains("WebKit") } ?? false) || (name?.contains("WebKit") ?? false) else { return nil }
    var result: [String: Any] = ["pid": pid, "diagnosticOnly": true, "adoptedByName": false,
        "selection": "executable-basename-or-proc-name; never ownership", "path": path as Any? ?? NSNull(), "procName": name as Any? ?? NSNull(),
        "pathQuery": ["returnedBytes": pathBytes, "errno": pathError], "nameQuery": ["returnedBytes": nameBytes, "errno": nameError],
        "rowExclusion": exclusion as Any? ?? NSNull(), "strictClassifiedKind": live?.kind as Any? ?? NSNull()]
    if let live { result["readableProcessRow"] = live.json }
    errno = 0
    if let first = bsd(pid) { result["bsd"] = ["available": true, "uid": first.pbi_uid, "parentPid": first.pbi_ppid, "birthMicros": birth(first), "status": first.pbi_status] }
    else { result["bsd"] = ["available": false, "errno": errno] }
    var ids = [UInt64](repeating: 0, count: 7)
    errno = 0; let idBytes = ids.withUnsafeMutableBytes { proc_pidinfo(pid, 17, 0, $0.baseAddress, Int32($0.count)) }; let idError = errno
    var idQuery: [String: Any] = ["returnedBytes": idBytes, "expectedBytes": 56, "errno": idError]
    if idBytes == 56 { idQuery["uniqueId"] = String(ids[2]); idQuery["parentUniqueId"] = String(ids[3]) }
    result["uniqueIdentityQuery"] = idQuery
    var coalitions = [UInt64](repeating: 0, count: 5)
    errno = 0; let coalitionBytes = coalitions.withUnsafeMutableBytes { proc_pidinfo(pid, 20, 0, $0.baseAddress, Int32($0.count)) }; let coalitionError = errno
    var coalitionQuery: [String: Any] = ["returnedBytes": coalitionBytes, "expectedBytes": 40, "errno": coalitionError]
    if coalitionBytes == 40 { coalitionQuery["resourceCoalitionId"] = String(coalitions[0]); coalitionQuery["jetsamCoalitionId"] = String(coalitions[1]) }
    result["coalitionQuery"] = coalitionQuery
    if let responsible { errno = 0; let value = responsible(pid); result["responsibilityQuery"] = ["available": true, "pid": value, "errno": errno] }
    else { result["responsibilityQuery"] = ["available": false] }
    var usage = rusage_info_v0()
    errno = 0
    let memoryResult = withUnsafeMutablePointer(to: &usage) { pointer in
        pointer.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V0, $0) }
    }
    var memoryQuery: [String: Any] = ["returnCode": memoryResult, "errno": errno, "available": memoryResult == 0]
    if memoryResult == 0 { memoryQuery["residentBytes"] = usage.ri_resident_size; memoryQuery["physicalFootprintBytes"] = usage.ri_phys_footprint }
    result["memoryQuery"] = memoryQuery
    if let first, let firstUnique, let after = bsd(pid), let afterUnique = unique(pid) {
        result["diagnosticStableIdentity"] = birth(first) == birth(after) && firstUnique[2] == afterUnique[2]
    } else { result["diagnosticStableIdentity"] = false }
    // Memory failures remain explicit in the original row's errors. Diagnostic
    // rows, including partial reads, are never included in resource totals.
    return result
}
private func matches(_ row: ProcessRow, _ expected: Identity) -> Bool {
    row.identity.pid == expected.pid && row.identity.birthMicros == expected.birthMicros && row.identity.uniqueId == expected.uniqueId && row.identity.path == expected.path
}
private func identities(_ value: Any?) throws -> [Identity] {
    guard let value else { return [] }
    let result = try JSONDecoder().decode([Identity].self, from: JSONSerialization.data(withJSONObject: value))
    guard result.count <= 4096, result.allSatisfy({ $0.pid > 0 && UInt64($0.birthMicros) != nil && UInt64($0.uniqueId) != nil && $0.path.hasPrefix("/") }) else { throw failure("invalid-process-identities") }
    return result
}
private func snapshot(_ request: [String: Any]) throws -> [String: Any] {
    let roots = try identities(request["roots"]), remembered = try identities(request["known"])
    guard let runner = roots.first(where: { $0.role == "runner" }), let helperPath = request["helperPath"] as? String, helperPath.hasPrefix("/") else { throw failure("missing-owned-runner") }
    let capacity = proc_listallpids(nil, 0)
    guard capacity > 0, capacity < 65536 else { throw failure("process-inventory-unavailable") }
    var pids = [Int32](repeating: 0, count: Int(capacity) + 1024)
    let count = pids.withUnsafeMutableBytes { proc_listallpids($0.baseAddress, Int32($0.count)) }
    guard count > 0, count < pids.count else { throw failure("process-inventory-truncated") }
    var exclusions: [Int32: String] = [:]
    let rows = pids.prefix(Int(count)).compactMap { pid in row(pid, excluded: { exclusions[pid] = $0 }) }
    let rowsByPid = Dictionary(uniqueKeysWithValues: rows.map { ($0.identity.pid, $0) })
    let webKitDiagnostics = pids.prefix(Int(count)).compactMap { webKitDiagnostic($0, rowsByPid[$0], exclusions[$0]) }
    guard let liveRunner = rows.first(where: { matches($0, runner) }) else { throw failure("runner-identity-changed") }
    var owned: [Int32: ProcessRow] = [:], errors: [String] = []
    for expected in roots + remembered {
        if var live = rows.first(where: { matches($0, expected) }) { live.identity.role = expected.role; owned[expected.pid] = live }
        else if let current = bsd(expected.pid), birth(current) == expected.birthMicros { errors.append("owned-live-process-unreadable:\(expected.pid)") }
    }
    for var candidate in rows where candidate.identity.path == helperPath && candidate.parentUniqueId == runner.uniqueId && candidate.bsd.pbi_ppid == runner.pid && UInt64(candidate.identity.birthMicros)! >= UInt64(runner.birthMicros)! {
        candidate.identity.role = "native"; owned[candidate.identity.pid] = candidate
    }
    func adoptDescendants() {
        var changed = true
        while changed {
            changed = false
            for candidate in rows where owned[candidate.identity.pid] == nil {
                guard let parent = owned[Int32(candidate.bsd.pbi_ppid)], candidate.parentUniqueId == parent.identity.uniqueId,
                      UInt64(candidate.identity.birthMicros)! >= UInt64(parent.identity.birthMicros)! else { continue }
                owned[candidate.identity.pid] = candidate; changed = true
            }
        }
    }
    adoptDescendants()
    let natives = owned.values.filter { $0.identity.role == "native" }
    if request["requireSelfResponsibleNative"] as? Bool == true {
        for native in natives where native.responsiblePid != native.identity.pid { errors.append("native-responsibility-not-disclaimed:\(native.identity.pid)") }
    }
    if responsible == nil { errors.append("responsibility-query-unavailable") }
    // The test-only shim obtains these identities from the exact own live WK
    // object. Never accept its PID alone: re-read OS birth, unique ID, same-user
    // executable file identity, coalition and responsibility independently.
    // Participation can include a shared WebKit process; it is not exclusive
    // memory ownership. The report includes the complete participating RSS.
    let associationBytes = try JSONSerialization.data(withJSONObject: request["viewAssociations"] ?? [])
    let associations = try JSONDecoder().decode([ViewAssociation].self, from: associationBytes)
    guard associations.count <= 128 else { throw failure("view-association-bound") }
    for association in associations {
        guard let native = natives.first(where: { matches($0, association.native) }),
              var candidate = rows.first(where: { matches($0, association.process) }),
              ["WebContent", "GPU", "Networking"].contains(association.kind), candidate.kind == association.kind,
              UInt64(candidate.identity.birthMicros)! >= UInt64(native.identity.birthMicros)!,
              native.resourceCoalitionId != nil, native.resourceCoalitionId != "0", candidate.resourceCoalitionId == native.resourceCoalitionId,
              native.responsiblePid != nil, candidate.responsiblePid == native.responsiblePid else {
            errors.append("view-associated-process-not-independently-verified:\(association.process.pid)"); continue
        }
        candidate.identity.role = "webkit-view-associated"; owned[candidate.identity.pid] = candidate
    }
    for var candidate in rows where candidate.kind != nil && owned[candidate.identity.pid] == nil {
        let native = natives.first { $0.identity.pid == candidate.responsiblePid && UInt64(candidate.identity.birthMicros)! >= UInt64($0.identity.birthMicros)! }
        if let native {
            guard native.resourceCoalitionId != nil, native.resourceCoalitionId != "0", candidate.resourceCoalitionId == native.resourceCoalitionId else { errors.append("webkit-responsibility-coalition-mismatch:\(candidate.identity.pid)"); continue }
            candidate.identity.role = "webkit-xpc"; owned[candidate.identity.pid] = candidate
        } else if natives.contains(where: { $0.resourceCoalitionId != nil && $0.resourceCoalitionId != "0" && $0.resourceCoalitionId == candidate.resourceCoalitionId && UInt64(candidate.identity.birthMicros)! >= UInt64($0.identity.birthMicros)! }) {
            // Ordinary spawn can share the Codex/terminal coalition. Names,
            // birth-after and coalition alone never prove ownership of XPC.
            errors.append("shared-coalition-webkit-unattributed:\(candidate.identity.pid)")
        }
    }
    adoptDescendants()
    for candidate in owned.values { errors += candidate.errors.map { "\($0):\(candidate.identity.pid)" } }
    let webKit = owned.values.filter { $0.kind != nil }
    let required = request["requireWebKit"] as? Bool ?? false
    if required && !webKit.contains(where: { $0.kind == "WebContent" }) { errors.append("owned-webcontent-not-verified") }
    if request["requireWebKit"] as? Bool == true && natives.isEmpty { errors.append("live-native-parent-not-verified") }
    return ["processes": owned.values.sorted { $0.identity.pid < $1.identity.pid }.map { $0.json }, "webKitDiagnostics": webKitDiagnostics,
        "attribution": ["complete": errors.isEmpty, "errors": errors, "responsibilityAvailable": responsible != nil,
            "method": "exact BSD birth + proc unique/parent descendants; own-view getter associations independently corroborated by system executable file identity, coalition and responsibility; shared coalition alone never adopted; all known exact identities retained",
            "observedWebKitKinds": Array(Set(webKit.compactMap { $0.kind })).sorted(), "runnerCoalitionId": liveRunner.resourceCoalitionId as Any? ?? NSNull()]]
}

private final class FrameWriter: NSObject, SCStreamOutput, @unchecked Sendable {
    private let lock = NSLock()
    private var image: Data?
    var data: Data? { lock.lock(); defer { lock.unlock() }; return image }
    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, buffer.isValid, let pixels = buffer.imageBuffer,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let state = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: state) == .complete else { return }
        lock.lock(); defer { lock.unlock() }; guard image == nil else { return }
        let ci = CIImage(cvPixelBuffer: pixels), context = CIContext(options: [.cacheIntermediates: false])
        if let cg = context.createCGImage(ci, from: ci.extent) { image = NSBitmapImageRep(cgImage: cg).representation(using: .jpeg, properties: [.compressionFactor: 0.8]) }
    }
}
@main private struct WKSoakObserver {
    static func main() async {
        do {
            let bytes = FileHandle.standardInput.readDataToEndOfFile()
            guard bytes.count <= 1_048_576, let request = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw failure("invalid-request") }
            let result: [String: Any]
            switch request["op"] as? String {
            case "preflight":
                guard let session = CGSessionCopyCurrentDictionary() as? [String: Any], let uid = session["kCGSSessionUserIDKey"] as? NSNumber else { throw failure("interactive-session-unavailable") }
                result = ["sessionUnlocked": (session["CGSSessionScreenIsLocked"] as? Bool) != true,
                    "sessionOwned": uid.uint32Value == getuid(), "screenRecording": CGPreflightScreenCaptureAccess()]
            case "identity":
                guard let pid = request["pid"] as? Int32, let live = row(pid) else { throw failure("process-identity-unavailable") }
                result = live.json
            case "snapshot": result = try snapshot(request)
            case "check":
                let values = try identities(request["identities"])
                let states: [[String: Any]] = values.map { expected in
                    if let live = row(expected.pid) { return ["pid": expected.pid, "birthMicros": expected.birthMicros, "uniqueId": expected.uniqueId, "state": matches(live, expected) ? "alive" : "reused-pid-skipped"] }
                    if let current = bsd(expected.pid) {
                        return ["pid": expected.pid, "birthMicros": expected.birthMicros, "uniqueId": expected.uniqueId,
                            "state": birth(current) == expected.birthMicros ? "unverified" : "reused-pid-skipped"]
                    }
                    // Signal 0 performs existence/permission checking only. An
                    // unreadable live process (including EPERM) is not gone.
                    errno = 0; let probe = Darwin.kill(expected.pid, 0); let probeError = errno
                    return ["pid": expected.pid, "birthMicros": expected.birthMicros, "uniqueId": expected.uniqueId,
                        "state": probe != 0 && probeError == ESRCH ? "exited" : "unverified",
                        "existenceProbe": ["result": probe, "errno": probeError]]
                }
                result = ["passed": states.allSatisfy { $0["state"] as? String != "alive" && $0["state"] as? String != "unverified" }, "results": states]
            case "window": result = try await window(request)
            default: throw failure("unsupported-readonly-operation")
            }
            FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: ["ok": true, "result": result], options: [.sortedKeys]))
        } catch {
            let code = (error as NSError).domain
            let safe = code.range(of: "^[a-z0-9-]{1,100}$", options: .regularExpression) != nil ? code : "observer-operation-failed"
            let data = try! JSONSerialization.data(withJSONObject: ["ok": false, "error": safe])
            FileHandle.standardOutput.write(data); exit(1)
        }
    }
    @MainActor static func window(_ request: [String: Any]) async throws -> [String: Any] {
        guard let expected = try identities(request["identities"]).first, let live = row(expected.pid), matches(live, expected),
              let title = request["title"] as? String, let output = request["output"] as? String, output.hasPrefix("/") else { throw failure("window-owner-identity-changed") }
        let shareable = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        guard let window = shareable.windows.first(where: { $0.owningApplication?.processID == expected.pid && $0.title == title }) else { throw failure("owned-native-window-not-found") }
        let descriptions = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        guard let description = descriptions.first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == window.windowID && ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == expected.pid }),
              (description[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0 > 0,
              window.windowLayer > 0 else { throw failure("floating-panel-not-visible") }
        let config = SCStreamConfiguration(); config.width = min(1600, Int(window.frame.width * 2)); config.height = Int(Double(config.width) * window.frame.height / window.frame.width)
        config.scalesToFit = true; config.showsCursor = false
        if #available(macOS 14.0, *) { config.ignoreShadowsSingleWindow = true }
        let writer = FrameWriter(), stream = SCStream(filter: SCContentFilter(desktopIndependentWindow: window), configuration: config, delegate: nil)
        try stream.addStreamOutput(writer, type: .screen, sampleHandlerQueue: DispatchQueue(label: "qiuya.test.wk-window"))
        try await stream.startCapture()
        for _ in 0..<100 { if writer.data != nil { break }; try await Task.sleep(nanoseconds: 30_000_000) }
        try await stream.stopCapture()
        guard let data = writer.data, let after = row(expected.pid), matches(after, expected) else { throw failure("owned-window-capture-timeout-or-retired") }
        try data.write(to: URL(fileURLWithPath: output), options: .atomic)
        return ["pid": expected.pid, "birthMicros": expected.birthMicros, "uniqueId": expected.uniqueId,
            "windowId": window.windowID, "title": title, "onScreen": true, "visible": true, "windowLayer": window.windowLayer,
            "frame": ["x": window.frame.minX, "y": window.frame.minY, "width": window.frame.width, "height": window.frame.height],
            "screenshot": ["width": config.width, "height": config.height, "bytes": data.count], "method": "independent ScreenCaptureKit floating-panel screenshot"]
    }
}
