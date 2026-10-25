import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const directory = await mkdtemp(join(tmpdir(), 'qiuya-computer-native-'))
const source = (await build({ entryPoints: [fileURLToPath(new URL('../src/features/computer-use/native.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })).outputFiles[0].text
const { NativeCompanionDriver, computerCompanionPath } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
test.after(() => rm(directory, { recursive: true, force: true }))
const script = join(directory, 'fixture.cjs'), records = join(directory, 'requests.jsonl')
await writeFile(script, `const fs=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const r=JSON.parse(line);fs.appendFileSync(${JSON.stringify(records)},JSON.stringify({...r,pid:process.pid,argv:process.argv.slice(2)})+'\\n');if(r.op==='observe')return;if(r.op==='closePreview'){process.stdout.write(JSON.stringify({event:'previewClosed',sessionId:'fixture'})+'\\n')}if(r.op==='act'){process.stdout.write(JSON.stringify({requestId:r.requestId,ok:false,error:{code:'CONTROL_CHANGED',message:'fenced'}})+'\\n');return}process.stdout.write(JSON.stringify({requestId:r.requestId,ok:true,result:r.op==='status'?{available:true,protocolVersion:process.argv.includes('--wrong-protocol')?99:1}:r})+'\\n')});rl.on('close',()=>process.exit(0));`)

let captureFixtureSequence = 0
async function captureFixture({ captureDelay = 120, timeoutMs = 10_000, gated = false, exitOnCapture = false } = {}) {
  const number = ++captureFixtureSequence, executable = join(directory, `capture-slot-${number}.cjs`), journal = join(directory, `capture-slot-${number}.jsonl`), gate = join(directory, `capture-slot-${number}.gate`)
  await writeFile(executable, `const fs=require('node:fs');let busy=false,sequence=0;const record=r=>fs.appendFileSync(${JSON.stringify(journal)},JSON.stringify({...r,pid:process.pid})+'\\n'),reply=(r,result)=>process.stdout.write(JSON.stringify({requestId:r.requestId,ok:true,result})+'\\n');const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const r=JSON.parse(line);record({...r,phase:'received',busy});if(r.op==='observe'){if(busy){record({...r,phase:'rejected',code:'CAPTURE_BUSY'});process.stdout.write(JSON.stringify({requestId:r.requestId,ok:false,error:{code:'CAPTURE_BUSY',message:'Another frame is being prepared.'}})+'\\n');return}busy=true;if(${exitOnCapture})process.exit(77);const frameId=String(++sequence),finish=()=>{busy=false;record({...r,phase:'completed'});reply(r,{targetId:r.targetId,frameId,imageBase64:'/9j/2Q==',mediaType:'image/jpeg',width:1,height:1,elements:r.preview?'':'fixture AX',geometry:{x:0,y:0,width:1,height:1,scale:1}})};if(${gated}){const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(timer);finish()}},5)}else setTimeout(finish,${captureDelay});return}reply(r,r.op==='status'?{available:true,protocolVersion:1,busy}:r)});rl.on('close',()=>{record({phase:'eof'});process.exit(0)});`)
  const read = async () => (await readFile(journal, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error))).trim().split('\n').filter(Boolean).map(JSON.parse)
  const waitFor = async check => {
    const deadline = performance.now() + 2000
    while (performance.now() < deadline) { const rows = await read(); if (check(rows)) return rows; await delay(5) }
    throw new Error('The exact JSONL capture fixture did not reach the expected checkpoint')
  }
  const options = { executable: process.execPath, args: [executable], timeoutMs }
  return { driver: new NativeCompanionDriver(options), read, waitFor, journal, options, unblock: () => writeFile(gate, 'read-only-fixture-completion') }
}

test('platform resolver selects fixed native assets and rejects unsupported architectures', () => {
  const base = pathToFileURL(directory + '/')
  assert.equal(computerCompanionPath('darwin', 'arm64', base), join(directory, 'QiuYaTools Computer.app/Contents/MacOS/qiuya-computer'))
  assert.equal(computerCompanionPath('win32', 'x64', base), join(directory, 'native/win32-x64/qiuya-windows.exe'))
  assert.throws(() => computerCompanionPath('win32', 'ia32', base), { code: 'PLATFORM_UNSUPPORTED' })
})

test('one companion receives RPC and authenticated preview URL through stdin; native errors preserve code', async () => {
  const driver = new NativeCompanionDriver({ executable: process.execPath, args: [script] })
  try {
    assert.equal((await driver.status()).available, true)
    await driver.openPreview('http://127.0.0.1:1/?token=fixture-secret', 'Fixture', 'fixture')
    await assert.rejects(driver.act(10, 'target', { kind: 'key', key: 'Enter' }), { code: 'CONTROL_CHANGED' })
    const lines = (await readFile(records, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(new Set(lines.slice(-3).map(value => value.pid)).size, 1)
    assert.ok(lines.every(value => !value.argv.join(' ').includes('fixture-secret')))
    assert.ok(lines.at(-2).url.includes('fixture-secret'))
  } finally { driver.dispose() }
})

test('abort releases local wait without killing companion, so service can fence native input with release', async () => {
  const driver = new NativeCompanionDriver({ executable: process.execPath, args: [script] }), abort = new AbortController()
  try {
    await driver.status()
    const observing = driver.observe('target', abort.signal)
    const rejected = assert.rejects(observing)
    abort.abort(new Error('cancelled')); await rejected
    const result = await driver.release(10)
    assert.equal(result.op, 'release')
    assert.equal((await driver.status()).available, true)
  } finally { driver.dispose() }
})

test('unsolicited preview-close events reach Host listeners and disposal rejects pending reads', async () => {
  const driver = new NativeCompanionDriver({ executable: process.execPath, args: [script] }), events = []
  driver.subscribe(event => events.push(event))
  await driver.closePreview()
  assert.equal(events[0].event, 'previewClosed')
  const pending = driver.observe('target'), rejected = assert.rejects(pending, { code: 'DISPOSED' })
  driver.dispose(); await rejected
  await assert.rejects(driver.targets(), { code: 'DISPOSED' })
})

test('timeout kills a hung native worker and reports failure instead of silently replaying a request', async () => {
  const driver = new NativeCompanionDriver({ executable: process.execPath, args: [script], timeoutMs: 100 })
  try { await assert.rejects(driver.observe('target'), { code: 'NATIVE_TIMEOUT' }) } finally { driver.dispose() }
})


test('incompatible companion is rejected before target enumeration or input', async () => {
  const driver = new NativeCompanionDriver({ executable: process.execPath, args: [script, '--wrong-protocol'] })
  try {
    assert.equal((await driver.status()).available, false)
    await assert.rejects(driver.targets(), { code: 'NATIVE_PROTOCOL_VERSION' })
    await assert.rejects(driver.lease(50), { code: 'NATIVE_PROTOCOL_VERSION' })
    await assert.rejects(driver.act(50, 'target', { kind: 'key', key: 'Enter' }), { code: 'NATIVE_PROTOCOL_VERSION' })
    const lines = (await readFile(records, 'utf8')).trim().split('\n').map(JSON.parse).filter(row => row.argv.includes('--wrong-protocol'))
    assert.deepEqual(lines.map(row => row.op), ['status'])
  } finally { driver.dispose() }
})

test('unexpected worker exit clears its recorded owned inputs in a separate cleanup process without replaying the action', async () => {
  const worker = join(directory, 'crash.cjs'), cleanup = join(directory, 'released.json')
  await writeFile(worker, `const fs=require('node:fs');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{if(process.argv.includes('--release-input')){fs.writeFileSync(${JSON.stringify(cleanup)},line);process.exit(0)}const r=JSON.parse(line);if(r.op==='status')process.stdout.write(JSON.stringify({requestId:r.requestId,ok:true,result:{available:true,protocolVersion:1}})+'\\n');else if(r.op==='observe'){process.stdout.write(JSON.stringify({event:'inputHeld',keys:[17],mouseButtons:['left']})+'\\n',()=>process.exit(77))}})`)
  const driver = new NativeCompanionDriver({ executable: process.execPath, args: [worker], releaseInputArgs: [worker, '--release-input'] })
  await assert.rejects(driver.observe('fixture'), { code: 'NATIVE_EXITED' })
  await driver.dispose()
  assert.deepEqual(JSON.parse(await readFile(cleanup, 'utf8')), { keys: [17], mouseButtons: ['left'] })
})

test('failed emergency cleanup blocks subsequent workers and makes disposal report the failure', async () => {
  const worker = join(directory, 'cleanup-failure.cjs')
  await writeFile(worker, `if(process.argv.includes('--release-input')){process.stdin.resume();process.stdin.once('end',()=>process.exit(2))}else{require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.op==='status')process.stdout.write(JSON.stringify({requestId:r.requestId,ok:true,result:{available:true,protocolVersion:1}})+'\\n');else process.stdout.write(JSON.stringify({event:'inputHeld',keys:[],mouseButtons:['left']})+'\\n',()=>process.exit(77))})}`)
  const driver = new NativeCompanionDriver({ executable: process.execPath, args: [worker], releaseInputArgs: [worker, '--release-input'] })
  await assert.rejects(driver.observe('fixture'), { code: 'NATIVE_EXITED' })
  await assert.rejects(driver.targets(), { code: 'NATIVE_CLEANUP_FAILED' })
  await assert.rejects(driver.dispose(), { code: 'NATIVE_CLEANUP_FAILED' })
})

test('emergency cleanup preserves the native owner and Unicode units while ignoring malformed held-input events', async () => {
  const worker = join(directory, 'unicode-crash.cjs'), cleanup = join(directory, 'unicode-released.json')
  const owned = { ownerId: 'a'.repeat(32), keys: [], mouseButtons: [], unicodeUnits: [0xd83d, 0xde00] }
  await writeFile(worker, `const fs=require('node:fs');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{if(process.argv.includes('--release-input')){fs.writeFileSync(${JSON.stringify(cleanup)},line);process.exit(0)}const r=JSON.parse(line);if(r.op==='status')process.stdout.write(JSON.stringify({requestId:r.requestId,ok:true,result:{available:true,protocolVersion:1}})+'\\n');else{process.stdout.write(JSON.stringify({event:'inputHeld',...${JSON.stringify(owned)}})+'\\n');process.stdout.write(JSON.stringify({event:'inputHeld',ownerId:'invalid',keys:[],mouseButtons:[],unicodeUnits:[]})+'\\n',()=>process.exit(77))}})`)
  const driver = new NativeCompanionDriver({ executable: process.execPath, args: [worker], releaseInputArgs: [worker, '--release-input'] })
  await assert.rejects(driver.observe('fixture'), { code: 'NATIVE_EXITED' })
  await driver.dispose()
  assert.deepEqual(JSON.parse(await readFile(cleanup, 'utf8')), owned)
})

test('capture FIFO coalesces two viewers while a model observation gets its own fresh AX frame', async () => {
  const fixture = await captureFixture(), { driver } = fixture
  try {
    const frames = await Promise.all([driver.preview('same-window'), driver.preview('same-window'), driver.observe('same-window'), driver.preview('other-window')])
    assert.equal(frames[0].frameId, frames[1].frameId)
    assert.notEqual(frames[2].frameId, frames[0].frameId)
    assert.equal(frames[0].elements, ''); assert.equal(frames[2].elements, 'fixture AX')
    assert.equal(frames[3].targetId, 'other-window')
    const rows = await fixture.read(), captures = rows.filter(row => row.op === 'observe' && row.phase === 'received')
    assert.deepEqual(captures.map(row => [row.targetId, row.preview === true]), [['same-window', true], ['same-window', false], ['other-window', true]])
    assert.ok(captures.every(row => row.busy === false)); assert.ok(rows.every(row => row.code !== 'CAPTURE_BUSY'))
  } finally {
    await driver.dispose()
    if (process.env.QIUYA_NATIVE_CAPTURE_EVIDENCE) await writeFile(join(process.env.QIUYA_NATIVE_CAPTURE_EVIDENCE, 'capture-requests.jsonl'), await readFile(fixture.journal))
  }
})

test('one aborted viewer does not cancel a shared frame, and control RPC bypasses the capture FIFO', async () => {
  const fixture = await captureFixture({ gated: true }), { driver } = fixture, first = new AbortController()
  try {
    const cancelled = driver.preview('shared', first.signal), rejected = assert.rejects(cancelled, /viewer left/)
    const remaining = driver.preview('shared'), model = driver.observe('model')
    await fixture.waitFor(rows => rows.some(row => row.op === 'observe' && row.phase === 'received'))
    first.abort(new Error('viewer left')); await rejected
    const status = await driver.status(); assert.equal(status.busy, true)
    const [released, action, leased] = await Promise.all([driver.release(9), driver.act(10, 'owned', { kind: 'move', x: 0, y: 0 }), driver.lease(10)])
    assert.equal(released.op, 'release'); assert.equal(action.op, 'act'); assert.equal(leased.op, 'lease')
    await fixture.unblock()
    const [preview, observed] = await Promise.all([remaining, model]); assert.equal(preview.targetId, 'shared'); assert.equal(observed.targetId, 'model')
    const rows = await fixture.read(), completed = rows.findIndex(row => row.op === 'observe' && row.phase === 'completed')
    for (const op of ['release', 'act', 'lease']) assert.ok(rows.findIndex(row => row.op === op) < completed, `${op} must not wait behind capture`)
    assert.equal(rows.filter(row => row.op === 'act').length, 1, 'Mutating input must never be replayed')
    assert.equal(rows.filter(row => row.op === 'observe' && row.phase === 'received').length, 2)
    assert.ok(rows.every(row => row.code !== 'CAPTURE_BUSY'))
  } finally { await driver.dispose() }
})

test('the next preview after awaiting a completed frame starts fresh rather than joining a settled flight', async () => {
  const fixture = await captureFixture({ captureDelay: 5 }), { driver } = fixture
  let deadline
  try {
    const first = await driver.preview('same-window')
    const second = await Promise.race([driver.preview('same-window'), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('A settled preview retained a new viewer')), 1000) })])
    assert.notEqual(second.frameId, first.frameId)
    assert.equal((await fixture.read()).filter(row => row.op === 'observe' && row.phase === 'received').length, 2)
  } finally { clearTimeout(deadline); await driver.dispose() }
})

test('abandoning every active viewer retains the native busy gate until its actual reply', async () => {
  const fixture = await captureFixture({ gated: true }), { driver } = fixture, first = new AbortController(), second = new AbortController()
  try {
    const a = assert.rejects(driver.preview('abandoned', first.signal), /left/), b = assert.rejects(driver.preview('abandoned', second.signal), /left/)
    await fixture.waitFor(rows => rows.some(row => row.op === 'observe' && row.phase === 'received'))
    first.abort(new Error('left')); second.abort(new Error('left')); await Promise.all([a, b])
    assert.equal((await driver.status()).busy, true)
    const next = driver.observe('next'); await fixture.unblock(); const frame = await next; assert.equal(frame.targetId, 'next')
    const rows = await fixture.read(), received = rows.filter(row => row.op === 'observe' && row.phase === 'received')
    assert.deepEqual(received.map(row => row.targetId), ['abandoned', 'next']); assert.ok(received.every(row => !row.busy))
  } finally { await driver.dispose() }
})

test('an aborted queued capture is skipped without sending or replaying native work', async () => {
  const fixture = await captureFixture({ gated: true }), { driver } = fixture, abort = new AbortController()
  try {
    const active = driver.preview('active')
    await fixture.waitFor(rows => rows.some(row => row.op === 'observe' && row.phase === 'received'))
    const discarded = assert.rejects(driver.observe('discarded', abort.signal), /queued left/), next = driver.observe('next')
    abort.abort(new Error('queued left')); await discarded; await fixture.unblock(); await Promise.all([active, next])
    const received = (await fixture.read()).filter(row => row.op === 'observe' && row.phase === 'received')
    assert.deepEqual(received.map(row => row.targetId), ['active', 'next'])
  } finally { await driver.dispose() }
})

test('capture jobs and shared-viewer callers have separate hard bounds', async () => {
  const fixture = await captureFixture({ gated: true }), { driver } = fixture
  try {
    const jobs = Array.from({ length: 16 }, (_, index) => driver.observe(`job-${index}`)), settled = Promise.allSettled(jobs)
    await assert.rejects(driver.observe('overflow'), { code: 'QUEUE_FULL' })
    await driver.dispose(); const results = await settled
    assert.ok(results.every(value => value.status === 'rejected' && value.reason.code === 'DISPOSED'))
    assert.ok((await fixture.read()).filter(row => row.op === 'observe' && row.phase === 'received').length <= 1)
  } finally { await driver.dispose() }
  const viewers = await captureFixture({ gated: true })
  try {
    const calls = Array.from({ length: 128 }, () => viewers.driver.preview('one-frame')), settled = Promise.allSettled(calls)
    await assert.rejects(viewers.driver.preview('one-frame'), { code: 'QUEUE_FULL' })
    await viewers.driver.dispose(); const results = await settled
    assert.ok(results.every(value => value.status === 'rejected' && value.reason.code === 'DISPOSED'))
  } finally { await viewers.driver.dispose() }
})

test('disposing active and queued captures rejects all callers without spawning another worker', async () => {
  const fixture = await captureFixture({ gated: true }), { driver } = fixture
  const active = driver.preview('active'), queued = driver.observe('queued'), settled = Promise.allSettled([active, queued])
  await fixture.waitFor(rows => rows.some(row => row.op === 'observe' && row.phase === 'received'))
  await driver.dispose()
  assert.ok((await settled).every(value => value.status === 'rejected' && value.reason.code === 'DISPOSED'))
  await assert.rejects(driver.preview('disposed'), { code: 'DISPOSED' })
  const rows = await fixture.read(); assert.equal(new Set(rows.map(row => row.pid)).size, 1)
  assert.deepEqual(rows.filter(row => row.op === 'observe' && row.phase === 'received').map(row => row.targetId), ['active'])
})

test('native capture timeout fences queued reads without replay or a replacement worker', async () => {
  const fixture = await captureFixture({ gated: true }), { driver } = fixture
  try {
    await driver.status(); fixture.options.timeoutMs = 100
    const result = await Promise.allSettled([driver.preview('active'), driver.observe('queued'), driver.preview('another-view')])
    assert.ok(result.every(value => value.status === 'rejected' && value.reason.code === 'NATIVE_TIMEOUT'))
    const rows = await fixture.read(); assert.equal(new Set(rows.map(row => row.pid)).size, 1)
    assert.deepEqual(rows.filter(row => row.op === 'observe' && row.phase === 'received').map(row => row.targetId), ['active'])
  } finally { await driver.dispose() }
})

test('unexpected native exit rejects active and queued captures without creating a replacement worker', async () => {
  const fixture = await captureFixture({ exitOnCapture: true }), { driver } = fixture
  try {
    const result = await Promise.allSettled([driver.preview('active'), driver.observe('queued'), driver.preview('other-window')])
    assert.ok(result.every(value => value.status === 'rejected' && value.reason.code === 'NATIVE_EXITED'))
    const rows = await fixture.read(); assert.equal(new Set(rows.map(row => row.pid)).size, 1)
    assert.deepEqual(rows.filter(row => row.op === 'observe' && row.phase === 'received').map(row => row.targetId), ['active'])
  } finally { await driver.dispose() }
})

test('native application metadata accepts bounded Unicode scalars and strips unlisted transport fields', async () => {
  const worker = join(directory, 'catalog.cjs'), name = '🖥'.repeat(160)
  await writeFile(worker, `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);process.stdout.write(JSON.stringify({requestId:r.requestId,ok:true,result:r.op==='status'?{available:true,protocolVersion:1}:{applications:[{appId:'fixture',name:${JSON.stringify(name)},running:false,launchable:true,executablePath:'/private/should-not-project'}]}})+'\\n')})`)
  const driver = new NativeCompanionDriver({ executable: process.execPath, args: [worker] })
  try {
    assert.deepEqual(await driver.applications(), [{ appId: 'fixture', name, running: false, launchable: true }])
    await assert.rejects(driver.openSystemSettings('arbitrary-url'), { code: 'INVALID_PERMISSION' })
  } finally { await driver.dispose() }
})

test('native application catalog retains a bounded embedded icon and keeps legacy or invalid-icon apps available', async () => {
  const worker = join(directory, 'icon-catalog.cjs')
  const iconDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
  const rows = [
    { appId: 'icon.app', name: '有图标应用', running: true, launchable: true, iconDataUrl, executablePath: '/private/app', iconPath: '/private/icon' },
    { appId: 'legacy.app', name: '旧版应用', running: false },
    { appId: 'url.app', name: '外链图标应用', running: false, iconDataUrl: 'https://example.invalid/icon.png' },
    { appId: 'svg.app', name: '矢量图标应用', running: true, iconDataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' },
    { appId: 'bad.app', name: '损坏图标应用', running: false, iconDataUrl: 'data:image/png;base64,!!!!' },
  ]
  await writeFile(worker, `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);process.stdout.write(JSON.stringify({requestId:r.requestId,ok:true,result:r.op==='status'?{available:true,protocolVersion:1}:{applications:${JSON.stringify(rows)}}})+'\\n')})`)
  const driver = new NativeCompanionDriver({ executable: process.execPath, args: [worker] })
  try {
    assert.deepEqual(await driver.applications(), [
      { appId: 'icon.app', name: '有图标应用', running: true, launchable: true, iconDataUrl },
      ...rows.slice(1).map(({ appId, name, running }) => ({ appId, name, running })),
    ])
  } finally { await driver.dispose() }
})
