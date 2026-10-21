import AppKit
import ApplicationServices
import Foundation

@MainActor private final class OperationBadgePanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}
@MainActor private final class OperationBadgeView: NSView {
    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func draw(_ dirtyRect: NSRect) {
        let capsule = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.75, dy: 0.75), xRadius: 15, yRadius: 15)
        NSColor(srgbRed: 0.025, green: 0.17, blue: 0.20, alpha: 0.95).setFill(); capsule.fill()
        NSColor(srgbRed: 0.25, green: 0.83, blue: 0.88, alpha: 0.75).setStroke(); capsule.lineWidth = 1; capsule.stroke()
        let cyan = NSColor(srgbRed: 0.32, green: 0.90, blue: 0.93, alpha: 1)
        let screen = NSBezierPath(roundedRect: CGRect(x: 11, y: 7, width: 18, height: 14), xRadius: 3, yRadius: 3)
        cyan.setStroke(); screen.lineWidth = 1.2; screen.stroke()
        "Q".draw(at: CGPoint(x: 16, y: 7.8), withAttributes: [.font: NSFont.systemFont(ofSize: 10, weight: .semibold), .foregroundColor: cyan])
        let stand = NSBezierPath(); stand.move(to: CGPoint(x: 17, y: 24)); stand.line(to: CGPoint(x: 23, y: 24)); stand.move(to: CGPoint(x: 20, y: 21)); stand.line(to: CGPoint(x: 20, y: 24)); stand.lineWidth = 1.1; stand.stroke()
        "AI 操作中".draw(at: CGPoint(x: 39, y: 7), withAttributes: [.font: NSFont.systemFont(ofSize: 12, weight: .medium), .foregroundColor: NSColor(srgbRed: 0.88, green: 0.99, blue: 1, alpha: 1)])
    }
}

/// Independent operation receipt, not part of the approved pointer glyph.
/// It never owns focus, hit tests, system cursor state or injected input.
@MainActor struct OperationBadgeBackend {
    let eligible: (NativeTarget) -> Bool
    let present: (CGRect) -> Bool
    let hide: () -> Void
}
@MainActor final class AIOperationBadge {
    private static var ownedWindows = Set<CGWindowID>()
    private var panel: OperationBadgePanel?
    private var timer: Timer?
    private var target: NativeTarget?
    private var epoch: Int?
    private var leaseEpoch: Int?
    private var interruptedEpoch: Int?
    private var observers: [NSObjectProtocol] = []
    private let testBackend: OperationBadgeBackend?
    private var testVisible = false
    var isLeaseCurrent: ((Int) -> Bool)?
    init(backend: OperationBadgeBackend? = nil) { testBackend = backend }
    static func ownsWindow(_ id: CGWindowID) -> Bool { ownedWindows.contains(id) }
    static func frame(target: CGRect) -> CGRect? {
        // Keep entirely below the traffic lights/title buttons and inside the
        // authorized target. Tiny windows omit the optional visual receipt.
        guard target.width >= 176, target.height >= 92 else { return nil }
        return CGRect(x: target.maxX - 158, y: target.minY + 40, width: 146, height: 30)
    }
    func beginLease(_ value: Int) { leaseEpoch = value; if interruptedEpoch != value { interruptedEpoch = nil }; hide() }
    func interrupt(_ value: Int) {
        guard leaseEpoch == value else { return }
        interruptedEpoch = value; hide(epoch: value)
    }
    func posted(epoch: Int, target: NativeTarget) {
        guard leaseEpoch == epoch, interruptedEpoch != epoch, isLeaseCurrent?(epoch) == true else { return }
        self.epoch = epoch; self.target = target
        if timer == nil {
            let watchedEpoch = epoch
            let source = Timer(timeInterval: 1 / 30, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.refresh() } }
            timer = source; RunLoop.main.add(source, forMode: .common)
            let notifications = testBackend == nil ? [NSWorkspace.willSleepNotification, NSWorkspace.screensDidSleepNotification, NSWorkspace.sessionDidResignActiveNotification,
                         NSWorkspace.didActivateApplicationNotification, NSWorkspace.didTerminateApplicationNotification, NSWorkspace.activeSpaceDidChangeNotification] : []
            for name in notifications {
                observers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in MainActor.assumeIsolated {
                    guard let self, self.epoch == watchedEpoch else { return }
                    if [NSWorkspace.willSleepNotification, NSWorkspace.screensDidSleepNotification, NSWorkspace.sessionDidResignActiveNotification].contains(name) { self.interrupt(watchedEpoch) }
                    else { self.refresh() }
                } })
            }
        }
        refresh()
    }
    func hide(epoch expected: Int? = nil) {
        if let expected, let epoch, expected != epoch { return }
        timer?.invalidate(); timer = nil; target = nil; epoch = nil
        testBackend?.hide(); testVisible = false
        for observer in observers { NSWorkspace.shared.notificationCenter.removeObserver(observer) }; observers.removeAll()
        if let panel { Self.ownedWindows.remove(CGWindowID(panel.windowNumber)); panel.orderOut(nil); panel.close() }
        panel = nil
    }
    var snapshot: [String: Any] {
        refresh()
        return ["visible": testBackend == nil ? panel?.isVisible == true : testVisible, "actor": "ai", "text": "AI 操作中", "targetId": target?.id as Any? ?? NSNull(), "epoch": epoch as Any? ?? NSNull()]
    }
    private func refresh() {
        guard let epoch, let target else { return }
        guard interruptedEpoch != epoch, isLeaseCurrent?(epoch) == true else { hide(); return }
        if let testBackend {
            guard testBackend.eligible(target), let frame = Self.frame(target: target.frame) else { hide(); return }
            testVisible = testBackend.present(frame); return
        }
        guard
              let session = CGSessionCopyCurrentDictionary() as? [String: Any], session[kCGSessionOnConsoleKey as String] as? Bool == true,
              session["CGSSessionScreenIsLocked"] as? Bool != true,
              (session[kCGSessionUserIDKey as String] as? NSNumber)?.uint32Value == getuid(),
              NSWorkspace.shared.frontmostApplication?.processIdentifier == target.pid,
              let windows = CGWindowListCopyWindowInfo(.optionIncludingWindow, target.windowId) as? [[String: Any]],
              let window = windows.first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == target.windowId }),
              (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == target.pid,
              window[kCGWindowIsOnscreen as String] as? Bool == true,
              let bounds = window[kCGWindowBounds as String] as? [String: Any], let actual = CGRect(dictionaryRepresentation: bounds as CFDictionary),
              actual == target.frame, let frame = Self.frame(target: actual) else { hide(); return }
        if panel == nil {
            let value = OperationBadgePanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            value.title = "QiuYaTools AI operation"; value.animationBehavior = .none; value.isOpaque = false; value.backgroundColor = .clear; value.hasShadow = false
            value.ignoresMouseEvents = true; value.hidesOnDeactivate = false; value.isReleasedWhenClosed = false
            value.isFloatingPanel = true; value.level = .floating; value.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
            value.contentView = OperationBadgeView(frame: CGRect(origin: .zero, size: frame.size)); value.setAccessibilityElement(false)
            panel = value; Self.ownedWindows.insert(CGWindowID(value.windowNumber))
        }
        let height = NSScreen.screens.first?.frame.height ?? 0
        panel?.setFrame(CGRect(x: frame.minX, y: height - frame.maxY, width: frame.width, height: frame.height), display: true)
        panel?.orderFrontRegardless()
    }
}
