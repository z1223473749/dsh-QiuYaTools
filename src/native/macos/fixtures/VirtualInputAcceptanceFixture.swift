import AppKit
import ApplicationServices

/// Chromium's tab strip has an empty structural sibling over the actionable
/// branch. Keep that layout in a real AX fixture so child-order routing fails.
@MainActor final class OverlappingAccessibilityContent: NSView {
    override func accessibilityChildren() -> [Any]? {
        let decoration = NSAccessibilityElement()
        decoration.setAccessibilityRole(.group)
        decoration.setAccessibilityParent(self)
        decoration.setAccessibilityFrame(accessibilityFrame())
        return (super.accessibilityChildren() ?? []) + [decoration]
    }
}

/// An advertised setter that accepts an AX call without applying the value.
/// This reproduces a renderer acknowledging input while its field stays empty.
@MainActor final class IgnoringAccessibilityTextField: NSTextField {
    var ignoredWrites = 0
    override func setAccessibilityValue(_ value: Any?) { ignoredWrites += 1 }
}

@main struct VirtualInputAcceptanceFixture {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let path = CommandLine.arguments[1]
        let controller = Fixture(path: path)
        app.delegate = controller
        app.run()
    }
    @MainActor final class Fixture: NSObject, NSApplicationDelegate {
        let path: String
        var window: NSWindow!
        let field = NSTextField(string: "")
        let ignoredField = IgnoringAccessibilityTextField(string: "")
        var button: NSButton!
        var ambiguousButton: NSButton!
        var clicks = 0
        init(path: String) { self.path = path }
        func applicationDidFinishLaunching(_ notification: Notification) {
            window = NSWindow(contentRect: NSRect(x: 80, y: 100, width: 360, height: 220), styleMask: [.titled, .closable], backing: .buffered, defer: false)
            window.title = "Disposable virtual input fixture"
            window.isReleasedWhenClosed = false
            window.animationBehavior = .none
            let content = OverlappingAccessibilityContent(frame: NSRect(x: 0, y: 0, width: 360, height: 220))
            content.setAccessibilityElement(true); content.setAccessibilityRole(.group)
            window.contentView = content
            field.frame = NSRect(x: 30, y: 45, width: 280, height: 28)
            field.placeholderString = "Virtual text target"
            ignoredField.frame = NSRect(x: 30, y: 10, width: 280, height: 28)
            ignoredField.placeholderString = "Ignored background write"
            button = NSButton(title: "Virtual button", target: self, action: #selector(clicked))
            button.frame = NSRect(x: 30, y: 115, width: 170, height: 34)
            window.contentView?.addSubview(field)
            window.contentView?.addSubview(ignoredField)
            window.contentView?.addSubview(button)
            for title in ["Ambiguous A", "Ambiguous B"] {
                let duplicate = NSButton(title: title, target: self, action: #selector(clicked))
                duplicate.frame = NSRect(x: 220, y: 115, width: 110, height: 34)
                window.contentView?.addSubview(duplicate)
                ambiguousButton = duplicate
            }
            window.orderBack(nil)
            Timer.scheduledTimer(withTimeInterval: 0.04, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.publish() }
            }
            publish()
        }
        @objc func clicked() { clicks += 1; publish() }
        func publish() {
            guard let row = (CGWindowListCopyWindowInfo(.optionIncludingWindow, CGWindowID(window.windowNumber)) as? [[String: Any]])?.first,
                  let bounds = row[kCGWindowBounds as String] as? [String: Any] else { return }
            func point(_ view: NSView) -> [String: Double] {
                let p = window.convertPoint(toScreen: view.convert(CGPoint(x: view.bounds.midX, y: view.bounds.midY), to: nil))
                return ["x": p.x, "y": (NSScreen.screens.first?.frame.height ?? 0) - p.y]
            }
            let state: [String: Any] = ["pid": Int(getpid()), "windowId": window.windowNumber, "bounds": bounds,
                "button": point(button), "field": point(field), "ignoredField": point(ignoredField), "ignoredWrites": ignoredField.ignoredWrites, "ignoredText": ignoredField.stringValue,
                "ambiguous": point(ambiguousButton), "clicks": clicks, "text": field.stringValue,
                "overlappingStructuralGroup": true, "keyWindow": window.isKeyWindow, "fieldEditorActive": field.currentEditor() != nil]
            if let data = try? JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]) { try? data.write(to: URL(fileURLWithPath: path), options: .atomic) }
        }
    }
}
