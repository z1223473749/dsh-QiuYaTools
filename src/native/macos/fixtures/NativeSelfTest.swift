import AppKit
import Foundation

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
        try cursorSuppressionStateMachine()
        try exactWindowReadiness()
        try await boundedFocusPreparation()
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
        print("Native self-test passed: geometry, approved small AI glyph/opacity/halo, cursor clipping/scale/occlusion, owned cursor suppression fake state/cleanup matrices (no native cursor calls), exact-window CG metadata/ambiguity/front-order zero-post matrices, associated AppKit CG component matrices, bounded focus readiness/human/cancel/epoch/deadline matrices (no real activation/AX/input), lease actor, epochs, key parsing, preview origin/preserve identity, wire numbers")
    }

    private static func exactWindowReadiness() throws {
        let frame = CGRect(x: 100, y: 200, width: 800, height: 600)
        let target = NativeTarget(id: "mac-window:11", appId: "fixture.own", title: "", pid: 99, windowId: 11, frame: frame, scale: 2)
        let geometry = FrameGeometry(frame: frame, pixelWidth: 1600, pixelHeight: 1200)
        let a = FocusWindowState(windowId: 11, pid: 99, frame: frame)
        let overlapping = FocusWindowState(windowId: 22, pid: 99, frame: frame)
        let b = FocusWindowState(windowId: 22, pid: 99, frame: frame.offsetBy(dx: 30, dy: 0))
        func rejected(_ windows: [FocusWindowState], pid: pid_t? = 99, code: String) throws {
            var posts = 0
            do { _ = try ExactWindowFocus.sample(target: target, geometry: geometry, frontmostPid: pid, windows: windows, requireFrontmost: true); posts += 1 }
            catch let error as ComputerError { precondition(error.code == code) }
            precondition(posts == 0, "An invalid exact-window identity must not reach the posting boundary")
        }
        let valid = try ExactWindowFocus.sample(target: target, geometry: geometry, frontmostPid: 99, windows: [a, b], requireFrontmost: true)
        precondition(valid.frontmostPid == 99 && valid.frontmostWindowId == 11, "CG metadata alone permits a unique foreground target without AX content")
        try rejected([overlapping, a], code: "FOCUS_CHANGED")
        try rejected([a, overlapping], code: "FOCUS_CHANGED")
        try rejected([b, a], code: "FOCUS_CHANGED")
        try rejected([a, b], pid: 88, code: "FOCUS_CHANGED")
        try rejected([FocusWindowState(windowId: 33, pid: 88, frame: frame.offsetBy(dx: 60, dy: 0)), a], code: "FOCUS_CHANGED")
        try rejected([FocusWindowState(windowId: 11, pid: 88, frame: frame)], code: "GEOMETRY_CHANGED")
        try rejected([FocusWindowState(windowId: 11, pid: 99, frame: frame.offsetBy(dx: 1, dy: 0))], code: "GEOMETRY_CHANGED")
        try rejected([FocusWindowState(windowId: 11, pid: 99, frame: frame, onscreen: false)], code: "GEOMETRY_CHANGED")
        try rejected([FocusWindowState(windowId: 11, pid: 99, frame: frame, alpha: 0)], code: "GEOMETRY_CHANGED")
        try rejected([FocusWindowState(windowId: 11, pid: 99, frame: frame, layer: CGWindowLevelForKey(.floatingWindow))], code: "GEOMETRY_CHANGED")
        try rejected([overlapping], code: "GEOMETRY_CHANGED")
        let hidden = FocusWindowState(windowId: 22, pid: 99, frame: frame, onscreen: false)
        let transparent = FocusWindowState(windowId: 23, pid: 99, frame: frame, alpha: 0)
        let overlay = FocusWindowState(windowId: 24, pid: 88, frame: frame, layer: CGWindowLevelForKey(.floatingWindow))
        _ = try ExactWindowFocus.sample(target: target, geometry: geometry, frontmostPid: 99, windows: [overlay, hidden, transparent, a], requireFrontmost: true)
        // A once-valid preparation cannot authorize a later post after the same
        // process switches to another window, even if its PID never changes.
        _ = try ExactWindowFocus.sample(target: target, geometry: geometry, frontmostPid: 99, windows: [a, b], requireFrontmost: true)
        try rejected([b, a], code: "FOCUS_CHANGED")
        // Actual regression: AppKit exposes a 66x20 traffic-light component as
        // a separate normal-layer CG surface in front of its main window.
        let component = FocusWindowState(windowId: 44, pid: 99, frame: CGRect(x: 106, y: 206, width: 66, height: 20))
        let hit = CGRect(x: 133, y: 210, width: 14, height: 14)
        func proof(windowId: CGWindowID = 44, pid: pid_t = 99, componentFrame: CGRect? = nil, focusedPid: pid_t = 99,
                   focusedFrame: CGRect? = nil, hitPid: pid_t = 99, hitWindowPid: pid_t = 99, hitFrame: CGRect? = nil,
                   associated: Bool = true, topLevel: Bool = false) -> FocusWindowComponentProof {
            FocusWindowComponentProof(windowId: windowId, pid: pid, componentFrame: componentFrame ?? component.frame,
                focusedPid: focusedPid, focusedFrame: focusedFrame ?? frame, hitPid: hitPid, hitWindowPid: hitWindowPid,
                hitFrame: hitFrame ?? hit, hitWindowIsFocused: associated, hitIsTopLevel: topLevel)
        }
        let accepted = try ExactWindowFocus.sample(target: target, geometry: geometry, frontmostPid: 99, windows: [component, a], components: [proof()], requireFrontmost: true)
        precondition(accepted.frontmostWindowId == a.windowId, "Only a geometrically contained AX child associated with the selected focused window may represent its CG surface")
        func rejectsComponent(_ windows: [FocusWindowState], _ proofs: [FocusWindowComponentProof]) throws {
            var posts = 0
            do { _ = try ExactWindowFocus.sample(target: target, geometry: geometry, frontmostPid: 99, windows: windows, components: proofs, requireFrontmost: true); posts += 1 }
            catch let error as ComputerError { precondition(error.code == "FOCUS_CHANGED") }
            precondition(posts == 0, "Small siblings, foreign windows, stale or unavailable AX associations must remain zero-post")
        }
        try rejectsComponent([component, a], [])
        try rejectsComponent([component, a], [proof(associated: false)]) // Real sibling B owns the AX hit.
        try rejectsComponent([component, a], [proof(topLevel: true)])
        try rejectsComponent([component, a], [proof(hitWindowPid: 88)])
        try rejectsComponent([component, a], [proof(hitPid: 88)])
        try rejectsComponent([component, a], [proof(focusedPid: 88)])
        try rejectsComponent([component, a], [proof(focusedFrame: component.frame)])
        try rejectsComponent([component, a], [proof(hitFrame: frame)]) // Underlying whole canvas is not a component hit.
        try rejectsComponent([component, a], [proof(hitFrame: hit.offsetBy(dx: 80, dy: 0))])
        let movedComponent = FocusWindowState(windowId: 44, pid: 99, frame: component.frame.offsetBy(dx: 0.5, dy: 0))
        try rejectsComponent([movedComponent, a], [proof()])
        let foreign = FocusWindowState(windowId: 44, pid: 88, frame: component.frame)
        try rejectsComponent([foreign, a], [proof(pid: 88)])
        try rejectsComponent([overlapping, component, a], [proof()])
        let edge = FocusWindowState(windowId: 44, pid: 99, frame: CGRect(x: frame.minX, y: 206, width: 66, height: 20))
        try rejectsComponent([edge, a], [proof(componentFrame: edge.frame)])
        let tooMany = (44...47).map { FocusWindowState(windowId: CGWindowID($0), pid: 99, frame: component.frame) }
        try rejectsComponent(tooMany + [a], tooMany.map { proof(windowId: $0.windowId) })
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

    @MainActor private static func cursorSuppressionStateMachine() throws {
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
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.02) { f.setWorks = true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
            precondition(c.clear && overlay.restorationComplete && f.unhides == 1, "Independent restoration timer survives panel/target teardown and never repeats Unhide")
            precondition(c.activate(b, eligible: { true }))
            RunLoop.current.run(until: Date().addingTimeInterval(0.04))
            precondition(c.owner == b && c.ownsHide && f.unhides == 1, "A retired restoration timer cannot touch a later owner")
            precondition(c.restore("test-end"))
        }
        do {
            let f = Fake(), c = SystemCursorSuppression(backend: f.backend), overlay = AICursorOverlay(suppression: c); var failures = 0
            overlay.onRestorationFailure = { failures += 1 }
            precondition(c.activate(a, eligible: { true })); f.readOverride = { _ in false }
            overlay.withdrawForPointerReadback(epoch: 10, targetId: a.targetId)
            RunLoop.current.run(until: Date().addingTimeInterval(0.65))
            precondition(failures == 1 && c.ownsHide && c.ownsProperty && f.unhides == 0, "Bounded recovery reports failure once without forgetting owned counter/property")
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
