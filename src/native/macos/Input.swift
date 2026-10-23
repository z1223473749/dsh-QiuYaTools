import AppKit
import ApplicationServices
import Foundation

/// A revocation is synchronous and cannot be undone by a delayed lease/release.
final class EpochFence {
    private(set) var highest = -1
    private(set) var active: Int?
    func lease(_ epoch: Int) throws {
        guard epoch > highest else { throw ComputerError("STALE_EPOCH", "The control lease is stale.") }
        highest = epoch; active = epoch
    }
    func release(_ epoch: Int) {
        if let current = active, current <= epoch { active = nil }
        highest = max(highest, epoch)
    }
    func check(_ epoch: Int) throws {
        guard active == epoch else { throw ComputerError("STALE_EPOCH", "Control was paused, released, or transferred.") }
    }
}

struct ActionInputGenerationFence {
    let expected: UInt64
    func check(current: UInt64, inputPosted: Bool) throws {
        guard current == expected else {
            throw ComputerError("HUMAN_INPUT_INTERRUPTED", inputPosted ? "Human input interrupted the action; remaining input stopped." : "Human input interrupted focus preparation; no input was posted.")
        }
    }
}

/// Never let cursor restoration failure bypass owned key/button cleanup, or
/// unlock the desktop before both independent cleanup boundaries succeed.
@MainActor func completeOwnedInputCleanup(restoreCursor: () -> Bool, releaseHeld: () throws -> Void, releaseDesktop: () throws -> Void) throws {
    let cursorRestored = restoreCursor()
    var cleanupError: Error?
    do { try releaseHeld() } catch { cleanupError = error }
    if !cursorRestored { throw ComputerError("CURSOR_CLEANUP_FAILED", "The owned cursor restoration is not confirmed. Control remains blocked.") }
    if let cleanupError { throw cleanupError }
    try releaseDesktop()
}

/// A key-up discharges an already posted down. It never authorizes another
/// down and must not wait on the target UI's accessibility response to that down.
enum OwnedKeyboardRecipient { case original, retired, unverified }
enum OwnedKeyboardReleaseDisposition { case postOriginal, retireWithoutPost, block }
enum OwnedKeyboardReleasePolicy {
    static func disposition(recipient: OwnedKeyboardRecipient, sessionVerified: Bool, keyHeld: Bool) -> OwnedKeyboardReleaseDisposition {
        switch recipient {
        case .original: return .postOriginal
        case .retired: return sessionVerified && !keyHeld ? .retireWithoutPost : .block
        case .unverified: return .block
        }
    }
}

@MainActor enum OwnedKeyboardPairDelivery {
    static func run(verifyBeforeDown: () async throws -> Void, verifyImmediatelyBeforePost: () throws -> Void = {}, postDown: () -> Void,
                    hold: () async throws -> Void, releaseUp: () throws -> Void,
                    verifyAfterUp: () throws -> Void) async throws {
        try Task.checkCancellation()
        try await verifyBeforeDown()
        try Task.checkCancellation()
        try verifyImmediatelyBeforePost()
        try Task.checkCancellation()
        postDown()
        do { try await hold() }
        catch { try releaseUp(); throw error }
        try releaseUp()
        try verifyAfterUp()
    }
}

/// Independent completion predicates only; none grants permission to post a
/// new event, substitutes for AX readiness, or claims an event-delivery ACK.
struct CompletedKeyboardInputState {
    let ownerId: String?
    let heldKeys: Int, ownedKeyReleases: Int
    let mouseHeld: Bool, osInputHeld: Bool, permissionsCurrent: Bool, cursorRestorationBlocked: Bool
}
enum CompletedKeyboardInputPolicy {
    static func check(_ state: CompletedKeyboardInputState, expectedOwnerId: String) throws {
        guard state.permissionsCurrent else { throw ComputerError("ACCESSIBILITY_REQUIRED", "Input permission was revoked before keyboard completion could be verified.") }
        guard !state.cursorRestorationBlocked else { throw ComputerError("CURSOR_CLEANUP_FAILED", "Owned cursor cleanup is pending; keyboard completion is not confirmed.") }
        guard !expectedOwnerId.isEmpty, state.ownerId == expectedOwnerId,
              state.heldKeys == 0, state.ownedKeyReleases == 0, !state.mouseHeld, !state.osInputHeld else {
            throw ComputerError("INPUT_CLEANUP_FAILED", "The completed keyboard action's ownership or released input cannot be confirmed.")
        }
    }
}

@MainActor final class NativeInput {
    let fence = EpochFence()
    private let eventSource = CGEventSource(stateID: .hidSystemState)
    private var heldMouse: CGMouseButton?
    private var heldKeys = Set<CGKeyCode>()
    private struct OwnedKeyRelease {
        let id: UUID, code: CGKeyCode, epoch: Int, ownerId: String
        let pid: pid_t, identity: NativeFocusIdentity, event: CGEvent
    }
    private var ownedKeyReleases: [CGKeyCode: OwnedKeyRelease] = [:]
    private var lastPoint = CGPoint.zero
    private var lastPid: pid_t?
    private var actionFocus: NativeFocusIdentity?
    private var actionInputFence: ActionInputGenerationFence?
    private var keyboardReadinessBudget: KeyboardReadinessRetryBudget?
    private var desktopLease: DesktopLeaseGuard?
    private(set) var leaseActor = NativeLeaseActor.ai
    private lazy var aiPointer: AICursorOverlay = {
        let overlay = AICursorOverlay()
        overlay.isLeaseCurrent = { [weak self] epoch in self?.fence.active == epoch && self?.leaseActor == .ai }
        overlay.physicalLeaseOwner = { [weak self] epoch in
            guard let self, self.fence.active == epoch, self.leaseActor == .ai else { return nil }
            return self.desktopLease?.ownerId
        }
        overlay.onSuppressionTransition = { value in Wire.send(["event": "cursorSuppression", "state": value]) }
        overlay.onRestorationFailure = { [weak self] in self?.onCursorCleanupFailure?() }
        return overlay
    }()
    var onCursorCleanupFailure: (() -> Void)?
    private lazy var operationBadge: AIOperationBadge = {
        let badge = AIOperationBadge()
        badge.isLeaseCurrent = { [weak self] epoch in self?.fence.active == epoch && self?.leaseActor == .ai && self?.desktopLease?.ownerId != nil }
        return badge
    }()
    var aiOperationState: [String: Any] { operationBadge.snapshot }
    var preparePointerRegion: (([CGPoint]) throws -> Void)?
    var prepareFocus: (() -> Void)?
    private var humanInputGeneration: UInt64 = 0
    private(set) var focusAttempt: [String: Any]?
    private(set) var busy = false
    var inputState: [String: Any] { ["mouseHeld": heldMouse != nil, "keysHeld": heldKeys.count, "ownerId": desktopLease?.ownerId as Any? ?? NSNull(),
        "leftButtonDown": CGEventSource.buttonState(.combinedSessionState, button: .left)] }

    func releaseHeldInput() throws {
        if heldMouse != nil || !heldKeys.isEmpty {
            guard AXIsProcessTrusted(), CGPreflightPostEventAccess() else { throw ComputerError("INPUT_CLEANUP_FAILED", "Input permission was revoked before owned input could be released.") }
        }
        if let button = heldMouse {
            let type: CGEventType = button == .left ? .leftMouseUp : button == .right ? .rightMouseUp : .otherMouseUp
            guard let event = CGEvent(mouseEventSource: eventSource, mouseType: type, mouseCursorPosition: lastPoint, mouseButton: button) else { throw ComputerError("INPUT_CLEANUP_FAILED", "The owned mouse release could not be created.") }
            postPointer(event)
            for _ in 0..<20 {
                if !CGEventSource.buttonState(.combinedSessionState, button: button) { break }
                usleep(10_000)
            }
            guard !CGEventSource.buttonState(.combinedSessionState, button: button) else { throw ComputerError("INPUT_CLEANUP_FAILED", "The owned mouse release is not confirmed. Control remains blocked.") }
            heldMouse = nil
        }
        for code in Array(heldKeys) {
            guard let owned = ownedKeyReleases[code] else { throw ComputerError("INPUT_CLEANUP_FAILED", "The owned key release identity is unavailable.") }
            try releaseOwnedKey(code, expectedId: owned.id, expectedEpoch: owned.epoch, expectedOwnerId: owned.ownerId)
        }
        if desktopLease?.ownerId != nil { try desktopLease?.record(keys: [], mouse: nil, targetPid: nil) }
    }

    private func releaseOwnedKey(_ code: CGKeyCode, expectedId: UUID, expectedEpoch: Int, expectedOwnerId: String) throws {
        // A concurrent revocation may already have discharged this exact pair.
        guard let owned = ownedKeyReleases[code] else {
            guard !heldKeys.contains(code) else { throw ComputerError("INPUT_CLEANUP_FAILED", "The owned key release identity is unavailable.") }
            return
        }
        guard owned.id == expectedId, owned.code == code, owned.epoch == expectedEpoch,
              !expectedOwnerId.isEmpty, owned.ownerId == expectedOwnerId, desktopLease?.ownerId == expectedOwnerId else {
            throw ComputerError("INPUT_CLEANUP_FAILED", "The owned key release responsibility cannot be confirmed.")
        }
        guard AXIsProcessTrusted(), CGPreflightPostEventAccess() else { throw ComputerError("INPUT_CLEANUP_FAILED", "Input permission was revoked before owned input could be released.") }
        let recipient = owned.identity.ownedKeyRecipient(to: owned.pid)
        let sessionVerified: Bool, keyHeld: Bool
        if recipient == .retired {
            if let session = CGSessionCopyCurrentDictionary() as? [String: Any],
               session[kCGSessionOnConsoleKey as String] as? Bool == true,
               (session[kCGSessionUserIDKey as String] as? NSNumber)?.uint32Value == getuid(),
               session["CGSSessionScreenIsLocked"] as? Bool != true { sessionVerified = true }
            else { sessionVerified = false }
            keyHeld = CGEventSource.keyState(.combinedSessionState, key: code)
        } else { sessionVerified = false; keyHeld = false }
        switch OwnedKeyboardReleasePolicy.disposition(recipient: recipient, sessionVerified: sessionVerified, keyHeld: keyHeld) {
        case .block:
            focusAttempt?["ownedKeyReleaseStage"] = recipient == .unverified ? "recipient-unverified" : !sessionVerified ? "retired-session-unverified" : "retired-os-held"
            throw ComputerError("INPUT_CLEANUP_FAILED", "The original key recipient or owned release cannot be confirmed; release remains blocked.")
        case .retireWithoutPost:
            // The original application's event queue is gone. Never address a
            // reused PID, and never release a key still held in this session.
            let retiredCount = focusAttempt?["retiredOwnedKeyReleases"] as? Int ?? 0
            focusAttempt?["retiredOwnedKeyReleases"] = retiredCount + 1
            focusAttempt?["ownedKeyReleaseStage"] = "retired-no-held-input"
        case .postOriginal:
            // Retain the original Unicode/virtual-key/flags event. Never send
            // a generic replacement or retry a posted up.
            owned.event.postToPid(owned.pid)
            let postedCount = focusAttempt?["ownedKeyUpPosts"] as? Int ?? 0
            focusAttempt?["ownedKeyUpPosts"] = postedCount + 1
            focusAttempt?["ownedKeyReleaseStage"] = "posted-original"
        }
        ownedKeyReleases.removeValue(forKey: code); heldKeys.remove(code)
    }

    private func keyboardPair(down: CGEvent, up: CGEvent, code: CGKeyCode, holdNanoseconds: UInt64 = 0,
                              epoch: Int, target: NativeTarget, geometry: FrameGeometry, ownerId: String) async throws {
        guard let identity = actionFocus, let generation = actionInputFence,
              !ownerId.isEmpty, desktopLease?.ownerId == ownerId,
              heldKeys.isEmpty, ownedKeyReleases.isEmpty else {
            throw ComputerError("INPUT_CLEANUP_FAILED", "An earlier owned key pair is not released.")
        }
        let id = UUID()
        try await OwnedKeyboardPairDelivery.run(verifyBeforeDown: {
            try await self.checkKeyboardBeforeDown(epoch, target, geometry, ownerId: ownerId, keys: [code])
        }, verifyImmediatelyBeforePost: {
            // The async readiness call may have yielded before returning. This
            // terminal exact metadata/fence check and the following post are
            // synchronous on MainActor; no delayed proof grants a new down.
            try identity.checkKeyboardPostAwaitIdentity {
                try self.keyboardCheckpoint(epoch, generation: generation, ownerId: ownerId, keys: [code])
            }
        }, postDown: {
            self.ownedKeyReleases[code] = OwnedKeyRelease(id: id, code: code, epoch: epoch, ownerId: ownerId, pid: target.pid, identity: identity, event: up)
            self.heldKeys.insert(code)
            down.postToPid(target.pid); self.focusAttempt?["inputPosted"] = true
            self.operationBadge.posted(epoch: epoch, target: target)
        }, hold: {
            if holdNanoseconds > 0 { try await Task.sleep(nanoseconds: holdNanoseconds) }
        }, releaseUp: {
            try self.releaseOwnedKey(code, expectedId: id, expectedEpoch: epoch, expectedOwnerId: ownerId)
        }, verifyAfterUp: {
            try self.fence.check(epoch)
            try generation.check(current: self.humanInputGeneration, inputPosted: true)
        })
    }

    func lease(_ epoch: Int, actor: NativeLeaseActor = .ai) throws {
        guard epoch > fence.highest else { throw ComputerError("STALE_EPOCH", "The control lease is stale.") }
        guard aiPointer.hide() else { throw ComputerError("CURSOR_CLEANUP_FAILED", "The previous cursor owner has not been restored. Control remains blocked.") }
        if desktopLease == nil { desktopLease = try DesktopLeaseGuard() }
        try desktopLease!.acquire()
        do { try fence.lease(epoch) } catch { try? desktopLease?.release(); throw error }
        leaseActor = actor; aiPointer.beginLease(epoch); operationBadge.beginLease(epoch)
    }
    func release(_ epoch: Int) throws {
        let wasActive = fence.active.map { $0 <= epoch } ?? false
        fence.release(epoch)
        if wasActive || (fence.active == nil && desktopLease?.ownerId != nil) {
            operationBadge.hide()
            try completeOwnedInputCleanup(restoreCursor: { aiPointer.hide() }, releaseHeld: { try releaseHeldInput() }, releaseDesktop: { try desktopLease?.release() })
        }
    }
    func shutdownCleanup() throws {
        // A failed action may already have revoked its epoch while still
        // retaining the physical lock. Shutdown must clean that owner too.
        fence.release(max(0, fence.highest))
        operationBadge.hide()
        try completeOwnedInputCleanup(restoreCursor: { aiPointer.hide() }, releaseHeld: { try releaseHeldInput() }, releaseDesktop: { try desktopLease?.release() })
    }

    func act(epoch: Int, target: NativeTarget, geometry: FrameGeometry, action: [String: Any]) async throws -> [String: Any] {
        defer { operationBadge.hide(epoch: epoch) }
        var ownsInput = false
        do {
            let result = try await performAct(epoch: epoch, target: target, geometry: geometry, action: action, started: { ownsInput = true })
            try releaseHeldInput()
            aiPointer.settled(epoch: epoch)
            return result
        } catch {
            let cursorRestored = fence.active == epoch ? aiPointer.hide() : aiPointer.restorationComplete
            if ownsInput { do { try releaseHeldInput() } catch { fence.release(epoch); throw error } }
            if !cursorRestored { fence.release(epoch); throw ComputerError("CURSOR_CLEANUP_FAILED", "The owned cursor restoration is not confirmed. Control remains blocked.") }
            throw error
        }
    }

    @discardableResult func hideAICursor() -> Bool { aiPointer.hide() }
    func humanInputDetected() {
        humanInputGeneration &+= 1
        if let epoch = fence.active { operationBadge.interrupt(epoch); _ = aiPointer.humanIntervened(epoch) } else { operationBadge.hide(); aiPointer.hide() }
    }
    var aiCursorState: [String: Any] { aiPointer.desktopSnapshot() }
    func aiCursor(target: NativeTarget, geometry: FrameGeometry) -> [String: Any] { aiPointer.snapshot(target: target, geometry: geometry) }

    private func performAct(epoch: Int, target: NativeTarget, geometry: FrameGeometry, action: [String: Any], started: () -> Void) async throws -> [String: Any] {
        try fence.check(epoch)
        guard !aiPointer.restorationBlocked else { throw ComputerError("CURSOR_CLEANUP_FAILED", "Owned cursor cleanup is pending; no new input is permitted.") }
        guard AXIsProcessTrusted(), CGPreflightPostEventAccess() else { throw ComputerError("ACCESSIBILITY_REQUIRED", "Enable Accessibility for QiuYaTools Computer in System Settings.") }
        guard !busy else { throw ComputerError("INPUT_BUSY", "Another input action is still settling.") }
        guard target.frame == geometry.frame else { throw ComputerError("GEOMETRY_CHANGED", "The window moved or resized. Observe it again before acting.") }
        guard let kind = action["kind"] as? String, ["click", "move", "drag", "scroll", "type", "key"].contains(kind) else { throw ComputerError("INVALID_ACTION", "Unsupported action kind.") }
        // Validate the whole action before changing application focus or posting any input.
        var start: CGPoint?; var destination: CGPoint?
        if ["click", "move", "drag", "scroll"].contains(kind) {
            guard let x = finiteNumber(action["x"]), let y = finiteNumber(action["y"]) else { throw ComputerError("INVALID_COORDINATES", "This action requires screenshot x and y.") }
            start = try geometry.point(x: x, y: y)
        }
        if kind == "drag" {
            guard let x = finiteNumber(action["toX"]), let y = finiteNumber(action["toY"]) else { throw ComputerError("INVALID_COORDINATES", "Drag requires screenshot toX and toY.") }
            destination = try geometry.point(x: x, y: y)
        }
        let buttonName = action["button"] as? String ?? "left"
        guard ["left", "right", "middle"].contains(buttonName) else { throw ComputerError("INVALID_ACTION", "Unsupported mouse button.") }
        let button: CGMouseButton = buttonName == "right" ? .right : buttonName == "middle" ? .center : .left
        let text = action["text"] as? String
        if kind == "type", text == nil || text!.utf16.count > 100_000 { throw ComputerError("INVALID_ACTION", "Text is missing or exceeds 100000 UTF-16 units.") }
        let key = kind == "key" ? try parseKey(action["key"] as? String) : nil
        let dx = finiteNumber(action["deltaX"]) ?? 0; let dy = finiteNumber(action["deltaY"]) ?? 0
        guard abs(dx) <= 20_000, abs(dy) <= 20_000 else { throw ComputerError("INVALID_ACTION", "Scroll delta is too large.") }
        guard let actionOwnerId = desktopLease?.ownerId, !actionOwnerId.isEmpty else { throw ComputerError("DESKTOP_LEASE_REQUIRED", "A desktop input lease is required.") }
        busy = true
        started()
        defer { busy = false; actionFocus = nil; actionInputFence = nil; keyboardReadinessBudget = nil }
        let focusIdentity = try NativeFocusIdentity(target: target, geometry: geometry)
        actionFocus = focusIdentity
        let expectedHumanInputGeneration = humanInputGeneration
        let generationFence = ActionInputGenerationFence(expected: expectedHumanInputGeneration)
        actionInputFence = generationFence
        keyboardReadinessBudget = KeyboardReadinessRetryBudget()
        let preparationCheckpoint = { [unowned self] in
            try self.fence.check(epoch)
            try generationFence.check(current: self.humanInputGeneration, inputPosted: false)
            guard !self.aiPointer.restorationBlocked else { throw ComputerError("CURSOR_CLEANUP_FAILED", "Owned cursor cleanup is pending; input stopped.") }
        }
        prepareFocus?()
        if let point = start { try preparePointerRegion?(destination.map { [point, $0] } ?? [point]) }
        let route: FocusInputRoute = kind == "type" || kind == "key" ? .keyboard : .pointer(start!)
        let focusBackend = try FocusPreparationBackend.native(identity: focusIdentity, route: route, checkpoint: preparationCheckpoint)
        try await BoundedFocusPreparation.run(targetPid: target.pid, targetWindowId: target.windowId, backend: focusBackend, checkpoint: preparationCheckpoint,
            record: { [unowned self] in self.focusAttempt = $0 })
        // Zero is evidence distinct from an absent counter, including when the
        // original recipient exits before any owned up can be posted.
        focusAttempt?["ownedKeyUpPosts"] = 0
        focusAttempt?["retiredOwnedKeyReleases"] = 0
        focusAttempt?["ownedKeyReleaseStage"] = "not-requested"
        try preparationCheckpoint()
        let keys: Set<CGKeyCode> = kind == "type" ? [0] : key.map { [$0.0] } ?? []
        if kind == "type" || kind == "key" { try await checkKeyboardBeforeDown(epoch, target, geometry, ownerId: actionOwnerId, keys: keys) }
        else { try check(epoch, target, geometry, route: route) }
        lastPid = target.pid
        // Record the entire action's possible downs before the first injected down.
        // Keeping this superset until completion avoids an fsync for every typed character.
        try desktopLease?.record(keys: keys, mouse: ["click", "drag"].contains(kind) ? button : nil, targetPid: target.pid)
        switch kind {
        case "click":
            try mouse(.mouseMoved, start!, .left, epoch, target, geometry)
            try mouse(button == .left ? .leftMouseDown : button == .right ? .rightMouseDown : .otherMouseDown, start!, button, epoch, target, geometry)
            heldMouse = button
            try await Task.sleep(nanoseconds: 35_000_000)
            try mouse(button == .left ? .leftMouseUp : button == .right ? .rightMouseUp : .otherMouseUp, start!, button, epoch, target, geometry)
            heldMouse = nil
        case "move": try mouse(.mouseMoved, start!, .left, epoch, target, geometry)
        case "drag":
            try mouse(.mouseMoved, start!, .left, epoch, target, geometry)
            try mouse(button == .left ? .leftMouseDown : button == .right ? .rightMouseDown : .otherMouseDown, start!, button, epoch, target, geometry)
            heldMouse = button
            for step in 1...24 {
                try await Task.sleep(nanoseconds: 16_000_000)
                let progress = Double(step) / 24
                let point = CGPoint(x: start!.x + (destination!.x - start!.x) * progress, y: start!.y + (destination!.y - start!.y) * progress)
                try mouse(button == .left ? .leftMouseDragged : button == .right ? .rightMouseDragged : .otherMouseDragged, point, button, epoch, target, geometry)
            }
            try mouse(button == .left ? .leftMouseUp : button == .right ? .rightMouseUp : .otherMouseUp, destination!, button, epoch, target, geometry)
            heldMouse = nil
        case "scroll":
            try mouse(.mouseMoved, start!, .left, epoch, target, geometry)
            // Protocol follows browser wheel semantics: positive is right/down.
            guard let event = CGEvent(scrollWheelEvent2Source: eventSource, units: .pixel, wheelCount: 2, wheel1: Int32(-dy), wheel2: Int32(-dx), wheel3: 0) else { throw ComputerError("EVENT_FAILED", "Could not create a scroll event.") }
            event.location = start!
            try check(epoch, target, geometry, route: .pointer(event.location))
            postPointer(event)
            focusAttempt?["inputPosted"] = true
        case "type":
            // Use Unicode events, never the user's clipboard. Split on Characters so
            // surrogate pairs and composed graphemes are not broken between events.
            for character in text! {
                let units = Array(String(character).utf16)
                guard let down = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: true),
                      let up = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: false) else { throw ComputerError("EVENT_FAILED", "Could not create a text event.") }
                down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                down.flags = []; up.flags = []
                try await keyboardPair(down: down, up: up, code: 0, epoch: epoch, target: target, geometry: geometry, ownerId: actionOwnerId)
                try await Task.sleep(nanoseconds: 1_000_000)
            }
        case "key":
            let combination = key!
            guard let down = CGEvent(keyboardEventSource: eventSource, virtualKey: combination.0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: eventSource, virtualKey: combination.0, keyDown: false) else { throw ComputerError("EVENT_FAILED", "Could not create a key event.") }
            down.flags = combination.1; up.flags = []
            try await keyboardPair(down: down, up: up, code: combination.0, holdNanoseconds: 25_000_000, epoch: epoch, target: target, geometry: geometry, ownerId: actionOwnerId)
        default: break
        }
        try await Task.sleep(nanoseconds: 50_000_000)
        if kind == "type" || kind == "key" {
            try checkKeyboardCompletion(epoch, target, geometry, ownerId: actionOwnerId, keys: keys)
        }
        return ["performed": true, "kind": kind, "epoch": epoch, "targetId": target.id]
    }

    private func mouse(_ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton, _ epoch: Int, _ target: NativeTarget, _ geometry: FrameGeometry) throws {
        guard let event = CGEvent(mouseEventSource: eventSource, mouseType: type, mouseCursorPosition: point, mouseButton: button) else { throw ComputerError("EVENT_FAILED", "Could not create a mouse event.") }
        event.setIntegerValueField(.mouseEventClickState, value: 1)
        try check(epoch, target, geometry, route: .pointer(event.location))
        lastPoint = point
        postPointer(event)
        focusAttempt?["inputPosted"] = true
        operationBadge.posted(epoch: epoch, target: target)
        if leaseActor == .ai {
            let pressed = [.leftMouseDown, .rightMouseDown, .otherMouseDown, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged].contains(type)
            aiPointer.posted(point, phase: pressed ? "pressed" : "moving", epoch: epoch, target: target)
        }
    }

    private func postPointer(_ event: CGEvent) {
        event.post(tap: .cghidEventTap)
    }

    private func checkKeyboardCompletion(_ epoch: Int, _ target: NativeTarget, _ geometry: FrameGeometry,
                                         ownerId: String, keys: Set<CGKeyCode>) throws {
        guard let identity = actionFocus, let generation = actionInputFence,
              identity.target.windowId == target.windowId, identity.target.pid == target.pid, identity.geometry.frame == geometry.frame else {
            throw ComputerError("FOCUS_CHANGED", "The completed action's selected window identity is unavailable.")
        }
        defer { focusAttempt?.merge(identity.diagnosticSnapshot) { _, latest in latest } }
        try identity.checkKeyboardCompletion {
            try self.keyboardCheckpoint(epoch, generation: generation, ownerId: ownerId, keys: keys)
        }
    }

    private func checkKeyboardBeforeDown(_ epoch: Int, _ target: NativeTarget, _ geometry: FrameGeometry,
                                         ownerId: String, keys: Set<CGKeyCode>) async throws {
        guard let identity = actionFocus, let generation = actionInputFence, let budget = keyboardReadinessBudget,
              identity.target.windowId == target.windowId, identity.target.pid == target.pid, identity.geometry.frame == geometry.frame else {
            throw ComputerError("FOCUS_CHANGED", "The keyboard action's selected window identity is unavailable; input stopped.")
        }
        defer { focusAttempt?.merge(identity.diagnosticSnapshot) { _, latest in latest } }
        let checkpoint = {
            try self.keyboardCheckpoint(epoch, generation: generation, ownerId: ownerId, keys: keys)
        }
        try await BoundedKeyboardDownReadiness.run(backend: KeyboardDownReadinessBackend(
            now: { ProcessInfo.processInfo.systemUptime }, proof: { try identity.keyboardDownProof(deadline: $0) },
            metadata: { try identity.checkKeyboardRetryIdentity(deadline: $0, checkpoint: $1) }, sleep: { try await Task.sleep(nanoseconds: $0) }),
            budget: budget, checkpoint: checkpoint)
    }

    private func keyboardCheckpoint(_ epoch: Int, generation: ActionInputGenerationFence, ownerId: String, keys: Set<CGKeyCode>) throws {
        try Task.checkCancellation(); try fence.check(epoch)
        try generation.check(current: humanInputGeneration, inputPosted: focusAttempt?["inputPosted"] as? Bool == true)
        let osHeld = keys.contains { CGEventSource.keyState(.combinedSessionState, key: $0) } ||
            [CGMouseButton.left, .right, .center].contains { CGEventSource.buttonState(.combinedSessionState, button: $0) }
        try CompletedKeyboardInputPolicy.check(CompletedKeyboardInputState(ownerId: desktopLease?.ownerId,
            heldKeys: heldKeys.count, ownedKeyReleases: ownedKeyReleases.count, mouseHeld: heldMouse != nil,
            osInputHeld: osHeld, permissionsCurrent: AXIsProcessTrusted() && CGPreflightPostEventAccess(),
            cursorRestorationBlocked: aiPointer.restorationBlocked), expectedOwnerId: ownerId)
    }

    private func check(_ epoch: Int, _ target: NativeTarget, _ geometry: FrameGeometry, route: FocusInputRoute) throws {
        try fence.check(epoch)
        guard !aiPointer.restorationBlocked else { fence.release(epoch); throw ComputerError("CURSOR_CLEANUP_FAILED", "Owned cursor cleanup is pending; input stopped.") }
        guard let identity = actionFocus, let generationFence = actionInputFence, identity.target.windowId == target.windowId, identity.target.pid == target.pid, identity.geometry.frame == geometry.frame else {
            aiPointer.hide(); throw ComputerError("FOCUS_CHANGED", "The action's selected window identity is unavailable; input stopped.")
        }
        defer { focusAttempt?.merge(identity.diagnosticSnapshot) { _, latest in latest } }
        do {
            try generationFence.check(current: humanInputGeneration, inputPosted: focusAttempt?["inputPosted"] as? Bool == true)
            _ = try identity.sample(route: route, requireReady: true)
            try fence.check(epoch)
            try generationFence.check(current: humanInputGeneration, inputPosted: focusAttempt?["inputPosted"] as? Bool == true)
        } catch { aiPointer.hide(); throw error }
    }
}

func parseKey(_ raw: String?) throws -> (CGKeyCode, CGEventFlags) {
    guard let raw, !raw.isEmpty, raw.utf8.count <= 100 else { throw ComputerError("INVALID_KEY", "A supported key or shortcut is required.") }
    let parts = raw.uppercased().split(separator: "+").map(String.init)
    var flags: CGEventFlags = []
    for modifier in parts.dropLast() {
        switch modifier {
        case "CMD", "COMMAND", "META", "SUPER": flags.insert(.maskCommand)
        case "CTRL", "CONTROL": flags.insert(.maskControl)
        case "ALT", "OPTION": flags.insert(.maskAlternate)
        case "SHIFT": flags.insert(.maskShift)
        default: throw ComputerError("INVALID_KEY", "Unsupported shortcut modifier.")
        }
    }
    let codes: [String: CGKeyCode] = ["A":0,"S":1,"D":2,"F":3,"H":4,"G":5,"Z":6,"X":7,"C":8,"V":9,"B":11,"Q":12,"W":13,"E":14,"R":15,"Y":16,"T":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"=":24,"9":25,"7":26,"-":27,"8":28,"0":29,
        "]":30,"O":31,"U":32,"[":33,"I":34,"P":35,"ENTER":36,"RETURN":36,"L":37,"J":38,"'":39,"K":40,";":41,"BACKSLASH":42,",":43,"/":44,"N":45,"M":46,".":47,"TAB":48,"SPACE":49,"BACKSPACE":51,"ESC":53,"ESCAPE":53,"DELETE":117,"HOME":115,"END":119,"PAGEUP":116,"PAGEDOWN":121,"LEFT":123,"RIGHT":124,"DOWN":125,"UP":126,"F1":122,"F2":120,"F3":99,"F4":118,"F5":96,"F6":97,"F7":98,"F8":100,"F9":101,"F10":109,"F11":103,"F12":111]
    let aliases = ["ARROWLEFT": "LEFT", "ARROWRIGHT": "RIGHT", "ARROWUP": "UP", "ARROWDOWN": "DOWN", " ": "SPACE", "PAGE UP": "PAGEUP", "PAGE DOWN": "PAGEDOWN"]
    guard let name = parts.last, let code = codes[aliases[name] ?? name] else { throw ComputerError("INVALID_KEY", "Unsupported key name.") }
    return (code, flags)
}
