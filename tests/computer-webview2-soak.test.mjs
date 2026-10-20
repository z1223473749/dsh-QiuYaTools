import test from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { WebViewClockAccumulator, createWebViewOwnershipTracker, installWebViewClockProbe, preciseWindowsProcessIdentity, sameWindowsProcessIdentity, windowsEmergencyCleanupIdentities, windowsPinnedProcessCommand, partitionWindowsCleanupIdentities } from '../scripts/computer-webview2-soak-evidence.mjs'

test('native WebView2 clocks span killed page generations, include recovery outage, and exclude warm-up', () => {
  const stats = new WebViewClockAccumulator(), now = 1792550000000
  const frame = atMs => ({ kind: 'frame', stamp: (atMs - 30) % 2 ** 32, atMs, width: 1280, height: 720 })
  stats.useGeneration(1); stats.accept(1, frame(now - 100)); stats.begin(now)
  assert.equal(stats.accept(1, frame(now - 50)), false)
  stats.accept(1, frame(now + 100)); stats.useGeneration(2)
  assert.equal(stats.accept(1, frame(now + 1000)), false)
  stats.accept(2, frame(now + 2100)); stats.finish(now + 3000)
  assert.equal(stats.accept(2, frame(now + 3100)), false)
  const result = stats.summary()
  assert.equal(result.frames, 2); assert.equal(result.endToEndFps, 2 / 3)
  assert.equal(result.maxFrameGapMs, 2000); assert.equal(result.latencyP95Ms, 30)
  assert.equal(result.warmupFramesExcluded, 1); assert.equal(result.invalidTimestamps, 0)
  const repeated = new WebViewClockAccumulator(); repeated.useGeneration(1); repeated.begin(now)
  repeated.accept(1, frame(now + 100)); repeated.accept(1, frame(now + 200))
  assert.equal(repeated.accept(1, { ...frame(now + 100), atMs: now + 300 }), false, 'A nonconsecutive repeated source image is not a new unique frame')
})

test('720p clock accounting fails wrong dimensions and old/future timestamps, including warm-up failures', () => {
  const stats = new WebViewClockAccumulator({ maximumFrames: 1 }), now = 2 ** 32 + 20
  stats.useGeneration(1)
  const frame = { kind: 'frame', stamp: 10, atMs: now, width: 1280, height: 720 }
  stats.accept(1, { ...frame, width: 640 }); stats.accept(1, { ...frame, stamp: 30 })
  stats.begin(now); stats.accept(1, frame)
  assert.equal(stats.accept(1, frame), false)
  assert.throws(() => stats.accept(1, { ...frame, stamp: 11 }), /budget/)
  stats.finish(now + 100)
  assert.equal(stats.summary().invalidTimestamps, 1); assert.equal(stats.summary().wrongDimensions, 1)
  assert.equal(stats.summary().latencyP95Ms, 10)
})

test('an owned WebView2 profile retains crashed-parent browser identities without adopting unrelated or reused PIDs', () => {
  const tracker = createWebViewOwnershipTracker(), birth = 639281000000000000n
  const row = (pid, parentPid, n, name, extra = {}) => ({ pid, parentPid, name, createdAtTicks: String(birth + BigInt(n)), executablePath: '', workingSetBytes: 1, ...extra })
  const runner = row(10, 1, 0, 'node.exe'), own = row(20, 99, 10, 'msedgewebview2.exe', { ownedWebView: true }), renderer = row(21, 20, 11, 'msedgewebview2.exe')
  assert.deepEqual(tracker([runner, own, renderer, row(30, 99, 12, 'msedgewebview2.exe')], 10, 'C:\\uuid\\helper.exe').map(r => r.pid), [10, 20, 21])
  assert.deepEqual(tracker([runner, renderer], 10, 'C:\\uuid\\helper.exe').map(r => r.pid), [10, 21])
  assert.deepEqual(tracker([runner, row(21, 1, 1000, 'unrelated.exe')], 10, 'C:\\uuid\\helper.exe').map(r => r.pid), [10])
  const exact = { ...runner, createdAtTicks: '639281324193729179', cimCreatedAtTicks: '639281324193729170' }
  assert.equal(preciseWindowsProcessIdentity(exact).createdAtTicks, '639281324193729179')
  assert.equal(sameWindowsProcessIdentity(exact, exact), true)
  assert.equal(preciseWindowsProcessIdentity({ ...exact, createdAtTicks: '639281324193729199' }), null, 'Mixed PID generations cannot corroborate one another')
  assert.throws(() => sameWindowsProcessIdentity({ ...exact, createdAtTicks: null }, exact), /could not be verified/, 'Live but unverified cannot mean exited')
  assert.throws(() => createWebViewOwnershipTracker()([{ ...exact, createdAtTicks: null }], 10, 'C:\\uuid\\helper.exe'), /unavailable/)
  assert.equal(createWebViewOwnershipTracker()([exact], 10, 'C:\\uuid\\helper.exe')[0].createdAtTicks, exact.createdAtTicks)
  const exactTracker = createWebViewOwnershipTracker(), exactRunner = { ...runner, createdAtTicks: '639281324193729160', cimCreatedAtTicks: '639281324193729160' }
  const firstOwner = { ...own, createdAtTicks: '639281324193729171', cimCreatedAtTicks: '639281324193729170' }
  exactTracker([exactRunner, firstOwner], 10, '')
  assert.deepEqual(exactTracker([exactRunner, { ...firstOwner, ownedWebView: false, createdAtTicks: '639281324193729179' }], 10, '').map(row => row.pid), [10], 'A rounded CIM birth match alone cannot adopt a reused PID')
})

test('the native WebView2 probe independently decodes doubled source pixels after completed production canvas draws', () => {
  const listeners = new Map(), calls = [], clock = 1792550000000
  class Canvas {
    width = 1280; height = 720; id = 'screen'
    getContext() { return { drawImage: image => { this.stamp = image.stamp }, getImageData: () => {
      const data = new Uint8ClampedArray(this.width * 4)
      for (let bit = 0; bit < 32; bit++) if (Math.floor(this.stamp / 2 ** bit) % 2) data.fill(255, (28 + bit * 16) * 2 * 4, (28 + bit * 16) * 2 * 4 + 3)
      return { data }
    } } }
    toDataURL() { return 'data:image/jpeg;base64,first-invalid' }
  }
  const context = { window: { binding: value => calls.push(JSON.parse(value)) }, document: { createElement: () => new Canvas(), addEventListener: (event, callback) => listeners.set(event, callback) }, HTMLCanvasElement: Canvas, location: { href: 'http://127.0.0.1/own-preview' }, Date: { now: () => clock } }
  runInNewContext(`(${installWebViewClockProbe.toString()})({bindingName:'binding',generation:3})`, context)
  const image = new Canvas(); image.stamp = (clock - 32) % 2 ** 32
  listeners.get('qiuya-preview-frame')({ target: image })
  assert.deepEqual(calls, [{ kind: 'frame', generation: 3, stamp: image.stamp, atMs: clock, width: 1280, height: 720 }])
  image.stamp -= 20000; listeners.get('qiuya-preview-frame')({ target: image })
  assert.match(context.window.__qytWebViewClockProbe.firstInvalidImage, /first-invalid/)
})


test('emergency cleanup retains exact orphan identities and UUID-marked workers after the runner dies', () => {
  const birth = 639281324193729160n, path = 'C:\\owned-uuid\\qiuya-windows.exe'
  const row = (pid, parentPid, offset, name, extra = {}) => { const native = birth + BigInt(offset); return { pid, parentPid, name, createdAtTicks: String(native), cimCreatedAtTicks: String(native - native % 10n), executablePath: 'C:\\runtime\\' + name, ...extra } }
  const runner = { pid: 10, createdAtTicks: String(birth), expectedExecutablePath: 'C:\\node\\node.exe' }
  const helper = row(20, 999, 100, 'qiuya-windows.exe', { executablePath: path })
  const orphan = row(30, 888, 200, 'msedgewebview2.exe', { ownedWebView: true }), child = row(31, 30, 210, 'msedgewebview2.exe')
  const fixture = row(40, 10, 220, 'powershell.exe', { ownedFixture: true })
  const saved = row(50, 777, 230, 'msedgewebview2.exe')
  const recorded = [{ pid: saved.pid, createdAtTicks: saved.createdAtTicks, expectedExecutablePath: saved.executablePath }]
  const selected = windowsEmergencyCleanupIdentities([helper, orphan, child, fixture, saved, row(60, 10, 300, 'unrelated.exe')], { runner, helperPath: path }, recorded)
  assert.deepEqual(selected.map(item => item.pid), [20, 30, 40, 50, 31])
  assert.ok(selected.every(item => item.expectedExecutablePath))
})

test('emergency cleanup does not adopt a reused runner PID, its new children, or rounded-only stale identities', () => {
  const runner = { pid: 10, createdAtTicks: '639281324193729160', expectedExecutablePath: 'C:\\node\\node.exe' }
  const rows = [{ pid: 10, parentPid: 1, name: 'unrelated.exe', executablePath: 'C:\\elsewhere\\unrelated.exe', createdAtTicks: '639281324193730170', cimCreatedAtTicks: '639281324193730170' }, { pid: 11, parentPid: 10, name: 'unrelated-child.exe', executablePath: 'C:\\elsewhere\\child.exe', createdAtTicks: '639281324193730180', cimCreatedAtTicks: '639281324193730180' }]
  assert.deepEqual(windowsEmergencyCleanupIdentities(rows, { runner, helperPath: 'C:\\uuid\\helper.exe' }), [])
  const saved = { pid: 20, createdAtTicks: '639281324193729171', expectedExecutablePath: 'C:\\runtime\\msedgewebview2.exe' }
  const reused = { pid: 20, name: 'msedgewebview2.exe', createdAtTicks: '639281324193729179', cimCreatedAtTicks: '639281324193729170', executablePath: saved.expectedExecutablePath }
  assert.deepEqual(windowsEmergencyCleanupIdentities([reused], { runner, helperPath: 'C:\\uuid\\helper.exe' }, [saved]), [])
  assert.throws(() => windowsEmergencyCleanupIdentities([{ ...reused, createdAtTicks: null }], { runner, helperPath: 'C:\\uuid\\helper.exe' }, [saved]), /could not be verified/)
  assert.throws(() => windowsEmergencyCleanupIdentities([{ ...reused, createdAtTicks: null, ownedWebView: true }], { runner, helperPath: 'C:\\uuid\\helper.exe' }), /exact native birth/)
})

test('pinned cleanup requires exact bounded identities and never delegates termination to PID taskkill', () => {
  const identity = { pid: 42, createdAtTicks: '639281324193729179', expectedExecutablePath: 'C:\\owned-uuid\\helper.exe' }
  const verify = windowsPinnedProcessCommand([identity]), terminate = windowsPinnedProcessCommand([identity], { terminate: true })
  assert.ok(!verify.includes('$p.Kill()')); assert.ok(terminate.includes('$p.Kill()')); assert.doesNotMatch(terminate, /taskkill|Stop-Process/u)
  assert.ok(terminate.indexOf('$p.SafeHandle') < terminate.indexOf('$p.StartTime'))
  assert.ok(terminate.indexOf('$p.StartTime') < terminate.indexOf('$p.MainModule.FileName'))
  assert.ok(terminate.indexOf('$p.MainModule.FileName') < terminate.indexOf('$p.Kill()'))
  assert.ok(terminate.includes('$p.WaitForExit(2000)'))
  assert.throws(() => windowsPinnedProcessCommand([{ ...identity, expectedExecutablePath: '' }]), /Invalid pinned/)
  assert.throws(() => windowsPinnedProcessCommand([identity, identity]), /Invalid pinned/)
})


test('empty pinned cleanup returns an actual empty report without converting JSON [] into a null process row', () => {
  for (const terminate of [false, true]) {
    const command = windowsPinnedProcessCommand([], { terminate })
    assert.doesNotMatch(command, /GetProcessById|ConvertFrom-Json|foreach|Kill\(/u)
    const encoded = command.match(/^\[Console\]::WriteLine\('(.+)'\)$/u)?.[1]
    assert.ok(encoded)
    assert.deepEqual(JSON.parse(encoded), { passed: true, terminate, results: [], errors: [] })
  }
})


test('only current owned exact direct system-console infrastructure defers to outer runner-exit verification', () => {
  const birth = 639281324193729160n
  const row = (pid, parentPid, delta, path) => { const stamp = birth + BigInt(delta); return { pid, parentPid, createdAtTicks: String(stamp), cimCreatedAtTicks: String(stamp - stamp % 10n), executablePath: path } }
  const runner = row(10, 1, 0, 'C:\\node\\node.exe')
  const console = row(20, 10, 19, 'C:\\WINDOWS\\system32\\conhost.exe')
  const nested = row(21, 99, 29, console.executablePath), fake = row(22, 10, 39, 'C:\\fake\\conhost.exe'), old = row(23, 10, -1, console.executablePath), unowned = row(24, 10, 59, console.executablePath)
  const rows = [runner, console, nested, fake, old, unowned], tracked = rows.slice(1), owned = rows.filter(item => item !== unowned)
  const result = partitionWindowsCleanupIdentities(tracked, rows, { owned, runner, systemDirectory: 'C:\\Windows\\System32' })
  assert.deepEqual(result.deferred.map(item => item.pid), [20])
  assert.equal(result.immediate.length + result.deferred.length, tracked.length, 'Deferral never removes tracked resource identities')
  assert.deepEqual(result.immediate.map(item => item.pid), [21, 22, 23, 24])
  const stale = { ...console, createdAtTicks: String(birth + 18n) }
  assert.equal(partitionWindowsCleanupIdentities([stale], rows, { owned, runner, systemDirectory: 'C:\\Windows\\System32' }).deferred.length, 0, 'PID reuse/exact-birth mismatch grants no deferral')
  assert.throws(() => partitionWindowsCleanupIdentities(tracked, rows, { owned: [], runner, systemDirectory: 'C:\\Windows\\System32' }), /runner identity unavailable/)
})
