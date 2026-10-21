import AppKit
import Foundation

private final class ReadProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var storedCalls = [(Int, String)](), storedTimeouts = [Float]()
    private var storedEntered = false, storedFinished = false, storedOnMain = false
    private var clockValue: TimeInterval = 0
    let continueRead = DispatchSemaphore(value: 0)
    func enter() { lock.lock(); storedEntered = true; storedOnMain = Thread.isMainThread; lock.unlock() }
    func finish() { lock.lock(); storedFinished = true; lock.unlock() }
    func call(_ element: Int, _ name: String) { lock.lock(); storedCalls.append((element, name)); lock.unlock() }
    func timeout(_ value: Float) { lock.lock(); storedTimeouts.append(value); lock.unlock() }
    func advance(_ value: TimeInterval) { lock.lock(); clockValue += value; lock.unlock() }
    var now: TimeInterval { lock.lock(); defer { lock.unlock() }; return clockValue }
    var entered: Bool { lock.lock(); defer { lock.unlock() }; return storedEntered }
    var finished: Bool { lock.lock(); defer { lock.unlock() }; return storedFinished }
    var onMain: Bool { lock.lock(); defer { lock.unlock() }; return storedOnMain }
    var calls: [(Int, String)] { lock.lock(); defer { lock.unlock() }; return storedCalls }
    var timeouts: [Float] { lock.lock(); defer { lock.unlock() }; return storedTimeouts }
}

@main struct AccessibilityWorkerSelfTest {
    private static let frame = CGRect(x: 10, y: -900, width: 640, height: 480)
    private static func backend(_ probe: ReadProbe, custom: @escaping (Int, String) -> AccessibilityReadValue<Int>?) -> AccessibilityReadBackend<Int> {
        AccessibilityReadBackend(trusted: { true }, application: { _ in -1 }, setTimeout: { _, value in probe.timeout(value) },
            attribute: { element, name in probe.call(element, name); return custom(element, name) }, identity: { CFHashCode($0 + 1000) })
    }
    private static func base(_ element: Int, _ name: String) -> AccessibilityReadValue<Int>? {
        if element == -1 && name == kAXWindowsAttribute { return .elements([0]) }
        if name == kAXPositionAttribute { return .point(frame.origin) }
        if name == kAXSizeAttribute { return .size(frame.size) }
        if name == kAXSubroleAttribute { return .text("AXStandardWindow") }
        if name == kAXTitleAttribute { return .text("own fixture \(element)") }
        return nil
    }
    @MainActor private static func waitEntered(_ probe: ReadProbe) async throws {
        let end = ProcessInfo.processInfo.systemUptime + 2
        while !probe.entered && ProcessInfo.processInfo.systemUptime < end { try await Task.sleep(nanoseconds: 1_000_000) }
        precondition(probe.entered, "Detached read did not begin")
    }
    @MainActor static func main() async throws {
        var passed = [String]()
        do {
            let probe = ReadProbe()
            let worker = Task { await accessibilityTextOffMain(pid: 1, frame: frame) { backend(probe) { element, name in
                if name == kAXWindowsAttribute { probe.enter(); _ = probe.continueRead.wait(timeout: .now() + 2); probe.finish() }
                return base(element, name)
            } } }
            try await waitEntered(probe)
            var property = false, hides = 0, unhides = 0, held = true, desktopOwned = true
            let counter = SystemCursorSuppression(backend: CursorCounterBackend(unsupportedReason: nil, ownsConnection: { true },
                setBackground: { property = $0; return true }, property: { property }, hide: { hides += 1 }, unhide: { unhides += 1 }, diagnostic: { ["fake": true] }))
            precondition(counter.activate(.init(epoch: 8, leaseOwnerId: "own-physical-lease", targetId: "own-window"), eligible: { true }))
            let began = ProcessInfo.processInfo.systemUptime
            try completeOwnedInputCleanup(restoreCursor: { counter.restore("release-during-slow-ax") }, releaseHeld: { held = false }, releaseDesktop: { desktopOwned = false })
            let elapsed = ProcessInfo.processInfo.systemUptime - began
            precondition(counter.clear && !held && !desktopOwned && hides == 1 && unhides == 1)
            precondition(!probe.finished && !probe.onMain && elapsed < 0.5, "MainActor release/restore must execute while the injected AX read is still blocked")
            probe.continueRead.signal()
            let value = await worker.value
            precondition(value.contains("own fixture"))
            passed.append("main-actor-release-and-owned-cursor-restoration-during-blocked-ax")
        }
        do {
            let probe = ReadProbe()
            let result = await accessibilityTextOffMain(pid: 1, frame: frame, now: { probe.now }) { backend(probe) { element, name in
                if name == kAXWindowsAttribute { probe.advance(0.4) }
                if name == kAXPositionAttribute { probe.advance(0.5) }
                return base(element, name)
            } }
            precondition(result == "The selected window has no matching accessibility tree.")
            precondition(probe.calls.map { $0.1 } == [kAXWindowsAttribute, kAXPositionAttribute], "Window lookup shares the total budget; late position starts neither size nor another window read")
            precondition(probe.timeouts.allSatisfy { $0 > 0 && $0 <= 0.25 })
            passed.append("window-lookup-and-every-attribute-share-monotonic-budget")
        }
        do {
            let probe = ReadProbe()
            let result = await accessibilityTextOffMain(pid: 1, frame: frame) { backend(probe) { element, name in
                if element == 0 && name == kAXChildrenAttribute { return .elements([1, 2]) }
                if element == 1 && name == kAXSubroleAttribute { return .text("AXSecureTextField") }
                if element == 1 && name == kAXValueAttribute { return .text("PRIVATE_VALUE_MUST_NOT_BE_READ") }
                if element == 2 && name == kAXValueAttribute { return .text("readable\nvalue") }
                return base(element, name)
            } }
            precondition(!probe.calls.contains { $0.0 == 1 && $0.1 == kAXValueAttribute })
            precondition(!result.contains("PRIVATE_VALUE") && result.contains("readable value"))
            passed.append("secure-field-value-remains-unread-and-newlines-remain-flattened")
        }
        do {
            let probe = ReadProbe()
            let result = await accessibilityTextOffMain(pid: 1, frame: frame) { backend(probe) { element, name in
                if element == 0 && name == kAXChildrenAttribute { return .elements([0] + Array(1...100)) }
                if name == kAXTitleAttribute { return .text("node-\(element) " + String(repeating: "x", count: 400)) }
                return base(element, name)
            } }
            precondition(!probe.calls.contains { $0.0 >= 80 }, "Children remain limited to 80, and visited nodes do not recurse")
            precondition(result.count <= 30_000 && result.split(separator: "\n").allSatisfy { $0.count <= 302 })
            passed.append("existing-child-cycle-text-and-output-bounds-retained")
        }
        do {
            let probe = ReadProbe()
            let worker = Task { await accessibilityTextOffMain(pid: 1, frame: frame) { backend(probe) { element, name in
                probe.enter(); _ = probe.continueRead.wait(timeout: .now() + 2); probe.finish(); return base(element, name)
            } } }
            try await waitEntered(probe)
            worker.cancel()
            precondition(!probe.finished, "Cancellation does not pretend that an in-flight AX call has retired")
            probe.continueRead.signal(); _ = await worker.value
            precondition(probe.finished && probe.calls.count == 1, "After cancellation, wait for the in-flight call and start no further AX read")
            passed.append("cancelled-caller-awaits-owned-worker-and-starts-no-next-read")
        }
        do {
            let probe = ReadProbe()
            _ = await accessibilityTextOffMain(pid: 1, frame: frame, budget: 0, now: { 0 }) { backend(probe) { base($0, $1) } }
            precondition(probe.calls.isEmpty && probe.timeouts.isEmpty)
            passed.append("exhausted-budget-starts-no-attribute-call")
        }
        let report: [String: Any] = ["passed": true, "checks": passed, "gui": false, "nativeInput": false, "realAX": false]
        print(String(data: try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), encoding: .utf8)!)
    }
}
