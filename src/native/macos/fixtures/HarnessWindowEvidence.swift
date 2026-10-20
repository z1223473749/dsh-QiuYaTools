// Read-only E2E evidence for a floating NSPanel, which is intentionally absent
// from the computer target catalog's normal-layer application windows.
import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit
import Vision

@main @MainActor struct HarnessWindowEvidence {
    static func main() async throws {
        _ = NSApplication.shared
        guard (3...4).contains(CommandLine.arguments.count) else { throw NSError(domain: "fixture", code: 1) }
        let title = CommandLine.arguments[1], output = CommandLine.arguments[2]
        let press = CommandLine.arguments.count == 4 ? CommandLine.arguments[3] : nil
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        guard let window = content.windows.first(where: { $0.title == title }) else { throw NSError(domain: "floating-window-not-found", code: 2) }
        let pid = window.owningApplication?.processID ?? 0
        let app = AXUIElementCreateApplication(pid)
        var accessibility: [String] = []
        var pressed = false
        var clickEvidence: [String: Any] = [:]
        func visit(_ node: AXUIElement, _ depth: Int) {
            guard depth < 12, accessibility.count < 250 else { return }
            for attribute in [kAXRoleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute] {
                var value: CFTypeRef?
                if AXUIElementCopyAttributeValue(node, attribute as CFString, &value) == .success, let value = value as? String, !value.isEmpty { accessibility.append(String(value.prefix(250))) }
            }
            var value: CFTypeRef?
            if AXUIElementCopyAttributeValue(node, kAXChildrenAttribute as CFString, &value) == .success, let children = value as? [AXUIElement] { for child in children { visit(child, depth + 1) } }
        }
        visit(app, 0)
        let config = SCStreamConfiguration()
        config.width = min(1600, Int(window.frame.width * 2)); config.height = Int(Double(config.width) * window.frame.height / window.frame.width)
        // This evidence capture deliberately enlarges text for OCR. SCK's
        // default only scales down and would otherwise pad the larger raster.
        config.scalesToFit = true
        config.showsCursor = false
        if #available(macOS 14.0, *) { config.ignoreShadowsSingleWindow = true }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let delegate = FrameWriter(output: output)
        let stream = SCStream(filter: filter, configuration: config, delegate: nil)
        try stream.addStreamOutput(delegate, type: .screen, sampleHandlerQueue: DispatchQueue(label: "fixture.frame"))
        try await stream.startCapture()
        for _ in 0..<100 {
            if delegate.finished { break }
            try await Task.sleep(nanoseconds: 30_000_000)
        }
        try await stream.stopCapture()
        guard delegate.finished else { throw NSError(domain: "floating-window-frame-timeout", code: 3) }
        let recognition = VNRecognizeTextRequest()
        recognition.recognitionLevel = .accurate; recognition.recognitionLanguages = ["zh-Hans", "en-US"]
        try VNImageRequestHandler(url: URL(fileURLWithPath: output)).perform([recognition])
        let candidates = (recognition.results ?? []).sorted { $0.boundingBox.midY > $1.boundingBox.midY }.compactMap { $0.topCandidates(1).first }
        let recognizedText = candidates.map { $0.string }
        if let press {
            for candidate in candidates {
                guard let range = candidate.string.range(of: press), let box = try candidate.boundingBox(for: range) else { continue }
                let point = CGPoint(x: window.frame.minX + box.boundingBox.midX * window.frame.width,
                                    y: window.frame.minY + (1 - box.boundingBox.midY) * window.frame.height)
                clickEvidence = ["x": point.x, "y": point.y, "frameX": window.frame.minX, "frameY": window.frame.minY,
                                 "frameWidth": window.frame.width, "frameHeight": window.frame.height, "label": candidate.string]
                let source = CGEventSource(stateID: .combinedSessionState)
                CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
                try await Task.sleep(nanoseconds: 50_000_000)
                CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
                try await Task.sleep(nanoseconds: 50_000_000)
                CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
                try await Task.sleep(nanoseconds: 300_000_000)
                pressed = true; break
            }
            if !pressed { throw NSError(domain: "preview-button-not-recognized", code: 4) }
        }
        let value: [String: Any] = ["id": window.windowID, "title": title, "pid": pid,
                                     "windowLayer": window.windowLayer, "width": config.width, "height": config.height,
                                     "accessibilityTrusted": AXIsProcessTrusted(), "accessibility": accessibility,
                                     "postEvents": CGPreflightPostEventAccess(), "recognizedText": recognizedText,
                                     "pressed": pressed, "click": clickEvidence]
        FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]))
    }
}
final class FrameWriter: NSObject, SCStreamOutput, @unchecked Sendable {
    let output: String
    private let lock = NSLock()
    private var done = false
    var finished: Bool { lock.lock(); defer { lock.unlock() }; return done }
    init(output: String) { self.output = output }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, CMSampleBufferIsValid(sampleBuffer), let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        lock.lock(); defer { lock.unlock() }; guard !done else { return }
        let image = CIImage(cvPixelBuffer: buffer), context = CIContext()
        guard let cg = context.createCGImage(image, from: image.extent),
              let jpeg = NSBitmapImageRep(cgImage: cg).representation(using: .jpeg, properties: [.compressionFactor: 0.8]) else { return }
        do { try jpeg.write(to: URL(fileURLWithPath: output)); done = true } catch { }
    }
}
