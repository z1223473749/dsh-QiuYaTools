// Synthetic visual-only business task; the AX canvas deliberately exposes no
// nonce, button text, source note, card positions or drag destination.
import AppKit
import Foundation

func visionNoteMatches(_ actual: String, _ expected: String) -> Bool { actual == expected }
func visionSubmissionFeedback(task: Int, submitted: Bool, passed: Bool) -> String? {
    if passed { return "已完成核验 ✓" }
    if task == 2 && submitted { return "校验未通过：请核对文字、标点和空格" }
    return nil
}

final class VisionCanvas: NSView {
    weak var owner: VisionFixture?
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        guard let o = owner else { return }
        NSColor(calibratedRed: 0.06, green: 0.13, blue: 0.18, alpha: 1).setFill(); bounds.fill()
        func label(_ text: String, _ rect: NSRect, _ size: CGFloat = 24) {
            text.draw(in: rect, withAttributes: [.font: NSFont.systemFont(ofSize: size), .foregroundColor: NSColor.white])
        }
        label("订单核验 · \(o.nonce)", NSRect(x: 24, y: 18, width: 610, height: 42), 28)
        if o.task == 1 {
            label("请点击绿色「确认本单」按钮", NSRect(x: 24, y: 80, width: 600, height: 40))
            NSColor.systemGreen.setFill(); NSBezierPath(roundedRect: o.button, xRadius: 12, yRadius: 12).fill()
            label("确认本单", o.button.insetBy(dx: 20, dy: 15), 26)
            NSColor.systemRed.setFill(); NSBezierPath(roundedRect: o.decoy, xRadius: 12, yRadius: 12).fill()
            label("取消订单", o.decoy.insetBy(dx: 20, dy: 15), 26)
        } else if o.task == 2 {
            label("请把以下收货备注逐字输入下方文本框，按 Enter 提交：", NSRect(x: 24, y: 80, width: 610, height: 80), 22)
            label(o.note, NSRect(x: 24, y: 165, width: 620, height: 100), 26)
        } else {
            label("把蓝色订单卡拖入绿色「已核验」框", NSRect(x: 24, y: 80, width: 620, height: 45))
            NSColor.systemGreen.setStroke(); let box = NSBezierPath(roundedRect: o.destination, xRadius: 14, yRadius: 14); box.lineWidth = 5; box.stroke()
            label("已核验", o.destination.insetBy(dx: 25, dy: 42), 26)
            NSColor.systemBlue.setFill(); NSBezierPath(roundedRect: o.card, xRadius: 10, yRadius: 10).fill()
            label("订单 \(o.nonce)", o.card.insetBy(dx: 10, dy: 22), 23)
        }
        if let feedback = visionSubmissionFeedback(task: o.task, submitted: o.submitted, passed: o.passed) {
            label(feedback, NSRect(x: 24, y: 405, width: 630, height: 60), o.passed ? 30 : 24)
        }
    }
    override func mouseDown(with event: NSEvent) {
        guard let o = owner else { return }; let point = convert(event.locationInWindow, from: nil); o.downs += 1
        if o.task == 1 { if o.button.contains(point) { o.passed = true; o.correctClicks += 1 } else { o.wrongClicks += 1 } }
        if o.task == 3 { o.dragging = o.card.contains(point); o.offset = CGPoint(x: point.x - o.card.minX, y: point.y - o.card.minY) }
        needsDisplay = true
    }
    override func mouseDragged(with event: NSEvent) {
        guard let o = owner, o.task == 3, o.dragging else { return }
        let point = convert(event.locationInWindow, from: nil); o.drags += 1
        o.card.origin = CGPoint(x: point.x - o.offset.x, y: point.y - o.offset.y); needsDisplay = true
    }
    override func mouseUp(with event: NSEvent) {
        guard let o = owner else { return }; o.ups += 1
        if o.task == 3 && o.dragging && o.destination.contains(convert(event.locationInWindow, from: nil)) { o.passed = true }
        o.dragging = false; needsDisplay = true
    }
}
final class VisionFixture: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
    let task: Int, nonce: String, note: String, seed: Int
    let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 680, height: 480), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    let canvas = VisionCanvas(), input = NSTextField(string: "")
    var button: NSRect, decoy: NSRect, destination: NSRect, card: NSRect
    var passed = false, correctClicks = 0, wrongClicks = 0, downs = 0, ups = 0, drags = 0, submitted = false, dragging = false, offset = CGPoint.zero
    var activity: NSObjectProtocol?
    init(task: Int, nonce: String, note: String, seed: Int) {
        self.task = task; self.nonce = nonce; self.note = note; self.seed = seed
        let reversed = seed % 2 == 0
        button = NSRect(x: reversed ? 365 : 65, y: CGFloat(175 + seed % 75), width: 230, height: 75)
        decoy = NSRect(x: reversed ? 65 : 365, y: button.minY, width: 230, height: 75)
        destination = NSRect(x: reversed ? 45 : 430, y: 175, width: 180, height: 160)
        card = NSRect(x: reversed ? 420 : 50, y: CGFloat(190 + seed % 45), width: 180, height: 85)
    }
    func send(_ value: [String: Any]) { if let data = try? JSONSerialization.data(withJSONObject: value) { FileHandle.standardOutput.write(data + Data([10])) } }
    func applicationDidFinishLaunching(_ notification: Notification) {
        window.title = "QiuYaTools Visual Business Fixture \(task)"; window.isReleasedWhenClosed = false
        canvas.frame = NSRect(x: 0, y: 0, width: 680, height: 480); canvas.owner = self
        canvas.setAccessibilityElement(true); canvas.setAccessibilityLabel("Disposable visual business canvas. Inspect the screenshot for the task.")
        window.contentView = canvas
        if task == 2 {
            input.frame = NSRect(x: 40, y: 310, width: 595, height: 40); input.font = NSFont.systemFont(ofSize: 22)
            input.delegate = self; input.target = self; input.action = #selector(submit)
            input.setAccessibilityLabel("收货备注输入框"); canvas.addSubview(input)
        }
        let menu = NSMenu(), appItem = NSMenuItem(); appItem.submenu = NSMenu(); menu.addItem(appItem)
        appItem.submenu!.addItem(withTitle: "Quit Fixture", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let edit = NSMenuItem(); edit.submenu = NSMenu(); menu.addItem(edit)
        edit.submenu!.addItem(withTitle: "Select All", action: Selector(("selectAll:")), keyEquivalent: "a"); NSApp.mainMenu = menu
        activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .idleDisplaySleepDisabled], reason: "Bounded synthetic visual business acceptance")
        window.center(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        // Independent fixture lifetime bound if the installing test host stalls.
        DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(240)) { NSApp.terminate(nil) }
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(150)) { self.send(["event": "ready", "pid": getpid(), "windowId": self.window.windowNumber, "bundleId": Bundle.main.bundleIdentifier ?? "", "task": self.task]) }
        DispatchQueue.global().async {
            while let line = readLine() { DispatchQueue.main.async {
                if line == "quit" { NSApp.terminate(nil) }
                else if line.hasPrefix("snapshot "), let requestId = Int(line.dropFirst(9)) { self.send(["event": "snapshot", "requestId": requestId, "passed": self.passed, "task": self.task, "correctClicks": self.correctClicks, "wrongClicks": self.wrongClicks, "mouseDown": self.downs, "mouseUp": self.ups, "dragged": self.drags, "submitted": self.submitted, "textMatches": self.input.stringValue == self.note]) }
            } }
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }
    @objc func submit() { submitted = true; passed = visionNoteMatches(input.stringValue, note); canvas.needsDisplay = true }
    func applicationWillTerminate(_ notification: Notification) { if let activity { ProcessInfo.processInfo.endActivity(activity) } }
}
if CommandLine.arguments.contains("--self-test") {
    let expected = "青山路18号，请轻放，核验码A1B2C3"
    precondition(!visionNoteMatches("青山路 18 号，请轻放，核验码 A1B2C3", expected))
    precondition(visionNoteMatches(expected, expected))
    precondition(visionSubmissionFeedback(task: 2, submitted: false, passed: false) == nil)
    precondition(visionSubmissionFeedback(task: 2, submitted: true, passed: false)?.contains("校验未通过") == true)
    precondition(visionSubmissionFeedback(task: 2, submitted: true, passed: true) == "已完成核验 ✓")
    print("Visual fixture self-test passed: exact whitespace, visible mismatch and success feedback; zero windows and input")
    exit(0)
}
guard let line = readLine(), let data = line.data(using: .utf8), let config = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let task = config["task"] as? Int, (1...3).contains(task), let nonce = config["nonce"] as? String, nonce.count == 6,
      let note = config["note"] as? String, note.count < 150, let seed = config["seed"] as? Int, seed >= 0 else { exit(2) }
let app = NSApplication.shared, fixture = VisionFixture(task: task, nonce: nonce, note: note, seed: seed)
app.delegate = fixture; app.setActivationPolicy(.regular); app.run()
