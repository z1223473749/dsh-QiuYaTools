/** Pure checked fixture transformation and boundary evidence policy. No process or GUI. */
const replaceOnce=(s,a,b)=>{if(s.split(a).length!==2)throw Error('Boundary fixture marker changed: '+a.slice(0,65));return s.replace(a,b)}
export const KEYBOARD_BOUNDARY_MODES=Object.freeze(['sibling-on-down','quit-on-down'])
export function keyboardBoundaryFixtureSource(source){
 const additions=`
final class KeyboardBoundaryWindow: NSWindow {
    weak var boundaryOwner: VisionFixture?
    var boundaryRole = "A"
    override func sendEvent(_ event: NSEvent) {
        if event.type == .keyDown || event.type == .keyUp { boundaryOwner?.boundaryWindowEvent(event, role: boundaryRole) }
        super.sendEvent(event)
        if event.type == .keyDown, boundaryRole == "A" { boundaryOwner?.boundaryAfterDown() }
    }
}
`
 let out=replaceOnce(source,'final class VisionFixture: NSObject, NSApplicationDelegate, NSTextFieldDelegate {',additions+'\nfinal class VisionFixture: NSObject, NSApplicationDelegate, NSTextFieldDelegate {')
 out=replaceOnce(out,'    let window = NSWindow(contentRect:','    let window = KeyboardBoundaryWindow(contentRect:')
 out=replaceOnce(out,'    var activity: NSObjectProtocol?',`    var activity: NSObjectProtocol?
    var boundaryMode = "normal", boundarySwitched = false, boundaryQuitDown = false
    var boundarySequence = 0, boundaryLedger: [[String: Any]] = []
    var boundaryADown = 0, boundaryAUp = 0, boundaryBDown = 0, boundaryBUp = 0
    var boundaryMonitorDown = 0, boundaryMonitorUp = 0
    var boundaryMonitor: Any?
    var boundarySibling: KeyboardBoundaryWindow?
    let boundarySiblingInput = NSTextField(string: "")
    func boundaryRecord(_ kind: String, role: String, key: UInt16? = nil) {
        boundarySequence += 1
        var row: [String: Any] = ["sequence": boundarySequence, "kind": kind, "window": role, "uptime": ProcessInfo.processInfo.systemUptime]
        if let key { row["keyCode"] = Int(key) }
        if boundaryLedger.count < 96 { boundaryLedger.append(row) }
        send(["event": "keyboard-boundary-event", "pid": getpid(), "boundary": boundarySnapshot])
    }
    var boundarySnapshot: [String: Any] {
        ["mode": boundaryMode, "switched": boundarySwitched, "quitDownSeen": boundaryQuitDown,
         "aWindowId": window.windowNumber, "bWindowId": boundarySibling?.windowNumber ?? 0,
         "keyWindowId": NSApp.keyWindow?.windowNumber ?? 0,
         "aDown": boundaryADown, "aUp": boundaryAUp, "bDown": boundaryBDown, "bUp": boundaryBUp,
         "monitorDown": boundaryMonitorDown, "monitorUp": boundaryMonitorUp, "ledger": boundaryLedger]
    }
    func boundaryWindowEvent(_ event: NSEvent, role: String) {
        if event.type == .keyDown { if role == "A" { boundaryADown += 1 } else { boundaryBDown += 1 } }
        else { if role == "A" { boundaryAUp += 1 } else { boundaryBUp += 1 } }
        boundaryRecord(event.type == .keyDown ? "window-down" : "window-up", role: role, key: event.keyCode)
    }
    func boundaryAfterDown() {
        guard boundaryMode == "sibling-on-down", !boundarySwitched, boundaryADown == 1, let sibling = boundarySibling else { return }
        boundarySwitched = true; sibling.makeKeyAndOrderFront(nil); sibling.makeFirstResponder(boundarySiblingInput)
        boundaryRecord("made-B-key", role: "B")
    }
    func configureBoundary() {
        window.boundaryOwner = self
        if boundaryMode == "sibling-on-down" {
            let sibling = KeyboardBoundaryWindow(contentRect: NSRect(x: window.frame.minX + 60, y: window.frame.minY + 30, width: 460, height: 180), styleMask: [.titled, .closable], backing: .buffered, defer: false)
            sibling.title = "QiuYaTools Keyboard Boundary B"; sibling.isReleasedWhenClosed = false
            sibling.boundaryOwner = self; sibling.boundaryRole = "B"
            boundarySiblingInput.frame = NSRect(x: 30, y: 65, width: 395, height: 40)
            boundarySiblingInput.font = NSFont.systemFont(ofSize: 22); boundarySiblingInput.setAccessibilityLabel("兄弟窗口独立输入框")
            sibling.contentView?.addSubview(boundarySiblingInput); boundarySibling = sibling; sibling.orderFront(nil)
        }
        boundaryMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .keyUp]) { [weak self] event in
            guard let self else { return event }
            let role = NSApp.keyWindow === self.boundarySibling ? "B" : "A"
            if event.type == .keyDown { self.boundaryMonitorDown += 1 } else { self.boundaryMonitorUp += 1 }
            if self.boundaryMode == "quit-on-down", event.type == .keyDown, event.keyCode == 12, event.modifierFlags.contains(.command) { self.boundaryQuitDown = true }
            self.boundaryRecord(event.type == .keyDown ? "application-monitor-down" : "application-monitor-up", role: role, key: event.keyCode)
            return event
        }
    }
`)
 out=replaceOnce(out,'        window.center(); window.makeKeyAndOrderFront(nil);','        configureBoundary(); window.center(); window.makeKeyAndOrderFront(nil);')
 out=replaceOnce(out,'"inputCenter": self.keyboardInputCenter]','"inputCenter": self.keyboardInputCenter, "boundary": self.boundarySnapshot]')
 out=replaceOnce(out,'    func applicationWillTerminate(_ notification: Notification) { if let activity { ProcessInfo.processInfo.endActivity(activity) } }',`    func applicationWillTerminate(_ notification: Notification) {
        boundaryRecord("application-will-terminate", role: boundaryMode == "quit-on-down" ? "A" : "none")
        send(["event": "keyboard-boundary-terminal", "pid": getpid(), "windowId": window.windowNumber, "bundleId": Bundle.main.bundleIdentifier ?? "", "task": task, "passed": passed, "textMatches": input.stringValue == note, "submitted": submitted, "boundary": boundarySnapshot])
        if let boundaryMonitor { NSEvent.removeMonitor(boundaryMonitor) }
        if let activity { ProcessInfo.processInfo.endActivity(activity) }
    }`)
 out=replaceOnce(out,'app.delegate = fixture; app.setActivationPolicy(.regular); app.run()',`let boundaryMode = config["fixtureMode"] as? String ?? "normal"
guard ["normal", "sibling-on-down", "quit-on-down", "witness"].contains(boundaryMode) else { exit(2) }
fixture.boundaryMode = boundaryMode
app.delegate = fixture; app.setActivationPolicy(.regular); app.run()`)
 return out
}
export function keyboardBoundaryVerdict({mode,evidence,cleanup,expected='green'}){
 const b=evidence.finalBoundary,focus=evidence.afterAction?.native?.focusAttempt,os=evidence.afterAction?.os
 const osEmpty=!!os&&!os.leftButtonDown&&!os.rightButtonDown&&!os.middleButtonDown&&os.keysDown?.length===0
 const sibling=mode==='sibling-on-down'&&b?.switched===true&&b.aDown===1&&b.bDown===0&&b.aUp+b.bUp===1&&b.keyWindowId===b.bWindowId&&b.bWindowId>0&&focus?.ownedKeyUpPosts===1&&focus.ownedKeyReleaseStage==='posted-original'&&evidence.action?.error==='FOCUS_CHANGED'&&osEmpty&&evidence.release?.confirmed===true
 const retired=mode==='quit-on-down'&&evidence.quitExit?.code===0&&evidence.quitExit.signal===null&&evidence.originalRetired===true&&b?.quitDownSeen===true&&focus?.ownedKeyUpPosts===0&&focus.retiredOwnedKeyReleases>=1&&focus.ownedKeyReleaseStage==='retired-no-held-input'&&osEmpty&&evidence.release?.confirmed===true&&evidence.successor?.started===true&&evidence.successor.newLeaseConfirmed===true&&evidence.successor.noInputEvents===true
 const green=(sibling||retired)&&cleanup.passed===true
 const oldBlockingRegression=mode==='quit-on-down'&&evidence.quitExit?.code===0&&evidence.originalRetired===true&&b?.quitDownSeen===true&&osEmpty&&evidence.release?.confirmed===false&&evidence.release.keysHeld>0&&evidence.release.journalPresent===true&&evidence.successor?.started!==true&&cleanup.safeRetirement===true
 return{status:green?'passed':expected==='red'&&oldBlockingRegression?'expected-red':'failed',functionalPassed:green,expectedBlockingRegressionConfirmed:oldBlockingRegression,comparisonAccepted:expected==='red'?oldBlockingRegression:green,noGlobalZeroEventClaim:true}
}
