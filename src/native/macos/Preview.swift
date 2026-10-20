import AppKit
import WebKit
import Foundation

@MainActor final class PreviewPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

@MainActor final class FloatingPreview: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    let window: NSPanel
    let sessionId: String
    let origin: URL
    private var notifyClose = true
    init(url: URL, title: String, sessionId: String) {
        self.origin = url; self.sessionId = sessionId
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: .zero, configuration: configuration)
        window = PreviewPanel(contentRect: NSRect(x: 100, y: 100, width: 640, height: 470),
                         styleMask: [.titled, .closable, .resizable, .miniaturizable, .nonactivatingPanel], backing: .buffered, defer: false)
        super.init()
        window.title = String(title.prefix(160))
        window.level = .floating
        window.hidesOnDeactivate = false
        window.isFloatingPanel = true
        window.isReleasedWhenClosed = false
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.minSize = NSSize(width: 360, height: 260)
        window.contentView = view
        window.delegate = self; view.navigationDelegate = self; view.uiDelegate = self
        window.center(); view.load(URLRequest(url: url)); window.makeKeyAndOrderFront(nil)
    }
    func windowWillClose(_ notification: Notification) {
        if notifyClose { Wire.send(["event": "previewClosed", "sessionId": sessionId]) }
    }
    func close() { notifyClose = false; window.close() }
    /// Keep the preview usable throughout input. A real desktop preview must
    /// move away from the next click/drag rather than intercepting that input or
    /// disabling its own Pause button for the duration of an action.
    func avoidPointerPath(_ points: [CGPoint]) throws {
        guard !points.isEmpty, window.isVisible else { return }
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        func quartz(_ rect: CGRect) -> CGRect { CGRect(x: rect.minX, y: primaryHeight - rect.maxY, width: rect.width, height: rect.height) }
        func blocks(_ rect: CGRect) -> Bool {
            let bounds = quartz(rect).insetBy(dx: -12, dy: -12)
            if points.count == 1 { return bounds.contains(points[0]) }
            let a = points[0], b = points[1], dx = b.x - a.x, dy = b.y - a.y
            var low = 0.0, high = 1.0
            for (p, q) in [(-dx, a.x - bounds.minX), (dx, bounds.maxX - a.x), (-dy, a.y - bounds.minY), (dy, bounds.maxY - a.y)] {
                if p == 0 { if q < 0 { return false }; continue }
                let ratio = q / p
                if p < 0 { low = max(low, ratio) } else { high = min(high, ratio) }
                if low > high { return false }
            }
            return true
        }
        guard blocks(window.frame) else { return }
        // Respect the user's size whenever one display corner has enough room.
        for compact in [false, true] {
            for screen in NSScreen.screens {
                let area = screen.visibleFrame.insetBy(dx: 12, dy: 12)
                let size = compact ? CGSize(width: min(420, area.width), height: min(320, area.height)) : CGSize(width: min(window.frame.width, area.width), height: min(window.frame.height, area.height))
                for corner in [CGPoint(x: area.minX, y: area.maxY - size.height), CGPoint(x: area.maxX - size.width, y: area.maxY - size.height), CGPoint(x: area.minX, y: area.minY), CGPoint(x: area.maxX - size.width, y: area.minY)] {
                    let candidate = CGRect(origin: corner, size: size)
                    if !blocks(candidate) { window.setFrame(candidate, display: true, animate: false); return }
                }
            }
        }
        throw ComputerError("PREVIEW_OVERLAP", "Move or reduce the floating preview so it does not cover the requested pointer path.")
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url,
              url.scheme == origin.scheme, url.host == origin.host, url.port == origin.port,
              url.user == nil, url.password == nil else { decisionHandler(.cancel); return }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
    static func validatedURL(_ raw: Any?) throws -> URL {
        guard let raw = raw as? String, raw.utf8.count <= 16_384, let url = URL(string: raw), url.scheme == "http",
              ["127.0.0.1", "localhost", "[::1]", "::1"].contains(url.host ?? ""),
              let port = url.port, port > 0, port <= 65_535, url.user == nil, url.password == nil else {
            throw ComputerError("INVALID_PREVIEW_URL", "The preview must use an authenticated localhost HTTP URL.")
        }
        return url
    }
}
