import AppKit

// Dedicated animation contains a machine-readable source timestamp. No private
// windows or clipboard are captured by the endurance test.
final class ClockCanvas: NSView {
    private(set) var drawStamp: UInt32 = 0
    private(set) var drawnAtMs: UInt64 = 0
    private(set) var drawCount: UInt64 = 0
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        NSColor(calibratedRed: 0.05, green: 0.18, blue: 0.23, alpha: 1).setFill(); bounds.fill()
        let stamp = UInt32(truncatingIfNeeded: UInt64(Date().timeIntervalSince1970 * 1000))
        for bit in 0..<32 {
            ((stamp & (1 << bit)) == 0 ? NSColor.black : NSColor.white).setFill()
            NSRect(x: 20 + bit * 16, y: 20, width: 16, height: 24).fill()
        }
        let text = "QiuYaTools native endurance fixture\nSource: \(stamp)\nOnly this disposable window is recorded."
        text.draw(in: NSRect(x: 20, y: 80, width: 600, height: 200), withAttributes: [.font: NSFont.systemFont(ofSize: 22), .foregroundColor: NSColor.white])
        drawStamp = stamp
        drawnAtMs = UInt64(Date().timeIntervalSince1970 * 1000)
        drawCount += 1
    }
}
final class SoakApp: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var timer: Timer?
    var activity: NSObjectProtocol?
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 640, height: 360), styleMask: [.borderless], backing: .buffered, defer: false)
        window.title = "QiuYaTools native endurance fixture"
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        // The test measures a live display surface. Prevent display-idle sleep only
        // for this fixture's lifetime; allowing it makes the source freeze even
        // while the timer and ScreenCaptureKit polling remain alive.
        activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .idleDisplaySleepDisabled, .latencyCritical], reason: "Disposable capture endurance fixture requires an awake display")
        let canvas = ClockCanvas(frame: NSRect(x: 0, y: 0, width: 640, height: 360))
        window.contentView = canvas; window.orderFrontRegardless()
        var ticks = 0
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { _ in
            let requestedAt = UInt64(Date().timeIntervalSince1970 * 1000)
            canvas.needsDisplay = true; canvas.display()
            let displayedStamp = canvas.drawStamp
            ticks += 1
            if ticks % 30 == 0 {
                // The draw/return timestamps are diagnostic evidence, not an
                // assertion that WindowServer/SCK delivered this frame.
                let sample: [String: Any] = ["tick": ticks, "requestedAtMs": requestedAt, "drawStamp": canvas.drawStamp,
                    "drawnAtMs": canvas.drawnAtMs, "drawCount": canvas.drawCount, "displayReturnedDrawStamp": displayedStamp,
                    "windowVisible": self.window.isVisible, "occluded": !self.window.occlusionState.contains(.visible),
                    "windowNumber": self.window.windowNumber, "preventsIdleDisplaySleep": self.activity != nil]
                if let bytes = try? JSONSerialization.data(withJSONObject: sample), let json = String(data: bytes, encoding: .utf8) { print(json); fflush(stdout) }
            }
        }
        print("{\"ready\":true}"); fflush(stdout)
        DispatchQueue.global().async { while let line = readLine() { if line == "quit" { break }; if line == "show" { DispatchQueue.main.async { self.window.orderFrontRegardless() } } }; DispatchQueue.main.async { NSApp.terminate(nil) } }
    }
    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
        if let activity { ProcessInfo.processInfo.endActivity(activity); self.activity = nil }
    }
}
let app = NSApplication.shared
let delegate = SoakApp(); app.delegate = delegate; app.setActivationPolicy(.accessory); app.run()
