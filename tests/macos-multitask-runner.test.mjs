import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile, writeFile, mkdir, mkdtemp, rm, access } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { finiteCursorDiagnostic, instrumentMacCursorSources, prepareMacCursorSourceSnapshot, currentCursorBaseline } from '../scripts/macos-cursor-diagnostic-core.mjs'

// Importing the GUI runner would execute it. Exercise its actual read-only
// gates in isolation; no native helper, GUI or input is launched by these tests.
const source = await readFile(new URL('../scripts/test-macos-multitask-manager.mjs', import.meta.url), 'utf8')
function extract(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first)
  assert.ok(first > 0 && last > first)
  return source.slice(first, last)
}
const settleSource = extract('async function settledCapture(', '\nasync function pin(')
const retireSource = extract('async function retireObserverAfterAudit(', '\nasync function fixtureState(')
const waitSource = extract('async function waitExit(', '\nasync function retireObserverAfterAudit(')
const heldSource = extract('async function held(', '\n\ntry {')
const untilSource = extract('async function until(', '\nasync function os(')
const owner = { pid: 55, startSeconds: '100', startMicroseconds: '3', uniqueId: 'own', executablePath: '/own/fixture' }
const target = { id: 'mac-window:88', pid: 55, appId: 'own.fixture', x: 100, y: -1200, width: 640, height: 492, scale: 1 }
const fixturePoint = { x: 420, y: -954 }
const same = (a, b) => !!a && !!b && ['pid', 'startSeconds', 'startMicroseconds', 'executablePath'].every(field => a[field] === b[field])

function geometry(mode) {
  let clock = 0, snapshots = 0, reads = 0
  const operations = [], geometrySettles = [], fixture = { identity: owner, target }, fixtures = new Map([['chat-B', fixture]])
  const context = {
    assert, fixtures, geometrySettles, setTimeout, clearTimeout, same,
    performance: { now: () => clock }, sleep: async ms => { clock += ms },
    observer: { async ok(op) { operations.push(op); return { identity: { ...owner, ...(mode === 'reused' ? { startMicroseconds: '4' } : {}) } } } },
    os: async () => { operations.push('snapshot'); snapshots++; return { foregroundPid: 99, windows: mode === 'transition' && snapshots === 1 ? [] : [{ ...target, id: 88, onScreen: true, alpha: 1 }] } },
    manager: { async targetsFor() { operations.push('targets'); return [{ ...target, ...(mode === 'different-app' ? { appId: 'other.fixture' } : {}) }] } },
    capture: async () => {
      operations.push('observe'); reads++
      if (mode === 'timeout') throw Object.assign(new Error('capture timeout'), { code: 'CAPTURE_TIMEOUT' })
      const geometry = mode === 'mismatch' ? { ...target, width: 630 } : reads % 2 ? { scale: 1, height: 492, width: 640, y: -1200, x: 100 } : { x: 100, y: -1200, width: 640, height: 492, scale: 1 }
      return { targetId: target.id, frameId: `frame-${reads}`, width: 1280, height: 984, geometry }
    },
    fixtureState: async () => ({ pid: 55, windowId: 88, bundleId: 'own.fixture', point: fixturePoint, visible: true }),
    point: (value, frame) => ({ x: (value.settledPoint.x - frame.geometry.x) * frame.width / frame.geometry.width, y: (value.settledPoint.y - frame.geometry.y) * frame.height / frame.geometry.height }),
  }
  return { run: () => vm.runInNewContext(`(${settleSource})`, context)('chat-B', 'before-input'), operations, geometrySettles, fixture, reads: () => reads, clock: () => clock }
}

test('default-manager GUI runner waits for exact stable CG/native geometry without activating its background chat', async () => {
  const state = geometry('transition'), frame = await state.run(), evidence = state.geometrySettles[0]
  assert.equal(frame.frameId, `frame-${state.reads()}`)
  assert.ok(evidence.stableMs >= 200 && evidence.agreeingSamples >= 3)
  assert.deepEqual(state.fixture.settledPoint, fixturePoint)
  assert.equal(evidence.point.x, 640); assert.equal(evidence.point.y, 492)
  assert.equal(evidence.samples[0].window, null)
  assert.ok(state.operations.every(op => ['identity', 'snapshot', 'targets', 'observe'].includes(op)))
})

test('default-manager GUI runner rejects identity drift, unmatched geometry and unknown read failures before any action', async () => {
  for (const [mode, pattern] of [['reused', /identity changed/u], ['different-app', /target identity changed/u], ['mismatch', /did not become continuously stable/u], ['timeout', /CAPTURE_TIMEOUT/u]]) {
    const state = geometry(mode)
    await assert.rejects(state.run(), pattern)
    assert.ok(state.operations.every(op => ['identity', 'snapshot', 'targets', 'observe'].includes(op)))
    if (mode === 'timeout') assert.equal(state.reads(), 1, 'Unknown capture failure is not silently replayed')
    if (mode === 'mismatch') assert.ok(state.clock() <= 8025)
  }
})

async function cleanupCase(mode) {
  const cleanup = { errors: [], forced: [], exits: [] }, operations = [], child = { pid: 55, exitCode: null, signalCode: null, stdin: { end: () => operations.push('EOF') }, kill: () => operations.push('KILL') }
  let waits = 0
  const value = { child, label: 'observer', identity: owner, async ok() { operations.push('audit'); if (mode === 'audit-failure') throw Error('audit unavailable'); return { leftButtonDown: mode === 'held', rightButtonDown: false, middleButtonDown: false, keysDown: [] } } }
  const context = { assert, cleanup, same, empty: state => !state.leftButtonDown && !state.rightButtonDown && !state.middleButtonDown && state.keysDown.length === 0,
    waitExit: async () => { operations.push('wait'); if (mode === 'eof-timeout' && waits++ === 0) throw Error('EOF timeout'); child.exitCode = 0; return { code: 0, signal: null } },
    fallbackIdentity: async () => mode === 'eof-timeout' && !operations.includes('KILL') ? owner : null,
    until: async read => assert.ok(await read()),
  }
  await vm.runInNewContext(`(${retireSource})`, context)(value)
  return { cleanup, operations }
}

test('default-manager observer still retires by EOF when held-input audit fails or throws', async () => {
  for (const mode of ['held', 'audit-failure']) {
    const { cleanup, operations } = await cleanupCase(mode)
    assert.deepEqual(operations, ['audit', 'EOF', 'wait'])
    assert.equal(cleanup.observerNaturalExit, true); assert.equal(cleanup.observerEofAttempted, true)
    assert.equal(cleanup.errors.length, 1); assert.equal(cleanup.forced.length, 0)
  }
})

test('default-manager observer fallback kill requires failed bounded EOF rather than only a failed input audit', async () => {
  const { cleanup, operations } = await cleanupCase('eof-timeout')
  assert.deepEqual(operations, ['audit', 'EOF', 'wait', 'KILL', 'wait'])
  assert.deepEqual(cleanup.forced, ['observer']); assert.equal(cleanup.errors.length, 1)
})

test('default-manager native child retirement wait is bounded when exit acknowledgement never arrives', async () => {
  const wait = vm.runInNewContext(`(${waitSource})`, { setTimeout, clearTimeout, Promise, Error })
  await assert.rejects(wait({ exited: new Promise(() => {}), label: 'native-chat-B' }, 5), /native-chat-B exit timeout/u)
})

function heldCase(mode, diagnostic) {
  let clock = 0, osReads = 0, statusReads = 0
  const heldSamples = [], operations = [], fixture = { identity: { pid: 55 }, target: { id: 'mac-window:88' }, settledGeometry: target }
  const nativeState = () => {
    statusReads++; operations.push('status')
    const epoch = mode === 'epoch-change' && statusReads >= 2 ? 2 : 1
    return { leaseEpoch: epoch, leaseActor: 'ai', inputState: { mouseHeld: mode !== 'foreign-os-held', ownerId: mode === 'missing-owner' ? null : 'private-owned-id', leftButtonDown: mode !== 'never-published' || clock < 40 }, aiCursor: { visible: mode !== 'hidden-native', phase: mode === 'hidden-native' ? 'hidden' : 'pressed', x: 0, y: 0, epoch, targetId: mode === 'foreign-target' ? 'mac-window:99' : fixture.target.id, finiteDiagnostic: diagnostic, systemCursorSuppression: { phase: 'idle', supported: true, ownedHideCount: 0 } } }
  }
  const context = { assert, finiteCursorDiagnostic, performance: { now: () => clock }, sleep: async ms => { clock += ms }, fatal: undefined, phase: 'actual-fifo', heldSamples,
    fixtures: new Map([['chat-A', fixture]]), bindings: new Map([['chat-A', { identity: { pid: 66 }, native: { status: async () => nativeState() } }]]),
    os: async () => { operations.push('os'); osReads++; clock++; return { leftButtonDown: true, cursor: fixturePoint, foregroundPid: mode === 'foreground-drift' ? 99 : 55, windows: mode === 'hidden-native' ? [{ ...target, id: 88, pid: 55, onScreen: true, alpha: 1 }] : mode === 'never-published' || mode === 'foreign-target' || mode === 'delayed-publish' && osReads === 1 ? [] : [{ pid: 66, title: 'QiuYaTools AI pointer', onScreen: true, alpha: 1, width: 20, height: 26 }] } },
  }
  context.until = vm.runInNewContext(`(${untilSource})`, context)
  return { run: () => vm.runInNewContext(`(${heldSource})`, context)('chat-A'), samples: heldSamples, operations, clock: () => clock, osReads: () => osReads }
}

test('default-manager held gate waits for WindowServer publication within the same real held action', async () => {
  const value = heldCase('delayed-publish'), result = await value.run()
  assert.equal(value.osReads(), 2)
  assert.equal(value.samples[0].nativeOwns, true)
  assert.equal(value.samples[0].osHeld, true)
  assert.equal(value.samples[0].exactOverlayPublished, false, 'AppKit visibility alone cannot pass')
  assert.equal(value.samples[1].confirmedOwnedHeld, true)
  assert.equal(result.sampling.jointSamples, 1)
  assert.ok(value.operations.every(op => op === 'status' || op === 'os'), 'The gate only observes and cannot resend or extend a drag')
})

test('default-manager held gate cannot pass zero published samples or another target after the original drag', async () => {
  for (const mode of ['never-published', 'foreign-target']) {
    const value = heldCase(mode)
    await assert.rejects(value.run(), /single actual drag did not expose/u)
    assert.equal(value.samples.filter(sample => sample.passed).length, 0)
    assert.ok(value.clock() <= 1808, 'The existing observation budget remains 1800 ms')
    assert.ok(value.operations.every(op => op === 'status' || op === 'os'))
  }
})

test('default-manager held gate rejects foreground or lease drift instead of adopting a later action', async () => {
  for (const [mode, pattern] of [['epoch-change', /lease changed during/u], ['foreground-drift', /foreground must remain/u]]) {
    const value = heldCase(mode)
    await assert.rejects(value.run(), pattern)
    assert.equal(value.samples.filter(sample => sample.passed).length, 0)
    assert.equal(value.osReads(), 1)
  }
})

test('a native-held but hidden pointer collects finite OS evidence while remaining an acceptance failure', async () => {
  const value = heldCase('hidden-native')
  await assert.rejects(value.run(), /single actual drag did not expose/u)
  const sample = value.samples[0]
  assert.equal(sample.nativeHeld, true); assert.equal(sample.nativeVisible, false); assert.equal(sample.nativeOwns, false)
  assert.equal(sample.osHeld, true); assert.equal(sample.foregroundMatchesTarget, true)
  assert.equal(sample.osCursorInsideTarget, true); assert.equal(sample.nativeCursorInsideTarget, false)
  assert.equal(sample.topCoverMatchesTarget, true); assert.equal(sample.exactOverlayPublished, false)
  assert.equal(sample.leaseActor, 'ai'); assert.equal(sample.suppressionPhase, 'idle')
  assert.equal(value.samples.some(row => row.passed === true), false)
  assert.ok(value.osReads() > 0); assert.ok(value.clock() <= 1808)
  for (const row of value.samples) for (const key of ['cursor', 'keysDown', 'foregroundPid', 'windows', 'targetId', 'physicalOwnerId']) assert.equal(Object.hasOwn(row, key), false)
  assert.ok(value.operations.every(op => op === 'status' || op === 'os'))
})


test('global OS-held state without this helper mouse/physical ownership never passes its cursor gate', async () => {
  for (const mode of ['foreign-os-held', 'missing-owner']) {
    const value = heldCase(mode)
    await assert.rejects(value.run(), /single actual drag did not expose/u)
    assert.equal(value.samples.some(row => row.passed === true), false)
    assert.equal(value.samples[0].nativeOwns, false)
    assert.equal(value.samples[0][mode === 'missing-owner' ? 'ownerPresent' : 'nativeMouseHeld'], false)
    assert.ok(value.samples.every(row => !Object.hasOwn(row, 'ownerId')))
  }
})

test('FIFO B cursor observation starts after original A release, without replaying B or extending its drag', () => {
  assert.match(source, /const firstBVisibility = first\.then\(\(\) => held\('chat-B', 'fifo-B'\)\)/u)
  assert.equal((source.match(/const second = act\('chat-B'/gu) ?? []).length, 1)
  assert.match(heldSource, /interval', 1800/u)
})

function diagnosticFixture(epoch = 2) {
  const first = { reason: 'refresh-visible-point-rejected', epoch, elapsedMs: 4.5, postedCalls: 2, refreshCalls: 1, hideCalls: 0,
    hasTarget: true, targetInside: true, foregroundMatches: true, readbackAvailable: true, readbackMatchesPosted: true,
    leaseCurrent: true, firstCoverClass: 'foreign-window', firstCoverIsTarget: false,
    ownerId: 'private-owner', targetId: 'private-window', title: 'private-title', axText: 'private-text', x: 999 }
  return { schemaVersion: 1, leases: [{ epoch, firstReject: first, firstHide: { ...first, hideCalls: 1 }, firstStatefulHide: { ...first, hideCalls: 1 },
    last: { ...first, reason: 'physical-release', hideCalls: 15 }, branches: Array(120).fill('refresh-panel-ordered'),
    ownerId: 'private-owner', windows: ['private-window'] }], axText: 'private-text' }
}

test('cursor diagnostics preserve per-lease first causes across the recent branch ring and cleanup, with finite privacy projection', () => {
  const native = diagnosticFixture(), projected = finiteCursorDiagnostic(native)
  assert.equal(projected.leases[0].branches.length, 96)
  assert.equal(projected.leases[0].firstReject.reason, 'refresh-visible-point-rejected')
  assert.equal(projected.leases[0].firstReject.firstCoverClass, 'foreign-window')
  assert.equal(projected.leases[0].firstStatefulHide.hideCalls, 1)
  assert.equal(projected.leases[0].last.reason, 'physical-release')
  const text = JSON.stringify(projected)
  for (const secret of ['private-owner', 'private-window', 'private-title', 'private-text', 'ownerId', 'targetId', 'axText', '"x":']) assert.equal(text.includes(secret), false)
  native.leases[0].firstReject.reason = 'private-unrecognized-reason'
  native.leases[0].branches[119] = 'private-unrecognized-reason'
  assert.equal(finiteCursorDiagnostic(native).leases[0].firstReject, null)
  assert.equal(JSON.stringify(finiteCursorDiagnostic(native)).includes('private-unrecognized'), false)
  assert.equal(finiteCursorDiagnostic({ ...native, schemaVersion: 99 }), null)
  assert.equal(finiteCursorDiagnostic(undefined), null)
})

test('finite cursor diagnostic histories separate native epochs and do not turn hidden pointers into held acceptance', async () => {
  const native = diagnosticFixture(2)
  native.leases.unshift(...Array.from({ length: 11 }, (_, epoch) => ({ epoch, firstReject: { reason: 'posted-owner-missing', epoch } })))
  const projected = finiteCursorDiagnostic(native)
  assert.equal(projected.leases.length, 8)
  assert.equal(projected.leases.at(-1).epoch, 2)
  assert.equal(projected.leases.at(-1).firstReject.reason, 'refresh-visible-point-rejected')
  const state = heldCase('hidden-native', native)
  await assert.rejects(state.run(), /single actual drag did not expose/u)
  assert.equal(state.samples[0].cursorDiagnostic.leases.at(-1).firstReject.reason, 'refresh-visible-point-rejected')
  assert.equal(state.samples.some(row => row.passed === true), false)
  assert.ok(state.clock() <= 1808)
  assert.ok(state.operations.every(op => op === 'status' || op === 'os'))
})

test('isolated cursor source transformation keeps production drag, cleanup and full-stack authorization rules, rejecting source drift', async () => {
  const originals = { cursor: await readFile(new URL('../src/native/macos/CursorOverlay.swift', import.meta.url), 'utf8'), input: await readFile(new URL('../src/native/macos/Input.swift', import.meta.url), 'utf8') }
  const result = instrumentMacCursorSources(originals)
  assert.match(result.cursor, /if rejected && diagnosticLeases\[index\]\.firstReject == nil/u)
  assert.match(result.cursor, /if hiding && diagnosticLeases\[index\]\.firstHide == nil/u)
  assert.match(result.cursor, /firstStatefulHide == nil/u)
  assert.match(result.cursor, /diagnosticLeases\[index\]\.branches\.count > 96/u)
  assert.match(result.cursor, /diagnosticLeases\.count > 8/u)
  assert.match(result.cursor, /return targetValid && firstCovering == target\.windowId/u)
  assert.match(result.cursor, /isNonBlockingDockWindow/u)
  assert.match(result.cursor, /ExactPointerRouting\.check\(point: point, selected: target\.windowId/u)
  assert.match(result.cursor, /lastPostedAt > 0\.12/u)
  assert.match(result.cursor, /hypot\(\$0\.x - actual\.x, \$0\.y - actual\.y\) <= 1\.5/u)
  const inputWithoutDiagnostics = result.input.replace(/\(diagnosticReason: "[a-z-]+"\)/gu, '()').replace('        // DIAGNOSTIC_SHUTDOWN_BOUNDARY\n', '')
  assert.equal(inputWithoutDiagnostics, originals.input, 'Input copy differs only in finite hide-call-site arguments')
  assert.match(result.input, /for step in 1\.\.\.24/u)
  assert.match(result.input, /Task\.sleep\(nanoseconds: 16_000_000\)/u)
  assert.throws(() => instrumentMacCursorSources({ ...originals, cursor: originals.cursor.replace('let matchesPosted =', 'let driftedReadback =') }), /source seam changed/u)
  assert.throws(() => instrumentMacCursorSources(result), /source seam changed/u)
  assert.equal(await readFile(new URL('../src/native/macos/CursorOverlay.swift', import.meta.url), 'utf8'), originals.cursor)
  assert.equal(await readFile(new URL('../src/native/macos/Input.swift', import.meta.url), 'utf8'), originals.input)
})

test('receipt-bound cursor preparation freezes exact sources and rejects drift without requiring a historical build artifact or running native code', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'qiuya-cursor-source-only-test-')), repository = fileURLToPath(new URL('../', import.meta.url)), root = join(temporary, 'unit-only-root')
  const sha = value => createHash('sha256').update(value).digest('hex')
  try {
    // This is a filesystem/receipt unit fixture, never an actual native lineage
    // claim. No ignored build artifacts or live formal helper are dependencies.
    const nativeNames = ['Protocol', 'Capture', 'LeaseGuard', 'Applications', 'MacTransport', 'PermissionGuide', 'OperationBadge', 'CursorOverlay', 'FocusPreparation', 'Input', 'Preview', 'main'].map(name => `src/native/macos/${name}.swift`)
    const files = [...nativeNames, 'src/features/computer-use/contract.ts', 'lib/macos-manifest.json', 'lib/QiuYaTools Computer.app/Contents/Info.plist',
      'scripts/macos-cursor-diagnostic-core.mjs', 'scripts/prepare-macos-multitask-acceptance.mjs', 'scripts/test-macos-multitask-manager.mjs', 'tests/macos-multitask-runner.test.mjs',
      'src/native/macos/fixtures/AICursorFixture.swift', 'src/native/macos/fixtures/AICursorObserver.swift', 'src/native/macos/fixtures/LeaseOracle.swift']
    for (const path of files) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), await readFile(join(repository, path))) }
    const helper = join(root, 'lib/QiuYaTools Computer.app/Contents/MacOS/qiuya-computer'), helperBytes = Buffer.from('unit-only-non-executable-canary'), expectedHelperSHA256 = sha(helperBytes)
    await mkdir(dirname(helper), { recursive: true }); await writeFile(helper, helperBytes, { mode: 0o600 })
    const before = Object.fromEntries(await Promise.all(nativeNames.map(async path => [path, sha(await readFile(join(root, path)))])))
    const buildReceiptPath = 'unit-only-build-receipt.json', receipt = { helperSHA256: expectedHelperSHA256, passed: true, sourceStable: true, before, after: { ...before }, unitFixtureOnly: true }
    await writeFile(join(root, buildReceiptPath), JSON.stringify(receipt))
    const options = { root, base: join(temporary, 'frozen'), buildReceiptPath, expectedHelperSHA256 }
    await assert.rejects(prepareMacCursorSourceSnapshot({ ...options, expectedHelperSHA256: currentCursorBaseline }), /pinned helper bytes/u)
    const result = await prepareMacCursorSourceSnapshot(options)
    assert.equal(result.helperSHA256, expectedHelperSHA256)
    assert.equal(result.buildPending, true); assert.equal(result.compileExecuted, false)
    assert.equal(result.guiStarted, 0); assert.equal(result.inputActions, 0)
    assert.equal(result.authorizationThresholdsChanged, false)
    assert.equal(await access(result.diagnosticExecutable).then(() => true, () => false), false)
    assert.equal(sha(await readFile(result.helper)), result.helperSHA256)
    for (const [path, expected] of Object.entries(result.baselineSourceHashes)) {
      assert.equal(sha(await readFile(join(root, path))), expected)
      assert.equal(sha(await readFile(join(result.base, 'baseline', path))), expected)
    }
    for (const [path, expected] of Object.entries(result.snapshotHashes)) assert.equal(sha(await readFile(join(result.base, path))), expected)
    const plan = JSON.parse(await readFile(join(result.base, 'build-plan.json'), 'utf8'))
    assert.equal(plan.executed, false); assert.equal(plan.inputActions, 0)
    assert.equal(plan.args.at(-1), result.diagnosticExecutable)
    await assert.rejects(prepareMacCursorSourceSnapshot(options), /EEXIST/u)
    await writeFile(join(root, nativeNames[0]), before[nativeNames[0]] + '\n')
    await assert.rejects(prepareMacCursorSourceSnapshot({ ...options, base: join(temporary, 'drifted') }), /Source differs from the pinned build receipt/u)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})
