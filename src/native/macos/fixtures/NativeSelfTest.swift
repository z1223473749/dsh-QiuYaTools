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
        print("Native self-test passed: geometry, AI cursor clipping/scale, lease actor, epochs, key parsing, preview origin/preserve identity, wire numbers")
    }
}
