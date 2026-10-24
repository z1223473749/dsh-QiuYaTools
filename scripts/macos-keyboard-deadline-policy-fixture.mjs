/** Extracts the actual pure Swift policy. No compiler, GUI, AX or input side effects. */
import assert from 'node:assert/strict'

export function makeKeyboardDeadlinePolicyFixture(source) {
  const begin = source.indexOf('enum KeyboardDownProof {'), end = source.indexOf('\nprivate struct FocusProcessBirth:', begin)
  assert(begin > 0 && end > begin)
  const policy = source.slice(begin, end)
  const diagnosticBegin = source.indexOf('@MainActor private final class FocusIdentityDiagnostics'), diagnosticEnd = source.indexOf('\n/// One identity is captured', diagnosticBegin)
  assert(diagnosticBegin > end && diagnosticEnd > diagnosticBegin)
  const diagnostics = source.slice(diagnosticBegin, diagnosticEnd)
  assert(!/import AppKit|AXUIElement|CGEvent\(|NSApplication|NSWorkspace|currentWindows\(/u.test(policy + diagnostics))
  const identityStart = source.indexOf('try ExactInputIdentity.check', source.indexOf('case .keyboard:', source.indexOf('diagnostics.routeStage = "metadata-recheck"')))
  const classification = source.indexOf('TransientKeyboardAXRead.mayWait', identityStart)
  assert(identityStart > 0 && classification > identityStart, 'Exact identity must precede transient classification')
  return `import Foundation
struct ComputerError: Error { let code: String; let message: String; init(_ code: String,_ message: String) { self.code=code;self.message=message } }
struct KeyboardFocusSnapshot {}
enum AXError: Int32 { case cannotComplete = -25204 }
${policy}
${diagnostics}
` + String.raw`
@MainActor final class Fake {
    let budget = KeyboardReadinessRetryBudget()
    var time=0.0, firstCost=0.061, laterCost=0.002, metadataCost=0.001
    var transient=1, permanent=false, stage="focused-window", axError:Int32 = -25204
    var identityFailure:String?, invalid:String?, invalidateOnSleep:String?
    var proofs=0, metadataChecks=0, sleeps=0, downs=0, ups=0
    var samples=[Double]()
    func checkpoint() throws { if let invalid { throw ComputerError(invalid,"fake checkpoint; no native input") } }
    func nextDown() async throws {
        try await BoundedKeyboardDownReadiness.run(backend:KeyboardDownReadinessBackend(now:{self.time},proof:{deadline in
            self.proofs += 1
            self.time += self.proofs == 1 ? self.firstCost : self.laterCost
            self.samples.append(self.time)
            if let failure=self.identityFailure { throw ComputerError(failure,"fake exact CG/process/frontmost rejection") }
            if self.permanent || self.transient > 0 {
                self.transient=max(0,self.transient-1)
                guard TransientKeyboardAXRead.mayWait(focused:nil,error:self.axError,stage:self.stage,now:self.time,deadline:deadline) else { throw ComputerError("FOCUS_CHANGED","fake failed AX read") }
                return .temporarilyUnavailable
            }
            return .ready
        },metadata:{deadline,checkpoint in
            self.metadataChecks += 1; try checkpoint()
            if let failure=self.identityFailure { throw ComputerError(failure,"fake independent metadata rejection") }
            self.time += self.metadataCost; try checkpoint()
            guard self.time < deadline else { throw ComputerError("FOCUS_CHANGED","fake metadata60ms cap") }
        },sleep:{ns in
            self.sleeps += 1; self.time += Double(ns)/1_000_000_000
            if self.invalidateOnSleep == "cancel" { withUnsafeCurrentTask { $0?.cancel() } }
            else if let failure=self.invalidateOnSleep { self.invalid=failure }
            await Task.yield()
        }),budget:budget,checkpoint:{try self.checkpoint()})
        downs += 1; ups += 1 // Simulated permission consumption only; no native event type exists here.
    }
    func run() async -> String? {
        let child=Task { @MainActor in try await self.nextDown() }
        do { try await child.value; return nil }
        catch let error as ComputerError { return error.code }
        catch is CancellationError { return "CANCELLED" }
        catch { return "UNEXPECTED" }
    }
}
@main struct PolicyMatrix {
    @MainActor static func main() async {
        var rows=[[String:Any]]()
        func row(_ name:String,_ passed:Bool,_ f:Fake,_ error:String?) {
            rows.append(["case":name,"passed":passed,"proofs":f.proofs,"sleeps":f.sleeps,"fakeDowns":f.downs,"fakeUps":f.ups,"elapsedMs":Int((f.time*1000).rounded()),"remainingMs":Int((f.budget.remaining*1000).rounded()),"error":error as Any? ?? NSNull()])
        }
        for stage in ["focused-window","deadline"] {
            let f=Fake();f.stage=stage;let error=await f.run()
            row("expired-cannotComplete-"+stage+"-needs-fresh60ms-proof",error == nil && f.proofs == 2 && f.downs == 1 && f.ups == 1 && f.sleeps == 1 && f.budget.remaining < 0.44 && f.budget.remaining > 0.4,f,error)
        }
        do { let f=Fake();f.transient=0;let e=await f.run();row("expired-ready-never-authorizes-down",e == "FOCUS_CHANGED" && f.downs == 0 && f.sleeps == 0,f,e) }
        do { let f=Fake();f.firstCost=0.06;f.transient=0;let e=await f.run();row("exact60ms-ready-is-expired",e == "FOCUS_CHANGED" && f.downs == 0,f,e) }
        do { let f=Fake();f.firstCost=0.002;f.transient=0;let e=await f.run();row("fresh-ready-keeps-fast-path",e == nil && f.downs == 1 && f.proofs == 1 && f.sleeps == 0 && f.budget.remaining == 0.5,f,e) }
        do { let f=Fake();f.permanent=true;f.laterCost=0.061;let e=await f.run();row("permanent-expired-cannotComplete-exhausts-original500ms",e == "FOCUS_CHANGED" && f.downs == 0 && f.time <= 0.501 && f.time >= 0.49,f,e) }
        do { let f=Fake();f.firstCost=0.501;let e=await f.run();row("over500ms-failed-read-consumes-remainder-without-retry",e == "FOCUS_CHANGED" && f.downs == 0 && f.sleeps == 0 && f.budget.remaining == 0,f,e) }
        do { let f=Fake();f.downs=2;f.ups=2;let e=await f.run();row("completed-prefix-not-replayed-one-successor-pair",e == nil && f.downs == 3 && f.ups == 3 && f.proofs == 2,f,e) }
        do { let f=Fake();f.transient=3;f.firstCost=0.2;let first=await f.run();let remaining=f.budget.remaining;f.permanent=true;let second=await f.run();row("later-character-cannot-renew-action-retry-budget",first == nil && second == "FOCUS_CHANGED" && f.downs == 1 && remaining < 0.3 && f.time <= 0.563,f,second) }
        for code in [Int32(-25201),Int32(-25205),Int32(0)] {
            let f=Fake();f.axError=code;let e=await f.run();row("other-AX-"+String(code)+"-never-retries",e == "FOCUS_CHANGED" && f.downs == 0 && f.proofs == 1 && f.sleeps == 0,f,e)
        }
        for failure in ["GEOMETRY_CHANGED","FOCUS_CHANGED","TARGET_GONE","SIBLING_CHANGED","PREFIX_CHANGED"] {
            let f=Fake();f.identityFailure=failure;let e=await f.run();row("expired-AX-with-exact-identity-"+failure+"-hard-fails",e == failure && f.downs == 0 && f.proofs == 1 && f.sleeps == 0,f,e)
        }
        for failure in ["HUMAN_INPUT_INTERRUPTED","STALE_EPOCH","INPUT_HELD","OWNED_RELEASE_PENDING","PERMISSION_REVOKED","CURSOR_CLEANUP_FAILED","OWNER_CHANGED","cancel"] {
            let f=Fake();f.invalidateOnSleep=failure;let e=await f.run();row("await-"+failure+"-prevents-new-proof-and-down",e == (failure == "cancel" ? "CANCELLED":failure) && f.downs == 0 && f.proofs == 1 && f.sleeps == 1,f,e)
        }
        do { let f=Fake();f.metadataCost=0.061;let e=await f.run();row("independent-metadata60ms-cap-unchanged",e == "FOCUS_CHANGED" && f.downs == 0 && f.sleeps == 0,f,e) }
        let focused=KeyboardFocusSnapshot()
        let refusesKnownRoot = !TransientKeyboardAXRead.mayWait(focused:focused,error:-25204,stage:"focused-window",now:0.07,deadline:0.06)
        let refusesPrematureDeadline = !TransientKeyboardAXRead.mayWait(focused:nil,error:-25204,stage:"deadline",now:0,deadline:1)
        let refusesNonfinite = !TransientKeyboardAXRead.mayWait(focused:nil,error:-25204,stage:"focused-window",now:.infinity,deadline:1)
        rows.append(["case":"classification-only-no-known-root-premature-deadline-or-nonfinite","passed":refusesKnownRoot && refusesPrematureDeadline && refusesNonfinite])
        let passed=rows.allSatisfy{$0["passed"] as? Bool == true}
        let report:[String:Any]=["passed":passed,"caseCount":rows.count,"rows":rows,"fullProofLimitMs":60,"sharedActionRetryBudgetMs":500,"maximumYieldMs":10,"actualAXReads":0,"actualWindows":0,"actualInputEvents":0,"fakeCallbacksOnly":true]
        let data=try! JSONSerialization.data(withJSONObject:report,options:[.sortedKeys]);print(String(data:data,encoding:.utf8)!)
        if !passed { exit(1) }
    }
}
`
}
