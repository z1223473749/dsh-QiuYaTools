/** Isolated cursor suppression research. Default: compile + fake-call self-test.
 * --run --gui-gate root-approved is an explicit GUI experiment, never a plugin.
 * No input injection/warp/association or another process's cursor Show exists. */
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createInterface } from 'node:readline'
import { mkdir, readFile, writeFile, realpath, access } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
const root = fileURLToPath(new URL('../', import.meta.url)), arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
const digest = bytes => createHash('sha256').update(bytes).digest('hex'), execute = promisify(execFile)
const appKitCounter = process.argv.includes('--appkit-counter'), counterArgs = appKitCounter ? ['--appkit-counter'] : []

// A test-only parent proxies its private child's stdin/stdout. Killing this
// parent closes the child's pipe; only that child balances its own Hide.
if (arg('--parent-proxy')) {
  const worker = await realpath(arg('--parent-proxy'))
  assert.equal(digest(await readFile(worker)), arg('--worker-sha256'))
  const child = spawn(worker, ['--hider', ...counterArgs], { stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.on('error', () => {}); child.stderr.resume(); child.stdout.pipe(process.stdout, { end: false }); process.stdin.pipe(child.stdin)
  const timer = setTimeout(() => child.stdin.end(), 18000)
  child.once('error', () => { clearTimeout(timer); process.exitCode = 1 })
  child.once('exit', (code, signal) => { clearTimeout(timer); console.log(JSON.stringify({ event: 'proxy-worker-exit', code, signal })); process.exitCode = code === 0 && !signal ? 0 : 1; process.stdin.destroy() })
} else {
  assert.equal(process.platform, 'darwin')
  const output = resolve(arg('--output') ?? 'artifacts/computer-use/macos-system-cursor-experiment-prepared')
  await mkdir(output, { recursive: true })
  const source = join(root, 'src/native/macos/fixtures/SystemCursorExperiment.swift'), observerSource = join(root, 'src/native/macos/fixtures/AICursorObserver.swift')
  let preparation
  if (arg('--prepared')) preparation = JSON.parse(await readFile(join(resolve(arg('--prepared')), 'preparation.json'), 'utf8'))
  else {
    const binary = join(output, 'cursor-experiment'), observer = join(output, 'independent-sck-observer')
    const sources = [source, observerSource, join(root, 'src/native/macos/Protocol.swift'), join(root, 'src/native/macos/CursorOverlay.swift'), fileURLToPath(import.meta.url)]
    const hashes = Object.fromEntries(await Promise.all(sources.map(async path => [path, digest(await readFile(path))])))
    const flags = ['-swift-version', '5', '-parse-as-library', '-framework', 'AppKit', '-module-cache-path', '/private/tmp/qiuya-system-cursor-module-cache']
    await execute('/usr/bin/swiftc', [...flags, '-framework', 'ApplicationServices', '-framework', 'ImageIO', join(root, 'src/native/macos/Protocol.swift'), join(root, 'src/native/macos/CursorOverlay.swift'), source, '-o', binary], { timeout: 90000 })
    await execute('/usr/bin/swiftc', [...flags, '-framework', 'ScreenCaptureKit', '-framework', 'CoreImage', '-framework', 'CoreMedia', observerSource, '-o', observer], { timeout: 90000 })
    const selfTest = JSON.parse((await execute(binary, ['--self-test'], { timeout: 10000 })).stdout)
    assert.equal(selfTest.passed, true); assert.equal(selfTest.actualCursorCalls, 0)
    for (const path of sources) assert.equal(digest(await readFile(path)), hashes[path], 'Experiment source changed during preparation')
    preparation = { status: 'prepared-not-GUI-run', binary: await realpath(binary), observer: await realpath(observer), binarySHA256: digest(await readFile(binary)), observerSHA256: digest(await readFile(observer)), sources: hashes, selfTest,
      experimentControl: { hiderActivationPolicy: 'accessory', priorFailedPolicy: 'prohibited', changedBehavior: 'hider activation policy only; read-only symbol ID evidence added', connectionSelection: 'CGSMainConnectionID then _CGSDefaultConnection, unchanged', productionChanged: false },
      authority: 'Only explicit --run and root-approved GUI gate may launch fixture/hider/probe; no plugin or profile changed.',
      crashRestoration: 'not-proven', references: ['https://developer.apple.com/library/archive/documentation/GraphicsImaging/Conceptual/QuartzDisplayServicesConceptual/Articles/MouseCursor.html', 'https://raw.githubusercontent.com/input-leap/input-leap/master/src/lib/platform/OSXScreen.h', 'https://raw.githubusercontent.com/input-leap/input-leap/master/src/lib/platform/OSXScreen.mm'] }
    await writeFile(join(output, 'preparation.json'), JSON.stringify(preparation, null, 2))
  }
  assert.equal(digest(await readFile(preparation.binary)), preparation.binarySHA256); assert.equal(digest(await readFile(preparation.observer)), preparation.observerSHA256)
  if (!process.argv.includes('--run')) console.log(JSON.stringify({ status: 'prepared-not-GUI-run', output, selfTest: preparation.selfTest, actualCursorCalls: 0 }, null, 2))
  else {
    assert.equal(arg('--gui-gate'), 'root-approved', 'The runner requires a separately assigned GUI/input gate')
    assert.equal(await access(join(output, 'report.json')).then(() => true, () => false), false, 'Preserve existing reports; use a new output directory')
    const endpoints = [], pictures = [], cases = [], snapshots = [], owned = [], cleanup = { passed: false, failures: [], unexpectedSignals: [] }
    let probe, camera, fixture, fixtureIdentity, windowId, cursor, fatal, report
    function endpoint(executable, args, role) {
      const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'] }), pending = new Map(), events = [], transcript = []; let seq = 0, stderrBytes = 0
      child.stdin.on('error', () => {}); child.stderr.on('data', data => { stderrBytes += data.length })
      const lines = createInterface({ input: child.stdout }); lines.on('line', line => {
        let data; try { data = JSON.parse(line) } catch { fatal ??= Error('Malformed experiment protocol'); return }
        const job = pending.get(data.requestId)
        if (job) { pending.delete(data.requestId); clearTimeout(job.timer); job.resolve(data) } else events.push(data)
        transcript.push(data)
      })
      const exited = new Promise(done => { child.once('exit', (code, signal) => { for (const job of pending.values()) { clearTimeout(job.timer); job.reject(Error('Owned experiment process exited')) }; pending.clear(); done({ code, signal }) }); child.once('error', () => done({ code: null, signal: null, startupFailed: true })) })
      const value = { child, role, transcript, exited, lines, get stderrBytes() { return stderrBytes }, async request(op, extra = {}) { const requestId = ++seq; return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(requestId); reject(Error('Bounded experiment RPC timeout')) }, 12000); pending.set(requestId, { timer, resolve, reject }); child.stdin.write(JSON.stringify({ requestId, op, ...extra }) + '\n') }) }, async ok(op, extra) { const response = await this.request(op, extra); assert.equal(response.ok, true, JSON.stringify(response.error)); return response.result }, async ready() { return until(() => { const failed = events.find(event => event.event === 'failed'); if (failed) throw Error(failed.code); return events.find(event => event.event === 'ready') }, 'Experiment process did not become ready') } }
      endpoints.push(value); return value
    }
    async function until(read, reason, ms = 6000) { const end = performance.now() + ms; while (performance.now() < end) { if (fatal) throw fatal; const value = await read(); if (value) return value; await sleep(25) }; throw Error(reason) }
    const same = (a, b) => !!a && !!b && ['pid', 'startSeconds', 'startMicroseconds', 'uniqueId', 'executablePath'].every(key => a[key] === b[key])
    async function identify(pid) { return (await probe.ok('identity', { pid })).identity }
    async function pin(value, role) { const actual = await identify(value.pid); assert.ok(same(actual, value), 'Independent PID/birth/path must match'); if (!owned.some(row => same(row.identity, value))) owned.push({ identity: value, role }); return value }
    async function snapshot(label) { const value = await probe.ok('snapshot', { identities: fixtureIdentity ? [fixtureIdentity] : [] }); snapshots.push({ label, ...value }); return value }
    async function gone(identity) {
      // A just-orphaned process can retain its PID briefly after its executable
      // identity becomes unreadable. Unknown is neither alive nor gone: keep
      // reading within the original deadline until ESRCH or a proven new birth.
      const attempts = []
      try {
        return await until(async () => {
          const reply = await probe.request('identity', { pid: identity.pid })
          attempts.push({ at: new Date().toISOString(), ok: reply.ok, code: reply.error?.code, identity: reply.result?.identity })
          if (!reply.ok) { assert.equal(reply.error?.code, 'identity-unavailable'); return false }
          const current = reply.result.identity
          return !current || !same(current, identity)
        }, 'Exact experiment process retirement remained unconfirmed', 6000)
      } finally { snapshots.push({ label: 'retirement-readback', identity, attempts }) }
    }
    async function waitExit(value, expectedSignal = null) { let timer; const exit = await Promise.race([value.exited, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Experiment process exit timeout')), 6000) })]).finally(() => clearTimeout(timer)); if (expectedSignal) assert.equal(exit.signal, expectedSignal); else { assert.equal(exit.code, 0); assert.equal(exit.signal, null) }; return exit }
    async function assertFixture(label) { const state = await snapshot(label); assert.equal(state.sessionActive, true); assert.equal(state.foregroundPid, fixtureIdentity.pid); assert.equal(state.leftButtonDown, false); assert.equal(state.rightButtonDown, false); assert.equal(state.middleButtonDown, false); assert.equal(state.keysHeldCount, 0); assert.ok(Math.hypot(state.cursor.x-cursor.x,state.cursor.y-cursor.y)<1.5, 'Cursor moved: no further hide permitted'); return state }
    async function pair(label, expectedVisible) {
      const before = await assertFixture(label+'-before'), paths = []
      for (const includeRealCursor of [false, true]) {
        const path = join(output, label+(includeRealCursor?'-with-system-cursor.png':'-without-system-cursor.png'))
        const image = await camera.ok('capture', { identity: fixtureIdentity, windowId, output: path, composited: true, includeRealCursor })
        assert.equal(image.includesRealOSCursor, includeRealCursor); assert.ok(same(image.owner, fixtureIdentity)); paths.push({ path, ...image }); pictures.push({ label, ...image, path, sha256: digest(await readFile(path)) })
      }
      const after = await assertFixture(label+'-after'), first = paths[0], second = paths[1]
      for (const key of ['x','y','width','height','pixelWidth','pixelHeight']) assert.equal(first[key],second[key], 'Paired independent SCK sources must have identical geometry')
      const sx=first.pixelWidth/first.width,sy=first.pixelHeight/first.height,crop={x:Math.floor((cursor.x-first.x-18)*sx),y:Math.floor((cursor.y-first.y-18)*sy),width:Math.round(48*sx),height:Math.round(50*sy)}
      const difference = await probe.ok('compare', { a:first.path,b:second.path,crop })
      if (expectedVisible) assert.ok(difference.changedPixelsOver8>=10,'Recovered real OS cursor pixels must be independently visible')
      else assert.ok(difference.changedPixelsOver8<=2,'Hidden with-cursor image must agree with independent no-cursor image')
      for (const state of [before,after]) if (state.visibility.value!==null) assert.equal(state.visibility.value,expectedVisible,'Deprecated visibility diagnostic contradicts actual SCK pixels')
      return { before,after,crop,difference,cursorWindowOwner:after.cursorWindows.some(row=>row.ownerVerification==='verified-WindowServer-executable')?'verified-WindowServer-executable':'unknown' }
    }
    async function holder(proxy=false) {
      const value=proxy?endpoint(process.execPath,[fileURLToPath(import.meta.url),'--parent-proxy',preparation.binary,'--worker-sha256',preparation.binarySHA256,...counterArgs],'proxy-parent'):endpoint(preparation.binary,['--hider',...counterArgs],'hider')
      const ready=await value.ready(),worker=await pin(ready.identity,'hider');assert.equal(ready.role,'hider');if(preparation.experimentControl)assert.equal(ready.activationPolicy,preparation.experimentControl.hiderActivationPolicy);const parent=proxy?await pin(await identify(value.child.pid),'proxy-parent'):null
      assert.equal(worker.parentPid,proxy?parent.pid:process.pid);return{value,worker,parent}
    }
    async function killOwned(identity, value) { assert.ok(same(await identify(identity.pid),identity),'Refusing to signal a reused PID'); process.kill(identity.pid,'SIGKILL'); if(value)await waitExit(value,'SIGKILL') }
    try {
      probe=endpoint(preparation.binary,['--probe'],'independent-probe');await probe.ready()
      const baseline=await snapshot('before-fixture');assert.equal(baseline.sessionActive,true);assert.equal(baseline.screenRecording,true);assert.equal(baseline.keysHeldCount,0);assert.equal(baseline.leftButtonDown,false)
      fixture=endpoint(preparation.binary,['--fixture'],'fixture');const ready=await fixture.ready();fixtureIdentity=await pin(ready.identity,'fixture');windowId=ready.windowId;cursor=ready.pointer
      assert.ok(Number.isSafeInteger(windowId)&&windowId>0&&Number.isFinite(cursor?.x)&&Number.isFinite(cursor?.y))
      camera=endpoint(preparation.observer,[],'independent-sck-observer');await camera.ready()
      let signature,stableAt
      await until(async()=>{const state=await camera.ok('snapshot',{identities:[fixtureIdentity]}),w=state.windows.find(row=>row.pid===fixtureIdentity.pid&&row.id===windowId&&row.alpha===1);const next=w&&JSON.stringify([w.x,w.y,w.width,w.height]);if(!next||state.foregroundPid!==fixtureIdentity.pid){signature=undefined;return false};if(signature!==next){signature=next;stableAt=performance.now()};return performance.now()-stableAt>=200},'Own fixture did not become geometrically stable')
      await pair('baseline',true)
      for(const mode of ['balanced','worker-eof','worker-sigkill','parent-eof','parent-sigkill']){
        const h=await holder(mode.startsWith('parent')),before=await assertFixture(mode+'-authorization')
        const hidden=await h.value.ok('hide',{fixture:fixtureIdentity,windowId});assert.equal(hidden.balance.ownedHideCount,1)
        const duplicate=await h.value.ok('hide',{fixture:fixtureIdentity,windowId});assert.equal(duplicate.balance.successfulHideCalls,1,'Repeated acquisition must not increment hide count')
        const hiddenPixels=await pair(mode+'-hidden',false)
        if(mode==='balanced'){const shown=await h.value.ok('show');assert.equal(shown.balance.ownedHideCount,0);assert.equal(shown.balance.successfulShowCalls,1);assert.equal(shown.balance.backgroundPropertyOwned,false);h.value.child.stdin.end();await waitExit(h.value)}
        else if(mode==='worker-sigkill')await killOwned(h.worker,h.value)
        else if(mode==='parent-sigkill')await killOwned(h.parent,h.value)
        else{h.value.child.stdin.end();await waitExit(h.value)}
        await gone(h.worker);if(h.parent)await gone(h.parent)
        // Only read after a crash: a fresh process must never Show on behalf of
        // the old connection, which would make count ownership unprovable.
        await until(async()=>{const state=await assertFixture(mode+'-restore-wait');return state.visibility.value===false?false:state},'Cursor did not restore after the exact owned lifecycle',4000)
        const restoredPixels=await pair(mode+'-restored',true)
        cases.push({mode,passed:true,worker:h.worker,parent:h.parent,authorization:before,hidden:hidden.balance,hiddenPixels,restoredPixels,otherProcessShowCalls:0})
      }
      report={status:'passed',cases,crashRestorationProven:true,boundary:'Independent SCK with/without real cursor in the own fixture region plus optional deprecated visibility and cursor-layer metadata. No production integration, input lease or CGEvent action claimed.'}
    } catch(error){report={status:'failed',cases,crashRestorationProven:false,reason:String(error.message).slice(0,2000)};process.exitCode=1}
    finally{
      for(const value of endpoints.filter(value=>['hider','proxy-parent'].includes(value.role))){if(value.child.exitCode===null&&!value.child.signalCode){try{await value.ok('show');value.child.stdin.end();await waitExit(value)}catch{cleanup.failures.push('Owned hider cleanup unconfirmed; no other process Show attempted')}}}
      for(const entry of owned.filter(row=>row.role!=='fixture'))try{await gone(entry.identity)}catch{cleanup.failures.push('Owned '+entry.role+' still present')}
      if(fixture?.child.exitCode===null&&!fixture.child.signalCode){fixture.child.stdin.end();try{await waitExit(fixture)}catch{cleanup.failures.push('Fixture natural exit unconfirmed')}}
      if(fixtureIdentity)try{await gone(fixtureIdentity)}catch{cleanup.failures.push('Fixture identity remained')}
      for(const value of[camera,probe].filter(Boolean)){value.child.stdin.end();try{await waitExit(value)}catch{cleanup.failures.push('Read-only observer natural exit unconfirmed')}}
      for(const value of endpoints)value.lines.close()
      cleanup.passed=cleanup.failures.length===0; if(!cleanup.passed){report.status='failed';process.exitCode=1}
      await writeFile(join(output,'report.json'),JSON.stringify({...report,preparation,counterAPI:appKitCounter?'NSCursor.hide/unhide':'CGDisplayHideCursor/ShowCursor',counterAPIReturnsStatus:!appKitCounter,owned,pictures,snapshots,cleanup,actualCGEventPosts:0,actualCursorWarpCalls:0,actualMouseAssociationCalls:0,otherProcessShowCalls:0,productionDefaultChanged:false,testedAt:new Date().toISOString()},null,2))
      await writeFile(join(output,'transcripts.json'),JSON.stringify(endpoints.map(value=>({role:value.role,pid:value.child.pid,transcript:value.transcript,stderrBytes:value.stderrBytes})),null,2))
      console.log(JSON.stringify({status:report.status,cases:cases.length,cleanup,output},null,2))
    }
  }
}
