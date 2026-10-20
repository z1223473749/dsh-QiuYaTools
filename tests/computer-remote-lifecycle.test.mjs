import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { setTimeout as delay } from 'node:timers/promises'

const output = (await build({ entryPoints: [fileURLToPath(new URL('../src/features/computer-use/remote.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })).outputFiles[0].text
const { RemoteComputerDriver } = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`)
const token = 'test-pair-token-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const reply = request => Response.json({ version: 1, requestId: request.requestId, ok: true, result: {} })
function remote(handle, extra = {}) { return new RemoteComputerDriver({ endpoint: 'http://127.0.0.1:1', token, heartbeatMs: 10_000, fetch: async (_url, options) => handle(JSON.parse(options.body), options), ...extra }) }

test('failed release remains owned and dispose retries the actual epoch instead of acknowledging cleanup', async () => {
  let fail = true; const releases = []
  const driver = remote(async input => { if (input.op === 'release') { releases.push(input.payload.epoch); if (fail) throw new Error('offline cleanup') }; return reply(input) })
  await driver.lease(9)
  await assert.rejects(driver.release(9), /offline cleanup/)
  await assert.rejects(driver.dispose(), /offline cleanup/)
  fail = false; await driver.dispose()
  assert.deepEqual(releases, [9, 9, 9])
  await assert.rejects(driver.lease(10), { code: 'DISPOSED' })
})

test('uncertain acquisition is released even when the HTTP lease response was lost', async () => {
  const releases = []
  const driver = remote(async input => { if (input.op === 'lease') throw new Error('response lost'); if (input.op === 'release') releases.push(input.payload.epoch); return reply(input) })
  await assert.rejects(driver.lease(17), /response lost/)
  await driver.dispose(); assert.deepEqual(releases, [17])
})

test('a failed heartbeat from an older lease cannot disconnect a newer lease', async () => {
  const pending = deferred(), entered = deferred(), events = [], releases = []; let newHeartbeat = false
  const driver = remote(async input => {
    if (input.op === 'heartbeat' && input.payload.epoch === 1) { entered.resolve(); return pending.promise }
    if (input.op === 'heartbeat' && input.payload.epoch === 2) newHeartbeat = true
    if (input.op === 'release') releases.push(input.payload.epoch)
    return reply(input)
  }, { heartbeatMs: 5 })
  driver.subscribe(event => events.push(event))
  await driver.lease(1); await entered.promise
  await driver.lease(2); pending.reject(new Error('old heartbeat timeout'))
  const deadline = Date.now() + 500
  while (!newHeartbeat && Date.now() < deadline) await delay(5)
  assert.equal(newHeartbeat, true); assert.deepEqual(events, [])
  await driver.dispose(); assert.deepEqual(releases, [2])
})

test('disposal covers in-flight acquisitions whose fetch implementation replies after cancellation', async () => {
  const pending = deferred(), entered = deferred(), releases = []; let acquisition
  const driver = remote(async input => {
    if (input.op === 'lease') { acquisition = input; entered.resolve(); return pending.promise }
    if (input.op === 'release') releases.push(input.payload.epoch)
    return reply(input)
  })
  const acquiring = driver.lease(23), rejected = assert.rejects(acquiring, { code: 'CONTROL_CHANGED' })
  await entered.promise; await driver.dispose()
  pending.resolve(reply(acquisition)); await rejected
  assert.deepEqual(releases, [23])
})
