import AppKit
import ApplicationServices
import Foundation

final class FocusActivationResult {
    var accepted = false
    var axSettableResult: Int32?
    var axFrontmostResult: Int32?
    var raiseResult: Int32?
}

struct FocusPreparationSample {
    let frontmostPid: pid_t?
}

/// Injectable boundaries keep the cancellation, deadline and consecutive-read
/// contract testable without activating an application or querying real AX.
@MainActor struct FocusPreparationBackend {
    var now: @MainActor () -> TimeInterval
    var frontmost: @MainActor () -> pid_t?
    var request: @MainActor (_ deadline: TimeInterval, _ result: FocusActivationResult) async throws -> Void
    var sample: @MainActor () throws -> FocusPreparationSample
    var sleep: @MainActor (_ nanoseconds: UInt64) async throws -> Void
}

@MainActor enum BoundedFocusPreparation {
    static func run(targetPid: pid_t, backend: FocusPreparationBackend, checkpoint: () throws -> Void,
                    record: ([String: Any]) -> Void) async throws {
        let begin = backend.now(), deadline = begin + 0.5
        let result = FocusActivationResult(), before = backend.frontmost()
        var after = before
        var receipt: [String: Any] {
            ["targetPid": Int(targetPid), "beforePid": before as Any? ?? NSNull(), "afterPid": after as Any? ?? NSNull(),
             "activationAccepted": result.accepted, "settledMs": max(0, Int(((backend.now() - begin) * 1000).rounded())),
             "axSettableResult": result.axSettableResult as Any? ?? NSNull(),
             "axFrontmostResult": result.axFrontmostResult as Any? ?? NSNull(), "raiseResult": result.raiseResult as Any? ?? NSNull(),
             "inputPosted": false]
        }
        record(receipt)
        defer { after = backend.frontmost(); record(receipt) }
        try Task.checkCancellation(); try checkpoint()
        try await backend.request(deadline, result)
        try Task.checkCancellation(); try checkpoint()
        var consecutive = 0
        while backend.now() < deadline {
            try Task.checkCancellation(); try checkpoint()
            after = try backend.sample().frontmostPid
            try checkpoint()
            if backend.now() >= deadline { break }
            if after == targetPid { consecutive += 1 } else { consecutive = 0 }
            record(receipt)
            if consecutive >= 2 { return }
            let remaining = deadline - backend.now()
            if remaining <= 0 { break }
            try await backend.sleep(max(1, UInt64((min(0.01, remaining) * 1_000_000_000).rounded(.up))))
        }
        throw ComputerError("FOCUS_CHANGED", "The target application did not become ready for input; input stopped.")
    }
}

private struct FocusProcessBirth: Equatable {
    let seconds: UInt64
    let microseconds: UInt64
    init?(_ pid: pid_t) {
        var value = proc_bsdinfo()
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &value, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size,
              value.pbi_uid == getuid() else { return nil }
        seconds = value.pbi_start_tvsec; microseconds = value.pbi_start_tvusec
    }
}

@MainActor extension FocusPreparationBackend {
    static func native(target: NativeTarget, geometry: FrameGeometry, checkpoint: @escaping () throws -> Void) throws -> FocusPreparationBackend {
        guard let birth = FocusProcessBirth(target.pid), let application = NSRunningApplication(processIdentifier: target.pid), !application.isTerminated else {
            throw ComputerError("TARGET_GONE", "The target application exited.")
        }
        func validate() throws {
            try checkpoint()
            guard FocusProcessBirth(target.pid) == birth, !application.isTerminated else { throw ComputerError("TARGET_GONE", "The target application exited.") }
            guard let rows = CGWindowListCopyWindowInfo(.optionIncludingWindow, target.windowId) as? [[String: Any]],
                  let row = rows.first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == target.windowId &&
                      ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == target.pid }),
                  row[kCGWindowIsOnscreen as String] as? Bool == true,
                  let bounds = row[kCGWindowBounds as String] as? [String: Any], let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary),
                  abs(frame.minX - geometry.frame.minX) < 1, abs(frame.minY - geometry.frame.minY) < 1,
                  abs(frame.width - geometry.frame.width) < 1, abs(frame.height - geometry.frame.height) < 1 else {
                throw ComputerError("GEOMETRY_CHANGED", "The window moved, resized, or became unavailable. Observe it again before acting.")
            }
        }
        return FocusPreparationBackend(now: { ProcessInfo.processInfo.systemUptime },
            frontmost: { NSWorkspace.shared.frontmostApplication?.processIdentifier }, request: { deadline, result in
                @MainActor func ready() throws {
                    try validate()
                    guard ProcessInfo.processInfo.systemUptime < deadline else { throw ComputerError("FOCUS_CHANGED", "The target application did not become ready for input; input stopped.") }
                }
                // AX calls are individually bounded. Yield between them so a
                // human event or release can invalidate the preparation. A
                // synchronous AX call already in progress cannot be cancelled.
                @MainActor func turn() async throws { await Task.yield(); try Task.checkCancellation(); try ready() }
                try ready()
                result.accepted = application.activate(options: [])
                await Task.yield(); try ready()
                let app = AXUIElementCreateApplication(target.pid)
                AXUIElementSetMessagingTimeout(app, 0.03)
                var settable = DarwinBoolean(false)
                let query = AXUIElementIsAttributeSettable(app, kAXFrontmostAttribute as CFString, &settable)
                result.axSettableResult = query.rawValue
                try await turn()
                if query == .success && settable.boolValue {
                    result.axFrontmostResult = AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue).rawValue
                    try await turn()
                }
                var windowsValue: CFTypeRef?
                let windowsResult = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windowsValue)
                try await turn()
                if windowsResult == .success, let windows = windowsValue as? [AXUIElement], windows.count <= 32 {
                    var matching = [AXUIElement]()
                    for window in windows {
                        try ready(); AXUIElementSetMessagingTimeout(window, 0.03)
                        var position: CFTypeRef?, size: CFTypeRef?
                        let positionResult = AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &position)
                        try await turn()
                        let sizeResult = AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &size)
                        try await turn()
                        guard positionResult == .success, sizeResult == .success, let position, let size,
                              CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { continue }
                        var point = CGPoint.zero, dimensions = CGSize.zero
                        guard AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else { continue }
                        if abs(point.x - geometry.frame.minX) < 1, abs(point.y - geometry.frame.minY) < 1,
                           abs(dimensions.width - geometry.frame.width) < 1, abs(dimensions.height - geometry.frame.height) < 1 { matching.append(window) }
                    }
                    // The public AX API exposes no CGWindowID. Refuse to pick
                    // between overlapping, identically sized app windows.
                    if matching.count == 1 {
                        let window = matching[0]
                        result.raiseResult = AXUIElementPerformAction(window, kAXRaiseAction as CFString).rawValue
                        try await turn()
                        _ = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
                        try await turn()
                        _ = AXUIElementSetAttributeValue(window, kAXFocusedAttribute as CFString, kCFBooleanTrue)
                        try await turn()
                        _ = AXUIElementSetAttributeValue(app, kAXFocusedWindowAttribute as CFString, window)
                        try await turn()
                    }
                }
            }, sample: { try validate(); return FocusPreparationSample(frontmostPid: NSWorkspace.shared.frontmostApplication?.processIdentifier) },
            sleep: { try await Task.sleep(nanoseconds: $0) })
    }
}
