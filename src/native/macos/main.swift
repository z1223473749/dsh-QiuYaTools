import AppKit
import ApplicationServices
import Foundation
import ScreenCaptureKit

@MainActor final class ComputerApplication: NSObject, NSApplicationDelegate {
    private let capture = WindowCapture()
    private let input = NativeInput()
    private var preview: FloatingPreview?
    private var geometries: [String: FrameGeometry] = [:]
    private var observationBusy = false
    private var lastObservedAt = Date.distantPast
    private var closing = false
    private var globalInputMonitor: Any?
    private var localInputMonitor: Any?
    private var signalSources: [DispatchSourceSignal] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        input.prepareFocus = { [weak self] in self?.preview?.window.resignKey() }
        input.preparePointerRegion = { [weak self] points in try self?.preview?.avoidPointerPath(points) }
        let events: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .otherMouseDown, .keyDown]
        globalInputMonitor = NSEvent.addGlobalMonitorForEvents(matching: events) { [weak self] event in self?.humanInput(event) }
        localInputMonitor = NSEvent.addLocalMonitorForEvents(matching: events) { [weak self] event in self?.humanInput(event); return event }
        for code in [SIGTERM, SIGINT] {
            signal(code, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: code, queue: .main)
            source.setEventHandler { [weak self] in self?.shutdown() }
            source.resume(); signalSources.append(source)
        }
        // No permission-request APIs are called here. Status is a pure preflight.
        DispatchQueue.global(qos: .userInitiated).async {
            while let line = readLine() {
                guard line.utf8.count <= 2_000_000, let data = line.data(using: .utf8),
                      let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                DispatchQueue.main.async { self.receive(command) }
            }
            DispatchQueue.main.async { self.shutdown() }
        }
        let expectedParent = ProcessInfo.processInfo.environment["QIUYA_TOOLS_PARENT_PID"].flatMap(Int32.init)
        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
            if getppid() == 1 || expectedParent.map({ getppid() != $0 || kill($0, 0) != 0 }) == true {
                Task { @MainActor in self.shutdown() }
            }
            Task { @MainActor in
                // A stopped session no longer polls frames. Release the recording
                // stream after a short idle grace instead of recording forever.
                if !self.observationBusy, self.lastObservedAt.timeIntervalSinceNow < -3 {
                    self.lastObservedAt = Date()
                    await self.capture.stop()
                }
            }
        }
    }

    private func humanInput(_ event: NSEvent) {
        guard let epoch = input.fence.active, let cgEvent = event.cgEvent,
              cgEvent.getIntegerValueField(.eventSourceUnixProcessID) != Int64(getpid()) else { return }
        let escape = event.type == .keyDown && event.keyCode == 53
        let previewPointer: Bool
        if event.type != .keyDown, input.busy, let panel = preview?.window, panel.isVisible {
            let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
            let rect = CGRect(x: panel.frame.minX, y: primaryHeight - panel.frame.maxY, width: panel.frame.width, height: panel.frame.height)
            previewPointer = rect.contains(cgEvent.location)
        } else { previewPointer = false }
        guard escape || previewPointer else { return }
        // A drag captures further mouse events for its original window, so a
        // human's click on Pause may not reach WebKit. Revoke at the native event
        // boundary as well; the Host mirrors this event to its paused state.
        input.release(epoch)
        var event: [String: Any] = ["event": "humanInput", "reason": escape ? "escape" : "preview-pointer", "epoch": epoch]
        if let sessionId = preview?.sessionId { event["sessionId"] = sessionId }
        Wire.send(event)
    }

    func receive(_ command: [String: Any]) {
        guard !closing, let requestId = requestIdentifier(command["requestId"]), let op = command["op"] as? String else { return }
        // Revocations run before asynchronous work, rather than queueing behind a
        // capture or drag. Every individual injected event checks this state.
        if op == "lease" || op == "release" {
            guard let epoch = integer(command["epoch"]) else { Wire.failure(requestId, ComputerError("INVALID_EPOCH", "A nonnegative safe integer epoch is required.")); return }
            do {
                if op == "lease" { try input.lease(epoch) } else { input.release(epoch) }
                Wire.success(requestId, ["epoch": epoch, "active": input.fence.active == epoch])
            } catch { Wire.failure(requestId, error) }
            return
        }
        if op == "status" {
            Wire.success(requestId, ["platform": "darwin", "available": true, "protocolVersion": 1,
                "permissions": ["screenRecording": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted(),
                                "postEvents": CGPreflightPostEventAccess(), "inputMonitoring": CGPreflightListenEventAccess()],
                "capabilities": ["window-targets", "window-capture", "accessibility-text", "mouse", "keyboard", "floating-preview", "epoch-fencing"],
                "leaseEpoch": input.fence.active as Any? ?? NSNull(), "inputState": input.inputState])
            return
        }
        if op == "closePreview" {
            preview?.close(); preview = nil
            Wire.success(requestId); return
        }
        if op == "openPreview" {
            do {
                let url = try FloatingPreview.validatedURL(command["url"])
                guard let sessionId = command["sessionId"] as? String, !sessionId.isEmpty, sessionId.utf8.count <= 1024 else { throw ComputerError("INVALID_SESSION", "A bounded session identifier is required.") }
                preview?.close()
                preview = FloatingPreview(url: url, title: command["title"] as? String ?? "QiuYaTools Computer", sessionId: sessionId)
                Wire.success(requestId, ["sessionId": sessionId])
            } catch { Wire.failure(requestId, error) }
            return
        }
        Task { @MainActor in
            do {
                switch op {
                case "targets": Wire.success(requestId, ["targets": try capture.targets().map { $0.json }])
                case "observe":
                    guard !observationBusy else { throw ComputerError("CAPTURE_BUSY", "Another frame is being prepared.") }
                    guard let id = command["targetId"] as? String else { throw ComputerError("INVALID_TARGET", "A target identifier is required.") }
                    observationBusy = true; defer { observationBusy = false }
                    let (target, window) = try await capture.resolve(id)
                    let (frame, generation) = try await capture.observe(target, window: window)
                    lastObservedAt = Date()
                    let geometry = FrameGeometry(frame: target.frame, pixelWidth: frame.width, pixelHeight: frame.height)
                    geometries = [id: geometry]
                    let cursor = CGEvent(source: nil)?.location ?? CGPoint(x: -1, y: -1)
                    let localX = (cursor.x - target.frame.minX) * Double(frame.width) / target.frame.width
                    let localY = (cursor.y - target.frame.minY) * Double(frame.height) / target.frame.height
                    Wire.success(requestId, ["targetId": id, "frameId": "\(generation):\(frame.sequence)", "imageBase64": frame.jpeg.base64EncodedString(),
                        "mediaType": "image/jpeg", "width": frame.width, "height": frame.height,
                        "elements": command["preview"] as? Bool == true || command["includeElements"] as? Bool == false ? "" : accessibilityText(target),
                        "geometry": ["x": target.frame.minX, "y": target.frame.minY, "width": target.frame.width, "height": target.frame.height,
                                     "scale": target.scale],
                        "cursor": ["x": localX, "y": localY, "visible": target.frame.contains(cursor)]])
                case "act":
                    guard let epoch = integer(command["epoch"]), let id = command["targetId"] as? String,
                          let action = command["action"] as? [String: Any] else { throw ComputerError("INVALID_ACTION", "epoch, targetId and action are required.") }
                    try input.fence.check(epoch)
                    guard let geometry = geometries[id] else { throw ComputerError("OBSERVATION_REQUIRED", "Observe this window before sending input.") }
                    let (target, _) = try await capture.resolve(id)
                    Wire.success(requestId, try await input.act(epoch: epoch, target: target, geometry: geometry, action: action))
                default: throw ComputerError("UNKNOWN_OPERATION", "Unsupported native operation.")
                }
            } catch { Wire.failure(requestId, error) }
        }
    }

    func shutdown() {
        guard !closing else { return }
        closing = true
        if let globalInputMonitor { NSEvent.removeMonitor(globalInputMonitor) }
        if let localInputMonitor { NSEvent.removeMonitor(localInputMonitor) }
        globalInputMonitor = nil; localInputMonitor = nil
        if let epoch = input.fence.active { input.release(epoch) }
        input.releaseHeldInput(); preview?.close(); preview = nil
        Task { @MainActor in await capture.stop(); NSApp.terminate(nil) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { NSApp.terminate(nil) }
    }
    func applicationWillTerminate(_ notification: Notification) { input.releaseHeldInput() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

MainActor.assumeIsolated {
    let application = NSApplication.shared
    let delegate = ComputerApplication()
    application.delegate = delegate
    application.setActivationPolicy(.accessory)
    application.run()
}
