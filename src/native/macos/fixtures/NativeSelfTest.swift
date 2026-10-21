import AppKit
import Foundation

@main struct NativeSelfTest {
    @MainActor static func main() throws {
        let geometry = FrameGeometry(frame: CGRect(x: -1280, y: 100, width: 800, height: 600), pixelWidth: 1600, pixelHeight: 1200)
        let point = try geometry.point(x: 400, y: 600)
        precondition(point == CGPoint(x: -1080, y: 400), "Retina/negative-display mapping")
        let scaled = FrameGeometry(frame: CGRect(x: 100, y: -900, width: 2000, height: 1000), pixelWidth: 1600, pixelHeight: 800)
        let scaledPoint = try scaled.point(x: 800, y: 400)
        precondition(scaledPoint == CGPoint(x: 1100, y: -400), "Downscaled screenshot mapping")
        precondition(AICursorOverlay.rasterPoint(scaledPoint, geometry: scaled) == CGPoint(x: 800, y: 400), "AI cursor uses screenshot scale and negative display coordinates")
        let edge = AICursorOverlay.clippedFrame(at: CGPoint(x: -1279, y: 101), target: geometry.frame)
        precondition(geometry.frame.contains(edge), "AI cursor and glow stay inside the authorized target")
        try approvedSmallGlyph()
        let cursorLayer = CGWindowLevelForKey(.cursorWindow)
        precondition(AICursorOverlay.isSystemCursorWindow(layer: cursorLayer, ownerPID: 415, verifyOwner: { $0 == 415 }), "Only an independently verified system cursor owner is excluded")
        precondition(!AICursorOverlay.isSystemCursorWindow(layer: cursorLayer, ownerPID: 415, verifyOwner: { _ in false }), "An unverified or spoofed cursor-level owner still occludes")
        precondition(!AICursorOverlay.isSystemCursorWindow(layer: CGWindowLevelForKey(.floatingWindow), ownerPID: 415, verifyOwner: { _ in true }), "Other system and application layers still occlude")
        precondition(!AICursorOverlay.isSystemCursorWindow(layer: nil, ownerPID: 415, verifyOwner: { _ in true }) &&
            !AICursorOverlay.isSystemCursorWindow(layer: cursorLayer, ownerPID: nil, verifyOwner: { _ in true }), "Incomplete cursor-window identity never bypasses occlusion")
        let defaultActor = try NativeLeaseActor.parse(nil), humanActor = try NativeLeaseActor.parse("human")
        precondition(defaultActor == .ai && humanActor == .human)
        for invalid: Any in [true, 0, "Human", "", NSNull()] {
            do { _ = try NativeLeaseActor.parse(invalid); preconditionFailure("Invalid lease actor accepted") } catch {}
        }
        do { _ = try geometry.point(x: 1600, y: 0); preconditionFailure("Out-of-raster input accepted") } catch {}
        do { _ = try geometry.point(x: .nan, y: 0); preconditionFailure("NaN input accepted") } catch {}
        let fence = EpochFence()
        try fence.lease(1); try fence.check(1); fence.release(1)
        do { try fence.check(1); preconditionFailure("Revoked epoch accepted") } catch {}
        do { try fence.lease(1); preconditionFailure("Old lease resurrected") } catch {}
        try fence.lease(2); fence.release(1); try fence.check(2)
        try fence.lease(3)
        do { try fence.check(2); preconditionFailure("Previous controller accepted") } catch {}
        fence.release(5)
        do { try fence.check(3); preconditionFailure("Newer revocation failed") } catch {}
        let shortcut = try parseKey("CMD+SHIFT+A")
        precondition(shortcut.0 == 0)
        do { _ = try parseKey("INVALID+RETURN"); preconditionFailure("Invalid modifier accepted") } catch {}
        _ = try FloatingPreview.validatedURL("http://127.0.0.1:3210/preview")
        let navigation = FloatingPreview.navigationURLs(URL(string: "http://127.0.0.1:3210/api/preview?session=fixture&token=local-test")!)
        precondition(navigation.initial.path == "/" && navigation.initial.query == "token=local-test", "Launch token must exchange at root")
        precondition(navigation.destination.path == "/api/preview" && navigation.destination.query == "session=fixture", "API destination must drop launch token")
        precondition(FloatingPreview.isDestination(URL(string: navigation.destination.absoluteString + "#local"), navigation.destination), "Preserve close permits only its exact preview document")
        precondition(!FloatingPreview.isDestination(navigation.initial, navigation.destination), "Auth root cannot preserve an unconfirmed preview")
        precondition(!FloatingPreview.isDestination(URL(string: "http://127.0.0.1:3210/api/preview?session=other"), navigation.destination), "A different session cannot receive preserve-close flag")
        let preserve = try FloatingPreview.preservesSession(true), ordinaryClose = try FloatingPreview.preservesSession(nil)
        precondition(preserve && !ordinaryClose)
        for invalid: Any in [1, "true", NSNull()] {
            do { _ = try FloatingPreview.preservesSession(invalid); preconditionFailure("Non-boolean preserveSession accepted") } catch {}
        }
        for url in ["https://example.com", "http://127.0.0.1.evil:3000/", "file:///tmp/x", "http://user:pass@localhost:4000/", "http://localhost/"] {
            do { _ = try FloatingPreview.validatedURL(url); preconditionFailure("Non-loopback/authenticated URL accepted") } catch {}
        }
        precondition(integer(true) == nil && integer(1.5) == nil && integer(-1) == nil && integer(4) == 4)
        print("Native self-test passed: geometry, approved small AI glyph/opacity/halo, cursor clipping/scale/occlusion, lease actor, epochs, key parsing, preview origin/preserve identity, wire numbers")
    }

    @MainActor private static func approvedSmallGlyph() throws {
        precondition(AICursorGlyph.hotspot == CGPoint(x: 2, y: 3), "Native and SVG hotspots must align")
        let bounds = AICursorGlyph.path(at: .zero).bounds
        precondition(bounds.width < 16 && bounds.height < 17, "The approved paper-plane contour has no traditional long tail")
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 96, pixelsHigh: 100, bitsPerSample: 8,
            samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        let context = NSGraphicsContext(bitmapImageRep: bitmap)!
        NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = context
        context.cgContext.translateBy(x: 0, y: 100); context.cgContext.scaleBy(x: 2, y: -2)
        NSColor.black.setFill(); CGRect(x: 0, y: 0, width: 48, height: 50).fill()
        AICursorGlyph.draw(at: CGPoint(x: 18, y: 18)); NSGraphicsContext.restoreGraphicsState()
        var white = 0, halo = 0, brightOutside = 0
        for row in 0..<100 { for column in 0..<96 {
            let color = bitmap.colorAt(x: column, y: row)!.usingColorSpace(.sRGB)!
            let rgb = [color.redComponent, color.greenComponent, color.blueComponent].map { $0 * 255 }
            let x = (Double(column) + 0.5) / 2 - 18 + 2, y = (Double(row) + 0.5) / 2 - 18 + 3
            let inside = x >= 0 && x < 18 && y >= 0 && y < 20
            if inside && rgb.min()! > 225 { white += 1 }
            if !inside && rgb.max()! > 160 { brightOutside += 1 }
            if !inside && rgb.max()! >= 2 && rgb.max()! <= 80 && rgb.max()! - rgb.min()! < 25 { halo += 1 }
        } }
        precondition(white >= 16 && white <= 360 && halo >= 16 && brightOutside == 0,
            "Rendered glyph requires a small white contour and dim outer glow, without a bright long tail")
        for (x, y) in [(5.3, 6.3), (5.8, 9.5), (8.0, 7.5)] {
            let color = bitmap.colorAt(x: Int((18 - 2 + x) * 2), y: Int((18 - 3 + y) * 2))!.usingColorSpace(.sRGB)!
            let rgb = [color.redComponent, color.greenComponent, color.blueComponent].map { $0 * 255 }
            precondition(rgb.min()! >= 35 && rgb.max()! <= 140 && rgb.max()! - rgb.min()! < 30,
                "Approved fill stays translucent neutral grey over black")
        }
    }
}
