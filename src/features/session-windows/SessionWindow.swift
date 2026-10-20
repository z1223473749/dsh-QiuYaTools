// Native auxiliary windows for the plugin. The official app and its installation are untouched.
import AppKit
import WebKit
import Foundation

struct Command: Decodable {
    let op: String
    let requestId: Int
    let sessionId: String
    let storeIdentifier: String?
    let url: String
    let title: String
    let source: String
    let position: Position?
    struct Position: Decodable { let x: Double; let y: Double }
}
func answer(_ id: Int, _ ok: Bool) {
    guard let data = try? JSONSerialization.data(withJSONObject: ["requestId": id, "ok": ok]), var text = String(data: data, encoding: .utf8) else { return }
    text += "\n"
    FileHandle.standardOutput.write(Data(text.utf8))
}

func sessionWindowStoreUUID(_ raw: String?) -> UUID? {
    guard let raw, raw.utf8.count == 36, let identifier = UUID(uuidString: raw),
          identifier.uuidString != "00000000-0000-0000-0000-000000000000" else { return nil }
    return identifier
}

// Pure ownership bookkeeping, shared with the native command lifecycle tests.
struct PreparedSessionWindow {
    private(set) var sessionId: String?
    mutating func replace(with id: String) -> String? {
        let previous = sessionId
        sessionId = id
        return previous == id ? nil : previous
    }
    mutating func reveal(_ id: String) {
        if sessionId == id { sessionId = nil }
    }
    mutating func cancel(_ id: String) -> Bool {
        guard sessionId == id else { return false }
        sessionId = nil
        return true
    }
}

final class SessionWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKScriptMessageHandler, WKUIDelegate {
    // The former shared store remains on disk for recovery; never remove it automatically.
    static let legacySharedStoreIdentifier = UUID(uuidString: "982880DD-DB84-4AE4-970A-414EE7997DE3")!
    let id: String
    let origin: URL
    let window: NSWindow
    let view: WKWebView
    var waiting: [Int] = []
    var ready = false
    var failed = false
    var isPrepared: Bool
    let failureOverlay = NSView(frame: .zero)
    let failureLabel = NSTextField(labelWithString: "")
    let closeFailureButton = NSButton(frame: .zero)
    var timeout: DispatchWorkItem?
    var timeoutGeneration = 0
    var onClose: (() -> Void)?

    init?(_ command: Command, prepare: Bool = false) {
        guard let storeIdentifier = sessionWindowStoreUUID(command.storeIdentifier),
              let url = URL(string: command.url), url.scheme == "http", url.host == "127.0.0.1", let port = url.port,
              port > 0, port <= 65535, url.user == nil, url.password == nil,
              URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "qiuya-session" })?.value == command.sessionId else { return nil }
        id = command.sessionId
        isPrepared = prepare
        origin = url
        let config = WKWebViewConfiguration()
        // Every profile/Session gets its own persistent network and storage
        // session. Shared HTTP pools otherwise stall once long polls occupy them.
        if #available(macOS 14.0, *) {
            config.websiteDataStore = WKWebsiteDataStore(forIdentifier: storeIdentifier)
        } else {
            // Named persistent stores are unavailable on macOS 13. Keep each
            // view independent there rather than returning to a shared pool.
            config.websiteDataStore = WKWebsiteDataStore.nonPersistent()
        }
        if #available(macOS 14.0, *) {
            // Preparation may be hidden or occluded while the main app is in
            // front. Keep its JS and layout work eligible for normal scheduling.
            config.preferences.inactiveSchedulingPolicy = .none
        }
        view = WKWebView(frame: .zero, configuration: config)
        let area = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1280, height: 900)
        let size = NSSize(width: min(1000, area.width), height: min(800, area.height))
        window = NSWindow(contentRect: NSRect(origin: area.origin, size: size), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        super.init()
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: min(600, area.width), height: min(480, area.height))
        window.title = String(command.title.prefix(200)) + " — QiuYaTools"
        let content = NSView(frame: NSRect(origin: .zero, size: size))
        window.contentView = content
        view.translatesAutoresizingMaskIntoConstraints = false
        failureOverlay.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(view)
        content.addSubview(failureOverlay)
        // Normal startup stays in the Web view so Harness owns its loading page.
        failureOverlay.isHidden = true
        failureOverlay.wantsLayer = true
        failureOverlay.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: content.leadingAnchor), view.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            view.topAnchor.constraint(equalTo: content.topAnchor), view.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            failureOverlay.leadingAnchor.constraint(equalTo: content.leadingAnchor), failureOverlay.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            failureOverlay.topAnchor.constraint(equalTo: content.topAnchor), failureOverlay.bottomAnchor.constraint(equalTo: content.bottomAnchor)
        ])
        failureLabel.font = NSFont.systemFont(ofSize: 14)
        failureLabel.textColor = .labelColor
        failureLabel.alignment = .center
        failureLabel.maximumNumberOfLines = 3
        closeFailureButton.title = "关闭窗口"
        closeFailureButton.bezelStyle = .rounded
        closeFailureButton.target = self
        closeFailureButton.action = #selector(closeFailedWindow)
        let failureStack = NSStackView(views: [failureLabel, closeFailureButton])
        failureStack.translatesAutoresizingMaskIntoConstraints = false
        failureStack.orientation = .vertical
        failureStack.alignment = .centerX
        failureStack.spacing = 16
        failureOverlay.addSubview(failureStack)
        NSLayoutConstraint.activate([
            failureStack.centerXAnchor.constraint(equalTo: failureOverlay.centerXAnchor),
            failureStack.centerYAnchor.constraint(equalTo: failureOverlay.centerYAnchor),
            failureStack.widthAnchor.constraint(lessThanOrEqualTo: failureOverlay.widthAnchor, constant: -48)
        ])
        window.delegate = self
        view.navigationDelegate = self
        view.uiDelegate = self
        config.userContentController.add(self, name: "qiuyaSession")
        let encodedSessionId = String(data: try! JSONSerialization.data(withJSONObject: command.sessionId, options: [.fragmentsAllowed]), encoding: .utf8)!
        let boot = """
        window.__QIUYA_SESSION_WINDOW__ = \(encodedSessionId);
        (() => {
            const guard = document.createElement('style');
            guard.dataset.qytSessionWindowBoot = 'true';
            guard.textContent = 'body:not([data-qyt-session-window-state="ready"]) :is(main,[class*="_centerCol"],[data-conversation-session]){visibility:hidden!important;pointer-events:none!important}';
            const install = () => {
                if (!document.documentElement) return false;
                document.documentElement.append(guard);
                return true;
            };
            if (!install()) {
                const observer = new MutationObserver(() => { if (install()) observer.disconnect(); });
                observer.observe(document, { childList: true });
            }
        })();
        """
        config.userContentController.addUserScript(WKUserScript(source: boot, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        waiting = prepare ? [] : [command.requestId]
        if command.source == "drag" { positionNearMouse() } else { window.center() }
        view.load(URLRequest(url: url))
        // Show Harness's own boot page; ack only after the plugin verifies the target Session.
        if !prepare {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        armTimeout()
    }
    func armTimeout() {
        timeout?.cancel()
        timeoutGeneration += 1
        let generation = timeoutGeneration
        let task = DispatchWorkItem { [weak self] in
            guard let self, !self.ready, !self.failed, self.timeoutGeneration == generation else { return }
            self.fail("会话加载超时，请关闭窗口后重试。")
        }
        timeout = task
        DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: task)
    }
    func positionNearMouse() {
        let cursor = NSEvent.mouseLocation
        let area = NSScreen.screens.first(where: { $0.frame.contains(cursor) })?.visibleFrame ?? NSScreen.main!.visibleFrame
        let size = window.frame.size
        window.setFrameOrigin(NSPoint(x: max(area.minX, min(area.maxX - size.width, cursor.x - 80)), y: max(area.minY, min(area.maxY - size.height, cursor.y - size.height + 30))))
    }
    func focus(_ command: Command) {
        if failed { answer(command.requestId, false); return }
        // A drop adopts this exact target view. A later drag cancellation must
        // never close a window which the operator has already made visible.
        isPrepared = false
        if ready { answer(command.requestId, true) } else { waiting.append(command.requestId) }
        if command.source == "drag" { positionNearMouse() }
        window.deminiaturize(nil)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        // Hidden preparation used its own budget. A real open always gets
        // the complete visible loading interval, even after a long drag.
        if !ready { armTimeout() }
    }
    func finish(_ ok: Bool) {
        timeoutGeneration += 1
        timeout?.cancel(); timeout = nil
        if ok {
            ready = true
            failureOverlay.isHidden = true
        }
        let pending = waiting; waiting = []
        for request in pending { answer(request, ok) }
    }
    @objc func closeFailedWindow() { window.close() }
    func fail(_ message: String) {
        guard !failed else { return }
        failed = true
        finish(false)
        view.stopLoading()
        failureLabel.stringValue = message
        failureOverlay.isHidden = false
        window.title = "无法打开会话 — QiuYaTools"
        // Background preparation never surfaces an error or a blank native window.
        if isPrepared { window.close() }
    }
    func windowWillClose(_ notification: Notification) {
        finish(false)
        view.stopLoading()
        view.configuration.userContentController.removeScriptMessageHandler(forName: "qiuyaSession")
        onClose?()
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.host == origin.host,
              message.frameInfo.securityOrigin.port == origin.port,
              let body = message.body as? [String: Any], body["sessionId"] as? String == id else { return }
        if failed { return }
        if body["type"] as? String == "ready" {
            if let title = body["title"] as? String { window.title = String(title.prefix(200)) + " — QiuYaTools" }
            finish(true)
        } else if body["type"] as? String == "unavailable" {
            window.title = "会话不可用 — QiuYaTools"
            if !ready {
                let reason = body["reason"] as? String
                let message = reason == "session-archived"
                    ? "会话已归档，请关闭窗口后在主窗口中查看。"
                    : ["catalog-failed", "session-open-failed"].contains(reason ?? "")
                        ? "会话读取失败，请关闭窗口后重试。"
                        : "会话暂时不可用，请关闭窗口后在主窗口中查看。"
                fail(message)
            }
        }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { fail("会话页面加载失败，请关闭窗口后重试。") }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { fail("会话页面加载失败，请关闭窗口后重试。") }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if navigationAction.targetFrame?.isMainFrame == true {
            if url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port { decisionHandler(.allow); return }
            if ["http", "https", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
            decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, ["http", "https", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        return nil
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel(); panel.allowsMultipleSelection = parameters.allowsMultipleSelection; panel.canChooseDirectories = parameters.allowsDirectories; panel.canChooseFiles = true
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.urls : nil) }
    }
}

final class Application: NSObject, NSApplicationDelegate {
    var windows: [String: SessionWindow] = [:]
    var prepared = PreparedSessionWindow()
    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let appItem = NSMenuItem(); menu.addItem(appItem)
        let appMenu = NSMenu(); appItem.submenu = appMenu
        appMenu.addItem(withTitle: "退出 QiuYaTools 会话窗口", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let fileItem = NSMenuItem(); menu.addItem(fileItem); fileItem.submenu = NSMenu(title: "文件")
        fileItem.submenu!.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        let editItem = NSMenuItem(); menu.addItem(editItem); editItem.submenu = NSMenu(title: "编辑")
        for (title, action, key) in [("撤销", "undo:", "z"), ("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] {
            editItem.submenu!.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        NSApp.mainMenu = menu
        DispatchQueue.global(qos: .userInitiated).async {
            while let line = readLine() {
                guard line.utf8.count <= 16384, let data = line.data(using: .utf8), let command = try? JSONDecoder().decode(Command.self, from: data) else { continue }
                DispatchQueue.main.async { self.receive(command) }
            }
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
        // stdin normally closes with the Host. Also cover an uncleanly orphaned pipe.
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
            if getppid() == 1 { NSApp.terminate(nil) }
        }
    }
    func receive(_ command: Command) {
        guard ["open", "prepare", "cancel"].contains(command.op), !command.sessionId.isEmpty, command.sessionId.utf8.count <= 1024 else { answer(command.requestId, false); return }
        if command.op == "cancel" {
            if prepared.cancel(command.sessionId), let existing = windows[command.sessionId], existing.isPrepared { existing.window.close() }
            answer(command.requestId, true)
            return
        }
        guard sessionWindowStoreUUID(command.storeIdentifier) != nil else { answer(command.requestId, false); return }
        if let existing = windows[command.sessionId] {
            if !existing.failed {
                // Preparing an already-visible same-session window is a no-op.
                if command.op == "prepare" { answer(command.requestId, true); return }
                prepared.reveal(command.sessionId)
                existing.focus(command)
                return
            }
            existing.window.close()
        }
        let prepare = command.op == "prepare"
        if prepare, let previous = prepared.replace(with: command.sessionId), let existing = windows[previous], existing.isPrepared { existing.window.close() }
        guard let window = SessionWindow(command, prepare: prepare) else {
            if prepare { _ = prepared.cancel(command.sessionId) }
            answer(command.requestId, false)
            return
        }
        windows[command.sessionId] = window
        window.onClose = { [weak self] in
            self?.prepared.reveal(command.sessionId)
            self?.windows.removeValue(forKey: command.sessionId)
        }
        // The receipt only means that preparation started. It must not wait
        // for JS readiness, otherwise an Escape cannot cancel a slow boot.
        if prepare { answer(command.requestId, true) }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}
let app = NSApplication.shared
let owner = Application()
app.delegate = owner
app.setActivationPolicy(.regular)
app.run()
