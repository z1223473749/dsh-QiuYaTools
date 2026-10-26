import AppKit
import Foundation
import Security

@main struct NativeSelfTest {
    @MainActor static func main() async throws {
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
        try await cursorSuppressionStateMachine()
        try exactWindowReadiness()
        try exactPointerRouting()
        try exactKeyboardFocus()
        try actionHumanInterruption()
        try await boundedFocusPreparation()
        try await ownedKeyboardPairs()
        try await completedKeyboardActions()
        try await keyboardReadinessRetries()
        ownedKeyboardRecipientRelease()
        try permissionGuideApplicationIdentity()
        permissionGuidePlacement()
        permissionGuideLifetime()
        try macControlTransportPolicy()
        for kind in ["screenRecording", "accessibility", "inputMonitoring"] {
            let (returned, url) = try NativeApplicationCatalog.settingsURL(kind)
            precondition(returned == kind && url.scheme == "x-apple.systempreferences" && url.absoluteString.hasPrefix("x-apple.systempreferences:com.apple.preference.security?Privacy_"))
        }
        for value: Any in ["file:///tmp/launch", "https://example.com", "screenRecording?url=x", "", NSNull(), 1] {
            do { _ = try NativeApplicationCatalog.settingsURL(value); preconditionFailure("Arbitrary system-settings destination accepted") } catch {}
        }
        precondition(NativeApplicationCatalog.validAppId("com.qiuya.中文") == false && NativeApplicationCatalog.validAppId("com.apple.finder"))
        precondition(!NativeApplicationCatalog.validAppId("../../launch") && NativeApplicationCatalog.displayName("工具\n箱\0").contains("\n") == false)
        precondition(!NativeApplicationCatalog.validAppId("com.apple.finder\n"), "An app identity must end at the actual string boundary")
        let boundedName = NativeApplicationCatalog.displayName("A" + String(repeating: "\u{301}", count: 10_000))
        precondition(boundedName.unicodeScalars.count <= 160 && boundedName.utf8.count <= 640, "A single large combining grapheme cannot exceed the metadata wire budget")
        do {
            let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 64, pixelsHigh: 64,
                bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
            bitmap.setColor(NSColor(deviceRed: 0, green: 0.5, blue: 0.5, alpha: 1), atX: 0, y: 0)
            let original = NSImage(size: NSSize(width: 64, height: 64)); original.addRepresentation(bitmap)
            let dataURL = NativeApplicationCatalog.iconDataURL(original)!
            precondition(original.size == NSSize(width: 64, height: 64), "Rasterizing an icon cannot mutate its shared system image")
            precondition(dataURL.hasPrefix("data:image/png;base64,"), "Application icon is an inline PNG, never a path or network URL")
            let data = Data(base64Encoded: String(dataURL.dropFirst("data:image/png;base64,".count)))!
            let decoded = NSBitmapImageRep(data: data)!
            precondition(data.count <= 16 * 1024 && decoded.pixelsWide == 32 && decoded.pixelsHigh == 32,
                "Application icon is a fixed 32-pixel PNG within its 16 KiB budget")
            precondition(NativeApplicationCatalog.iconDataURL(nil) == nil, "Unavailable icons are omitted")
            let missing = NativeApplicationMetadata(appId: "own.app", name: "Own", running: true, launchable: false)
            precondition(missing.json["iconDataUrl"] == nil, "Missing icon metadata has no placeholder path")
            var present = missing; present.iconDataUrl = dataURL
            precondition(present.json["iconDataUrl"] as? String == dataURL && present.json["launchable"] as? Bool == false,
                "An icon enriches display metadata without acquiring launch permission")
            let cache = NativeApplicationIconCache<String>(); var reads = 0
            func read() -> String? { reads += 1; return dataURL }
            precondition(cache.icon(appId: "own", key: "identity-a", now: 1, mayLoad: true, load: read) == dataURL)
            precondition(cache.icon(appId: "own", key: "identity-a", now: 2.5, mayLoad: false, load: read) == dataURL && reads == 1,
                "Cached icons are reused during polling, even after the separate I/O budget")
            _ = cache.icon(appId: "own", key: "identity-b", now: 3, mayLoad: true, load: read)
            precondition(reads == 2, "A changed application identity invalidates its cached icon")
            _ = cache.icon(appId: "own", key: "identity-b", now: 63, mayLoad: true, load: read)
            precondition(reads == 3, "Positive icon cache entries expire after sixty seconds")
            cache.retain([])
            _ = cache.icon(appId: "own", key: "identity-b", now: 64, mayLoad: true, load: read)
            precondition(reads == 4, "Removing an application retires its icon cache")
            var failedReads = 0
            func unavailable() -> String? { failedReads += 1; return nil }
            _ = cache.icon(appId: "missing", key: "a", now: 1, mayLoad: true, load: unavailable)
            _ = cache.icon(appId: "missing", key: "a", now: 2.5, mayLoad: true, load: unavailable)
            precondition(failedReads == 1, "Unavailable icons have a short negative cache")
            _ = cache.icon(appId: "missing", key: "a", now: 6, mayLoad: true, load: unavailable)
            precondition(failedReads == 2, "A transient icon failure may recover after five seconds")
            precondition(cache.icon(appId: "deferred", key: "a", now: 1, mayLoad: false, load: read) == nil && reads == 4,
                "An exhausted icon budget starts no read and does not remove discovery metadata")
            _ = cache.icon(appId: "deferred", key: "a", now: 2, mayLoad: true, load: read)
            precondition(reads == 5, "An icon skipped by the I/O budget can be loaded on the next refresh")
            let userApps = "/Users/own/Applications"
            func priority(_ running: Bool, _ regular: Bool, _ path: String?) -> Int {
                NativeApplicationCatalog.iconPriority(running: running, regular: regular, installationPath: path, userApplicationsPath: userApps)
            }
            precondition(priority(true, true, "/Applications/Chrome.app") == 0 && priority(true, false, "/System/Library/CoreServices/OwnHelper.app") == 1,
                "Running regular applications get icons before running helpers")
            precondition(priority(false, false, "/Applications/Own.app") == 2 && priority(false, false, userApps + "/Own.app") == 2,
                "Common and per-user application directories get icons before system applications")
            precondition(priority(false, false, "/System/Applications/TextEdit.app") == 3 && priority(false, false, "/System/Library/CoreServices/OwnHelper.app") == 4,
                "System application icons precede inactive service helpers")
            precondition(priority(false, false, "/ApplicationsOther/Own.app") == 4 && priority(false, false, userApps + "Other/Own.app") == 4 && priority(false, false, nil) == 4,
                "Icon priority respects directory boundaries and does not invent an installation")
            print("Application icon pure checks: fixed PNG, original image unchanged, optional metadata, identity cache, expiry, failure recovery, deferred reads and running/common/system/helper priorities")
        }
        let badgeTarget = CGRect(x: -900, y: 80, width: 640, height: 460)
        let badge = AIOperationBadge.frame(target: badgeTarget)!
        precondition(badgeTarget.contains(badge) && badge.minY >= badgeTarget.minY + 40 && badge.maxX <= badgeTarget.maxX - 12, "Operation receipt stays inside its target below title buttons")
        precondition(AIOperationBadge.frame(target: CGRect(x: 0, y: 0, width: 150, height: 80)) == nil, "A tiny target must omit its optional operation receipt")
        do {
            var epoch = 20, eligible = true, frames = [CGRect](), hides = 0
            let receipt = AIOperationBadge(backend: OperationBadgeBackend(eligible: { _ in eligible }, present: { frame in frames.append(frame); return true }, hide: { hides += 1 }))
            receipt.isLeaseCurrent = { $0 == epoch }
            let target = NativeTarget(id: "own-receipt", appId: "own.receipt", title: "own", pid: 99, windowId: 99, frame: badgeTarget, scale: 2)
            receipt.beginLease(epoch)
            precondition(receipt.snapshot["visible"] as? Bool == false && frames.isEmpty, "A lease or status read is not an actual operation")
            receipt.interrupt(epoch); receipt.posted(epoch: epoch, target: target)
            precondition(receipt.snapshot["visible"] as? Bool == false && frames.isEmpty, "Human input before first posted operation latches out the receipt")
            epoch = 21; receipt.beginLease(epoch); receipt.posted(epoch: epoch, target: target)
            precondition(receipt.snapshot["visible"] as? Bool == true && receipt.snapshot["targetId"] as? String == target.id && receipt.snapshot["epoch"] as? Int == epoch && frames.allSatisfy { $0 == badge }, "Actual posted operation exposes only its bounded exact target receipt")
            receipt.hide(epoch: 20); precondition(receipt.snapshot["visible"] as? Bool == true, "An old action cannot hide its successor")
            eligible = false; precondition(receipt.snapshot["visible"] as? Bool == false && hides > 0, "Focus/visibility/geometry loss withdraws the receipt")
            eligible = true; receipt.posted(epoch: epoch, target: target); receipt.hide(epoch: epoch)
            precondition(receipt.snapshot["visible"] as? Bool == false, "Action completion withdraws the receipt without extending input ownership")
        }
        let cursorLayer = CGWindowLevelForKey(.cursorWindow)
        precondition(AICursorOverlay.isSystemCursorWindow(layer: cursorLayer, ownerPID: 415, verifyOwner: { $0 == 415 }), "Only an independently verified system cursor owner is excluded")
        precondition(!AICursorOverlay.isSystemCursorWindow(layer: cursorLayer, ownerPID: 415, verifyOwner: { _ in false }), "An unverified or spoofed cursor-level owner still occludes")
        precondition(!AICursorOverlay.isSystemCursorWindow(layer: CGWindowLevelForKey(.floatingWindow), ownerPID: 415, verifyOwner: { _ in true }), "Other system and application layers still occlude")
        precondition(!AICursorOverlay.isSystemCursorWindow(layer: nil, ownerPID: 415, verifyOwner: { _ in true }) &&
            !AICursorOverlay.isSystemCursorWindow(layer: cursorLayer, ownerPID: nil, verifyOwner: { _ in true }), "Incomplete cursor-window identity never bypasses occlusion")
        do {
            let dockLayer = CGWindowLevelForKey(.dockWindow)
            var verifies = 0, routes = 0, verified = true
            func check(_ layer: CGWindowLevel?, _ pid: pid_t?, route: Bool = true) -> Bool {
                AICursorOverlay.isNonBlockingDockWindow(layer: layer, ownerPID: pid,
                    routedToTarget: { routes += 1; return route }, verifyOwner: { _ in verifies += 1; return verified })
            }
            precondition(check(dockLayer, 415) && verifies == 1 && routes == 1)
            for layer: CGWindowLevel? in [nil, CGWindowLevelForKey(.normalWindow)] {
                let before = (verifies, routes)
                precondition(!check(layer, 415) && verifies == before.0 && routes == before.1, "Other layers must not query a route")
            }
            for pid: pid_t? in [nil, 0, -1] {
                let before = (verifies, routes)
                precondition(!check(dockLayer, pid) && verifies == before.0 && routes == before.1, "Unknown owner cannot query a route")
            }
            verified = false; let before = routes
            precondition(!check(dockLayer, 415) && routes == before, "Unverified Dock owner cannot query a route")
            verified = true
            precondition(!check(dockLayer, 415, route: false), "A verified Dock still blocks when the actual point routes elsewhere")
            let beforeVerify = verifies, beforeRoute = routes
            precondition(check(dockLayer, 415)); verified = false
            precondition(!check(dockLayer, 415) && verifies == beforeVerify + 2 && routes == beforeRoute + 1,
                "An exact repeated PID must be verified again; no cached owner or prior route authorizes another skip")
            print("Dock window pure policy matrix: 9 cases; fake verified owner and point route only; no real Dock lookup, GUI or input")
        }
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
        print("Native self-test passed: geometry, approved small AI glyph/opacity/halo, cursor clipping/scale/occlusion, owned cursor suppression fake state/cleanup matrices (no native cursor calls), exact-window CG metadata/ambiguity/front-order zero-post matrices, exact ordered-prefix/destination-specific identity matrices, exact pointer route/negative-screen/zero-post matrices, strict AX keyboard-root/non-key-sibling/error/drift matrices, per-post human-generation/partial-input/independent-UP matrices, bounded focus readiness/human/cancel/epoch/deadline matrices (no real activation/AX/input), lease actor, epochs, key parsing, preview origin/preserve identity, wire numbers")
    }

    private static func exactWindowReadiness() throws {
        let frame=CGRect(x:100,y:200,width:800,height:600)
        let target=NativeTarget(id:"mac-window:11",appId:"fixture.own",title:"",pid:99,windowId:11,frame:frame,scale:2)
        let geometry=FrameGeometry(frame:frame,pixelWidth:1600,pixelHeight:1200)
        let a=FocusWindowState(windowId:11,pid:99,frame:frame)
        let overlapping=FocusWindowState(windowId:22,pid:99,frame:frame)
        let b=FocusWindowState(windowId:22,pid:99,frame:frame.offsetBy(dx:30,dy:0))
        func check(_ before:[FocusWindowState],_ after:[FocusWindowState]?=nil,beforePid:pid_t?=99,afterPid:pid_t?=99,birth:Bool=true) throws {
            try ExactInputIdentity.check(target:target,geometry:geometry,before:before,after:after ?? before,
                beforePid:beforePid,afterPid:afterPid,processIdentityCurrent:birth)
        }
        func rejected(_ before:[FocusWindowState],_ after:[FocusWindowState]?=nil,beforePid:pid_t?=99,afterPid:pid_t?=99,birth:Bool=true,code:String="FOCUS_CHANGED") {
            var posts=0
            do{try check(before,after,beforePid:beforePid,afterPid:afterPid,birth:birth);posts+=1}
            catch let error as ComputerError{precondition(error.code==code)}catch{preconditionFailure("Unexpected identity error")}
            precondition(posts==0,"Invalid identity must remain zero-post before either input route")
        }
        try check([a,b])
        rejected([overlapping,a]);rejected([a,overlapping])
        rejected([a,b],beforePid:88);rejected([a,b],afterPid:88);rejected([a],beforePid:nil);rejected([a],afterPid:nil)
        rejected([a],birth:false,code:"TARGET_GONE")
        rejected([FocusWindowState(windowId:11,pid:88,frame:frame)],code:"GEOMETRY_CHANGED")
        rejected([FocusWindowState(windowId:11,pid:99,frame:frame.offsetBy(dx:1,dy:0))],code:"GEOMETRY_CHANGED")
        rejected([FocusWindowState(windowId:11,pid:99,frame:frame,onscreen:false)],code:"GEOMETRY_CHANGED")
        rejected([FocusWindowState(windowId:11,pid:99,frame:frame,alpha:0)],code:"GEOMETRY_CHANGED")
        rejected([FocusWindowState(windowId:11,pid:99,frame:frame,layer:CGWindowLevelForKey(.floatingWindow))],code:"GEOMETRY_CHANGED")
        rejected([overlapping],code:"GEOMETRY_CHANGED")
        let component=FocusWindowState(windowId:44,pid:99,frame:CGRect(x:106,y:206,width:66,height:20))
        let second=FocusWindowState(windowId:45,pid:99,frame:component.frame.offsetBy(dx:70,dy:0))
        // Shared metadata cannot infer the destination from CG's first surface.
        // An explicit point-route or keyboard-root proof is still required.
        try check([component,second,a,b]);try check([b,a])
        rejected([component,second,a],[second,component,a])
        rejected([component,a],[FocusWindowState(windowId:44,pid:99,frame:component.frame.offsetBy(dx:0.1,dy:0)),a])
        rejected([component,a],[a]);rejected([component,a],[component,b,a])
        rejected([component,a],[component],code:"GEOMETRY_CHANGED")
        rejected([a,b],[FocusWindowState(windowId:11,pid:99,frame:frame.offsetBy(dx:0.1,dy:0)),b])
        try check([component,a,b],[component,a]) // Behind-selected order does not own its input.
        precondition(FocusInputRoute.pointer(CGPoint(x:200,y:300)).kind=="pointer" && FocusInputRoute.keyboard.kind=="keyboard")
    }

    @MainActor private static func exactPointerRouting() throws {
        let frame=CGRect(x:-1280,y:-900,width:800,height:600),point=CGPoint(x:-1100,y:-700)
        var queries=[CGPoint](),route:CGWindowID?=11,posts=0
        let backend=PointerRoutingBackend(primaryMaxY:{1080},windowAt:{queries.append($0);return route})
        try ExactPointerRouting.check(point:point,selected:11,frame:frame,backend:backend);posts+=1
        precondition(queries==[CGPoint(x:-1100,y:1780)] && posts==1,"Negative display coordinates use primary maxY rather than the target display height")
        for wrong:CGWindowID? in [nil,0,44,88] {
            route=wrong;let before=posts
            do {try ExactPointerRouting.check(point:point,selected:11,frame:frame,backend:backend);posts+=1}
            catch let error as ComputerError {precondition(error.code=="FOCUS_CHANGED")}
            precondition(posts==before,"Unknown, sibling and foreign mouse routes are all zero-post")
        }
        route=11
        for step in 0...24 {
            let p=CGPoint(x:frame.minX+10+Double(step)*10,y:frame.minY+20)
            try ExactPointerRouting.check(point:p,selected:11,frame:frame,backend:backend)
        }
        let beforeQueries=queries.count
        for invalid in [CGPoint(x:frame.maxX,y:frame.midY),CGPoint(x:.nan,y:frame.midY),CGPoint(x:frame.midX,y:.infinity)] {
            do {try ExactPointerRouting.check(point:invalid,selected:11,frame:frame,backend:backend);preconditionFailure("Invalid route coordinate accepted")}
            catch let error as ComputerError {precondition(error.code=="FOCUS_CHANGED")}
        }
        precondition(queries.count==beforeQueries,"Invalid points must not reach the AppKit route query")
        precondition(ExactPointerRouting.appKitPoint(point,primaryMaxY:.nan)==nil)
        let unavailable=PointerRoutingBackend(primaryMaxY:{nil},windowAt:{_ in preconditionFailure("No route without a primary coordinate system")})
        do {try ExactPointerRouting.check(point:point,selected:11,frame:frame,backend:unavailable);preconditionFailure("Missing primary screen accepted")} catch {}
        let a=FocusWindowState(windowId:11,pid:99,frame:frame)
        let target=NativeTarget(id:"pointer-A",appId:"fixture.own",title:"",pid:99,windowId:11,frame:frame,scale:2)
        let geometry=FrameGeometry(frame:frame,pixelWidth:1600,pixelHeight:1200)
        let component=FocusWindowState(windowId:44,pid:99,frame:CGRect(x:frame.minX+6,y:frame.minY+6,width:66,height:20))
        let unrelated=FocusWindowState(windowId:88,pid:77,frame:frame.offsetBy(dx:1600,dy:0))
        // Exactly the production pointer sequence: route the actual point and
        // surround it with the shared CG/birth/front checks; no AX is required.
        func pointerPost(_ windows:[FocusWindowState],_ after:[FocusWindowState]?=nil) throws {
            try ExactWindowFocus.validate(target:target,geometry:geometry,windows:windows)
            try ExactPointerRouting.check(point:point,selected:target.windowId,frame:frame,backend:backend)
            try ExactInputIdentity.check(target:target,geometry:geometry,before:windows,after:after ?? windows,
                beforePid:99,afterPid:99,processIdentityCurrent:true)
            posts+=1
        }
        route=11
        try pointerPost([component,a]);try pointerPost([unrelated,component,a])
        let baseline=posts
        for wrong:CGWindowID? in [nil,44,88] {
            route=wrong
            do{try pointerPost([unrelated,component,a]);preconditionFailure("Wrong actual point route accepted")}
            catch let error as ComputerError{precondition(error.code=="FOCUS_CHANGED")}
        }
        route=11
        do{try pointerPost([component,a],[a]);preconditionFailure("Route proof survived CG prefix drift")}
        catch let error as ComputerError{precondition(error.code=="FOCUS_CHANGED")}
        do{try pointerPost([a,FocusWindowState(windowId:22,pid:99,frame:frame)]);preconditionFailure("Ambiguous point target accepted")}
        catch let error as ComputerError{precondition(error.code=="FOCUS_CHANGED")}
        precondition(posts==baseline,"A different actual route, changed CG prefix, or ambiguous geometry never posts")

    }

    private static func exactKeyboardFocus() throws {
        let frame=CGRect(x:100,y:200,width:800,height:600),a=FocusWindowState(windowId:11,pid:99,frame:frame)
        let b=FocusWindowState(windowId:22,pid:99,frame:frame.insetBy(dx:80,dy:80))
        let target=NativeTarget(id:"keyboard-A",appId:"fixture.own",title:"",pid:99,windowId:11,frame:frame,scale:2)
        let geometry=FrameGeometry(frame:frame,pixelWidth:1600,pixelHeight:1200)
        let focused=KeyboardFocusSnapshot(pid:99,frame:frame,isWindow:true,identityStable:true)
        func check(_ root:KeyboardFocusSnapshot?,before:[FocusWindowState]?=nil,after:[FocusWindowState]?=nil,
                   beforePid:pid_t?=99,afterPid:pid_t?=99,birth:Bool=true) throws {
            try ExactKeyboardFocus.check(target:target,geometry:geometry,before:before ?? [a,b],after:after ?? [a,b],
                beforePid:beforePid,afterPid:afterPid,focused:root,processIdentityCurrent:birth)
        }
        func rejected(_ root:KeyboardFocusSnapshot?,before:[FocusWindowState]?=nil,after:[FocusWindowState]?=nil,
                      beforePid:pid_t?=99,afterPid:pid_t?=99,birth:Bool=true,code:String="FOCUS_CHANGED") {
            var posts=0
            do{try check(root,before:before,after:after,beforePid:beforePid,afterPid:afterPid,birth:birth);posts+=1}
            catch let error as ComputerError{precondition(error.code==code)}catch{preconditionFailure("Unexpected keyboard focus error")}
            precondition(posts==0,"No keyboard post may follow an unavailable, ambiguous or different focused root")
        }
        try check(focused)
        // The independently reproduced AppKit counterexample: selected A is
        // topmost and non-key; same-PID, different-geometry B remains key/AX focus.
        rejected(KeyboardFocusSnapshot(pid:99,frame:b.frame,isWindow:true,identityStable:true))
        rejected(nil) // AX unsupported, no value, error, or read deadline.
        rejected(KeyboardFocusSnapshot(pid:88,frame:frame,isWindow:true,identityStable:true))
        rejected(KeyboardFocusSnapshot(pid:99,frame:frame,isWindow:false,identityStable:true))
        rejected(KeyboardFocusSnapshot(pid:99,frame:frame,isWindow:true,identityStable:false))
        rejected(KeyboardFocusSnapshot(pid:99,frame:CGRect(x:0,y:0,width:0,height:0),isWindow:true,identityStable:true))
        rejected(KeyboardFocusSnapshot(pid:99,frame:CGRect(x:CGFloat.nan,y:200,width:800,height:600),isWindow:true,identityStable:true))
        rejected(focused,beforePid:88);rejected(focused,afterPid:88);rejected(focused,beforePid:nil);rejected(focused,afterPid:nil)
        rejected(focused,birth:false,code:"TARGET_GONE")
        let sibling=FocusWindowState(windowId:33,pid:99,frame:frame)
        rejected(focused,before:[a,sibling]);rejected(focused,after:[a,sibling])
        rejected(focused,after:[FocusWindowState(windowId:11,pid:88,frame:frame)],code:"GEOMETRY_CHANGED")
        rejected(focused,after:[FocusWindowState(windowId:11,pid:99,frame:frame.offsetBy(dx:0.1,dy:0)),b])
        let component=FocusWindowState(windowId:44,pid:99,frame:CGRect(x:106,y:206,width:66,height:20))
        try check(focused,before:[component,a,b],after:[component,a,b])
        rejected(focused,before:[component,a,b],after:[a,b])
    }

    @MainActor private static func actionHumanInterruption() throws {
        let fence=ActionInputGenerationFence(expected:7)
        try fence.check(current:7,inputPosted:false)
        do{try fence.check(current:8,inputPosted:false);preconditionFailure("Pre-input human intervention accepted")}
        catch let error as ComputerError{precondition(error.code=="HUMAN_INPUT_INTERRUPTED" && error.message=="Human input interrupted focus preparation; no input was posted.")}
        for steps in [4,24] {
            var generation:UInt64=7,posts=0,cleanupUps=0,desktopReleases=0
            for step in 0..<steps {
                if step==2{generation+=1}
                do{try fence.check(current:generation,inputPosted:posts>0);posts+=1}
                catch let error as ComputerError{
                    precondition(error.code=="HUMAN_INPUT_INTERRUPTED" && error.message=="Human input interrupted the action; remaining input stopped.")
                    break
                }
            }
            precondition(posts==2,"Same-window human intervention stops remaining characters and drag steps without requiring a focus change")
            try completeOwnedInputCleanup(restoreCursor:{true},releaseHeld:{cleanupUps+=1},releaseDesktop:{desktopReleases+=1})
            precondition(cleanupUps==1 && desktopReleases==1,"The human-generation fence never blocks independent owned UP cleanup")
        }
        var posts=0
        try fence.check(current:7,inputPosted:false)
        // A human event may be observed during a synchronous AX boundary.
        do{try fence.check(current:8,inputPosted:false);posts+=1}catch let error as ComputerError{precondition(error.code=="HUMAN_INPUT_INTERRUPTED")}
        precondition(posts==0,"Rechecking generation after the focus/AX boundary prevents the following post")
    }

    /// Executes the production pair-ordering helper with fake callbacks only.
    /// It does not instantiate NativeInput/NativeFocusIdentity or send CGEvents.
    private static func ownedKeyboardRecipientRelease() {
        var cases = 0
        for recipient: OwnedKeyboardRecipient in [.original, .retired, .unverified] {
            for sessionVerified in [false, true] {
                for keyHeld in [false, true] {
                    let result = OwnedKeyboardReleasePolicy.disposition(recipient: recipient, sessionVerified: sessionVerified, keyHeld: keyHeld)
                    if recipient == .original {
                        precondition(result == .postOriginal, "An exact original recipient still requires its owned up")
                    } else if recipient == .retired && sessionVerified && !keyHeld {
                        precondition(result == .retireWithoutPost, "An exited recipient with no held OS key must not receive a new event")
                    } else {
                        precondition(result == .block, "Missing identity, unavailable session or held input must retain the release responsibility")
                    }
                    cases += 1
                }
            }
        }
        precondition(cases == 12)
        print("OwnedKeyboardRecipientPolicy pure matrix: {\"passed\":true,\"cases\":12,\"nativeInputEvents\":0,\"livePIDReuseTested\":false}")
    }

    @MainActor private static func ownedKeyboardPairs() async throws {
        final class Fake {
            let fence = EpochFence()
            let generationFence = ActionInputGenerationFence(expected: 7)
            var generation: UInt64 = 7
            var focusAccepted = true, recipientIdentityAccepted = true, physicalOwnerAccepted = true
            var failUp = false, cancelBeforePair = false, cancelDuringVerification = false, cancelAfterDown = false
            var downs = 0, ups = 0, releaseAttempts = 0, beforeChecks = 0, afterChecks = 0
            var held = false
            var trace = [String]()
            var onHold: (() throws -> Void)?, onUp: (() -> Void)?
            init() { try! fence.lease(10) }
            func pair() async throws {
                if cancelBeforePair { withUnsafeCurrentTask { $0?.cancel() } }
                try await OwnedKeyboardPairDelivery.run(verifyBeforeDown: {
                    self.trace.append("AX-before-down"); self.beforeChecks += 1
                    try self.fence.check(10)
                    try self.generationFence.check(current: self.generation, inputPosted: self.downs > 0)
                    guard self.focusAccepted else { throw ComputerError("FOCUS_CHANGED", "fake full focus rejection") }
                    if self.cancelDuringVerification { withUnsafeCurrentTask { $0?.cancel() } }
                }, postDown: {
                    precondition(!self.held, "No second down before the original held pair retires")
                    self.trace.append("down"); self.downs += 1; self.held = true
                    if self.cancelAfterDown { withUnsafeCurrentTask { $0?.cancel() } }
                }, hold: {
                    self.trace.append("hold")
                    try self.onHold?()
                    try Task.checkCancellation()
                }, releaseUp: {
                    self.trace.append("release-attempt"); self.releaseAttempts += 1
                    // These booleans are deliberately fake release predicates.
                    // They prove ordering on failure, not the live PID/birth or
                    // private registry guard's real OS implementation.
                    guard self.recipientIdentityAccepted, self.physicalOwnerAccepted, !self.failUp else {
                        throw ComputerError("INPUT_CLEANUP_FAILED", "fake owned release rejection")
                    }
                    precondition(self.held, "This fake up must discharge one actual fake down")
                    self.trace.append("up"); self.ups += 1; self.held = false; self.onUp?()
                }, verifyAfterUp: {
                    self.trace.append("post-up-fence"); self.afterChecks += 1
                    try self.fence.check(10)
                    try self.generationFence.check(current: self.generation, inputPosted: true)
                })
            }
        }
        var cases = [String]()
        do {
            let f = Fake(); try await f.pair()
            precondition(f.downs == 1 && f.ups == 1 && f.releaseAttempts == 1 && !f.held)
            precondition(f.trace == ["AX-before-down", "down", "hold", "release-attempt", "up", "post-up-fence"], "No AX callback may run between the original down/up")
            cases.append("normal-exact-order-one-down-one-up")
        }
        do {
            let f = Fake(); f.focusAccepted = false
            do { try await f.pair(); preconditionFailure("Rejected full check posted a down") }
            catch let e as ComputerError { precondition(e.code == "FOCUS_CHANGED") }
            precondition(f.downs == 0 && f.ups == 0 && f.releaseAttempts == 0 && f.trace == ["AX-before-down"])
            cases.append("before-down-full-check-rejects-zero-posts")
        }
        do {
            let f = Fake(); f.onHold = { throw CancellationError() }
            do { try await f.pair(); preconditionFailure("Cancelled hold was swallowed") } catch is CancellationError {}
            precondition(f.downs == 1 && f.ups == 1 && f.releaseAttempts == 1 && f.afterChecks == 0 && !f.held)
            cases.append("hold-cancellation-discharges-up-once")
        }
        for kind in ["human-generation", "epoch"] {
            let f = Fake(); f.onHold = { if kind == "epoch" { f.fence.release(10) } else { f.generation = 8 } }
            do { for _ in 0..<2 { try await f.pair() }; preconditionFailure("A changed authorization allowed the following down") }
            catch let e as ComputerError { precondition(e.code == (kind == "epoch" ? "STALE_EPOCH" : "HUMAN_INPUT_INTERRUPTED")) }
            precondition(f.downs == 1 && f.ups == 1 && f.releaseAttempts == 1 && f.beforeChecks == 1 && f.afterChecks == 1 && !f.held)
            cases.append(kind + "-changes-after-down-still-up-one-next-down-zero")
        }
        do {
            let f = Fake(); f.failUp = true
            do { for _ in 0..<2 { try await f.pair() }; preconditionFailure("Failed release allowed a following down") }
            catch let e as ComputerError { precondition(e.code == "INPUT_CLEANUP_FAILED") }
            precondition(f.downs == 1 && f.ups == 0 && f.releaseAttempts == 1 && f.afterChecks == 0 && f.held)
            cases.append("up-failure-retains-held-and-prevents-next-down")
        }
        do {
            let f = Fake(); f.failUp = true; f.onHold = { throw CancellationError() }
            do { try await f.pair(); preconditionFailure("Cancelled hold plus failed release passed") }
            catch let e as ComputerError { precondition(e.code == "INPUT_CLEANUP_FAILED") }
            precondition(f.downs == 1 && f.ups == 0 && f.releaseAttempts == 1 && f.afterChecks == 0 && f.held)
            cases.append("release-failure-on-cancellation-remains-blocking")
        }
        for kind in ["recipient-identity", "physical-owner"] {
            let f = Fake(); f.onHold = { if kind == "recipient-identity" { f.recipientIdentityAccepted = false } else { f.physicalOwnerAccepted = false } }
            do { for _ in 0..<2 { try await f.pair() }; preconditionFailure("Fake release identity rejection was ignored") }
            catch let e as ComputerError { precondition(e.code == "INPUT_CLEANUP_FAILED") }
            precondition(f.downs == 1 && f.ups == 0 && f.releaseAttempts == 1 && f.held)
            cases.append("fake-" + kind + "-release-rejection-not-live-identity-proof")
        }
        do {
            let f = Fake(); f.onUp = { f.focusAccepted = false }
            do { for _ in 0..<2 { try await f.pair() }; preconditionFailure("A new target received the following down") }
            catch let e as ComputerError { precondition(e.code == "FOCUS_CHANGED") }
            precondition(f.downs == 1 && f.ups == 1 && f.releaseAttempts == 1 && f.beforeChecks == 2 && f.afterChecks == 1 && !f.held)
            cases.append("focus-switch-requires-fresh-full-check-before-next-down")
        }
        do {
            let f = Fake(); for _ in 0..<2 { try await f.pair() }
            precondition(f.downs == 2 && f.ups == 2 && f.beforeChecks == 2 && f.afterChecks == 2)
            precondition(f.trace == Array(repeating: ["AX-before-down", "down", "hold", "release-attempt", "up", "post-up-fence"], count: 2).flatMap { $0 })
            cases.append("every-successor-down-has-its-own-full-check")
        }
        for kind in ["before-pair", "during-verification", "after-down"] {
            let f = Fake()
            f.cancelBeforePair = kind == "before-pair"
            f.cancelDuringVerification = kind == "during-verification"
            f.cancelAfterDown = kind == "after-down"
            let child = Task { @MainActor in
                for _ in 0..<2 { try await f.pair() }
            }
            do { try await child.value; preconditionFailure("Actual Swift Task cancellation was ignored") } catch is CancellationError {}
            if kind == "after-down" {
                precondition(f.downs == 1 && f.ups == 1 && f.releaseAttempts == 1 && f.afterChecks == 0 && !f.held)
            } else {
                precondition(f.downs == 0 && f.ups == 0 && f.releaseAttempts == 0 && !f.held)
                precondition(f.beforeChecks == (kind == "before-pair" ? 0 : 1))
            }
            precondition(!Task.isCancelled, "A cancelled child must not contaminate the remaining pure matrix")
            cases.append("actual-swift-task-cancel-" + kind)
        }
        precondition(cases.count == 14)
        let receipt: [String: Any] = ["passed": true, "cases": cases, "caseCount": cases.count, "fakeCallbacksOnly": true,
            "realSwiftTaskCancellation": true, "guiStarted": 0, "realAXReads": 0, "nativeInputEvents": 0,
            "livePIDReuseTested": false, "privateNativeReleaseRegistryTested": false]
        let data = try JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys])
        print("OwnedKeyboardPairDelivery pure matrix: " + String(data: data, encoding: .utf8)!)
    }

    @MainActor private static func completedKeyboardActions() async throws {
        @MainActor final class Fake {
            let frame = CGRect(x: 100, y: 200, width: 800, height: 600)
            let fence = EpochFence(), generationFence = ActionInputGenerationFence(expected: 7)
            var generation: UInt64 = 7
            var owner: String? = "original-owner", expectedOwner = "original-owner"
            var heldKeys = 0, releases = 0, mouseHeld = false, osHeld = false, permission = true, cursorBlocked = false
            var beforePid: pid_t? = 99, afterPid: pid_t? = 99, birthBefore = true, birthAfter = true
            var windowsBefore: [FocusWindowState]?, windowsAfter: [FocusWindowState]?
            var reads = 0, checkpoints = 0, birthChecks = 0, axReads = 0, newDowns = 0
            var focused: KeyboardFocusSnapshot?
            var onCheckpoint: ((Int) -> Void)?
            var target: NativeTarget { NativeTarget(id: "completed-A", appId: "fixture.own", title: "", pid: 99, windowId: 11, frame: frame, scale: 2) }
            var geometry: FrameGeometry { FrameGeometry(frame: frame, pixelWidth: 1600, pixelHeight: 1200) }
            var a: FocusWindowState { FocusWindowState(windowId: 11, pid: 99, frame: frame) }
            var b: FocusWindowState { FocusWindowState(windowId: 22, pid: 99, frame: frame.insetBy(dx: 80, dy: 80)) }
            init() { try! fence.lease(10) }
            func checkpoint() throws {
                checkpoints += 1; onCheckpoint?(checkpoints)
                try Task.checkCancellation(); try fence.check(10)
                try generationFence.check(current: generation, inputPosted: true)
                try CompletedKeyboardInputPolicy.check(CompletedKeyboardInputState(ownerId: owner, heldKeys: heldKeys,
                    ownedKeyReleases: releases, mouseHeld: mouseHeld, osInputHeld: osHeld,
                    permissionsCurrent: permission, cursorRestorationBlocked: cursorBlocked), expectedOwnerId: expectedOwner)
            }
            func complete() throws {
                try ExactKeyboardCompletion.check(target: target, geometry: geometry, backend: KeyboardCompletionBackend(
                    windows: { self.reads += 1; return (self.reads == 1 ? self.windowsBefore : self.windowsAfter) ?? [self.a, self.b] },
                    frontmost: { self.reads == 1 ? self.beforePid : self.afterPid },
                    processIdentityCurrent: { self.birthChecks += 1; return self.birthChecks == 1 ? self.birthBefore : self.birthAfter }),
                    checkpoint: { try self.checkpoint() })
            }
            func nextDown() throws {
                axReads += 1
                try ExactKeyboardFocus.check(target: target, geometry: geometry, before: [a, b], after: [a, b],
                    beforePid: 99, afterPid: 99, focused: focused, processIdentityCurrent: true)
                newDowns += 1
            }
        }
        var cases = [String]()
        do {
            let f = Fake() // nil models the failed AXFocusedWindow read after the owned pair.
            try f.complete()
            precondition(f.reads == 2 && f.birthChecks == 2 && f.checkpoints == 3 && f.axReads == 0)
            do { try f.nextDown(); preconditionFailure("Completion authorized a new down without fresh AX readiness") }
            catch let error as ComputerError { precondition(error.code == "FOCUS_CHANGED") }
            precondition(f.newDowns == 0 && f.axReads == 1)
            cases.append("completed-pair-accepts-AX-unavailable-but-next-down-refuses-zero-posts")
        }
        do {
            let f = Fake(); try f.complete()
            f.focused = KeyboardFocusSnapshot(pid: 99, frame: f.frame, isWindow: true, identityStable: true)
            try f.nextDown()
            precondition(f.newDowns == 1 && f.axReads == 1, "A successor down still consumes its own full keyboard proof")
            cases.append("next-down-requires-new-complete-AX-proof")
        }
        for kind in ["different-window", "owner-drift", "geometry-drift", "subpixel-drift", "same-geometry-sibling", "prefix-drift", "foreground-before", "foreground-after", "foreground-unknown", "birth-before", "birth-after"] {
            let f = Fake(); var code = "FOCUS_CHANGED"
            switch kind {
            case "different-window": f.windowsAfter = [f.b]; code = "GEOMETRY_CHANGED"
            case "owner-drift": f.windowsAfter = [FocusWindowState(windowId: 11, pid: 88, frame: f.frame)]; code = "GEOMETRY_CHANGED"
            case "geometry-drift": f.windowsAfter = [FocusWindowState(windowId: 11, pid: 99, frame: f.frame.offsetBy(dx: 8, dy: 0))]; code = "GEOMETRY_CHANGED"
            case "subpixel-drift": f.windowsAfter = [FocusWindowState(windowId: 11, pid: 99, frame: f.frame.offsetBy(dx: 0.1, dy: 0)), f.b]
            case "same-geometry-sibling": f.windowsAfter = [f.a, FocusWindowState(windowId: 33, pid: 99, frame: f.frame)]
            case "prefix-drift": f.windowsBefore = [f.b, f.a]; f.windowsAfter = [f.a, f.b]
            case "foreground-before": f.beforePid = 88
            case "foreground-after": f.afterPid = 88
            case "foreground-unknown": f.afterPid = nil
            case "birth-before": f.birthBefore = false; code = "TARGET_GONE"
            case "birth-after": f.birthAfter = false; code = "TARGET_GONE"
            default: preconditionFailure("Unknown completion case")
            }
            do { try f.complete(); preconditionFailure("Changed completed-action identity accepted") }
            catch let error as ComputerError { precondition(error.code == code) }
            precondition(f.axReads == 0 && f.newDowns == 0)
            cases.append("completion-refuses-" + kind)
        }
        do {
            let f = Fake(); f.windowsAfter = [f.a]; try f.complete()
            precondition(f.axReads == 0, "Behind-selected windows do not own completed input")
            cases.append("behind-selected-change-does-not-own-completion")
        }
        for kind in ["owner-missing", "owner-changed", "expected-owner-empty", "held-key", "owned-release", "held-mouse", "OS-held", "permission", "cursor-restoration"] {
            let f = Fake(); var code = "INPUT_CLEANUP_FAILED"
            switch kind {
            case "owner-missing": f.owner = nil
            case "owner-changed": f.owner = "successor-owner"
            case "expected-owner-empty": f.expectedOwner = ""
            case "held-key": f.heldKeys = 1
            case "owned-release": f.releases = 1
            case "held-mouse": f.mouseHeld = true
            case "OS-held": f.osHeld = true
            case "permission": f.permission = false; code = "ACCESSIBILITY_REQUIRED"
            case "cursor-restoration": f.cursorBlocked = true; code = "CURSOR_CLEANUP_FAILED"
            default: preconditionFailure("Unknown completed responsibility case")
            }
            do { try f.complete(); preconditionFailure("Incomplete keyboard responsibility accepted") }
            catch let error as ComputerError { precondition(error.code == code) }
            precondition(f.reads == 0 && f.axReads == 0 && f.newDowns == 0)
            cases.append("completion-refuses-" + kind)
        }
        for boundary in [1, 2, 3] {
            for kind in ["epoch", "human", "owner", "permission", "owned-release"] {
                let f = Fake()
                f.onCheckpoint = { step in
                    if step == boundary {
                        switch kind {
                        case "epoch": f.fence.release(10)
                        case "human": f.generation = 8
                        case "owner": f.owner = "successor-owner"
                        case "permission": f.permission = false
                        case "owned-release": f.releases = 1
                        default: preconditionFailure("Unknown completion checkpoint case")
                        }
                    }
                }
                do { try f.complete(); preconditionFailure("Checkpoint drift was ignored") }
                catch let error as ComputerError {
                    precondition(error.code == (kind == "epoch" ? "STALE_EPOCH" : kind == "human" ? "HUMAN_INPUT_INTERRUPTED" : kind == "permission" ? "ACCESSIBILITY_REQUIRED" : "INPUT_CLEANUP_FAILED"))
                }
                precondition(f.checkpoints == boundary && f.axReads == 0 && f.newDowns == 0)
                cases.append("completion-checkpoint-\(boundary)-refuses-" + kind)
            }
            let f = Fake(); f.onCheckpoint = { if $0 == boundary { withUnsafeCurrentTask { $0?.cancel() } } }
            let child = Task { @MainActor in try f.complete() }
            do { try await child.value; preconditionFailure("Actual Swift completion Task cancellation was ignored") }
            catch is CancellationError {}
            precondition(f.checkpoints == boundary && f.axReads == 0 && f.newDowns == 0 && !Task.isCancelled)
            cases.append("completion-actual-swift-task-cancel-\(boundary)")
        }
        precondition(cases.count == 41)
        let receipt: [String: Any] = ["passed": true, "cases": cases, "caseCount": cases.count, "fakeCallbacksOnly": true,
            "realSwiftTaskCancellation": true, "guiStarted": 0, "realAXReads": 0, "nativeInputEvents": 0,
            "livePIDReuseTested": false, "privateNativeReleaseRegistryTested": false, "eventDeliveryAcknowledged": false]
        let data = try JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys])
        print("CompletedKeyboardAction pure matrix: " + String(data: data, encoding: .utf8)!)
    }

    @MainActor private static func keyboardReadinessRetries() async throws {
        @MainActor final class Fake {
            let frame = CGRect(x: 100, y: 200, width: 800, height: 600)
            let fence = EpochFence(), generationFence = ActionInputGenerationFence(expected: 7), budget = KeyboardReadinessRetryBudget()
            var time = 0.0, proofCost = 0.005, metadataCost = 0.0
            var generation: UInt64 = 7
            var owner: String? = "original-owner", held = 0, releases = 0, permission = true, cursorBlocked = false
            var proofs = 0, sleeps = 0, metadataChecks = 0, posts = 0, ups = 0
            var transient = 0, permanent = false, birth = true
            var beforePid: pid_t? = 99, afterPid: pid_t? = 99
            var windowsBefore: [FocusWindowState]?, windowsAfter: [FocusWindowState]?
            var root: KeyboardFocusSnapshot?
            var axError: Int32? = AXError.cannotComplete.rawValue
            var onSleep: (() -> Void)?, duringAX: (() -> Void)?
            var a: FocusWindowState { FocusWindowState(windowId: 11, pid: 99, frame: frame) }
            var b: FocusWindowState { FocusWindowState(windowId: 22, pid: 99, frame: frame.insetBy(dx: 80, dy: 80)) }
            var target: NativeTarget { NativeTarget(id: "readiness-A", appId: "fixture.own", title: "", pid: 99, windowId: 11, frame: frame, scale: 2) }
            var geometry: FrameGeometry { FrameGeometry(frame: frame, pixelWidth: 1600, pixelHeight: 1200) }
            init() { try! fence.lease(10); root = KeyboardFocusSnapshot(pid: 99, frame: frame, isWindow: true, identityStable: true) }
            func checkpoint() throws {
                try Task.checkCancellation(); try fence.check(10)
                try generationFence.check(current: generation, inputPosted: posts > 0)
                try CompletedKeyboardInputPolicy.check(CompletedKeyboardInputState(ownerId: owner, heldKeys: held,
                    ownedKeyReleases: releases, mouseHeld: false, osInputHeld: false, permissionsCurrent: permission,
                    cursorRestorationBlocked: cursorBlocked), expectedOwnerId: "original-owner")
            }
            func identity() throws {
                try ExactInputIdentity.check(target: target, geometry: geometry, before: windowsBefore ?? [a, b], after: windowsAfter ?? [a, b],
                    beforePid: beforePid, afterPid: afterPid, processIdentityCurrent: birth)
            }
            func nextDown() async throws {
                try await BoundedKeyboardDownReadiness.run(backend: KeyboardDownReadinessBackend(now: { self.time }, proof: { deadline in
                    self.proofs += 1; self.time += self.proofCost; self.duringAX?()
                    try self.identity() // The real sample must pass this before it may return a transient result.
                    if self.permanent || self.transient > 0 {
                        self.transient = max(0, self.transient - 1)
                        guard TransientKeyboardAXRead.mayWait(focused: nil, error: self.axError, stage: "focused-window", now: self.time, deadline: deadline) else {
                            throw ComputerError("FOCUS_CHANGED", "fake non-transient AX refusal")
                        }
                        return .temporarilyUnavailable
                    }
                    // Every ready result reads a fresh complete root and exact CG proof.
                    try ExactKeyboardFocus.check(target: self.target, geometry: self.geometry, before: self.windowsBefore ?? [self.a, self.b], after: self.windowsAfter ?? [self.a, self.b],
                        beforePid: self.beforePid, afterPid: self.afterPid, focused: self.root, processIdentityCurrent: self.birth)
                    return .ready
                }, metadata: { deadline, checkpoint in
                    self.metadataChecks += 1; try checkpoint(); try self.identity(); self.time += self.metadataCost; try checkpoint()
                    guard self.time < deadline else { throw ComputerError("FOCUS_CHANGED", "fake independent metadata deadline") }
                }, sleep: { ns in self.sleeps += 1; self.time += Double(ns) / 1_000_000_000; self.onSleep?(); await Task.yield() }), budget: budget,
                    checkpoint: { try self.checkpoint() })
                posts += 1; ups += 1 // Fake immediate pair only; no CGEvent is created or posted.
            }
        }
        var cases = [String]()
        do {
            let f = Fake(); f.transient = 1; try await f.nextDown()
            precondition(f.proofs == 2 && f.sleeps == 1 && f.metadataChecks == 2 && f.posts == 1 && f.ups == 1)
            cases.append("cannotComplete-yields-with-independent-identity-and-fresh-full-AX-before-one-down")
        }
        do {
            let f = Fake(); for _ in 0..<3 { try await f.nextDown() }
            precondition(f.proofs == 3 && f.posts == 3 && f.ups == 3 && f.sleeps == 0 && f.budget.remaining == 0.5)
            cases.append("every-new-down-needs-new-full-proof-without-cached-AX")
        }
        do {
            let f = Fake(); f.permanent = true
            do { try await f.nextDown(); preconditionFailure("Permanent AX unavailability posted input") }
            catch let error as ComputerError { precondition(error.code == "FOCUS_CHANGED") }
            precondition(f.posts == 0 && f.ups == 0 && f.sleeps > 0 && f.time <= 0.501, "The single shared recovery budget cannot renew")
            cases.append("permanent-cannotComplete-exhausts-shared-500ms-zero-new-downs")
        }
        do {
            let f = Fake(); f.transient = 20; try await f.nextDown()
            let firstRemaining = f.budget.remaining, firstProofs = f.proofs
            precondition(firstRemaining > 0 && firstRemaining < 0.21 && f.posts == 1)
            f.permanent = true
            do { try await f.nextDown(); preconditionFailure("A new character renewed the action retry budget") }
            catch let error as ComputerError { precondition(error.code == "FOCUS_CHANGED") }
            precondition(f.posts == 1 && f.ups == 1 && f.proofs > firstProofs && f.time <= 0.501,
                "Already completed characters are never replayed and later downs share the original remainder")
            cases.append("retry-budget-is-shared-across-characters-no-renewal-no-replay")
        }
        for error in [AXError.failure.rawValue, AXError.noValue.rawValue, AXError.attributeUnsupported.rawValue, AXError.success.rawValue] {
            let f = Fake(); f.permanent = true; f.axError = error
            do { try await f.nextDown(); preconditionFailure("A non-cannotComplete error was retried") }
            catch let e as ComputerError { precondition(e.code == "FOCUS_CHANGED") }
            precondition(f.proofs == 1 && f.sleeps == 0 && f.posts == 0)
            cases.append("other-AX-error-\(error)-refuses-immediately")
        }
        do {
            let f = Fake(); f.transient = 1; f.onSleep = { f.root = KeyboardFocusSnapshot(pid: 99, frame: f.b.frame, isWindow: true, identityStable: true) }
            do { try await f.nextDown(); preconditionFailure("A sibling focused root was swallowed by retry") }
            catch let e as ComputerError { precondition(e.code == "FOCUS_CHANGED") }
            precondition(f.proofs == 2 && f.sleeps == 1 && f.posts == 0)
            cases.append("fresh-AX-reveals-sibling-focus-immediate-zero-down-refusal")
        }
        for kind in ["geometry", "prefix", "same-geometry-sibling", "foreground", "process-birth"] {
            let f = Fake(); f.permanent = true
            f.duringAX = {
                switch kind {
                case "geometry": f.windowsAfter = [FocusWindowState(windowId: 11, pid: 99, frame: f.frame.offsetBy(dx: 8, dy: 0))]
                case "prefix": f.windowsAfter = [f.b, f.a]
                case "same-geometry-sibling": f.windowsAfter = [f.a, FocusWindowState(windowId: 33, pid: 99, frame: f.frame)]
                case "foreground": f.afterPid = 88
                case "process-birth": f.birth = false
                default: preconditionFailure("Unknown retry identity case")
                }
            }
            do { try await f.nextDown(); preconditionFailure("Identity drift was treated as transient AX") }
            catch let e as ComputerError { precondition(["FOCUS_CHANGED", "GEOMETRY_CHANGED", "TARGET_GONE"].contains(e.code)) }
            precondition(f.proofs == 1 && f.sleeps == 0 && f.posts == 0)
            cases.append("cannotComplete-with-" + kind + "-drift-never-retries")
        }
        for kind in ["epoch", "human", "owner", "permission", "held-key", "owned-release", "cursor", "foreground", "geometry", "same-geometry-sibling", "process-birth"] {
            let f = Fake(); f.permanent = true
            f.onSleep = {
                switch kind {
                case "epoch": f.fence.release(10)
                case "human": f.generation = 8
                case "owner": f.owner = "next-owner"
                case "permission": f.permission = false
                case "held-key": f.held = 1
                case "owned-release": f.releases = 1
                case "cursor": f.cursorBlocked = true
                case "foreground": f.afterPid = 88
                case "geometry": f.windowsAfter = [FocusWindowState(windowId: 11, pid: 99, frame: f.frame.offsetBy(dx: 8, dy: 0))]
                case "same-geometry-sibling": f.windowsAfter = [f.a, FocusWindowState(windowId: 33, pid: 99, frame: f.frame)]
                case "process-birth": f.birth = false
                default: preconditionFailure("Unknown retry await case")
                }
            }
            do { try await f.nextDown(); preconditionFailure("Await invalidation was ignored") }
            catch is ComputerError {}
            precondition(f.proofs == 1 && f.sleeps == 1 && f.posts == 0)
            cases.append("await-" + kind + "-change-stops-before-new-AX-or-down")
        }
        for duringWait in [false, true] {
            let f = Fake(); f.permanent = true
            if duringWait { f.onSleep = { withUnsafeCurrentTask { $0?.cancel() } } }
            let child = Task { @MainActor in
                if !duringWait { withUnsafeCurrentTask { $0?.cancel() } }
                try await f.nextDown()
            }
            do { try await child.value; preconditionFailure("Actual Swift retry cancellation was ignored") } catch is CancellationError {}
            precondition(f.posts == 0 && f.proofs == (duringWait ? 1 : 0) && f.sleeps == (duringWait ? 1 : 0) && !Task.isCancelled)
            cases.append("actual-swift-task-cancel-" + (duringWait ? "during-wait" : "before-proof"))
        }
        do {
            let f = Fake(); f.proofCost = 0.061
            do { try await f.nextDown(); preconditionFailure("A proof exceeded its original 60 ms deadline") }
            catch let e as ComputerError { precondition(e.code == "FOCUS_CHANGED") }
            precondition(f.posts == 0 && f.sleeps == 0)
            cases.append("full-proof-original-60ms-cap-still-blocks-new-down")
        }
        do {
            let f = Fake(); f.permanent = true; f.metadataCost = 0.025
            do { try await f.nextDown(); preconditionFailure("Metadata proofs renewed the wait budget") }
            catch is ComputerError {}
            precondition(f.posts == 0 && f.sleeps < 10 && f.time <= 0.526,
                "Independent metadata proof time is charged and deadline overrun fails without input")
            cases.append("independent-metadata-time-charges-same-budget-no-extra-down")
        }
        do {
            let root = KeyboardFocusSnapshot(pid: 99, frame: CGRect(x: 1, y: 2, width: 3, height: 4), isWindow: true, identityStable: true)
            precondition(!TransientKeyboardAXRead.mayWait(focused: root, error: AXError.cannotComplete.rawValue, stage: "focused-window", now: 0, deadline: 1))
            precondition(!TransientKeyboardAXRead.mayWait(focused: nil, error: AXError.cannotComplete.rawValue, stage: "deadline", now: 0, deadline: 1))
            precondition(TransientKeyboardAXRead.mayWait(focused: nil, error: AXError.cannotComplete.rawValue, stage: "focused-window", now: 1, deadline: 1))
            // Waiting is not an accepted proof; BoundedKeyboardDownReadiness
            // still rejects every expired ready result before a new Down.
            cases.append("retry-eligibility-refuses-existing-root-and-classifies-expired-cannotComplete-only-as-wait")
        }
        var terminalCases = [String]()
        for kind in ["unchanged", "epoch", "human", "owner", "permission", "held-key", "owned-release", "geometry", "foreground", "process-birth", "cancel"] {
            let f = Fake(); var postCalls = 0, releaseCalls = 0, trace = [String]()
            let child = Task { @MainActor in
                try await OwnedKeyboardPairDelivery.run(verifyBeforeDown: {
                    try ExactKeyboardFocus.check(target: f.target, geometry: f.geometry, before: [f.a, f.b], after: [f.a, f.b],
                        beforePid: 99, afterPid: 99, focused: f.root, processIdentityCurrent: true)
                    trace.append("full-AX-proof-ready")
                    await Task.yield()
                    trace.append("async-proof-returned")
                }, verifyImmediatelyBeforePost: {
                    // Inject at the exact post-await/pre-post seam. A fresh AX
                    // proof cannot exempt this later synchronous safety check.
                    trace.append("terminal-check")
                    switch kind {
                    case "epoch": f.fence.release(10)
                    case "human": f.generation = 8
                    case "owner": f.owner = "successor-owner"
                    case "permission": f.permission = false
                    case "held-key": f.held = 1
                    case "owned-release": f.releases = 1
                    case "geometry": f.windowsAfter = [FocusWindowState(windowId: 11, pid: 99, frame: f.frame.offsetBy(dx: 8, dy: 0))]
                    case "foreground": f.afterPid = 88
                    case "process-birth": f.birth = false
                    case "cancel": withUnsafeCurrentTask { $0?.cancel() }
                    default: break
                    }
                    var reads = 0
                    try ExactKeyboardCompletion.check(target: f.target, geometry: f.geometry, backend: KeyboardCompletionBackend(
                        windows: { reads += 1; return (reads == 1 ? f.windowsBefore : f.windowsAfter) ?? [f.a, f.b] },
                        frontmost: { reads == 1 ? f.beforePid : f.afterPid }, processIdentityCurrent: { f.birth }),
                        checkpoint: { try f.checkpoint() })
                }, postDown: { trace.append("down"); postCalls += 1 }, hold: {}, releaseUp: {
                    trace.append("up"); releaseCalls += 1
                }, verifyAfterUp: { try f.checkpoint() })
            }
            if kind == "unchanged" {
                try await child.value
                precondition(postCalls == 1 && releaseCalls == 1 && trace == ["full-AX-proof-ready", "async-proof-returned", "terminal-check", "down", "up"])
            } else {
                do { try await child.value; preconditionFailure("Post-await invalidation reached a new down") }
                catch is ComputerError { precondition(kind != "cancel") }
                catch is CancellationError { precondition(kind == "cancel") }
                precondition(postCalls == 0 && releaseCalls == 0 && trace == ["full-AX-proof-ready", "async-proof-returned", "terminal-check"])
            }
            precondition(!Task.isCancelled)
            terminalCases.append("post-await-terminal-" + kind)
        }
        precondition(terminalCases.count == 11)
        print("KeyboardPostAwait pure matrix: " + String(data: try JSONSerialization.data(withJSONObject: ["passed": true,
            "caseCount": terminalCases.count, "cases": terminalCases, "realSwiftTaskCancellation": true,
            "nativeInputEvents": 0, "realAXReads": 0], options: [.sortedKeys]), encoding: .utf8)!)
        precondition(cases.count == 30)
        let receipt: [String: Any] = ["passed": true, "cases": cases, "caseCount": cases.count, "fakeCallbacksOnly": true,
            "realSwiftTaskCancellation": true, "guiStarted": 0, "realAXReads": 0, "nativeInputEvents": 0,
            "sharedActionRetryBudgetMs": 500, "fullProofLimitMs": 60, "maximumYieldMs": 10, "eventDeliveryAcknowledged": false]
        print("KeyboardDownReadiness pure matrix: " + String(data: try JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys]), encoding: .utf8)!)
    }

    @MainActor private static func boundedFocusPreparation() async throws {
        final class Fake {
            var time = 0.0, requests = 0, samples = 0, foreground: pid_t? = 42
            var accepted = true, sequence: [pid_t?] = [42, 99, 99]
            var frontmostWindowId: CGWindowID? = 11, windowSequence: [CGWindowID?] = []
            var readError: ComputerError?, requestError: ComputerError?, sampleCost = 0.0, requestCost = 0.0
            var onSleep: (() throws -> Void)?, afterSample: (() -> Void)?
            var records = [[String: Any]]()
            var diagnosticValues = [String: Any]()
            var backend: FocusPreparationBackend {
                FocusPreparationBackend(now: { self.time }, frontmost: { self.foreground }, request: { _, result in
                    self.requests += 1; result.accepted = self.accepted; self.time += self.requestCost
                    result.axSettableResult = 0; result.axFrontmostResult = 0
                    if let error = self.requestError { throw error }
                }, sample: {
                    self.samples += 1; self.time += self.sampleCost
                    if let error = self.readError { throw error }
                    if !self.sequence.isEmpty { self.foreground = self.sequence.removeFirst() }
                    if !self.windowSequence.isEmpty { self.frontmostWindowId = self.windowSequence.removeFirst() }
                    self.afterSample?()
                    return FocusPreparationSample(frontmostPid: self.foreground, frontmostWindowId: self.frontmostWindowId)
                }, sleep: { nanos in self.time += Double(nanos) / 1_000_000_000; try self.onSleep?() },
                diagnostics: { self.diagnosticValues })
            }
            func run(_ checkpoint: () throws -> Void = {}) async throws {
                try await BoundedFocusPreparation.run(targetPid: 99, targetWindowId: 11, backend: backend, checkpoint: checkpoint, record: { self.records.append($0) })
            }
        }
        do {
            let f = Fake(); f.sequence = [99, 99]; f.frontmostWindowId = 22
            var posts = 0
            do { try await f.run(); posts += 1 } catch let error as ComputerError { precondition(error.code == "FOCUS_CHANGED") }
            precondition(posts == 0 && f.requests == 1, "Same-PID B-front/A-selected must remain zero-post and cannot replay activation")
        }
        do {
            let f = Fake(); f.foreground = 99; f.sequence = []; f.windowSequence = [11, 22, 11, 11]
            try await f.run()
            precondition(f.samples == 4 && f.requests == 1, "Switching between same-process windows resets consecutive readiness")
        }
        do {
            let f = Fake(); f.foreground = 99; f.sequence = []; f.frontmostWindowId = nil
            do { try await f.run(); preconditionFailure("Unknown foreground window accepted") } catch let error as ComputerError { precondition(error.code == "FOCUS_CHANGED") }
        }
        do {
            let f = Fake(); f.sequence = [42, 99, 42, 99, 99]
            try await f.run()
            precondition(f.requests == 1 && f.samples == 5 && f.time < 0.5, "A transient foreground match cannot satisfy two consecutive reads; no activation replay")
            let value = f.records.last!
            precondition(value["beforePid"] as? Int32 == 42 && value["afterPid"] as? Int32 == 99 && value["inputPosted"] as? Bool == false)
            precondition(value["preparationPhase"] as? String == "ready" && value["readinessSamples"] as? Int == 5 && value["consecutiveReadinessSamples"] as? Int == 2)
            precondition(Set(value.keys) == Set(["targetPid", "beforePid", "afterPid", "activationAccepted", "settledMs", "axSettableResult", "axFrontmostResult", "raiseResult", "inputPosted", "preparationPhase", "readinessSamples", "consecutiveReadinessSamples"]), "Focus status contains only bounded owner diagnostics, never titles, paths or text")
        }
        do {
            let f = Fake(); f.accepted = false; f.sequence = [99, 99]
            f.diagnosticValues = ["targetPid": -1, "beforePid": -1, "afterPid": -1, "inputPosted": true,
                "activationAccepted": true, "settledMs": -1, "preparationPhase": "forged", "readinessSamples": 999,
                "consecutiveReadinessSamples": 999, "metadataSamples": 17, "componentProofCalls": 2,
                "componentProofMs": 12, "acceptedComponentProofs": 1, "componentProofStage": "complete", "componentAXError": NSNull()]
            try await f.run()
            let value = f.records.last!
            precondition(f.requests == 1 && f.samples == 2, "Diagnostic success never substitutes for the two real exact-window readiness samples")
            precondition(value["targetPid"] as? Int == 99 && value["beforePid"] as? Int32 == 42 && value["afterPid"] as? Int32 == 99 && value["inputPosted"] as? Bool == false,
                "Backend diagnostic collisions cannot replace selected identity or claim an input post")
            precondition(value["activationAccepted"] as? Bool == false && value["settledMs"] as? Int == 10 &&
                value["preparationPhase"] as? String == "ready" && value["readinessSamples"] as? Int == 2 && value["consecutiveReadinessSamples"] as? Int == 2,
                "Control-owned progress and acceptance fields cannot be forged by a diagnostic hook")
            precondition(value["metadataSamples"] as? Int == 17 && value["componentProofCalls"] as? Int == 2 &&
                value["componentProofMs"] as? Int == 12 && value["acceptedComponentProofs"] as? Int == 1 && value["componentProofStage"] as? String == "complete",
                "Independent bounded metadata counters survive alongside authoritative readiness fields")
            precondition(f.records.first?["preparationPhase"] as? String == "request" && f.records.first?["readinessSamples"] as? Int == 0)
            precondition(f.records.filter { $0["preparationPhase"] as? String == "ready" }.count == 1,
                "Only the completed strict preparation emits its terminal ready receipt")
        }
        do {
            let f = Fake(); f.accepted = false; f.sequence = [99, 99]
            try await f.run()
            precondition(f.requests == 1 && f.records.last?["activationAccepted"] as? Bool == false, "Request acceptance is not the foreground readiness oracle")
        }
        do {
            let f = Fake(); f.sequence = []
            f.diagnosticValues = ["activationAccepted": true, "inputPosted": true, "preparationPhase": "ready",
                "readinessSamples": 999, "consecutiveReadinessSamples": 2, "acceptedComponentProofs": 3]
            do { try await f.run(); preconditionFailure("Unfocused target accepted") } catch let error as ComputerError { precondition(error.code == "FOCUS_CHANGED") }
            precondition(f.requests == 1 && f.time <= 0.500001 && f.records.last?["inputPosted"] as? Bool == false, "Deadline cannot retry activation or post input")
            precondition(f.records.last?["preparationPhase"] as? String == "readiness" && f.records.last?["readinessSamples"] as? Int == f.samples && f.records.last?["consecutiveReadinessSamples"] as? Int == 0,
                "Diagnostic acceptance/proof counters do not make an unfocused target ready; timeout records the actual readiness attempts")
            precondition(!f.records.contains { $0["preparationPhase"] as? String == "ready" })
        }
        do {
            let f = Fake(); f.readError = ComputerError("GEOMETRY_CHANGED", "fake")
            f.diagnosticValues = ["componentProofStage": "copy-focused-window", "componentAXError": Int32(-25204)]
            do { try await f.run(); preconditionFailure("Changed geometry accepted") } catch let error as ComputerError { precondition(error.code == "GEOMETRY_CHANGED") }
            precondition(f.samples == 1 && f.requests == 1)
            precondition(f.records.last?["preparationPhase"] as? String == "readiness" && f.records.last?["readinessSamples"] as? Int == 1 && f.records.last?["consecutiveReadinessSamples"] as? Int == 0,
                "A throwing readiness read records its attempt without claiming a valid consecutive observation")
            precondition(f.records.last?["componentProofStage"] as? String == "copy-focused-window" && f.records.last?["componentAXError"] as? Int32 == -25204 && f.records.last?["inputPosted"] as? Bool == false,
                "A failed read retains its finite backend diagnostic without changing the geometry rejection")
        }
        do {
            let f = Fake(); var generation = 1
            f.onSleep = { generation += 1 }
            do { try await f.run { if generation != 1 { throw ComputerError("HUMAN_INPUT_INTERRUPTED", "fake") } }; preconditionFailure("Human intervention ignored") }
            catch let error as ComputerError { precondition(error.code == "HUMAN_INPUT_INTERRUPTED") }
            precondition(f.samples == 1 && f.requests == 1, "Human input during focus preparation aborts before the next readiness read")
        }
        do {
            let f = Fake(), fence = EpochFence(); try fence.lease(8)
            f.onSleep = { fence.release(8) }
            do { try await f.run { try fence.check(8) }; preconditionFailure("Revoked preparation accepted") }
            catch let error as ComputerError { precondition(error.code == "STALE_EPOCH") }
            precondition(f.samples == 1 && f.requests == 1)
        }
        do {
            let f = Fake(); f.sequence = [99, 99]; f.onSleep = { throw CancellationError() }
            do { try await f.run(); preconditionFailure("Cancelled preparation accepted") } catch is CancellationError {}
            precondition(f.requests == 1 && f.samples == 1 && f.records.last?["inputPosted"] as? Bool == false)
            precondition(f.records.last?["preparationPhase"] as? String == "readiness" && f.records.last?["readinessSamples"] as? Int == 1 && f.records.last?["consecutiveReadinessSamples"] as? Int == 1,
                "Cancellation after one exact match preserves that observation but never claims the second or terminal readiness")
        }
        do {
            let f = Fake(); f.requestError = ComputerError("STALE_EPOCH", "fake")
            f.diagnosticValues = ["preparationPhase": "ready", "readinessSamples": 999, "inputPosted": true]
            do { try await f.run(); preconditionFailure("Failed activation preparation accepted") } catch let error as ComputerError { precondition(error.code == "STALE_EPOCH") }
            precondition(f.samples == 0 && f.records.last?["activationAccepted"] as? Bool == true, "Partial activation receipt survives later failure without claiming input")
            precondition(f.records.last?["preparationPhase"] as? String == "request" && f.records.last?["readinessSamples"] as? Int == 0 && f.records.last?["consecutiveReadinessSamples"] as? Int == 0 && f.records.last?["inputPosted"] as? Bool == false,
                "Request failure retains its actual phase and zero reads even when diagnostics claim success")
        }
        do {
            let f = Fake(); f.requestCost = 0.51; f.sequence = [99, 99]
            do { try await f.run(); preconditionFailure("Late request accepted") } catch let error as ComputerError { precondition(error.code == "FOCUS_CHANGED") }
            precondition(f.samples == 0 && f.requests == 1)
        }
        do {
            let f = Fake(); f.sequence = [99, 99]; f.sampleCost = 0.25
            do { try await f.run(); preconditionFailure("Readiness arriving beyond budget accepted") } catch let error as ComputerError { precondition(error.code == "FOCUS_CHANGED") }
            precondition(f.samples == 2)
            precondition(f.records.last?["preparationPhase"] as? String == "readiness" && f.records.last?["readinessSamples"] as? Int == 2 && f.records.last?["consecutiveReadinessSamples"] as? Int == 1,
                "A sample returning beyond the budget is recorded without completing the consecutive readiness requirement")
        }
        do {
            let f = Fake(); var valid = true; f.sequence = [99, 99]; f.afterSample = { valid = false }
            do { try await f.run { if !valid { throw ComputerError("STALE_EPOCH", "fake") } }; preconditionFailure("Epoch revoked inside readiness read accepted") }
            catch let error as ComputerError { precondition(error.code == "STALE_EPOCH") }
            precondition(f.samples == 1)
        }
    }

    /// Observe actual main-runloop work, not a fixed sleep that assumes a timer ran.
    /// The deadline only bounds the test; production restoration keeps its own 500ms limit.
    @MainActor private static func awaitCursorEvent(timeout: TimeInterval, install: (@escaping () -> Void) -> Void) async -> Bool {
        await withCheckedContinuation { continuation in
            var finished = false
            let expiry = Timer(timeInterval: timeout, repeats: false) { _ in MainActor.assumeIsolated {
                guard !finished else { return }
                finished = true; continuation.resume(returning: false)
            } }
            RunLoop.main.add(expiry, forMode: .common)
            install {
                guard !finished else { return }
                finished = true; expiry.invalidate(); continuation.resume(returning: true)
            }
        }
    }

    @MainActor private static func cursorSuppressionStateMachine() async throws {
        final class Fake {
            var calls = [String](), propertyValue: Bool? = false, connection = true, setWorks = true
            var readOverride: ((Bool?) -> Bool?)?, onHide: (() -> Void)?
            var backend: CursorCounterBackend {
                CursorCounterBackend(unsupportedReason: nil, ownsConnection: { self.connection }, setBackground: { enabled in
                    self.calls.append(enabled ? "set-true" : "set-false"); if self.setWorks { self.propertyValue = enabled }; return self.setWorks
                }, property: { self.calls.append("copy"); if let readOverride = self.readOverride { return readOverride(self.propertyValue) }; return self.propertyValue },
                hide: { self.calls.append("hide"); self.onHide?() }, unhide: { self.calls.append("unhide") }, diagnostic: { ["fake": true] })
            }
            var hides: Int { calls.filter { $0 == "hide" }.count }
            var unhides: Int { calls.filter { $0 == "unhide" }.count }
        }
        let a = SystemCursorSuppression.Owner(epoch: 10, leaseOwnerId: "fake-owner-a", targetId: "own-window-a")
        let b = SystemCursorSuppression.Owner(epoch: 11, leaseOwnerId: "fake-owner-b", targetId: "own-window-b")
        do {
            let f = Fake(), c = SystemCursorSuppression(backend: f.backend)
            precondition(c.clear && f.calls.isEmpty, "Status/idle construction never hides")
            precondition(!c.activate(a, eligible: { false }) && f.calls.isEmpty, "No cursor mutation without actual eligibility")
            for _ in 0..<24 { precondition(c.activate(a, eligible: { true })) }
            precondition(f.hides == 1 && c.ownsHide && c.ownsProperty, "One Hide for all events of the physical AI owner")
            precondition(c.restore("release") && c.restore("EOF") && c.restore("termination"))
            precondition(f.calls == ["copy", "set-true", "copy", "hide", "copy", "unhide", "set-false", "copy"], "The same-CID copy fences bracket a single matched counter pair")
        }
        do {
            var mutations = 0
            let backend = CursorCounterBackend(unsupportedReason: "SPI_UNAVAILABLE", ownsConnection: { false }, setBackground: { _ in mutations += 1; return false }, property: { nil }, hide: { mutations += 1 }, unhide: { mutations += 1 }, diagnostic: { [:] })
            let c = SystemCursorSuppression(backend: backend)
            precondition(!c.activate(a, eligible: { true }) && c.restore("normal-preview") && c.phase == "unsupported" && mutations == 0, "Unsupported capability does not break unrelated preview/input")
        }
        do {
            let f = Fake(); f.connection = false; let c = SystemCursorSuppression(backend: f.backend)
            precondition(!c.activate(a, eligible: { true }) && f.calls.isEmpty && c.phase == "unsupported", "An unverified connection is explicitly unsupported and never mutated")
        }
        do {
            let f = Fake(); f.propertyValue = true; let c = SystemCursorSuppression(backend: f.backend)
            precondition(!c.activate(a, eligible: { true }) && c.phase == "unsupported" && c.clear && f.calls == ["copy"], "Pre-existing true belongs to neither our counter nor our property cleanup")
            precondition(c.restore("teardown") && f.calls == ["copy"], "Unsupported baseline must never be reset to false")
        }
        do {
            let f = Fake(); f.readOverride = { _ in false }; let c = SystemCursorSuppression(backend: f.backend)
            precondition(!c.activate(a, eligible: { true }) && f.hides == 0 && c.clear && c.phase == "unsupported", "Unconfirmed true is cleaned without Hide")
        }
        do {
            let f = Fake(); f.readOverride = { _ in nil }; let c = SystemCursorSuppression(backend: f.backend)
            precondition(!c.activate(a, eligible: { true }) && f.hides == 0 && c.ownsProperty && !c.ownsHide, "Unknown/non-Boolean readback never hides or forgets uncertain property cleanup")
            f.readOverride = nil; precondition(c.restore("readback-recovered") && c.clear && f.unhides == 0)
        }
        do {
            let f = Fake(); f.setWorks = false; let c = SystemCursorSuppression(backend: f.backend)
            precondition(!c.activate(a, eligible: { true }) && f.hides == 0 && c.ownsProperty)
            f.setWorks = true; precondition(c.restore("setter-recovered") && c.clear && f.unhides == 0)
        }
        do {
            let f = Fake(), c = SystemCursorSuppression(backend: f.backend); var eligibilityChecks = 0
            precondition(!c.activate(a, eligible: { eligibilityChecks += 1; return eligibilityChecks < 4 }))
            precondition(f.hides == 0 && c.clear, "Authorization is rechecked after the property roundtrip")
        }
        do {
            let f = Fake(), c = SystemCursorSuppression(backend: f.backend); var eligible = true
            f.onHide = { eligible = false }
            precondition(!c.activate(a, eligible: { eligible }) && f.hides == 1 && f.unhides == 1 && c.clear, "Post-Hide authorization loss immediately balances its own count")
        }
        do {
            let f = Fake(), c = SystemCursorSuppression(backend: f.backend)
            precondition(c.activate(a, eligible: { true })); precondition(c.interrupt(10, reason: "human"))
            precondition(!c.activate(a, eligible: { true }) && f.hides == 1, "Human intervention latches out later posted events of the same physical epoch")
            c.beginLease(10); precondition(c.interrupted(10)); c.beginLease(11)
            precondition(c.activate(b, eligible: { true }) && f.hides == 2)
            _ = c.interrupt(10, reason: "stale-human-callback"); _ = c.restore("stale-timer", expectedOwner: a)
            precondition(c.owner == b && c.ownsHide && f.unhides == 1, "Late old-owner callbacks cannot release the new owner")
            precondition(c.restore("release-b"))
        }
        do {
            let f = Fake(), c = SystemCursorSuppression(backend: f.backend), overlay = AICursorOverlay(suppression: c)
            let target = NativeTarget(id: a.targetId, appId: "own.fake", title: "own", pid: 99, windowId: 99, frame: CGRect(x: 0, y: 0, width: 640, height: 480), scale: 1)
            overlay.isLeaseCurrent = { _ in false }; overlay.physicalLeaseOwner = { _ in "fake-owner-a" }
            overlay.posted(.zero, phase: "moving", epoch: 10, target: target)
            overlay.isLeaseCurrent = { _ in true }; overlay.physicalLeaseOwner = { _ in nil }
            overlay.posted(.zero, phase: "moving", epoch: 10, target: target)
            precondition(f.calls.isEmpty && c.clear, "Human actor, stale/absent physical lease and unowned status never mutate the cursor or create a panel")
            overlay.isLeaseCurrent = { $0 == 10 }; overlay.physicalLeaseOwner = { $0 == 10 ? "fake-owner-a" : nil }
            precondition(overlay.humanIntervened(10), "Human input before any panel/point still latches the real physical epoch")
            overlay.posted(.zero, phase: "moving", epoch: 10, target: target)
            precondition(c.interrupted(10) && f.calls.isEmpty, "A later first posted event of that epoch cannot Hide or create a panel")
            c.beginLease(11); precondition(c.activate(b, eligible: { true }))
            _ = overlay.humanIntervened(10)
            precondition(c.ownsHide && c.owner == b && f.unhides == 0, "Stale old-epoch human callback cannot restore a new owner")
            precondition(c.restore("test-end"))
        }
        do {
            let f = Fake(), c = SystemCursorSuppression(backend: f.backend), overlay = AICursorOverlay(suppression: c)
            precondition(c.activate(a, eligible: { true }))
            overlay.withdrawForPointerReadback(epoch: 9, targetId: a.targetId)
            overlay.withdrawForPointerReadback(epoch: 10, targetId: "different-window")
            precondition(c.ownsHide && f.unhides == 0, "Unknown/stale geometry cannot restore someone else's active cursor")
            overlay.withdrawForPointerReadback(epoch: 10, targetId: a.targetId)
            precondition(c.clear && f.unhides == 1, "Pointer delivery delay restores immediately without waiting for the visual 120ms timeout")
        }
        do {
            let f = Fake(), c = SystemCursorSuppression(backend: f.backend), overlay = AICursorOverlay(suppression: c)
            precondition(c.activate(a, eligible: { true })); f.setWorks = false
            overlay.withdrawForPointerReadback(epoch: 10, targetId: a.targetId)
            precondition(!overlay.hide() && c.ownsProperty && f.unhides == 1)
            var independentRetryObserved = false
            let restored = await awaitCursorEvent(timeout: 0.1) { observed in
                overlay.onSuppressionTransition = { value in
                    if value["phase"] as? String == "restoring" && value["reason"] as? String == "pending-restoration" { independentRetryObserved = true }
                    if independentRetryObserved && c.clear && overlay.restorationComplete { observed() }
                }
                // Recover on a later main-queue turn; only the independent
                // production timer may complete the pending property reset.
                DispatchQueue.main.async { f.setWorks = true }
            }
            overlay.onSuppressionTransition = nil
            precondition(restored && independentRetryObserved && c.clear && overlay.restorationComplete && f.unhides == 1, "Independent restoration timer survives panel/target teardown and never repeats Unhide")
            precondition(c.activate(b, eligible: { true }))
            let witness = await awaitCursorEvent(timeout: 0.1) { observed in
                let nextTurn = Timer(timeInterval: 0.04, repeats: false) { _ in MainActor.assumeIsolated { observed() } }
                RunLoop.main.add(nextTurn, forMode: .common)
            }
            precondition(witness && c.owner == b && c.ownsHide && f.unhides == 1, "A retired restoration timer cannot touch a later owner")
            precondition(c.restore("test-end"))
        }
        do {
            let f = Fake(), c = SystemCursorSuppression(backend: f.backend), overlay = AICursorOverlay(suppression: c); var failures = 0
            precondition(c.activate(a, eligible: { true })); f.readOverride = { _ in false }
            let failureDeadline = ProcessInfo.processInfo.systemUptime + 0.65
            let failureObserved = await awaitCursorEvent(timeout: 0.65) { observed in
                overlay.onRestorationFailure = { failures += 1; observed() }
                overlay.withdrawForPointerReadback(epoch: 10, targetId: a.targetId)
            }
            let failureSettled = await awaitCursorEvent(timeout: max(0, failureDeadline - ProcessInfo.processInfo.systemUptime)) { observed in
                // Keep observing beyond another production timer period so a
                // repeated failure callback cannot masquerade as exactly once.
                let nextTurn = Timer(timeInterval: 0.04, repeats: false) { _ in MainActor.assumeIsolated { observed() } }
                RunLoop.main.add(nextTurn, forMode: .common)
            }
            overlay.onRestorationFailure = nil
            precondition(failureObserved && failureSettled && failures == 1 && c.ownsHide && c.ownsProperty && f.unhides == 0, "Bounded recovery reports failure once without forgetting owned counter/property")
            f.readOverride = nil; precondition(overlay.hide() && f.unhides == 1)
        }
        do {
            let f = Fake(), c = SystemCursorSuppression(backend: f.backend); precondition(c.activate(a, eligible: { true }))
            f.readOverride = { _ in false }
            precondition(!c.restore("focus-loss") && c.ownsHide && c.ownsProperty && f.unhides == 0)
            precondition(!c.activate(a, eligible: { true }), "An unrestored same owner cannot be reported active again")
            precondition(!c.activate(b, eligible: { true }) && f.hides == 1, "An unconfirmed old owner blocks a new physical owner")
            f.readOverride = nil; precondition(c.restore("pending-restoration") && c.clear && f.unhides == 1)
        }
        do {
            let f = Fake(), c = SystemCursorSuppression(backend: f.backend); precondition(c.activate(a, eligible: { true }))
            f.setWorks = false
            precondition(!c.restore("sleep") && !c.ownsHide && c.ownsProperty && f.unhides == 1)
            for _ in 0..<3 { precondition(!c.restore("pending-after-panel-closed")) }
            precondition(f.unhides == 1, "Pending reset survives panel teardown without a second Unhide")
            f.setWorks = true; precondition(c.restore("pending-restoration") && c.clear && f.unhides == 1)
        }
        do {
            let f = Fake(), c = SystemCursorSuppression(backend: f.backend); precondition(c.activate(a, eligible: { true }))
            f.readOverride = { value in value == false ? true : value }
            precondition(!c.restore("session-inactive") && !c.ownsHide && c.ownsProperty)
            f.readOverride = nil; precondition(c.restore("reset-readback-retry") && f.unhides == 1)
        }
        for reason in ["focus-loss", "geometry-change", "target-exit", "pending-pointer-timeout", "sleep", "session-inactive", "EOF", "action-error"] {
            let f = Fake(), c = SystemCursorSuppression(backend: f.backend); precondition(c.activate(a, eligible: { true }))
            precondition(c.restore(reason) && c.restore("termination") && f.hides == 1 && f.unhides == 1)
        }
        for (cursorOK, heldOK) in [(false, true), (true, false), (false, false), (true, true)] {
            var sequence = [String]()
            do {
                try completeOwnedInputCleanup(restoreCursor: { sequence.append("cursor"); return cursorOK }, releaseHeld: { sequence.append("held"); if !heldOK { throw ComputerError("FAKE_HELD_FAILURE", "fake") } }, releaseDesktop: { sequence.append("unlock") })
                precondition(cursorOK && heldOK)
            } catch { precondition(!cursorOK || !heldOK) }
            precondition(sequence == (cursorOK && heldOK ? ["cursor", "held", "unlock"] : ["cursor", "held"]), "All cleanup paths attempt held input but retain global guard on either failure")
        }
    }

    private static func permissionGuideLifetime() {
        var state = PermissionGuideLifetime(), shown = 0
        func callback(_ revision: UInt64?) { if state.accepts(revision) { shown += 1 } }
        callback(nil)
        precondition(shown == 0, "A guide that was never opened cannot appear")
        let old = state.begin()
        callback(old); callback(nil)
        precondition(shown == 2, "The current timer and active drag completion may update the guide")
        state.end()
        callback(old); callback(nil)
        precondition(shown == 2, "Closing fences both queued timer and late drag completion before window cleanup")
        let reopened = state.begin()
        callback(old)
        precondition(shown == 2 && reopened != old, "A previous lifetime's queued timer cannot affect an explicitly reopened guide")
        callback(reopened)
        precondition(shown == 3, "An explicit new open can follow Settings again")
        state.end(); state.end()
        callback(reopened); callback(nil)
        precondition(shown == 3, "Repeated shutdown remains closed after all late callbacks")
    }

    private static func macControlTransportPolicy() throws {
        let fileManager = FileManager.default
        guard let temporaryRoot = MacSocketPathPolicy.canonicalDirectory("/tmp") else { preconditionFailure("The test socket requires a short POSIX temporary path") }
        let directory = URL(fileURLWithPath: temporaryRoot).appendingPathComponent("qyt-transport-policy-\(UUID().uuidString)")
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? fileManager.removeItem(at: directory) }
        guard let canonical = MacSocketPathPolicy.canonicalDirectory(directory.path) else { preconditionFailure("The test directory must have a POSIX canonical path") }
        precondition(MacSocketPathPolicy.canonicalDirectory(canonical) == canonical,
                     "A Node-compatible POSIX path remains canonical even if Foundation shortens /private/tmp or /private/var")
        let symbolic = directory.appendingPathComponent("alias")
        try fileManager.createSymbolicLink(atPath: symbolic.path, withDestinationPath: canonical)
        precondition(MacSocketPathPolicy.canonicalDirectory(symbolic.path) != symbolic.path,
                     "A symbolic-link control directory cannot pass the canonical-path comparison")
        let nonce = String(repeating: "a1", count: 32)
        let arguments = ["--qiuya-control-socket", "/private/tmp/qyt-test/control.sock", "--qiuya-control-nonce", nonce, "--qiuya-owner-pid", "123"]
        let parsed = try MacTransportArguments.parse(arguments)
        precondition(parsed == MacTransportArguments(socketPath: "/private/tmp/qyt-test/control.sock", nonce: nonce, ownerPid: 123), "The public LaunchServices argument schema parses exactly")
        let hosted = try MacTransportArguments.parse(arguments + ["--qiuya-hosted"])
        precondition(hosted == MacTransportArguments(socketPath: "/private/tmp/qyt-test/control.sock", nonce: nonce, ownerPid: 123, hosted: true), "Hosted mode is explicit and keeps the same authenticated socket fields")
        let standardInput = try MacTransportArguments.parse([]), fixture = try MacTransportArguments.parse(["--fixture"])
        precondition(standardInput == nil, "No transport arguments retains standard input")
        precondition(fixture == nil, "Existing nontransport fixture arguments retain standard input")
        var rejected = [Array(arguments.dropLast()), arguments + ["--extra", "x"], arguments + Array(arguments.prefix(2)),
                        arguments + ["--qiuya-hosted", "--qiuya-hosted"], arguments + ["--qiuya-hosted", "true"],
                        ["--qiuya-hosted"], ["--qiuya-unknown", "x"], ["--qiuya-control-socket", "/private/tmp/own.sock"]]
        for path in ["relative.sock", "/private/tmp/../other.sock", "/private/tmp/a\0b", "/private/tmp/a\nb", "//private/tmp/control.sock", "/private/tmp/./control.sock", "/private/tmp//control.sock", "/private/tmp/", "/" + String(repeating: "a", count: 103)] {
            var candidate = arguments; candidate[1] = path; rejected.append(candidate)
        }
        for invalidNonce in ["", String(repeating: "a", count: 63), String(repeating: "A", count: 64), String(repeating: "z", count: 64)] {
            var candidate = arguments; candidate[3] = invalidNonce; rejected.append(candidate)
        }
        for pid in ["0", "1", "-1", "0123", "123x", "2147483648", " 123", "123\n"] {
            var candidate = arguments; candidate[5] = pid; rejected.append(candidate)
        }
        for candidate in rejected {
            do { _ = try MacTransportArguments.parse(candidate); preconditionFailure("An ambiguous transport configuration was accepted") }
            catch { precondition((error as? ComputerError)?.code == "NATIVE_TRANSPORT_ARGUMENTS") }
        }
        let socketPath = canonical + "/control.sock", descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        precondition(descriptor >= 0 && socketPath.utf8.count <= 103)
        defer { Darwin.close(descriptor) }
        var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX); address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: Array(socketPath.utf8) + [0]) }
        let bound = withUnsafePointer(to: &address) { pointer in pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        precondition(bound == 0 && chmod(socketPath, 0o600) == 0, "The framing fixture uses a real private Unix socket")
        var liveSocketArguments = arguments; liveSocketArguments[1] = socketPath
        let liveSocket = try MacTransportArguments.parse(liveSocketArguments)
        precondition(liveSocket?.socketPath == socketPath, "An existing /private/tmp socket must not be rejected by Foundation's path abbreviation")
        let owner = MacProcessIdentity(pid: 123, uid: 501, startSeconds: 10, startMicroseconds: 50, uniqueId: 80)
        precondition(PermissionGuideApplication.parentIsCurrent(owner: owner, actual: owner, parentPid: 123), "Only the actual authenticated direct parent can own hosted authorization")
        precondition(!PermissionGuideApplication.parentIsCurrent(owner: owner, actual: owner, parentPid: 1), "LaunchServices parentage cannot masquerade as hosted authorization")
        precondition(!PermissionGuideApplication.parentIsCurrent(owner: owner, actual: nil, parentPid: 123), "An unavailable parent birth identity never inherits host authorization")
        precondition(MacOwnerPolicy.current(expected: owner, actual: owner, alive: true), "An unchanged live owner is accepted independently of launchd parentage")
        precondition(!MacOwnerPolicy.current(expected: owner, actual: owner, alive: false), "A retired owner cannot retain control")
        precondition(!MacOwnerPolicy.current(expected: owner, actual: nil, alive: true), "Unavailable birth information fails closed")
        for changed in [MacProcessIdentity(pid: 124, uid: 501, startSeconds: 10, startMicroseconds: 50, uniqueId: 80),
                        MacProcessIdentity(pid: 123, uid: 502, startSeconds: 10, startMicroseconds: 50, uniqueId: 80),
                        MacProcessIdentity(pid: 123, uid: 501, startSeconds: 11, startMicroseconds: 50, uniqueId: 80),
                        MacProcessIdentity(pid: 123, uid: 501, startSeconds: 10, startMicroseconds: 51, uniqueId: 80),
                        MacProcessIdentity(pid: 123, uid: 501, startSeconds: 10, startMicroseconds: 50, uniqueId: 81)] {
            precondition(!MacOwnerPolicy.current(expected: owner, actual: changed, alive: true), "PID reuse and changed owner identities cannot inherit the connection")
            precondition(!PermissionGuideApplication.parentIsCurrent(owner: owner, actual: changed, parentPid: 123), "Reused parent PIDs cannot nominate an authorization app")
        }
        var lifetime = MacTransportLifetime()
        precondition(!lifetime.markRetired(), "An unconnected process cannot issue a retirement receipt")
        precondition(lifetime.markReady() && !lifetime.markReady(), "The first ready frame is unique")
        precondition(lifetime.markRetired() && !lifetime.markRetired(), "Retirement is acknowledged once and cannot be upgraded by a late cleanup")
        lifetime.markClosed(); lifetime.markClosed()
        precondition(!lifetime.markReady() && !lifetime.markRetired(), "A closed transport cannot be resurrected by queued work")
        var closedEarly = MacTransportLifetime(); closedEarly.markClosed()
        precondition(!closedEarly.markReady(), "Closing before readiness suppresses a late handshake")
        var decoder = MacJSONLineDecoder(maximumBytes: 8)
        let firstChunk = try decoder.append(Data("{\"x\":".utf8))
        precondition(firstChunk.isEmpty)
        let lines = try decoder.append(Data("1}\n\n2\n3".utf8))
        precondition(lines == [Data("{\"x\":1}".utf8), Data("2".utf8)], "Split lines and multiple commands preserve framing without empty commands")
        let tail = try decoder.finish(), empty = try decoder.finish()
        precondition(tail == Data("3".utf8), "The existing final standard-input line remains compatible")
        precondition(empty == nil)
        var oversized = MacJSONLineDecoder(maximumBytes: 8)
        do { _ = try oversized.append(Data("123456789".utf8)); preconditionFailure("A missing newline escaped the line budget") }
        catch { precondition((error as? ComputerError)?.code == "NATIVE_MESSAGE_LIMIT") }
        var longLine = MacJSONLineDecoder(maximumBytes: 8)
        do { _ = try longLine.append(Data("123456789\n".utf8)); preconditionFailure("A complete oversized line escaped the line budget") }
        catch { precondition((error as? ComputerError)?.code == "NATIVE_MESSAGE_LIMIT") }
    }

    private static func permissionGuidePlacement() {
        let size = CGSize(width: 320, height: 84)
        let wide = CGRect(x: 0, y: 24, width: 1800, height: 1000)
        let leftSettings = CGRect(x: 100, y: 120, width: 720, height: 800)
        let right = PermissionGuidePlacement.frame(size: size, beside: leftSettings, in: wide)
        precondition(wide.contains(right) && right.minX > leftSettings.maxX && !right.intersects(leftSettings), "A free right-hand area keeps the list unobscured")
        let rightSettings = CGRect(x: 1050, y: 120, width: 720, height: 800)
        let left = PermissionGuidePlacement.frame(size: size, beside: rightSettings, in: wide)
        precondition(wide.contains(left) && left.maxX < rightSettings.minX && !left.intersects(rightSettings), "A free left-hand area is used when the right side does not fit")
        let secondary = CGRect(x: -1600, y: -900, width: 1600, height: 900)
        let negative = PermissionGuidePlacement.frame(size: size, beside: CGRect(x: -1500, y: -820, width: 720, height: 740), in: secondary)
        precondition(secondary.contains(negative) && negative.maxX < 0, "Negative-origin displays preserve AppKit coordinates")
        let small = CGRect(x: -400, y: -200, width: 900, height: 700)
        let cramped = PermissionGuidePlacement.frame(size: size, beside: small.insetBy(dx: 12, dy: 12), in: small)
        precondition(small.contains(cramped) && cramped.size == size, "A narrow screen still keeps the entire guide within its visible frame")
        precondition(cramped.maxX == small.maxX - 24 && cramped.maxY == small.maxY - 68,
                     "Without side room the compact card rests inside the upper-right edge of Settings")
        let clamped = PermissionGuidePlacement.clamped(CGRect(origin: CGPoint(x: -10000, y: 10000), size: size), to: small)
        precondition(small.contains(clamped) && clamped.minX == small.minX + 12 && clamped.maxY == small.maxY - 12, "Clamping respects the menu and Dock-safe visible frame")
        let undersized = CGRect(x: 20, y: 30, width: 200, height: 60)
        precondition(undersized.contains(PermissionGuidePlacement.clamped(CGRect(origin: .zero, size: size), to: undersized)), "Even a smaller-than-guide display yields bounded geometry")
    }

    @MainActor private static func permissionGuideApplicationIdentity() throws {
        let fileManager = FileManager.default
        let directory = fileManager.temporaryDirectory.appendingPathComponent("qiuya-permission-guide-selftest-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? fileManager.removeItem(at: directory) }
        guard let requirement = PermissionGuideApplication.trustedHostRequirement() else { preconditionFailure("The official host signing policy must compile as a Security requirement") }
        var requirementText: CFString?
        precondition(SecRequirementCopyString(requirement, SecCSFlags(rawValue: 0), &requirementText) == errSecSuccess)
        let signingPolicy = requirementText! as String
        precondition(signingPolicy.components(separatedBy: " and ").count == 5 && !signingPolicy.contains(" or "),
                     "Every official host constraint is mandatory, with no alternate identity or permissive fallback")
        for term in ["identifier \"com.deepseek.dsh\"", "anchor apple generic",
                     "certificate 1[field.1.2.840.113635.100.6.2.6]", "certificate leaf[field.1.2.840.113635.100.6.1.13]",
                     "certificate leaf[subject.OU] = NAN929V4UM"] {
            precondition(signingPolicy.contains(term), "The official Harness Developer ID, Apple authority, application certificate type and exact DeepSeek Team are all required")
        }
        func application(_ name: String, id: String = PermissionGuideApplication.bundleIdentifier, packageType: String = "APPL", executableName: String = "qiuya-computer", binaryOutside: Bool = false) throws -> (URL, URL) {
            let app = directory.appendingPathComponent(name, isDirectory: true)
            let contents = app.appendingPathComponent("Contents", isDirectory: true)
            let bin = contents.appendingPathComponent("MacOS", isDirectory: true)
            try fileManager.createDirectory(at: bin, withIntermediateDirectories: true)
            let executable = binaryOutside ? directory.appendingPathComponent(UUID().uuidString) : bin.appendingPathComponent(executableName)
            try Data("#!/bin/sh\nexit 0\n".utf8).write(to: executable)
            try fileManager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
            let info: [String: Any] = ["CFBundleIdentifier": id, "CFBundleExecutable": executableName, "CFBundlePackageType": packageType]
            try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: contents.appendingPathComponent("Info.plist"))
            return (app, executable)
        }
        let (app, executable) = try application("QiuYaTools Computer.app")
        let actual = try PermissionGuideApplication.validated(bundleURL: app, executableURL: executable)
        precondition(actual.bundleURL == app.standardizedFileURL && actual.executableURL == executable.standardizedFileURL,
                     "The authorization artifact is the actual executable's bundle")
        precondition(actual.pasteboardURL.isFileURL && actual.pasteboardURL.absoluteString == app.absoluteString,
                     "The drag source exports a native file URL rather than a display string")
        precondition(actual.metadata["kind"] as? String == "companion" && actual.metadata["bundleIdentifier"] as? String == PermissionGuideApplication.bundleIdentifier
            && Set(actual.metadata.keys) == ["kind", "appName", "bundleIdentifier"], "Permission owner metadata is explicit and contains no local paths")
        let (spoofedHost, spoofedHostExecutable) = try application("DeepSeek Harness.app", id: PermissionGuideApplication.hostBundleIdentifier)
        do { _ = try PermissionGuideApplication.validatedHost(bundleURL: spoofedHost, executableURL: spoofedHostExecutable, pid: getpid()); preconditionFailure("A named directory and copied Info.plist nominated a fake running host") }
        catch { precondition((error as? ComputerError)?.code == "PERMISSION_APP_UNAVAILABLE") }
        // Sign only a disposable copy of this test binary, never the installed
        // application. A matching name/bundle ID and valid ad-hoc code seal are
        // still insufficient to satisfy the official Developer ID policy.
        try fileManager.removeItem(at: spoofedHostExecutable)
        try fileManager.copyItem(at: URL(fileURLWithPath: CommandLine.arguments[0]), to: spoofedHostExecutable)
        let signer = Process(); signer.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
        signer.arguments = ["--force", "--sign", "-", "--identifier", PermissionGuideApplication.hostBundleIdentifier, "--timestamp=none", spoofedHost.path]
        signer.standardOutput = FileHandle.nullDevice; signer.standardError = FileHandle.nullDevice
        try signer.run(); signer.waitUntilExit()
        precondition(signer.terminationStatus == 0, "The forged-name fixture has a real valid local signature")
        var spoofedCode: SecStaticCode?
        precondition(SecStaticCodeCreateWithPath(spoofedHost as CFURL, SecCSFlags(rawValue: 0), &spoofedCode) == errSecSuccess)
        precondition(SecStaticCodeCheckValidity(spoofedCode!, SecCSFlags(rawValue: kSecCSStrictValidate), nil) == errSecSuccess,
                     "The test first proves the copied bundle's seal is valid")
        precondition(SecStaticCodeCheckValidity(spoofedCode!, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) != errSecSuccess,
                     "Even a valid locally signed com.deepseek.dsh app cannot impersonate the official Developer ID and Team")
        do { _ = try PermissionGuideApplication.current(owner: nil, hosted: true); preconditionFailure("Missing hosted owner silently fell back to the companion") }
        catch { precondition((error as? ComputerError)?.code == "PERMISSION_APP_UNAVAILABLE") }
        if let ownIdentity = MacProcessIdentity.read(getpid()) {
            do { _ = try PermissionGuideApplication.current(owner: ownIdentity, hosted: true); preconditionFailure("The helper itself masqueraded as its authenticated parent") }
            catch { precondition((error as? ComputerError)?.code == "PERMISSION_APP_UNAVAILABLE") }
        }
        for (name, id, packageType, outside) in [("Wrong.app", "com.example.other", "APPL", false),
                                              ("NotApplication", PermissionGuideApplication.bundleIdentifier, "APPL", false),
                                              ("NotAppPackage.app", PermissionGuideApplication.bundleIdentifier, "BNDL", false),
                                              ("Outside.app", PermissionGuideApplication.bundleIdentifier, "APPL", true)] {
            let (candidate, binary) = try application(name, id: id, packageType: packageType, binaryOutside: outside)
            do { _ = try PermissionGuideApplication.validated(bundleURL: candidate, executableURL: binary); preconditionFailure("An unrelated authorization artifact was accepted") }
            catch { precondition((error as? ComputerError)?.code == "PERMISSION_APP_UNAVAILABLE") }
        }
        for (candidate, binary) in [(URL(string: "https://example.com/Other.app")!, executable),
                                    (app, URL(string: "https://example.com/qiuya-computer")!),
                                    (app, directory.appendingPathComponent("missing"))] {
            do { _ = try PermissionGuideApplication.validated(bundleURL: candidate, executableURL: binary); preconditionFailure("A remote URL or unrelated binary was accepted") }
            catch { precondition((error as? ComputerError)?.code == "PERMISSION_APP_UNAVAILABLE") }
        }
        let (retired, retiredExecutable) = try application("Removed.app")
        try fileManager.removeItem(at: retiredExecutable)
        do { _ = try PermissionGuideApplication.validated(bundleURL: retired, executableURL: retiredExecutable); preconditionFailure("A missing executable was accepted") }
        catch { precondition((error as? ComputerError)?.code == "PERMISSION_APP_UNAVAILABLE") }
        for kind in ["screenRecording", "accessibility", "inputMonitoring"] {
            let content = try PermissionGuideContent.validated(kind)
            precondition(content.kind == kind && !content.label.isEmpty && !content.purpose.isEmpty)
        }
        for kind: Any in ["file:///tmp/app", "accessibility?redirect=x", "", NSNull(), 1] {
            do { _ = try PermissionGuideContent.validated(kind); preconditionFailure("An unsupported guide destination was accepted") } catch {}
        }
        let guide = PermissionGuideController(application: { actual })
        precondition(guide.status["shown"] as? Bool == false && guide.status["kind"] == nil,
                     "Creating the guide does not open a window or select a permission")
        precondition(guide.status["appName"] as? String == actual.name && guide.status.keys.allSatisfy { ["shown", "kind", "appName"].contains($0) },
                     "Guide diagnostics never disclose local paths")
        let unavailable = PermissionGuideController(application: { throw ComputerError("PERMISSION_APP_UNAVAILABLE", "test") })
        precondition(unavailable.permissionOwner == nil && unavailable.status["appName"] == nil,
                     "An unconfirmed permission owner has no guessed application name")
        do { _ = try guide.open("file:///tmp/app"); preconditionFailure("Invalid kind opened a permission guide") } catch {}
        guide.close(); guide.close()
        precondition(guide.status["shown"] as? Bool == false, "Closing an unused guide is harmless and opens no window")
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
