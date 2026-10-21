import AppKit
import Foundation

/// An isolated, disposable application. E2E actions must target this PID only.
final class Fixture: NSObject, NSApplicationDelegate {
    let window = NSWindow(contentRect: NSRect(x: 150, y: 150, width: 640, height: 480), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    let button = NSButton(title: "Fixture click", target: nil, action: nil)
    let textField = NSTextField(string: "")
    let label = NSTextField(labelWithString: "QiuYaTools controlled computer-use fixture")
    var counts: [String: Int] = ["clicks": 0, "mouseDown": 0, "mouseUp": 0, "dragged": 0, "keys": 0, "scrolls": 0, "moves": 0]
    var monitor: Any?
    func send(_ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
        FileHandle.standardOutput.write(data + Data([10]))
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let appItem = NSMenuItem(); appItem.submenu = NSMenu(); menu.addItem(appItem)
        appItem.submenu!.addItem(withTitle: "Quit Fixture", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let editItem = NSMenuItem(); editItem.submenu = NSMenu(title: "Edit"); menu.addItem(editItem)
        for (title, action, key) in [("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            editItem.submenu!.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        NSApp.mainMenu = menu
        window.title = "QiuYaTools Computer E2E Fixture"
        window.isReleasedWhenClosed = false
        button.frame = NSRect(x: 40, y: 350, width: 180, height: 42); button.bezelStyle = .rounded
        button.target = self; button.action = #selector(clicked)
        button.setAccessibilityIdentifier("qiuya-e2e-click")
        textField.frame = NSRect(x: 40, y: 270, width: 500, height: 32)
        textField.placeholderString = "Disposable test text only"; textField.setAccessibilityIdentifier("qiuya-e2e-text")
        label.frame = NSRect(x: 40, y: 410, width: 550, height: 24)
        window.contentView!.addSubview(label); window.contentView!.addSubview(button); window.contentView!.addSubview(textField)
        window.acceptsMouseMovedEvents = true; window.center()
        if CommandLine.arguments.contains("--defer-activation") { window.orderFront(nil) }
        else { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseUp, .leftMouseDragged, .keyDown, .scrollWheel, .mouseMoved]) { event in
            let key: String
            switch event.type { case .leftMouseDown: key = "mouseDown"; case .leftMouseUp: key = "mouseUp"; case .leftMouseDragged: key = "dragged"; case .keyDown: key = "keys"; case .scrollWheel: key = "scrolls"; default: key = "moves" }
            self.counts[key, default: 0] += 1
            return event
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { self.snapshot("ready") }
        DispatchQueue.global().async {
            while let line = readLine() { DispatchQueue.main.async {
                if line == "quit" { NSApp.terminate(nil) }
                else if line.hasPrefix("preview-click "), let pid = Int32(line.dropFirst(14)) { self.clickPreview(pid) }
                else { self.snapshot("snapshot") }
            } }
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }
    @objc func clicked() { counts["clicks", default: 0] += 1 }
    func clickPreview(_ pid: pid_t) {
        guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
              let window = windows.first(where: { ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid && ($0[kCGWindowName as String] as? String) == "QiuYa E2E Preview" }),
              let bounds = window[kCGWindowBounds as String] as? [String: Any], let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { send(["event": "preview-click-failed"]); return }
        // Test-only injection into our own helper's local fixture page.
        let point = CGPoint(x: frame.minX + 70, y: frame.minY + 66)
        CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
        CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
        send(["event": "preview-clicked"])
    }
    func point(_ view: NSView) -> [String: Double] {
        let local = view.convert(NSPoint(x: view.bounds.midX, y: view.bounds.midY), to: nil)
        let global = window.convertPoint(toScreen: local)
        return ["x": global.x, "y": (NSScreen.screens.first?.frame.height ?? 0) - global.y]
    }
    func snapshot(_ event: String) {
        send(["event": event, "pid": getpid(), "counts": counts, "text": textField.stringValue,
              "points": ["button": point(button), "text": point(textField), "canvas": ["x": point(textField)["x"]!, "y": point(textField)["y"]! + 140]]])
    }
    func applicationWillTerminate(_ notification: Notification) { if let monitor { NSEvent.removeMonitor(monitor) } }
}
let app = NSApplication.shared
let delegate = Fixture()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
