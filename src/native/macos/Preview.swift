import AppKit
import WebKit
import Foundation

@MainActor final class PreviewPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}
@MainActor final class PreviewWebView: WKWebView {
    // Pause/takeover must work on the first click while another app is active.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

@MainActor final class FloatingPreview: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    let window: NSPanel
    let sessionId: String
    let origin: URL
    private let destination: URL
    private let webView: PreviewWebView
    private var bootstrapping: Bool
    private(set) var navigationState: [String: Any] = [:]
    private var notifyClose = true
    private var closeAttempt: UUID?
    init(url: URL, title: String, sessionId: String) {
        self.origin = url; self.sessionId = sessionId
        let navigation = Self.navigationURLs(url)
        self.destination = navigation.destination
        self.bootstrapping = navigation.initial != navigation.destination
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let view = PreviewWebView(frame: .zero, configuration: configuration)
        webView = view
        window = PreviewPanel(contentRect: NSRect(x: 100, y: 100, width: 640, height: 470),
                         styleMask: [.titled, .closable, .resizable, .miniaturizable, .nonactivatingPanel], backing: .buffered, defer: false)
        super.init()
        navigationState = ["stage": bootstrapping ? "bootstrap" : "destination", "path": navigation.initial.path]
        window.title = String(title.prefix(160))
        window.level = .floating
        window.hidesOnDeactivate = false
        window.isFloatingPanel = true
        window.isReleasedWhenClosed = false
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.minSize = NSSize(width: 360, height: 260)
        window.contentView = view
        window.delegate = self; view.navigationDelegate = self; view.uiDelegate = self
        window.center(); view.load(URLRequest(url: navigation.initial)); window.makeKeyAndOrderFront(nil)
    }
    func windowWillClose(_ notification: Notification) {
        if notifyClose { Wire.send(["event": "previewClosed", "sessionId": sessionId]) }
    }
    func close(notify: Bool = false) { notifyClose = notify; window.close() }
    /// Returning to the chat preview is an explicit owner action. Do not let the
    /// destination page's pagehide handler interpret it as a session stop.
    func closePreservingSession() async throws {
        guard window.isVisible, !bootstrapping, Self.isDestination(webView.url, destination), closeAttempt == nil else {
            throw ComputerError("PREVIEW_NOT_READY", "Wait for this preview to load before returning it to chat.")
        }
        let attempt = UUID(); closeAttempt = attempt
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            webView.evaluateJavaScript("window.__qytPreserveSessionOnClose = true; true") { [weak self] value, error in
                guard let self, self.closeAttempt == attempt else { return }
                self.closeAttempt = nil
                guard error == nil, (value as? Bool) == true, Self.isDestination(self.webView.url, self.destination), self.window.isVisible else {
                    continuation.resume(throwing: ComputerError("PREVIEW_CLOSE_FAILED", "The preview could not confirm returning to chat.")); return
                }
                self.close()
                continuation.resume()
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                guard let self, self.closeAttempt == attempt else { return }
                self.closeAttempt = nil
                continuation.resume(throwing: ComputerError("PREVIEW_CLOSE_TIMEOUT", "The preview did not confirm returning to chat in time."))
            }
        }
    }
    static func isDestination(_ current: URL?, _ destination: URL) -> Bool {
        guard let current, var a = URLComponents(url: current, resolvingAgainstBaseURL: false),
              var b = URLComponents(url: destination, resolvingAgainstBaseURL: false) else { return false }
        a.fragment = nil; b.fragment = nil
        return a == b
    }
    static func preservesSession(_ value: Any?) throws -> Bool {
        guard let value else { return false }
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
            throw ComputerError("INVALID_ACTION", "preserveSession must be a boolean.")
        }
        return number.boolValue
    }
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
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        navigationState["finishedPath"] = webView.url?.path ?? ""
        webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
            self?.navigationState["cookieCount"] = cookies.count
        }
        continueAfterBootstrap(webView)
    }
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        // The full Harness root may wait on asynchronous Client module startup
        // before didFinish. The committed clean-root document already owns the
        // exchanged cookie; leave immediately instead of booting another UI.
        continueAfterBootstrap(webView)
    }
    private func continueAfterBootstrap(_ webView: WKWebView) {
        guard bootstrapping, let url = webView.url, url.path == "/",
              URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.contains(where: { $0.name == "token" }) != true else { return }
        // Harness exchanges its launch token only on the root index. Its 303
        // strips the token and installs an owner cookie in this private store;
        // API preview routes then use that cookie, never a query credential.
        bootstrapping = false
        navigationState["stage"] = "destination"
        // Keep a same-origin document initiator for Harness's SameSite=Strict
        // cookie. A second native load is treated as a new external navigation
        // by WebKit and can omit that cookie from the API request.
        guard let data = try? JSONSerialization.data(withJSONObject: destination.absoluteString, options: [.fragmentsAllowed]),
              let literal = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.location.replace(\(literal))", completionHandler: nil)
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if navigationResponse.isForMainFrame, let response = navigationResponse.response as? HTTPURLResponse {
            navigationState["path"] = response.url?.path ?? ""
            navigationState["httpStatus"] = response.statusCode
        }
        decisionHandler(.allow)
    }
    static func navigationURLs(_ url: URL) -> (initial: URL, destination: URL) {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let token = components.queryItems?.first(where: { $0.name == "token" }) else { return (url, url) }
        components.queryItems = components.queryItems?.filter { $0.name != "token" }
        let destination = components.url ?? url
        components.path = "/"; components.queryItems = [token]; components.fragment = nil
        return (components.url ?? url, destination)
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
