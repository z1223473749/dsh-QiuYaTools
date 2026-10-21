import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
const temporary = await mkdtemp(join(tmpdir(), 'qiuya-launch-quiescence-'))
after(() => rm(temporary, { recursive: true, force: true }))
const source = (await build({ stdin: { contents: "export {NativeCompanionDriver} from './src/features/computer-use/native.ts';export {ComputerInputScheduler,ScheduledComputerDriver} from './src/features/computer-use/scheduled-driver.ts';export {RemoteComputerDriver} from './src/features/computer-use/remote.ts';export {ComputerEnvironmentManager} from './src/features/computer-use/environment-manager.ts';export {ComputerDriverRouter} from './src/features/computer-use/driver-router.ts';", resolveDir: fileURLToPath(new URL('../', import.meta.url)) }, bundle: true, write: false, platform: 'node', format: 'esm' })).outputFiles[0].text
const runtime = join(temporary, 'runtime.mjs'); await writeFile(runtime, source)
const { NativeCompanionDriver, ComputerInputScheduler, ScheduledComputerDriver, RemoteComputerDriver, ComputerEnvironmentManager, ComputerDriverRouter } = await import(pathToFileURL(runtime).href)
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const target = { id: 'own-window', appId: 'own.app', title: 'Own fixture', pid: 10, x: 0, y: 0, width: 100, height: 80, scale: 1 }
function inner(calls = []) {
  return { async status() { return { available: true } }, async applications() { return [{ appId: target.appId, name: 'Own', running: false, launchable: true }] }, async targets() { return [target] },
    async lease(epoch) { calls.push(['lease', epoch]) }, async release(epoch) { calls.push(['release', epoch]) }, async act() { calls.push(['act']); return {} },
    async observe() { return { targetId: target.id, frameId: 'one', imageBase64: '/9j/2Q==', mediaType: 'image/jpeg', width: 100, height: 80, elements: '', geometry: target } },
    async openPreview() {}, async closePreview() {}, async dispose() { calls.push(['dispose']) }, subscribe() { return () => {} } }
}
async function nativeFixture({ timeoutMs = 10000, exits = false, rejects = false } = {}) {
  const id = crypto.randomUUID(), worker = join(temporary, id + '.cjs'), journal = join(temporary, id + '.jsonl'), gate = join(temporary, id + '.gate')
  await writeFile(worker, `const fs=require('node:fs'),timers=new Set(),rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const r=JSON.parse(line),record=phase=>fs.appendFileSync(${JSON.stringify(journal)},JSON.stringify({op:r.op,phase})+'\\n'),reply=result=>process.stdout.write(JSON.stringify({requestId:r.requestId,ok:true,result})+'\\n');record('received');if(r.op==='launchApplication'){if(${exits})return process.exit(77);const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(timer);timers.delete(timer);record('completed');if(${rejects})process.stdout.write(JSON.stringify({requestId:r.requestId,ok:false,error:{code:'APPLICATION_LAUNCH_FAILED',message:'Synthetic explicit rejection'}})+'\\n');else reply({launched:true})}},5);timers.add(timer);return}reply(r.op==='status'?{available:true,protocolVersion:1}:{});});rl.on('close',()=>{for(const timer of timers)clearInterval(timer);process.exit(0)});`)
  const options = { executable: process.execPath, args: [worker], timeoutMs }; const driver = new NativeCompanionDriver(options)
  const rows = async () => (await readFile(journal, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error))).split('\n').filter(Boolean).map(JSON.parse)
  const entered = async () => { const end = Date.now() + 10000; while (Date.now() < end) { if ((await rows()).some(row => row.op === 'launchApplication')) return; await delay(10) }; throw Error('Synthetic launch not received') }
  return { driver, options, entered, rows, finish: () => writeFile(gate, 'complete-readonly-fixture') }
}

test('issued native launch cancellation retains the physical FIFO until the actual JSONL reply', async () => {
  const f = await nativeFixture(), scheduler = new ComputerInputScheduler(), calls = [], a = new ScheduledComputerDriver(f.driver, 'surface', scheduler), b = new ScheduledComputerDriver(inner(calls), 'surface', scheduler), abort = new AbortController()
  const launching = a.launchApplication('own.app', abort.signal), cancelled = assert.rejects(launching, /owner cancelled/u)
  let acting
  try {
    await f.entered(); abort.abort(new Error('owner cancelled')); await b.lease(1)
    acting = b.act(1, target.id, { kind: 'move', x: 1, y: 1 }); await delay(40)
    assert.equal(calls.some(row => row[0] === 'act'), false, 'No other chat input may overtake a still-running native launch')
    await f.finish(); await cancelled; await acting
    assert.equal(calls.filter(row => row[0] === 'act').length, 1)
    assert.equal((await f.rows()).filter(row => row.op === 'launchApplication' && row.phase === 'received').length, 1)
  } finally { await f.finish(); await Promise.allSettled([launching, acting]); await Promise.all([a.dispose(), b.dispose()]) }
})

test('issued paired HTTP launch ignores caller abort until its matching response and then reports cancellation', async () => {
  const entered = deferred(), reply = deferred(), controller = new AbortController(); let wireSignal, calls = 0, settled = false
  const driver = new RemoteComputerDriver({ endpoint: 'http://127.0.0.1:1', token: 'test-pair-token-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ', fetch: async (_url, options) => {
    calls++; const request = JSON.parse(options.body); wireSignal = options.signal; entered.resolve()
    await new Promise((resolve, reject) => { reply.promise.then(resolve); options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }) })
    return Response.json({ version: 1, requestId: request.requestId, ok: true, result: { launched: true } })
  } })
  const launching = driver.launchApplication(driver.deviceId + ':own.app', controller.signal), cancelled = assert.rejects(launching, /owner cancelled/u)
  void launching.finally(() => { settled = true }).catch(() => {})
  try {
    await entered.promise; controller.abort(new Error('owner cancelled')); await delay(40)
    assert.equal(wireSignal.aborted, false, 'Caller cancellation must not abandon an already-issued side effect')
    assert.equal(settled, false)
    reply.resolve(); await cancelled; assert.equal(calls, 1)
  } finally { reply.resolve(); await Promise.allSettled([launching]); await driver.dispose() }
})

test('launch transport failure fences every later input on that physical surface without replay', async () => {
  const f = await nativeFixture({ exits: true }), scheduler = new ComputerInputScheduler(), calls = [], a = new ScheduledComputerDriver(f.driver, 'same', scheduler), b = new ScheduledComputerDriver(inner(calls), 'same', scheduler), other = new ScheduledComputerDriver(inner(), 'different', scheduler)
  try {
    await assert.rejects(a.launchApplication('own.app'), { code: 'APPLICATION_LAUNCH_UNCONFIRMED' })
    await b.lease(1)
    await assert.rejects(b.act(1, target.id, { kind: 'move', x: 1, y: 1 }), { code: 'APPLICATION_LAUNCH_UNCONFIRMED' })
    assert.equal(calls.some(row => ['lease', 'act'].includes(row[0])), false)
    await other.lease(1); await other.act(1, target.id, { kind: 'move', x: 1, y: 1 })
    assert.equal((await f.rows()).filter(row => row.op === 'launchApplication').length, 1)
  } finally { await Promise.all([a.dispose(), b.dispose(), other.dispose()]) }
})

test('only an explicit owner reconnect with a fresh retired-and-replaced driver reopens an unknown launch surface', async () => {
  let now = 0, first = true; const devices = new Map(), count = new Map()
  const manager = new ComputerEnvironmentManager({ now: () => now, idleMs: 100, createRouter(id, scheduler) {
    const calls = [], local = inner(calls); devices.set(id, { local, calls }); count.set(id, (count.get(id) ?? 0) + 1)
    local.launchApplication = async () => { if (first) { first = false; throw Object.assign(Error('Unknown synthetic transport'), { code: 'APPLICATION_LAUNCH_UNCONFIRMED' }) }; return { launched: true } }
    return new ComputerDriverRouter({ local: new ScheduledComputerDriver(local, 'same', scheduler) })
  } })
  try {
    await assert.rejects(manager.launchApplicationFor('A', 'own.app'), { code: 'APPLICATION_LAUNCH_UNCONFIRMED' })
    now = 200; await manager.sweep()
    await manager.authorizationStatus('B') // automatic discovery/new identity is not owner consent
    await manager.start('B', target.id, { allowOnce: true }); let frame = await manager.observe('B')
    await assert.rejects(manager.act('B', { actionId: 'blocked', frameId: frame.frameId, action: { kind: 'move', x: 1, y: 1 } }), { code: 'APPLICATION_LAUNCH_UNCONFIRMED' })
    await manager.connect('B', { mode: 'local' })
    await manager.start('B', target.id, { allowOnce: true }); frame = await manager.observe('B')
    await manager.act('B', { actionId: 'fresh', frameId: frame.frameId, action: { kind: 'move', x: 1, y: 1 } })
    assert.ok(count.get('B') >= 2)
    assert.equal(devices.get('B').calls.filter(row => row[0] === 'act').length, 1)
  } finally { await manager.dispose() }
})


test('pre-dispatch cancellation still skips a queued native application launch completely', async () => {
  const scheduler = new ComputerInputScheduler(), entered = deferred(), gate = deferred(), calls = [], blocker = inner(), cancelled = new AbortController()
  blocker.act = async () => { entered.resolve(); await gate.promise; return {} }
  const a = new ScheduledComputerDriver(blocker, 'same', scheduler), f = await nativeFixture(), b = new ScheduledComputerDriver(f.driver, 'same', scheduler)
  let acting, launching
  try {
    await a.lease(1); acting = a.act(1, target.id, { kind: 'move', x: 1, y: 1 }); await entered.promise
    launching = b.launchApplication('own.app', cancelled.signal); const rejected = assert.rejects(launching, /cancelled before dispatch/u)
    cancelled.abort(new Error('cancelled before dispatch')); await rejected
    gate.resolve(); await acting
    assert.equal((await f.rows()).some(row => row.op === 'launchApplication'), false)
  } finally { gate.resolve(); await Promise.allSettled([acting, launching]); await Promise.all([a.dispose(), b.dispose()]) }
})

test('an acknowledged native launch rejection does not poison a healthy input surface', async () => {
  const f = await nativeFixture({ rejects: true }), scheduler = new ComputerInputScheduler(), a = new ScheduledComputerDriver(f.driver, 'same', scheduler), calls = [], b = new ScheduledComputerDriver(inner(calls), 'same', scheduler)
  try {
    const launching = a.launchApplication('own.app'), rejected = assert.rejects(launching, { code: 'APPLICATION_LAUNCH_FAILED' })
    await f.entered(); await f.finish(); await rejected
    await b.lease(1); await b.act(1, target.id, { kind: 'move', x: 1, y: 1 })
    assert.equal(calls.filter(row => row[0] === 'act').length, 1)
  } finally { await f.finish(); await Promise.all([a.dispose(), b.dispose()]) }
})

test('issued native launch timeout is an uncertain outcome even when EOF retires the fake worker cleanly', async () => {
  const f = await nativeFixture(), scheduler = new ComputerInputScheduler(), a = new ScheduledComputerDriver(f.driver, 'same', scheduler), calls = [], b = new ScheduledComputerDriver(inner(calls), 'same', scheduler)
  try {
    await f.driver.status(); f.options.timeoutMs = 100
    await assert.rejects(a.launchApplication('own.app'), { code: 'APPLICATION_LAUNCH_UNCONFIRMED' })
    await a.dispose(); await b.lease(1)
    await assert.rejects(b.act(1, target.id, { kind: 'move', x: 1, y: 1 }), { code: 'APPLICATION_LAUNCH_UNCONFIRMED' })
    assert.equal(calls.some(row => row[0] === 'act'), false, 'Natural worker exit is not an owner reconnect')
  } finally { await Promise.all([a.dispose(), b.dispose()]) }
})

test('owner reconnect cannot resurrect work already queued before an uncertain-launch fence', async () => {
  const scheduler = new ComputerInputScheduler(), owner = {}, entered = deferred(), gate = deferred(), signal = new AbortController().signal
  scheduler.register(owner); let inputs = 0
  const active = scheduler.run('same', signal, async () => {
    entered.resolve(); await gate.promise; scheduler.launchUnconfirmed('same', owner); scheduler.retired(owner)
    const fresh = {}; scheduler.register(fresh); scheduler.acknowledgeOwnerReconnect('same', fresh)
  })
  await entered.promise
  const queued = scheduler.run('same', signal, async () => { inputs++ }), rejected = assert.rejects(queued, { code: 'APPLICATION_LAUNCH_UNCONFIRMED' })
  gate.resolve(); await active; await rejected; assert.equal(inputs, 0)
  await scheduler.run('same', signal, async () => { inputs++ }); assert.equal(inputs, 1)
})

test('failed retirement and unavailable replacement cannot clear uncertainty; a later explicit fresh reconnect can', async () => {
  let canRetire = false, available = true, launches = 0, created = 0
  const manager = new ComputerEnvironmentManager({ createRouter(_id, scheduler) {
    created++; const local = inner(); local.status = async () => ({ available })
    local.launchApplication = async () => { launches++; throw Object.assign(Error('Synthetic transport loss'), { code: 'APPLICATION_LAUNCH_UNCONFIRMED' }) }
    local.dispose = async () => { if (!canRetire) throw Error('Synthetic retirement not acknowledged') }
    return new ComputerDriverRouter({ local: new ScheduledComputerDriver(local, 'same', scheduler) })
  } })
  try {
    await assert.rejects(manager.launchApplicationFor('A', 'own.app'), { code: 'APPLICATION_LAUNCH_UNCONFIRMED' })
    await assert.rejects(manager.connect('A', { mode: 'local' })); assert.equal(created, 1)
    canRetire = true; available = false
    await assert.rejects(manager.connect('A', { mode: 'local' }), { code: 'APPLICATION_LAUNCH_UNCONFIRMED' }); assert.equal(created, 2)
    available = true; await manager.connect('A', { mode: 'local' }); assert.equal(created, 3)
    await manager.start('A', target.id, { allowOnce: true }); const frame = await manager.observe('A')
    await manager.act('A', { actionId: 'new', frameId: frame.frameId, action: { kind: 'move', x: 1, y: 1 } })
    assert.equal(launches, 1, 'Recovery never replays the uncertain application launch')
  } finally { canRetire = true; await manager.dispose() }
})
