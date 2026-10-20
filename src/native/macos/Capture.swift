import AppKit
import ScreenCaptureKit
import CoreImage
import CoreMedia
import Foundation

struct CapturedFrame {
    let sequence: Int
    let jpeg: Data
    let width: Int
    let height: Int
}

/// Keep only the newest frame. Preview polling never accumulates encoded frames.
final class FrameReceiver: NSObject, SCStreamOutput, SCStreamDelegate {
    private let lock = NSLock()
    private let context = CIContext(options: [.cacheIntermediates: false])
    private var latest: CapturedFrame?
    private var sequence = 0
    private var stopped = false
    func stream(_ stream: SCStream, didStopWithError error: Error) { lock.lock(); stopped = true; lock.unlock() }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let statusRaw = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: statusRaw) == .complete,
              let pixelBuffer = sampleBuffer.imageBuffer else { return }
        autoreleasepool {
            let image = CIImage(cvPixelBuffer: pixelBuffer)
            guard let cgImage = context.createCGImage(image, from: image.extent) else { return }
            let bitmap = NSBitmapImageRep(cgImage: cgImage)
            guard let jpeg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.72]) else { return }
            lock.lock(); defer { lock.unlock() }
            sequence += 1
            latest = CapturedFrame(sequence: sequence, jpeg: jpeg, width: cgImage.width, height: cgImage.height)
        }
    }
    func snapshot() throws -> CapturedFrame? {
        lock.lock(); defer { lock.unlock() }
        if stopped { throw ComputerError("CAPTURE_STOPPED", "The capture stream stopped. Select the window again.") }
        return latest
    }
}

@MainActor final class WindowCapture {
    private var stream: SCStream?
    private var receiver: FrameReceiver?
    private var identity: String?
    private var frame: CGRect?
    private var generation = 0
    private var shareableWindows: [CGWindowID: SCWindow] = [:]
    private let outputQueue = DispatchQueue(label: "com.qiuya.tools.computer-use.capture", qos: .userInitiated)

    func targets() throws -> [NativeTarget] {
        guard CGPreflightScreenCaptureAccess() else { throw ComputerError("SCREEN_RECORDING_REQUIRED", "Enable Screen Recording for QiuYaTools Computer in System Settings, then restart the helper.") }
        guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            throw ComputerError("TARGETS_UNAVAILABLE", "The current window list is unavailable.")
        }
        return windows.compactMap { info in
            guard (info[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
                  (info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1 > 0,
                  let bounds = info[kCGWindowBounds as String] as? [String: Any], let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary),
                  frame.width >= 40, frame.height >= 40,
                  let pid = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value, pid != getpid(),
                  let windowId = (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
                  let application = NSRunningApplication(processIdentifier: pid), !application.isTerminated,
                  let appId = application.bundleIdentifier, !appId.isEmpty else { return nil }
            let screen = NSScreen.screens.first { screen in
                // NSScreen uses a bottom-left origin; Quartz and SCWindow use top-left.
                let mainHeight = NSScreen.screens.first?.frame.height ?? 0
                let quartz = CGRect(x: screen.frame.minX, y: mainHeight - screen.frame.maxY, width: screen.frame.width, height: screen.frame.height)
                return quartz.intersects(frame)
            }
            return NativeTarget(id: "mac-window:\(windowId)", appId: appId,
                                title: info[kCGWindowName as String] as? String ?? application.localizedName ?? appId,
                                pid: pid, windowId: windowId, frame: frame, scale: Double(screen?.backingScaleFactor ?? 1))
        }.sorted { ($0.appId, $0.title, $0.id) < ($1.appId, $1.title, $1.id) }
    }

    func resolve(_ id: String) async throws -> (NativeTarget, SCWindow) {
        guard id.hasPrefix("mac-window:"), id.utf8.count < 100 else { throw ComputerError("INVALID_TARGET", "Invalid target identifier.") }
        guard let target = try targets().first(where: { $0.id == id }) else { throw ComputerError("TARGET_GONE", "The selected window is no longer available.") }
        if let window = shareableWindows[target.windowId], window.owningApplication?.processID == target.pid,
           window.owningApplication?.bundleIdentifier == target.appId { return (target, window) }
        // SCShareableContent is expensive: only query it when constructing a new
        // stream/filter, not twice for every preview frame. Quartz metadata still
        // validates current ownership, geometry and visibility on every call.
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        shareableWindows = Dictionary(content.windows.map { ($0.windowID, $0) }, uniquingKeysWith: { _, new in new })
        guard let window = shareableWindows[target.windowId], window.owningApplication?.processID == target.pid,
              window.owningApplication?.bundleIdentifier == target.appId else { throw ComputerError("TARGET_GONE", "The selected window is not available for capture.") }
        return (target, window)
    }

    func observe(_ target: NativeTarget, window: SCWindow) async throws -> (CapturedFrame, Int) {
        if identity != target.id || frame != target.frame || receiver == nil {
            await stop()
            let sink = FrameReceiver()
            let config = SCStreamConfiguration()
            let factor = min(target.scale, 1600 / max(target.frame.width, target.frame.height))
            config.width = max(1, Int((target.frame.width * factor).rounded()))
            config.height = max(1, Int((target.frame.height * factor).rounded()))
            config.minimumFrameInterval = CMTime(value: 1, timescale: 12)
            config.queueDepth = 3
            config.pixelFormat = kCVPixelFormatType_32BGRA
            config.showsCursor = true
            config.capturesAudio = false
            config.colorSpaceName = CGColorSpace.sRGB
            if #available(macOS 14.0, *) { config.ignoreShadowsSingleWindow = true }
            let next = SCStream(filter: SCContentFilter(desktopIndependentWindow: window), configuration: config, delegate: sink)
            try next.addStreamOutput(sink, type: .screen, sampleHandlerQueue: outputQueue)
            receiver = sink; stream = next; identity = target.id; frame = target.frame; generation += 1
            do { try await next.startCapture() } catch { await stop(); throw ComputerError("CAPTURE_START_FAILED", "ScreenCaptureKit could not start the selected window capture.") }
        }
        let currentGeneration = generation
        for _ in 0..<100 {
            guard identity == target.id, currentGeneration == generation, let sink = receiver else { throw ComputerError("CAPTURE_CHANGED", "The capture target changed.") }
            if let image = try sink.snapshot() { return (image, currentGeneration) }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        throw ComputerError("CAPTURE_TIMEOUT", "No complete frame arrived from the selected window.")
    }

    func stop() async {
        let old = stream
        stream = nil; receiver = nil; identity = nil; frame = nil; generation += 1
        try? await old?.stopCapture()
    }
}

func accessibilityText(_ target: NativeTarget) -> String {
    guard AXIsProcessTrusted() else { return "Accessibility permission is not granted." }
    let app = AXUIElementCreateApplication(target.pid)
    AXUIElementSetMessagingTimeout(app, 0.25)
    var windowValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windowValue) == .success,
          let windows = windowValue as? [AXUIElement] else { return "No accessibility windows are available." }
    var chosen: AXUIElement?
    for window in windows {
        var position: CFTypeRef?; var size: CFTypeRef?
        AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &position)
        AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &size)
        if let position, let size, CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() {
            var p = CGPoint.zero; var s = CGSize.zero
            AXValueGetValue(position as! AXValue, .cgPoint, &p); AXValueGetValue(size as! AXValue, .cgSize, &s)
            if abs(p.x - target.frame.minX) < 3, abs(p.y - target.frame.minY) < 3,
               abs(s.width - target.frame.width) < 3, abs(s.height - target.frame.height) < 3 { chosen = window; break }
        }
    }
    guard let root = chosen else { return "The selected window has no matching accessibility tree." }
    var lines: [String] = []; var visited = Set<CFHashCode>(); let deadline = Date().addingTimeInterval(0.8)
    func walk(_ element: AXUIElement, _ depth: Int) {
        guard depth < 9, lines.count < 160, Date() < deadline, visited.insert(CFHash(element)).inserted else { return }
        var values: [String] = []
        var roleValue: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString, &roleValue)
        let secure = (roleValue as? String) == "AXSecureTextField"
        for name in secure ? [kAXRoleAttribute, kAXTitleAttribute, kAXDescriptionAttribute] : [kAXRoleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute] {
            var value: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success, let text = value as? String, !text.isEmpty {
                let safe = text.replacingOccurrences(of: "\n", with: " ")
                if !values.contains(safe) { values.append(String(safe.prefix(300))) }
            }
        }
        if !values.isEmpty { lines.append(String(repeating: "  ", count: depth) + values.joined(separator: " | ")) }
        var children: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &children) == .success, let children = children as? [AXUIElement] {
            for child in children.prefix(80) { walk(child, depth + 1) }
        }
    }
    walk(root, 0)
    return String(lines.joined(separator: "\n").prefix(30_000))
}
