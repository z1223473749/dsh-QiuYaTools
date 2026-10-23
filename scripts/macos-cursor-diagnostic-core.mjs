/** Test-only source instrumentation and finite projection; importing never starts native code. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir, realpath, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

export const currentCursorBaseline = '66ae37d056385e3053724a07a982993c9f8356481666b2d8ee59f65d1356e502'
const hash = value => createHash('sha256').update(value).digest('hex')
const reasons = new Set([
  'posted-lease-rejected', 'posted-owner-missing', 'posted-interrupted', 'posted-accepted',
  'target-change', 'settled', 'external-hide', 'lease-reset', 'physical-release', 'shutdown-cleanup',
  'action-error', 'explicit-hide', 'human-without-active-lease', 'human-intervention',
  'focus-identity-missing', 'focus-check-failed', 'session-notification',
  'refresh-session-latched-inactive', 'refresh-session-not-active', 'refresh-lease-rejected',
  'refresh-foreground-mismatch', 'refresh-cursor-unavailable', 'refresh-readback-pending',
  'refresh-readback-expired', 'refresh-point-outside-target', 'refresh-visible-point-rejected',
  'refresh-clipped-empty', 'refresh-owner-missing', 'refresh-suppression-blocked',
  'refresh-suppression-not-activated', 'refresh-panel-ordered',
])
const booleans = ['hasTarget', 'hasPointerEpoch', 'pointerEpochMatchesLease', 'hasPanel', 'panelVisible',
  'pendingReadback', 'sessionLatchedActive', 'sessionActive', 'leaseCurrent', 'physicalOwnerPresent',
  'foregroundMatches', 'readbackAvailable', 'readbackMatchesPosted', 'targetInside', 'visiblePointAccepted',
  'windowListAvailable', 'targetValid', 'firstCoverIsTarget', 'verifiedSystemCursorSkipped', 'suppressionAccepted']
const counters = ['epoch', 'postedCalls', 'refreshCalls', 'hideCalls', 'postedPointCount']
const coverClasses = new Set(['none', 'exact-target', 'target-other-window', 'own-other-window', 'foreign-window'])

function finiteSnapshot(value) {
  if (!value || typeof value !== 'object' || !reasons.has(value.reason)) return null
  const result = { reason: value.reason }
  for (const name of counters) if (Number.isSafeInteger(value[name]) && value[name] >= 0) result[name] = value[name]
  for (const name of ['elapsedMs', 'factsElapsedMs']) if (Number.isFinite(value[name]) && value[name] >= 0) result[name] = value[name]
  for (const name of booleans) if (typeof value[name] === 'boolean') result[name] = value[name]
  if (coverClasses.has(value.firstCoverClass)) result.firstCoverClass = value.firstCoverClass
  return result
}

/** Do not retain arbitrary native dictionaries, owner IDs, AX text, coordinates or titles. */
export function finiteCursorDiagnostic(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.leases)) return null
  const leases = value.leases.slice(-8).filter(row => Number.isSafeInteger(row?.epoch) && row.epoch >= 0).map(row => ({
    epoch: row.epoch,
    firstReject: finiteSnapshot(row.firstReject), firstHide: finiteSnapshot(row.firstHide),
    firstStatefulHide: finiteSnapshot(row.firstStatefulHide), last: finiteSnapshot(row.last),
    branches: Array.isArray(row.branches) ? row.branches.slice(-96).filter(reason => reasons.has(reason)) : [],
  }))
  return { schemaVersion: 1, diagnosticOnly: true, maximumLeaseRecords: 8, leases }
}

function once(source, before, after, label) {
  const index = source.indexOf(before)
  assert.ok(index >= 0 && source.indexOf(before, index + before.length) < 0, `Diagnostic source seam changed or ambiguous: ${label}`)
  return source.slice(0, index) + after + source.slice(index + before.length)
}

const diagnosticState = String.raw`
    // DIAGNOSTIC COPY ONLY. First causes survive the 96-entry recent branch ring.
    // Keep eight native leases; this finite two-chat runner issues at most three per helper.
    private struct CursorLeaseDiagnostic {
        let epoch: Int
        let startedAt: TimeInterval
        var postedCalls = 0
        var refreshCalls = 0
        var hideCalls = 0
        var facts: [String: Any] = [:]
        var branches: [String] = []
        var firstReject: [String: Any]?
        var firstHide: [String: Any]?
        var firstStatefulHide: [String: Any]?
        var last: [String: Any]?
        var snapshot: [String: Any] {
            ["epoch": epoch, "firstReject": firstReject as Any? ?? NSNull(),
             "firstHide": firstHide as Any? ?? NSNull(), "firstStatefulHide": firstStatefulHide as Any? ?? NSNull(),
             "last": last as Any? ?? NSNull(), "branches": branches]
        }
    }
    private var diagnosticLeases: [CursorLeaseDiagnostic] = []
    private func diagnosticBeginLease(_ epoch: Int) {
        guard diagnosticLeases.last?.epoch != epoch else { return }
        diagnosticLeases.append(CursorLeaseDiagnostic(epoch: epoch, startedAt: ProcessInfo.processInfo.systemUptime))
        if diagnosticLeases.count > 8 { diagnosticLeases.removeFirst(diagnosticLeases.count - 8) }
    }
    private func diagnosticFacts(_ facts: [String: Any], replace: Bool = false) {
        guard !diagnosticLeases.isEmpty else { return }
        let index = diagnosticLeases.count - 1
        if replace { diagnosticLeases[index].facts = facts }
        else { diagnosticLeases[index].facts.merge(facts) { _, latest in latest } }
        diagnosticLeases[index].facts["factsElapsedMs"] = max(0, (ProcessInfo.processInfo.systemUptime - diagnosticLeases[index].startedAt) * 1000)
    }
    private func recordDiagnostic(_ reason: String, rejected: Bool = false, hiding: Bool = false) {
        guard !diagnosticLeases.isEmpty else { return }
        let index = diagnosticLeases.count - 1
        if hiding { diagnosticLeases[index].hideCalls += 1 }
        let record = diagnosticLeases[index]
        var sample = record.facts
        sample.merge(["reason": reason, "epoch": record.epoch,
            "elapsedMs": max(0, (ProcessInfo.processInfo.systemUptime - record.startedAt) * 1000),
            "postedCalls": record.postedCalls, "refreshCalls": record.refreshCalls, "hideCalls": record.hideCalls,
            "hasTarget": target != nil, "hasPointerEpoch": epoch != nil, "pointerEpochMatchesLease": epoch == record.epoch,
            "hasPanel": panel != nil, "panelVisible": panel?.isVisible == true,
            "postedPointCount": postedPoints.count, "pendingReadback": pendingReadback,
            "sessionLatchedActive": !sessionInactive, "leaseCurrent": isLeaseCurrent?(record.epoch) == true,
            "physicalOwnerPresent": physicalLeaseOwner?(record.epoch)?.isEmpty == false]) { _, latest in latest }
        diagnosticLeases[index].last = sample
        diagnosticLeases[index].branches.append(reason)
        if diagnosticLeases[index].branches.count > 96 { diagnosticLeases[index].branches.removeFirst(diagnosticLeases[index].branches.count - 96) }
        if rejected && diagnosticLeases[index].firstReject == nil { diagnosticLeases[index].firstReject = sample }
        if hiding && diagnosticLeases[index].firstHide == nil { diagnosticLeases[index].firstHide = sample }
        if hiding && (target != nil || panel != nil || !postedPoints.isEmpty) && diagnosticLeases[index].firstStatefulHide == nil {
            diagnosticLeases[index].firstStatefulHide = sample
        }
    }
    private var finiteDiagnostic: [String: Any] {
        ["schemaVersion": 1, "diagnosticOnly": true, "maximumLeaseRecords": 8, "leases": diagnosticLeases.map { $0.snapshot }]
    }
`

/** All replacements must match exactly once. No production file is written here. */
export function instrumentMacCursorSources({ cursor, input }) {
  const readbackRule = '        let matchesPosted = postedPoints.contains { hypot($0.x - actual.x, $0.y - actual.y) <= 1.5 }'
  cursor = once(cursor, readbackRule, readbackRule, 'unchanged readback tolerance')
  cursor = once(cursor, '    var isLeaseCurrent: ((Int) -> Bool)?', diagnosticState + '    var isLeaseCurrent: ((Int) -> Bool)?', 'diagnostic state')
  cursor = once(cursor, '    func beginLease(_ epoch: Int) { sessionInactive = !Self.sessionActive(); suppression.beginLease(epoch) }',
    '    func beginLease(_ epoch: Int) { diagnosticBeginLease(epoch); sessionInactive = !Self.sessionActive(); suppression.beginLease(epoch) }', 'lease begin')
  cursor = once(cursor, '        return hide()\n    }\n\n    func withdrawForPointerReadback', '        return hide(diagnosticReason: "human-intervention")\n    }\n\n    func withdrawForPointerReadback', 'human hide')
  cursor = once(cursor, '        guard isLeaseCurrent?(epoch) == true, let ownerId = physicalLeaseOwner?(epoch), !ownerId.isEmpty, !suppression.interrupted(epoch) else { return }', String.raw`        if !diagnosticLeases.isEmpty { diagnosticLeases[diagnosticLeases.count - 1].postedCalls += 1 }
        let diagnosticLeaseCurrent = isLeaseCurrent?(epoch) == true
        diagnosticFacts(["leaseCurrent": diagnosticLeaseCurrent], replace: true)
        guard diagnosticLeaseCurrent else { recordDiagnostic("posted-lease-rejected", rejected: true); return }
        let diagnosticOwnerId = physicalLeaseOwner?(epoch)
        diagnosticFacts(["physicalOwnerPresent": diagnosticOwnerId?.isEmpty == false])
        guard let ownerId = diagnosticOwnerId, !ownerId.isEmpty else { recordDiagnostic("posted-owner-missing", rejected: true); return }
        guard !suppression.interrupted(epoch) else { recordDiagnostic("posted-interrupted", rejected: true); return }
        recordDiagnostic("posted-accepted")`, 'posted guards')
  cursor = once(cursor, '            hide()\n            self.epoch = epoch; self.target = target', '            hide(diagnosticReason: "target-change")\n            self.epoch = epoch; self.target = target', 'target transition')
  cursor = once(cursor, '        phase = "idle"\n        // Old points', '        phase = "idle"\n        recordDiagnostic("settled")\n        // Old points', 'settled')
  cursor = once(cursor, '    @discardableResult func hide() -> Bool {\n        timer?', '    @discardableResult func hide(diagnosticReason: String = "external-hide") -> Bool {\n        recordDiagnostic(diagnosticReason, hiding: true)\n        timer?', 'hide entry')
  cursor = once(cursor, '"coordinateSpace": "desktop", "systemCursorSuppression": suppression.snapshot]', '"coordinateSpace": "desktop", "systemCursorSuppression": suppression.snapshot, "finiteDiagnostic": finiteDiagnostic]', 'desktop status')
  cursor = once(cursor, '"actor": "ai", "phase": visible ? phase : "hidden", "systemCursorSuppression": suppression.snapshot]', '"actor": "ai", "phase": visible ? phase : "hidden", "systemCursorSuppression": suppression.snapshot, "finiteDiagnostic": finiteDiagnostic]', 'frame status')
  cursor = once(cursor, '                        self.hide()\n                    } else { self.refresh() }', '                        self.hide(diagnosticReason: "session-notification")\n                    } else { self.refresh() }', 'session notification')
  cursor = once(cursor, String.raw`        guard !sessionInactive, Self.sessionActive(), isLeaseCurrent?(epoch) == true, NSWorkspace.shared.frontmostApplication?.processIdentifier == target.pid,
              let actual = CGEvent(source: nil)?.location else { hide(); return }`, String.raw`        if !diagnosticLeases.isEmpty { diagnosticLeases[diagnosticLeases.count - 1].refreshCalls += 1 }
        diagnosticFacts([:], replace: true)
        guard !sessionInactive else { recordDiagnostic("refresh-session-latched-inactive", rejected: true); hide(diagnosticReason: "refresh-session-latched-inactive"); return }
        let diagnosticSessionActive = Self.sessionActive()
        diagnosticFacts(["sessionActive": diagnosticSessionActive])
        guard diagnosticSessionActive else { recordDiagnostic("refresh-session-not-active", rejected: true); hide(diagnosticReason: "refresh-session-not-active"); return }
        let diagnosticLeaseCurrent = isLeaseCurrent?(epoch) == true
        diagnosticFacts(["leaseCurrent": diagnosticLeaseCurrent])
        guard diagnosticLeaseCurrent else { recordDiagnostic("refresh-lease-rejected", rejected: true); hide(diagnosticReason: "refresh-lease-rejected"); return }
        let diagnosticForegroundMatches = NSWorkspace.shared.frontmostApplication?.processIdentifier == target.pid
        diagnosticFacts(["foregroundMatches": diagnosticForegroundMatches])
        guard diagnosticForegroundMatches else { recordDiagnostic("refresh-foreground-mismatch", rejected: true); hide(diagnosticReason: "refresh-foreground-mismatch"); return }
        let diagnosticActual = CGEvent(source: nil)?.location
        diagnosticFacts(["readbackAvailable": diagnosticActual != nil])
        guard let actual = diagnosticActual else { recordDiagnostic("refresh-cursor-unavailable", rejected: true); hide(diagnosticReason: "refresh-cursor-unavailable"); return }`, 'refresh readiness')
  cursor = once(cursor, '        if !matchesPosted {\n            // Event posting', '        diagnosticFacts(["readbackMatchesPosted": matchesPosted])\n        if !matchesPosted {\n            recordDiagnostic("refresh-readback-pending")\n            // Event posting', 'readback pending')
  cursor = once(cursor, '            if !pendingReadback || ProcessInfo.processInfo.systemUptime - lastPostedAt > 0.12 { hide() }', '            if !pendingReadback || ProcessInfo.processInfo.systemUptime - lastPostedAt > 0.12 { recordDiagnostic("refresh-readback-expired", rejected: true); hide(diagnosticReason: "refresh-readback-expired") }', 'readback expiry')
  cursor = once(cursor, '        guard target.frame.contains(actual), targetOwnsVisiblePoint(target, point: actual) else { hide(); return }', String.raw`        let diagnosticInside = target.frame.contains(actual)
        diagnosticFacts(["targetInside": diagnosticInside])
        guard diagnosticInside else { recordDiagnostic("refresh-point-outside-target", rejected: true); hide(diagnosticReason: "refresh-point-outside-target"); return }
        let diagnosticVisiblePoint = targetOwnsVisiblePoint(target, point: actual)
        diagnosticFacts(["visiblePointAccepted": diagnosticVisiblePoint])
        guard diagnosticVisiblePoint else { recordDiagnostic("refresh-visible-point-rejected", rejected: true); hide(diagnosticReason: "refresh-visible-point-rejected"); return }`, 'visible point')
  cursor = once(cursor, '        guard !clipped.isNull, !clipped.isEmpty else { hide(); return }\n        guard let ownerId = physicalLeaseOwner?(epoch), !ownerId.isEmpty else { hide(); return }', String.raw`        guard !clipped.isNull, !clipped.isEmpty else { recordDiagnostic("refresh-clipped-empty", rejected: true); hide(diagnosticReason: "refresh-clipped-empty"); return }
        let diagnosticOwnerId = physicalLeaseOwner?(epoch)
        diagnosticFacts(["physicalOwnerPresent": diagnosticOwnerId?.isEmpty == false])
        guard let ownerId = diagnosticOwnerId, !ownerId.isEmpty else { recordDiagnostic("refresh-owner-missing", rejected: true); hide(diagnosticReason: "refresh-owner-missing"); return }`, 'clip and owner')
  cursor = once(cursor, '            _ = suppression.activate(.init(epoch: epoch, leaseOwnerId: ownerId, targetId: target.id))', '            let diagnosticSuppressionAccepted = suppression.activate(.init(epoch: epoch, leaseOwnerId: ownerId, targetId: target.id))', 'suppression result')
  cursor = once(cursor, '            maintainRestoration(suppression.clear || suppression.phase == "hidden")\n            guard suppression.phase != "blocked" else { hide(); return }', String.raw`            diagnosticFacts(["suppressionAccepted": diagnosticSuppressionAccepted])
            if !diagnosticSuppressionAccepted { recordDiagnostic("refresh-suppression-not-activated", rejected: true) }
            maintainRestoration(suppression.clear || suppression.phase == "hidden")
            guard suppression.phase != "blocked" else { recordDiagnostic("refresh-suppression-blocked", rejected: true); hide(diagnosticReason: "refresh-suppression-blocked"); return }`, 'suppression diagnostic')
  cursor = once(cursor, '        panel?.orderFrontRegardless()\n    }', '        panel?.orderFrontRegardless()\n        recordDiagnostic("refresh-panel-ordered")\n    }', 'panel ordered')
  cursor = once(cursor, '        guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return false }', '        guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { diagnosticFacts(["windowListAvailable": false]); return false }', 'full window list')
  cursor = once(cursor, '        var firstCovering: CGWindowID?\n        for item in windows {', '        var firstCovering: CGWindowID?\n        var diagnosticFirstCoverClass = "none"\n        var diagnosticSystemCursorSkipped = false\n        for item in windows {', 'cover classification')
  cursor = once(cursor, '                ownerPID: (item[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value) { continue }',
    '                ownerPID: (item[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value) { diagnosticSystemCursorSkipped = true; continue }', 'system cursor proof')
  cursor = once(cursor, '            if firstCovering == nil, rect.contains(point), (item[kCGWindowAlpha as String] as? NSNumber)?.doubleValue != 0 { firstCovering = id }', String.raw`            if firstCovering == nil, rect.contains(point), (item[kCGWindowAlpha as String] as? NSNumber)?.doubleValue != 0 {
                firstCovering = id
                let owner = (item[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
                diagnosticFirstCoverClass = id == target.windowId ? "exact-target" : owner == target.pid ? "target-other-window" : owner == getpid() ? "own-other-window" : "foreign-window"
            }`, 'first covering window')
  cursor = once(cursor, '        return targetValid && firstCovering == target.windowId', String.raw`        diagnosticFacts(["windowListAvailable": true, "targetValid": targetValid, "firstCoverIsTarget": firstCovering == target.windowId,
            "firstCoverClass": diagnosticFirstCoverClass, "verifiedSystemCursorSkipped": diagnosticSystemCursorSkipped])
        return targetValid && firstCovering == target.windowId`, 'full stack proof')

  const inputReplacements = [
    ['guard aiPointer.hide() else', 'guard aiPointer.hide(diagnosticReason: "lease-reset") else', 'lease reset'],
    ['restoreCursor: { aiPointer.hide() }', 'restoreCursor: { aiPointer.hide(diagnosticReason: "physical-release") }', 'physical release'],
    ['restoreCursor: { aiPointer.hide() }', 'restoreCursor: { aiPointer.hide(diagnosticReason: "shutdown-cleanup") }', 'shutdown cleanup'],
    ['fence.active == epoch ? aiPointer.hide() : aiPointer.restorationComplete', 'fence.active == epoch ? aiPointer.hide(diagnosticReason: "action-error") : aiPointer.restorationComplete', 'action error'],
    ['func hideAICursor() -> Bool { aiPointer.hide() }', 'func hideAICursor() -> Bool { aiPointer.hide(diagnosticReason: "explicit-hide") }', 'explicit hide'],
    ['else { operationBadge.hide(); aiPointer.hide() }', 'else { operationBadge.hide(); aiPointer.hide(diagnosticReason: "human-without-active-lease") }', 'human without lease'],
    ['aiPointer.hide(); throw ComputerError("FOCUS_CHANGED"', 'aiPointer.hide(diagnosticReason: "focus-identity-missing"); throw ComputerError("FOCUS_CHANGED"', 'focus identity'],
    ['catch { aiPointer.hide(); throw error }', 'catch { aiPointer.hide(diagnosticReason: "focus-check-failed"); throw error }', 'focus checks'],
  ]
  // Distinguish the two cleanup call sites before applying exact-once replacements.
  input = once(input, 'func shutdownCleanup() throws {', 'func shutdownCleanup() throws {\n        // DIAGNOSTIC_SHUTDOWN_BOUNDARY', 'shutdown boundary')
  const shutdownIndex = input.indexOf('        // DIAGNOSTIC_SHUTDOWN_BOUNDARY')
  let beforeShutdown = input.slice(0, shutdownIndex), afterShutdown = input.slice(shutdownIndex)
  beforeShutdown = once(beforeShutdown, inputReplacements[1][0], inputReplacements[1][1], inputReplacements[1][2])
  afterShutdown = once(afterShutdown, inputReplacements[2][0], inputReplacements[2][1], inputReplacements[2][2])
  input = beforeShutdown + afterShutdown
  for (const [before, after, label] of inputReplacements.filter((_, index) => index !== 1 && index !== 2)) input = once(input, before, after, label)
  assert.equal((input.match(/aiPointer\.hide\(\)/gu) ?? []).length, 0, 'Every direct input hide must have a finite diagnostic call-site')
  return { cursor, input }
}

const nativeNames = ['Protocol', 'Capture', 'LeaseGuard', 'Applications', 'OperationBadge', 'CursorOverlay', 'FocusPreparation', 'Input', 'Preview', 'main'].map(name => `src/native/macos/${name}.swift`)

/** Freeze source and a build plan only. This function cannot compile, start a Host, or send input. */
export async function prepareMacCursorSourceSnapshot({ root, base, expectedHelperSHA256 = currentCursorBaseline, buildReceiptPath = 'artifacts/computer-use/macos-keyboard-pair-formal-build/1c5b471e-9d6e-4d3d-9f83-bb58b1a311de/report.json' }) {
  const id = randomUUID()
  base ??= join(root, 'artifacts/computer-use/macos-cursor-first-cause-source-prepared-' + id)
  const helper = await realpath(join(root, 'lib/QiuYaTools Computer.app/Contents/MacOS/qiuya-computer'))
  const helperSHA256 = hash(await readFile(helper)), receipt = JSON.parse(await readFile(join(root, buildReceiptPath), 'utf8'))
  assert.match(expectedHelperSHA256, /^[a-f0-9]{64}$/u, 'An explicit helper digest must be exact')
  assert.equal(helperSHA256, expectedHelperSHA256, 'Source-only diagnostic requires the pinned helper bytes')
  assert.equal(receipt.helperSHA256, helperSHA256); assert.equal(receipt.passed, true); assert.equal(receipt.sourceStable, true)
  const originals = {}, baselineSourceHashes = {}
  for (const path of nativeNames) {
    originals[path] = await readFile(join(root, path), 'utf8'); baselineSourceHashes[path] = hash(originals[path])
    assert.equal(baselineSourceHashes[path], receipt.before[path]?.sha256 ?? receipt.before[path], `Source differs from the pinned build receipt: ${path}`)
    assert.equal(baselineSourceHashes[path], receipt.after[path]?.sha256 ?? receipt.after[path], `Pinned build source was unstable: ${path}`)
  }
  const instrumented = instrumentMacCursorSources({ cursor: originals['src/native/macos/CursorOverlay.swift'], input: originals['src/native/macos/Input.swift'] })
  const runtimeFiles = (await readdir(join(root, 'src/features/computer-use'))).filter(name => name.endsWith('.ts')).map(name => 'src/features/computer-use/' + name)
  const bound = [buildReceiptPath, ...nativeNames, ...runtimeFiles, 'lib/macos-manifest.json', 'lib/QiuYaTools Computer.app/Contents/Info.plist',
    'scripts/macos-cursor-diagnostic-core.mjs', 'scripts/prepare-macos-multitask-acceptance.mjs', 'scripts/test-macos-multitask-manager.mjs', 'tests/macos-multitask-runner.test.mjs',
    'src/native/macos/fixtures/AICursorFixture.swift', 'src/native/macos/fixtures/AICursorObserver.swift', 'src/native/macos/fixtures/LeaseOracle.swift']
  const sourceHashes = {}
  for (const path of bound) sourceHashes[path] = hash(await readFile(join(root, path)))
  await mkdir(base)
  const snapshotHashes = {}
  for (const path of bound) {
    const destination = join(base, 'baseline', path)
    await mkdir(join(destination, '..'), { recursive: true })
    const bytes = await readFile(join(root, path)); assert.equal(hash(bytes), sourceHashes[path], `Source changed while freezing: ${path}`)
    await writeFile(destination, bytes); snapshotHashes[relative(base, destination)] = hash(bytes)
  }
  for (const path of nativeNames) {
    const destination = join(base, 'source', path)
    await mkdir(join(destination, '..'), { recursive: true })
    const bytes = path.endsWith('/CursorOverlay.swift') ? instrumented.cursor : path.endsWith('/Input.swift') ? instrumented.input : originals[path]
    await writeFile(destination, bytes); snapshotHashes[relative(base, destination)] = hash(bytes)
  }
  const app = join(base, 'QiuYaTools Computer.app/Contents'), executable = join(app, 'MacOS/qiuya-computer')
  await mkdir(join(app, 'MacOS'), { recursive: true })
  const info = await readFile(join(root, 'lib/QiuYaTools Computer.app/Contents/Info.plist')); await writeFile(join(app, 'Info.plist'), info)
  snapshotHashes[relative(base, join(app, 'Info.plist'))] = hash(info)
  const buildPlan = { command: '/usr/bin/swiftc', args: ['-O', '-swift-version', '5', '-target', 'arm64-apple-macosx13.0',
    ...['AppKit', 'WebKit', 'ScreenCaptureKit', 'ApplicationServices', 'CoreImage', 'CoreMedia'].flatMap(name => ['-framework', name]),
    '-module-cache-path', '/private/tmp/qiuya-cursor-first-cause-cache', ...nativeNames.map(path => join(base, 'source', path)), '-o', executable],
    executed: false, guiStarted: 0, inputActions: 0 }
  await writeFile(join(base, 'build-plan.json'), JSON.stringify(buildPlan, null, 2)); snapshotHashes['build-plan.json'] = hash(JSON.stringify(buildPlan, null, 2))
  const data = { id, kind: 'receipt-bound-cursor-first-cause-source-only', root, base, helper, helperSHA256, buildReceiptPath,
    baselineSourceHashes, sourceHashes, snapshotHashes, diagnosticExecutable: executable, buildPending: true, compileExecuted: false, guiStarted: 0, inputActions: 0,
    productionSourcesModified: false, productionHelperModified: false, authorizationThresholdsChanged: false, maximumHeldObservationMs: 1800,
    maximumLeaseRecords: 8, recentBranchLimit: 96, preparedAt: new Date().toISOString(),
    scope: 'Isolated source diagnostic based on exact pinned helper/build-receipt sources. First per-native-lease rejection/hide/stateful-hide snapshots are independent of the recent 96-branch ring. No native compilation, Host, GUI, PD, model or actual input has run; no visibility, pixel or acceptance claim.' }
  for (const [path, expected] of Object.entries(sourceHashes)) assert.equal(hash(await readFile(join(root, path))), expected, `Source changed after freezing: ${path}`)
  assert.equal(hash(await readFile(helper)), helperSHA256, 'Formal helper changed after freezing')
  await writeFile(join(base, 'prepare-data.json'), JSON.stringify(data, null, 2))
  return data
}
