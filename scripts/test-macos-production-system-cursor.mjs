/** Test-only formal-helper acceptance. Default only prepares binaries.
 * GUI/input requires explicit --run --gui-gate root-approved + pinned SHA.
 * Only the production helper changes the cursor. No private hider is linked.
 * Optional --manual-modifier-gate writes a private own-window marker and waits
 * for the root's single Shift action; this runner never injects a modifier.
 */
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createInterface } from 'node:readline'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, realpath, access, rename } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const ownPath = fileURLToPath(import.meta.url), ownDir = dirname(ownPath)
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const execute = promisify(execFile)
const same = (a, b) => !!a && !!b && ['pid', 'startSeconds', 'startMicroseconds', 'uniqueId', 'executablePath'].every(k => a[k] === b[k])

if (arg('--parent-proxy')) {
  assert.equal(process.platform, 'darwin')
  const helper = await realpath(arg('--parent-proxy'))
  assert.equal(hash(await readFile(helper)), arg('--expect-sha256'))
  const child = spawn(helper, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, QIUYA_TOOLS_PARENT_PID: String(process.pid) } })
  child.stdin.on('error', () => {}); child.stderr.resume()
  child.stdout.pipe(process.stdout, { end: false }); process.stdin.pipe(child.stdin)
  process.stdout.write(JSON.stringify({ event: 'production-worker', pid: child.pid, parentPid: process.pid }) + '\n')
  const timer = setTimeout(() => { process.stdout.write(JSON.stringify({ event: 'safety-expiry' }) + '\n'); child.stdin.end() }, 45000)
  child.once('error', () => { clearTimeout(timer); process.exitCode = 1; process.stdin.destroy() })
  child.once('exit', (code, signal) => { clearTimeout(timer); process.stdout.write(JSON.stringify({ event: 'production-worker-exit', code, signal }) + '\n'); process.exitCode = code === 0 && signal === null ? 0 : 1; process.stdin.destroy() })
} else {
  assert.equal(process.platform, 'darwin')
  const root = resolve(arg('--repo') ?? join(ownDir, '..'))
  const output = resolve(arg('--output') ?? join(root, 'artifacts/computer-use/macos-production-system-cursor-prepared'))
  await mkdir(output, { recursive: true })
  let preparation
  if (arg('--prepared')) preparation = JSON.parse(await readFile(join(resolve(arg('--prepared')), 'preparation.json'), 'utf8'))
  else {
    assert.ok(arg('--native') && /^[a-f0-9]{64}$/u.test(arg('--expect-sha256') ?? ''), 'Preparation requires an exact production helper path and SHA')
    assert.equal(await access(join(output, 'preparation.json')).then(() => true, () => false), false, 'Preserve prior preparations')
    const helper = await realpath(resolve(arg('--native'))), helperSHA256 = hash(await readFile(helper))
    assert.equal(helperSHA256, arg('--expect-sha256'), 'No helper is launched during preparation')
    const fixtureSource = join(root, 'src/native/macos/fixtures/AICursorFixture.swift'), observerSource = join(root, 'src/native/macos/fixtures/AICursorObserver.swift'), probeSource = join(root, 'src/native/macos/fixtures/ProductionCursorProbe.swift')
    const fixture = join(output, 'Production Cursor Fixture.app/Contents/MacOS/fixture'), observer = join(output, 'independent-sck-observer'), probe = join(output, 'read-only-cursor-probe')
    await mkdir(dirname(fixture), { recursive: true })
    await writeFile(join(dirname(dirname(fixture)), 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.qiuya.tools.production-cursor.${randomUUID().replaceAll('-', '')}</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`)
    const sources = Object.fromEntries(await Promise.all([ownPath, fixtureSource, observerSource, probeSource].map(async path => [path, hash(await readFile(path))])))
    const common = ['-swift-version', '5', '-target', 'arm64-apple-macosx13.0', '-framework', 'AppKit', '-module-cache-path', '/private/tmp/qiuya-production-cursor-acceptance-cache']
    const jobs = [
      ['fixture', [...common, fixtureSource, '-o', fixture]],
      ['observer', [...common, '-parse-as-library', '-framework', 'ScreenCaptureKit', '-framework', 'CoreImage', '-framework', 'CoreMedia', observerSource, '-o', observer]],
      ['probe', [...common, '-parse-as-library', '-framework', 'ApplicationServices', probeSource, '-o', probe]],
    ]
    for (const [name, flags] of jobs) {
      try { const result = await execute('/usr/bin/swiftc', flags, { timeout: 90000 }); await writeFile(join(output, `${name}-build.log`), result.stdout + result.stderr) }
      catch (error) { await writeFile(join(output, `${name}-build.log`), `${error.stdout ?? ''}${error.stderr ?? ''}`); throw error }
    }
    const selfTest = JSON.parse((await execute(probe, ['--self-test', output], { timeout: 10000 })).stdout)
    assert.equal(selfTest.passed, true); assert.equal(selfTest.actualCursorCalls, 0); assert.equal(selfTest.actualCGEventPosts, 0)
    for (const [path, sha] of Object.entries(sources)) assert.equal(hash(await readFile(path)), sha, 'Sources changed while preparing')
    preparation = { status: 'prepared-not-GUI-run', helper, helperSHA256, fixture: await realpath(fixture), observer: await realpath(observer), probe: await realpath(probe), fixtureSHA256: hash(await readFile(fixture)), observerSHA256: hash(await readFile(observer)), probeSHA256: hash(await readFile(probe)), sources, selfTest,
      scope: 'Formal production helper gets real physical lease and one move per fresh lifecycle case. Read-only observer/probe never hides, shows or posts input.',
      scenarios: ['release-live-helper', 'worker-eof', 'worker-sigkill', 'parent-eof', 'parent-sigkill'],
      notRun: ['Physical modifier-key intervention: root CUA gate required', 'Default scheduler per-action short lease timing', 'Other target applications or user content'], productionChanged: false }
    await writeFile(join(output, 'preparation.json'), JSON.stringify(preparation, null, 2))
  }
  for (const key of ['helper', 'fixture', 'observer', 'probe']) assert.equal(hash(await readFile(preparation[key])), preparation[`${key}SHA256`], `Pinned ${key} artifact changed`)
  assert.equal(preparation.sources[ownPath], hash(await readFile(ownPath)), 'Create a fresh preparation bound to this exact promoted runner')
  if (!process.argv.includes('--run')) console.log(JSON.stringify({ status: preparation.status, output, selfTest: preparation.selfTest, actualHelpersLaunched: 0, actualCGEventPosts: 0 }))
  else {
    assert.equal(arg('--gui-gate'), 'root-approved')
    assert.equal(await access(join(output, 'report.json')).then(() => true, () => false), false, 'Use a fresh output; never replace failed evidence')
    for (const [path, sha] of Object.entries(preparation.sources)) assert.equal(hash(await readFile(path)), sha, 'Prepared test source drifted')
    const manualModifierGate = process.argv.includes('--manual-modifier-gate')
    const modes = [...preparation.scenarios, ...(manualModifierGate ? ['manual-modifier'] : [])]
    const notRun = preparation.notRun.filter(value => !manualModifierGate || !value.startsWith('Physical modifier-key intervention:'))
    if (manualModifierGate) notRun.push('Physical HID source identity is not claimed; correlate the root CUA Shift action receipt separately')
    const markerPath = join(output, 'manual-modifier-gate.json')
    if (manualModifierGate) assert.equal(await access(markerPath).then(() => true, () => false), false, 'A manual gate marker must belong to this fresh run')
    const endpoints = [], cases = [], pictures = [], snapshots = [], geometrySettles = [], owned = [], cleanup = { passed: false, failures: [], forced: [], processes: [] }
    let observer, probe, fixture, fixtureIdentity, fixtureState, runnerIdentity, current, fatal, report, phase = 'preflight', moveRequests = 0
    let manualMarker
    const empty = s => !!s && !s.leftButtonDown && !s.rightButtonDown && !s.middleButtonDown && s.keysDown?.length === 0
    function endpoint(executable, args, role) {
      const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, QIUYA_TOOLS_PARENT_PID: String(process.pid) } })
      child.stdin.on('error', () => {}); let stderrBytes = 0, seq = 0
      child.stderr.on('data', bytes => { stderrBytes += bytes.length })
      const pending = new Map(), events = [], transcript = []
      const lines = createInterface({ input: child.stdout })
      lines.on('line', line => {
        let value; try { value = JSON.parse(line) } catch { fatal ??= Error('Malformed owned process protocol'); return }
        const recorded = structuredClone(value)
        if (recorded.result?.imageBase64) recorded.result.imageBase64 = `[${recorded.result.imageBase64.length} base64 characters]`
        if (recorded.result?.targets) recorded.result.targets = recorded.result.targets.filter(t => t.pid === fixtureIdentity?.pid)
        transcript.push(recorded)
        if (value.event === 'safety-expiry') fatal ??= Error('Owned proxy safety lifetime expired')
        const job = pending.get(value.requestId)
        if (job) { pending.delete(value.requestId); clearTimeout(job.timer); job.resolve(value) } else events.push(value)
      })
      const exited = new Promise(done => {
        child.once('exit', (code, signal) => { for (const job of pending.values()) { clearTimeout(job.timer); job.reject(Error('Owned process exited during RPC')) }; pending.clear(); done({ code, signal }) })
        child.once('error', () => done({ code: null, signal: null, startupFailed: true }))
      })
      const value = { child, role, events, transcript, lines, exited, get stderrBytes() { return stderrBytes },
        request(op, payload = {}) { return new Promise((resolve, reject) => { const requestId = ++seq, timer = setTimeout(() => { pending.delete(requestId); reject(Error(`Bounded ${role} ${op} timeout`)) }, 12000); pending.set(requestId, { timer, resolve, reject }); child.stdin.write(JSON.stringify({ requestId, op, ...payload }) + '\n', error => { if (error) { clearTimeout(timer); pending.delete(requestId); reject(error) } }) }) },
        async ok(op, payload) { const reply = await this.request(op, payload); assert.equal(reply.ok, true, `${role} ${op}: ${JSON.stringify(reply.error)}`); return reply.result },
        async ready(event = 'ready') { return until(() => events.find(e => e.event === event), `${role} readiness missing`) },
      }
      endpoints.push(value); return value
    }
    async function until(read, reason, timeout = 6000) {
      const end = performance.now() + timeout
      while (performance.now() < end) { if (fatal && phase !== 'cleanup') throw fatal; const value = await read(); if (performance.now() >= end) break; if (value) return value; await sleep(25) }
      throw Error(reason)
    }
    async function identity(pid) { return (await observer.ok('identity', { pid })).identity }
    function remember(value, role) { assert.ok(value?.pid && value.startSeconds && value.startMicroseconds && value.uniqueId && value.executablePath); if (!owned.some(row => same(row.identity, value))) owned.push({ identity: value, role }); return value }
    async function pin(pid, role) { return remember(await identity(pid), role) }
    async function state(label, native = current) {
      const identities = [fixtureIdentity, native?.worker].filter(Boolean)
      const os = await observer.ok('snapshot', { identities })
      const result = { label, os, ...(native ? { native: await native.value.ok('status') } : {}) }
      snapshots.push(result)
      assert.ok(os.sessionExists && !os.screenLocked && empty(os), 'Unlocked owned fixture with no externally held input required')
      if (fixtureIdentity) { assert.ok(same(await identity(fixtureIdentity.pid), fixtureIdentity)); assert.equal(os.foregroundPid, fixtureIdentity.pid) }
      return result
    }
    async function waitExit(value, expectedSignal = null) {
      let timer; const exit = await Promise.race([value.exited, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${value.role} did not retire within deadline`)), 6000) })]).finally(() => clearTimeout(timer))
      if (expectedSignal) assert.equal(exit.signal, expectedSignal); else { assert.equal(exit.code, 0); assert.equal(exit.signal, null) }
      return exit
    }
    async function gone(value) {
      const attempts = []
      try { return await until(async () => {
        const reply = await observer.request('identity', { pid: value.pid }); attempts.push({ ok: reply.ok, code: reply.error, identity: reply.result?.identity })
        if (!reply.ok) { assert.ok(['identity-unavailable', 'identity-changed'].includes(reply.error)); return false }
        return !reply.result.identity || !same(reply.result.identity, value)
      }, 'Exact owned process retirement is unconfirmed') }
      finally { snapshots.push({ label: 'retirement', identity: value, attempts }) }
    }
    async function freeLease(label) {
      return until(async () => { const value = await probe.ok('leaseAudit'); snapshots.push({ label, lease: value }); return value.leaseFree && !value.journalPresent ? value : false }, 'Owned lease/journal did not retire cleanly')
    }
    async function guards(owner) {
      const children = (await observer.ok('children', { identity: owner })).identities
      for (const value of children) remember(value, 'native-guardian')
      assert.equal(children.length, 1, 'Production lease must have exactly one independently pinned guardian')
      return children
    }
    async function settled(native) {
      const expected = `mac-window:${fixtureState.windowId}`, samples = [], start = performance.now()
      geometrySettles.push({ mode: phase, samples }); let signature, stableAt, count = 0
      return until(async () => {
        assert.ok(same(await identity(fixtureIdentity.pid), fixtureIdentity))
        const before = await state('settle-before', native), w = before.os.windows.find(w => w.pid === fixtureIdentity.pid && w.id === fixtureState.windowId && w.onScreen === true && w.alpha === 1)
        const target = (await native.value.ok('targets')).targets.find(t => t.id === expected && t.pid === fixtureIdentity.pid && t.appId === fixtureState.bundleId)
        if (!w || !target || !['x', 'y', 'width', 'height'].every(k => w[k] === target[k])) { signature = undefined; return false }
        const frame = await native.value.ok('observe', { targetId: expected, preview: true })
        const after = await state('settle-after', native), ww = after.os.windows.find(t => t.id === w.id && t.pid === w.pid)
        const local = await fixture.ok('snapshot')
        assert.equal(local.windowId, fixtureState.windowId); assert.equal(local.pid, fixtureIdentity.pid); assert.equal(local.bundleId, target.appId)
        const agrees = ww?.onScreen === true && ['x', 'y', 'width', 'height'].every(k => ww[k] === w[k] && frame.geometry[k] === w[k]) && frame.geometry.scale === target.scale
        if (!agrees) { signature = undefined; return false }
        const next = JSON.stringify([w.x, w.y, w.width, w.height, target.scale, frame.width, frame.height, local.point])
        if (signature !== next) { signature = next; stableAt = performance.now(); count = 1 } else count++
        const sample = { atMs: performance.now() - start, frameId: frame.frameId, geometry: frame.geometry, point: local.point, stableMs: performance.now() - stableAt, count }; samples.push(sample)
        if (count < 3 || sample.stableMs < 200) return false
        const point = { x: (local.point.x - frame.geometry.x) * frame.width / frame.geometry.width, y: (local.point.y - frame.geometry.y) * frame.height / frame.geometry.height }
        assert.ok(point.x >= 0 && point.y >= 0 && point.x < frame.width && point.y < frame.height)
        return { target, frame: { frameId: frame.frameId, width: frame.width, height: frame.height, geometry: frame.geometry }, point, desktopPoint: local.point }
      }, 'Exact CG/native/raster geometry never settled; no action sent', 8000)
    }
    async function holder(proxy) {
      assert.equal(hash(await readFile(preparation.helper)), preparation.helperSHA256)
      const value = proxy ? endpoint(process.execPath, [ownPath, '--parent-proxy', preparation.helper, '--expect-sha256', preparation.helperSHA256], 'production-parent-proxy') : endpoint(preparation.helper, [], 'production-helper')
      const workerPid = proxy ? (await value.ready('production-worker')).pid : value.child.pid
      const worker = await pin(workerPid, 'production-helper'), parent = proxy ? await pin(value.child.pid, 'test-parent') : undefined
      assert.equal(worker.executablePath, preparation.helper)
      assert.equal(worker.parentPid, parent?.pid ?? runnerIdentity.pid)
      assert.equal(worker.parentUniqueId, (parent ?? runnerIdentity).uniqueId)
      const status = await value.ok('status')
      assert.ok(status.permissions?.screenRecording && status.permissions?.accessibility && status.permissions?.postEvents, 'Existing inherited permissions must suffice; none are requested')
      assert.equal(status.leaseEpoch, null)
      return { value, worker, parent, epoch: cases.length + 101 }
    }
    function visibleArrow(analysis) {
      const a = analysis?.approvedSmallArrow
      assert.ok(a && a.backgroundSpread <= 8 && a.backgroundRGB.every(c => c >= 0 && c <= 25))
      assert.ok(a.outlineArea >= 4 && a.outlineArea <= 90 && a.softGreyHaloArea >= 4)
      assert.equal(a.brightAreaOutsideGlyph, 0)
      for (const sample of a.bodySamples) assert.ok(sample.pixels > 0 && Math.min(...sample.rgb) >= 35 && Math.max(...sample.rgb) <= 140 && Math.max(...sample.rgb) - Math.min(...sample.rgb) < 30)
    }
    async function pair(label, desktopPoint, hidden) {
      const records = [], before = await state(label + '-before', hidden ? current : undefined)
      const owns = s => {
        const cursor = s.aiCursor?.systemCursorSuppression
        assert.equal(s.leaseEpoch, current.epoch); assert.equal(s.leaseActor, 'ai'); assert.equal(s.aiCursor.visible, true)
        assert.equal(cursor?.phase, 'hidden'); assert.equal(cursor.ownedHideCount, 1); assert.equal(cursor.propertyOwned, true); assert.equal(cursor.backend.property, true)
      }
      if (hidden) owns(before.native)
      assert.ok(Math.hypot(before.os.cursor.x - desktopPoint.x, before.os.cursor.y - desktopPoint.y) < 1.5, 'Unexpected real cursor movement invalidates pair; no input replay')
      for (const includeRealCursor of [false, true]) {
        const path = join(output, `${label}-${includeRealCursor ? 'with' : 'without'}-system-cursor.png`)
        const w = before.os.windows.find(row => row.id === fixtureState.windowId && row.pid === fixtureIdentity.pid)
        assert.ok(w?.onScreen)
        const tipX = desktopPoint.x - w.x, tipY = desktopPoint.y - w.y
        const record = await observer.ok('capture', { identity: fixtureIdentity, windowId: fixtureState.windowId, output: path, composited: true, includeRealCursor, ...(hidden ? { probe: { x: tipX - 18, y: tipY - 18, width: 48, height: 50, tipX, tipY } } : {}) })
        assert.ok(same(record.owner, fixtureIdentity)); assert.equal(record.includesRealOSCursor, includeRealCursor)
        if (hidden) visibleArrow(record.analysis)
        const evidence = { label, ...record, path, sha256: hash(await readFile(path)) }; pictures.push(evidence); records.push(evidence)
      }
      const after = await state(label + '-after', hidden ? current : undefined)
      if (hidden) owns(after.native)
      assert.ok(Math.hypot(after.os.cursor.x - desktopPoint.x, after.os.cursor.y - desktopPoint.y) < 1.5)
      const a = records[0], b = records[1]
      for (const field of ['x', 'y', 'width', 'height', 'pixelWidth', 'pixelHeight']) assert.equal(a[field], b[field], 'Pair geometry must match exactly')
      const sx = a.pixelWidth / a.width, sy = a.pixelHeight / a.height
      const crop = { x: Math.floor((desktopPoint.x - a.x - 18) * sx), y: Math.floor((desktopPoint.y - a.y - 18) * sy), width: Math.round(48 * sx), height: Math.round(50 * sy) }
      const difference = await probe.ok('compare', { a: a.path, b: b.path, crop })
      if (hidden) assert.ok(difference.changedPixelsOver8 <= 2, 'Active AI must have no extra black system cursor pixels')
      else assert.ok(difference.changedPixelsOver8 >= 10, 'Actual OS cursor must recover while production helper/owner retires')
      return { records: records.map(r => r.path), crop, difference, before, after }
    }
    async function killOwned(id, endpoint) {
      assert.ok(same(await identity(id.pid), id), 'Refuse signal after PID/birth/path change')
      process.kill(id.pid, 'SIGKILL'); if (endpoint) await waitExit(endpoint, 'SIGKILL')
    }
    async function writeManualMarker(value) {
      manualMarker = { ...manualMarker, ...value }
      const temporary = join(output, `.manual-modifier-${randomUUID()}.tmp`)
      await writeFile(temporary, JSON.stringify(manualMarker, null, 2), { mode: 0o600, flag: 'wx' })
      await rename(temporary, markerPath)
    }
    async function manualModifier(stable) {
      const owner = current, epoch = owner.epoch, readbacks = [], deadline = performance.now() + 60000
      let shiftKeyObserved = false, observedKeys = new Set()
      await writeManualMarker({ phase: 'awaiting-root-shift', fixture: fixtureIdentity,
        window: { id: fixtureState.windowId, bundleId: fixtureState.bundleId, title: fixtureState.title, geometry: stable.frame.geometry },
        productionHelper: owner.worker, epoch, desktopPoint: stable.desktopPoint,
        deadlineUTC: new Date(Date.now() + 60000).toISOString(), inputProducer: 'root CUA; runner injects no modifier',
        instruction: 'Target only this exact owned fixture. Press and release Shift once; do not move the mouse or press another key. No further act is sent.' })
      async function read(label) {
        assert.ok(same(await identity(fixtureIdentity.pid), fixtureIdentity) && same(await identity(owner.worker.pid), owner.worker), 'Manual gate owner changed')
        const os = await observer.ok('snapshot', { identities: [fixtureIdentity, owner.worker] })
        assert.ok(os.sessionExists && !os.screenLocked && os.foregroundPid === fixtureIdentity.pid)
        assert.ok(!os.leftButtonDown && !os.rightButtonDown && !os.middleButtonDown)
        assert.ok(Math.hypot(os.cursor.x - stable.desktopPoint.x, os.cursor.y - stable.desktopPoint.y) < 1.5, 'Manual modifier gate forbids pointer movement')
        assert.ok(os.keysDown.every(key => [56, 60].includes(key)), 'Only Shift may be pressed during the manual gate')
        for (const key of os.keysDown) observedKeys.add(key)
        shiftKeyObserved ||= os.keysDown.some(key => [56, 60].includes(key))
        const native = await owner.value.ok('status'), c = native.aiCursor?.systemCursorSuppression
        assert.equal(native.leaseEpoch, epoch, 'Shift must not pause/release or change the physical epoch')
        assert.equal(native.leaseActor, 'ai')
        assert.equal(native.inputState.mouseHeld, false); assert.equal(native.inputState.keysHeld, 0)
        assert.equal(owner.value.transcript.filter(e => e.event === 'humanInput').length, 0, 'Modifier must not emit a pause event')
        const result = { label, atMs: 60000 - (deadline - performance.now()), os, native }
        readbacks.push(result); if (readbacks.length > 200) readbacks.splice(1, 1)
        return { ...result, restored: c?.interruptedEpoch === epoch && c.ownedHideCount === 0 && c.propertyOwned === false && c.backend?.property === false && native.aiCursor.visible === false }
      }
      const restored = await until(async () => { const value = await read('await-shift'); return value.restored ? value : false }, 'Root Shift did not restore/latch the same live AI epoch before the manual deadline', 60000)
      await writeManualMarker({ phase: 'restored-awaiting-shift-release', shiftKeyObserved })
      const released = await until(async () => { const value = await read('await-key-release'); assert.ok(value.restored, 'Cursor may not hide again in the interrupted epoch'); return value.os.keysDown.length === 0 ? value : false }, 'Shift was not released within the bounded manual gate', Math.max(1, deadline - performance.now()))
      const stableUntil = performance.now() + 500
      while (performance.now() < stableUntil) { const value = await read('restored-stability'); assert.ok(value.restored && value.os.keysDown.length === 0); await sleep(25) }
      const restoredPixels = await pair('manual-modifier-restored-live-helper', stable.desktopPoint, false)
      assert.ok(same(await identity(owner.worker.pid), owner.worker), 'Balanced recovery must be proven while the helper lives')
      assert.equal(owner.value.transcript.filter(e => e.event === 'cursorSuppression' && e.state?.phase === 'hidden').length, 1, 'No second Hide is allowed after intervention')
      await writeManualMarker({ phase: 'verified', shiftKeyObserved, observedKeyCodes: [...observedKeys], interruptedEpoch: epoch, helperStillAlive: true, actRequests: 1, otherProcessShowCalls: 0 })
      return { restored, released, readbacks, restoredPixels, shiftKeyObserved, observedKeyCodes: [...observedKeys],
        inputProducer: 'root CUA Shift action; correlate the root action receipt separately', physicalHIDClaimed: false, runnerModifierPosts: 0, markerPath }
    }
    try {
      observer = endpoint(preparation.observer, [], 'independent-sck-observer'); const ready = await observer.ready(); remember(ready.identity, 'observer')
      runnerIdentity = await pin(process.pid, 'runner')
      probe = endpoint(preparation.probe, [], 'read-only-lease-pixel-probe'); await probe.ready(); await pin(probe.child.pid, 'probe')
      await state('unlocked-initial', undefined); await freeLease('baseline-no-owner')
      fixture = endpoint(preparation.fixture, [], 'owned-fixture'); fixtureState = (await fixture.ready()).state; fixtureIdentity = await pin(fixture.child.pid, 'fixture')
      assert.equal(fixtureState.pid, fixtureIdentity.pid)
      for (const mode of modes) {
        phase = mode; current = await holder(mode.startsWith('parent'))
        const stable = await settled(current)
        await current.value.ok('lease', { epoch: current.epoch, actor: 'ai' }); current.guardians = await guards(current.worker)
        current.activeEpoch = current.epoch
        // Exactly one formal act is sent. Readiness/visibility failure cannot
        // cause a replay or a second Hide request from this runner.
        moveRequests++
        const actResult = await current.value.ok('act', { epoch: current.epoch, targetId: stable.target.id, action: { kind: 'move', ...stable.point } })
        await until(async () => { const s = await current.value.ok('status'), c = s.aiCursor?.systemCursorSuppression; assert.notEqual(c?.phase, 'unsupported', 'This Mac does not support the production counter capability'); return c?.phase === 'hidden' && c.ownedHideCount === 1 && s.aiCursor.visible ? s : false }, 'Production posted action never exposed an authorized hidden cursor')
        const hiddenPixels = await pair(mode + '-active', stable.desktopPoint, true)
        const transitions = current.value.transcript.filter(e => e.event === 'cursorSuppression' && e.state?.phase === 'hidden')
        assert.equal(transitions.length, 1, 'A case must observe exactly one Hide acquisition, without replay')
        let releaseReadback
        if (mode === 'manual-modifier') {
          const intervention = await manualModifier(stable)
          await current.value.ok('release', { epoch: current.epoch }); current.activeEpoch = undefined
          await freeLease(mode + '-released')
          current.value.child.stdin.end(); await waitExit(current.value)
          await gone(current.worker); for (const guardian of current.guardians) await gone(guardian)
          cases.push({ mode, passed: true, worker: current.worker, actRequests: 1, actResult, stable, hiddenPixels, intervention, otherProcessShowCalls: 0 })
          await writeManualMarker({ phase: 'completed', leaseReleased: true, helperRetired: true })
        } else if (mode === 'release-live-helper') {
          await current.value.ok('release', { epoch: current.epoch }); current.activeEpoch = undefined
          releaseReadback = await current.value.ok('status')
          assert.equal(releaseReadback.leaseEpoch, null); assert.equal(releaseReadback.aiCursor.visible, false)
          const c = releaseReadback.aiCursor.systemCursorSuppression
          assert.equal(c.ownedHideCount, 0); assert.equal(c.propertyOwned, false); assert.equal(c.backend.property, false)
          await freeLease(mode + '-released')
          // The helper remains alive across this pair, proving real balanced
          // Unhide rather than relying on its WindowServer connection closing.
          const restoredPixels = await pair(mode + '-restored-live-helper', stable.desktopPoint, false)
          assert.ok(same(await identity(current.worker.pid), current.worker))
          current.value.child.stdin.end(); await waitExit(current.value)
          await gone(current.worker); for (const guardian of current.guardians) await gone(guardian)
          cases.push({ mode, passed: true, worker: current.worker, actRequests: 1, actResult, stable, hiddenPixels, releaseReadback, restoredPixels, otherProcessShowCalls: 0 })
        } else {
          const worker = current.worker, parent = current.parent
          if (mode === 'worker-sigkill') await killOwned(worker, current.value)
          else if (mode === 'parent-sigkill') await killOwned(parent, current.value)
          else { current.value.child.stdin.end(); await waitExit(current.value) }
          await gone(worker); if (parent) await gone(parent)
          for (const guardian of current.guardians) await gone(guardian)
          current.activeEpoch = undefined
          await freeLease(mode + '-retired')
          // No status/restore call is sent to another helper after a crash.
          current = undefined
          const restoredPixels = await pair(mode + '-restored', stable.desktopPoint, false)
          cases.push({ mode, passed: true, worker, parent, actRequests: 1, actResult, stable, hiddenPixels, restoredPixels, otherProcessShowCalls: 0 })
        }
        current = undefined
      }
      report = { status: 'passed', cases, crashRestorationProven: true, formalProductionHelper: true, notRun }
    } catch (error) { report = { status: 'failed', phase, reason: String(error.message).slice(0, 1800), cases, crashRestorationProven: false, formalProductionHelper: true, notRun }; process.exitCode = 1 }
    finally {
      phase = 'cleanup'
      // Cleanup always attempts EOF even if held-input or pixel evidence failed.
      for (const value of endpoints.filter(e => ['production-helper', 'production-parent-proxy'].includes(e.role))) {
        if (value.child.exitCode !== null || value.child.signalCode) continue
        try { if (current?.value === value && current.activeEpoch !== undefined && same(await identity(current.worker.pid), current.worker)) await value.ok('release', { epoch: current.activeEpoch }) }
        catch { cleanup.failures.push('Owned release cleanup unconfirmed') }
        value.child.stdin.end()
        try { await waitExit(value) } catch { cleanup.failures.push('Owned helper/proxy did not retire naturally') }
      }
      for (const row of owned.filter(r => ['production-helper', 'test-parent', 'native-guardian'].includes(r.role))) {
        try { await gone(row.identity); cleanup.processes.push({ ...row, state: 'retired' }) }
        catch {
          cleanup.failures.push('Pinned owned helper identity retirement unconfirmed')
          try { if (same(await identity(row.identity.pid), row.identity)) { process.kill(row.identity.pid, 'SIGKILL'); cleanup.forced.push(row) } } catch {}
        }
      }
      try { const audit = await probe.ok('leaseAudit'); cleanup.lease = audit; assert.ok(audit.leaseFree && !audit.journalPresent) } catch { cleanup.failures.push('Final lease/journal not free') }
      try { const audit = await observer.ok('snapshot', { identities: fixtureIdentity ? [fixtureIdentity] : [] }); cleanup.finalOS = audit; assert.ok(empty(audit)) } catch { cleanup.failures.push('Final actual OS input audit failed') }
      if (fixture?.child.exitCode === null && !fixture.child.signalCode) { fixture.child.stdin.end(); try { await waitExit(fixture) } catch { cleanup.failures.push('Fixture EOF did not retire naturally') } }
      if (fixtureIdentity) try { await gone(fixtureIdentity) } catch { cleanup.failures.push('Fixture exact identity not retired') }
      for (const value of [probe, observer].filter(Boolean)) { value.child.stdin.end(); try { await waitExit(value) } catch { cleanup.failures.push('Read-only observer/probe did not retire naturally') } }
      for (const e of endpoints) e.lines.close()
      cleanup.passed = cleanup.failures.length === 0 && cleanup.forced.length === 0
      if (!cleanup.passed) { report.status = 'failed'; process.exitCode = 1 }
      if (manualMarker && report.status !== 'passed') await writeManualMarker({ phase: 'failed', cleanupPassed: cleanup.passed, code: 'MANUAL_MODIFIER_OR_RUN_FAILED' })
      await writeFile(join(output, 'report.json'), JSON.stringify({ ...report, preparation, pictures, snapshots, geometrySettles, owned, cleanup, realMoveRequests: moveRequests, actualForeignCursorShowCalls: 0, actualCursorWarpCalls: 0, actualMouseAssociationCalls: 0, modifierInjection: manualModifierGate ? 'root-CUA-only; no runner injection' : 'not-run', testedAt: new Date().toISOString() }, null, 2))
      await writeFile(join(output, 'transcripts.json'), JSON.stringify(endpoints.map(e => ({ role: e.role, pid: e.child.pid, transcript: e.transcript, stderrBytes: e.stderrBytes })), null, 2))
      console.log(JSON.stringify({ status: report.status, cases: cases.length, cleanup, output }))
    }
  }
}
