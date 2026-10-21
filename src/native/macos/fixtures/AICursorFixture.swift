import AppKit
import Foundation

/// Disposable application with actual AppKit event receipts. It only activates
/// its own window on an explicit test command and never manufactures input.
@MainActor final class CursorFixture: NSObject, NSApplicationDelegate {
    let secondary = CommandLine.arguments.contains("--secondary")
    var window: NSWindow!
    var canvas: CursorCanvas!
    var counts: [String: Int] = ["downs": 0, "ups": 0, "clicks": 0, "moves": 0, "drags": 0]
    var events: [[String: Any]] = []
    func applicationDidFinishLaunching(_ notification: Notification) {
        let size = secondary ? CGSize(width: 220, height: 140) : CGSize(width: 640, height: 460)
        window = NSWindow(contentRect: CGRect(origin: .zero, size: size), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = secondary ? "QiuYa AI Cursor Secondary Fixture" : "QiuYa AI Cursor Primary Fixture"
        window.isReleasedWhenClosed = false; window.acceptsMouseMovedEvents = true
        let view = CursorCanvas(frame: CGRect(origin: .zero, size: size)); view.fixture = self
        canvas = view; window.contentView = view
        if secondary {
            let area = NSScreen.screens.first?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1000, height: 700)
            window.setFrameOrigin(CGPoint(x: area.minX + 20, y: area.minY + 20)); window.orderFront(nil)
        } else { window.center(); activate() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { self.emit(["event": "ready", "state": self.state()]) }
        DispatchQueue.global().async {
            while let line = readLine() {
                guard line.utf8.count <= 8192, let data = line.data(using: .utf8), let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                DispatchQueue.main.async {
                    let id = command["requestId"] as Any? ?? NSNull()
                    switch command["op"] as? String {
                    case "snapshot": self.emit(["requestId": id, "ok": true, "result": self.state()])
                    case "activate": self.activate(); self.emit(["requestId": id, "ok": true, "result": self.state()])
                    case "hide": self.window.orderOut(nil); self.emit(["requestId": id, "ok": true, "result": self.state()])
                    case "show": self.window.orderFront(nil); self.emit(["requestId": id, "ok": true, "result": self.state()])
                    case "quit": self.emit(["requestId": id, "ok": true]); NSApp.terminate(nil)
                    default: self.emit(["requestId": id, "ok": false, "error": "unsupported-fixture-operation"])
                    }
                }
            }
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }
    func activate() { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    func receipt(_ kind: String, _ event: NSEvent) {
        counts[kind, default: 0] += 1
        if kind == "ups" { counts["clicks", default: 0] += 1 }
        let global = event.cgEvent?.location ?? .zero
        events.append(["kind": kind, "x": global.x, "y": global.y, "sourcePid": event.cgEvent?.getIntegerValueField(.eventSourceUnixProcessID) ?? -1,
            "atNs": String(DispatchTime.now().uptimeNanoseconds)])
        if events.count > 300 { events.removeFirst(events.count - 300) }
    }
    func state() -> [String: Any] {
        let p = window.convertPoint(toScreen: CGPoint(x: canvas.bounds.midX, y: canvas.bounds.midY))
        return ["pid": getpid(), "windowId": window.windowNumber, "title": window.title,
            "bundleId": Bundle.main.bundleIdentifier ?? "", "visible": window.isVisible, "counts": counts, "events": events,
            "point": ["x": p.x, "y": (NSScreen.screens.first?.frame.height ?? 0) - p.y]]
    }
    func emit(_ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: .sortedKeys) else { return }
        FileHandle.standardOutput.write(data + Data([10]))
    }
}
@MainActor final class CursorCanvas: NSView {
    weak var fixture: CursorFixture?
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        NSColor(srgbRed: 0.045, green: 0.045, blue: 0.045, alpha: 1).setFill(); bounds.fill()
        let caption = "Disposable AI pointer fixture"
        caption.draw(at: CGPoint(x: 20, y: bounds.height - 40), withAttributes: [.font: NSFont.systemFont(ofSize: 17), .foregroundColor: NSColor.white])
        // The central area stays flat black, so arrow fill/outline pixel
        // evidence cannot be supplied by text or another grey UI component.
        NSColor.systemRed.setFill(); CGRect(x: 8, y: 8, width: 8, height: 8).fill()
        NSColor.systemBlue.setFill(); CGRect(x: 8, y: bounds.height - 16, width: 8, height: 8).fill()
    }
    override func mouseDown(with event: NSEvent) { fixture?.receipt("downs", event) }
    override func mouseUp(with event: NSEvent) { fixture?.receipt("ups", event) }
    override func mouseMoved(with event: NSEvent) { fixture?.receipt("moves", event) }
    override func mouseDragged(with event: NSEvent) { fixture?.receipt("drags", event) }
}
MainActor.assumeIsolated {
    let app = NSApplication.shared, delegate = CursorFixture()
    app.setActivationPolicy(.regular); app.delegate = delegate; app.run()
}
