import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const source = (await build({ entryPoints: [new URL('../src/features/computer-use/browser.ts', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'esm' })).outputFiles[0].text
const { BrowserSession, BrowserDeviceDriver, browserExecutableCandidates } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

test('browser policies deny privileged origins and nonloopback debugging without starting a process', async () => {
  for (const origin of ['file:///private', 'chrome://settings', 'javascript:alert(1)']) assert.throws(() => new BrowserSession({ allowedOrigins: [origin] }), { code: 'INVALID_ORIGIN' })
  for (const cdpEndpoint of ['http://example.com:9222', 'ws://8.8.8.8/devtools/browser/1', 'http://user:secret@127.0.0.1:9222', 'http://127.0.0.1:9222?secret=token']) assert.throws(() => new BrowserSession({ allowedOrigins: [], cdpEndpoint }), { code: 'UNSAFE_CDP_ENDPOINT' })
  const browser = new BrowserSession({ allowedOrigins: ['https://example.com/page'], profileDir: '/fixture/profile' })
  assert.deepEqual(browser.allowedOrigins(), ['https://example.com'])
  await assert.rejects(browser.open('https://other.example/'), { code: 'SITE_NOT_ALLOWED' })
  await assert.rejects(browser.navigate('tab', 'file:///etc/passwd'), { code: 'SITE_NOT_ALLOWED' })
  browser.setAllowedOrigins([])
  assert.deepEqual(browser.allowedOrigins(), [])
  await browser.close()
})

test('driver targets use allowed origin scope and a browser-specific app identity', async () => {
  const browser = { deviceId: 'browser:test', async list() { return [{ id: 'allowed', url: 'https://example.com/page', title: 'Example', allowed: true }, { id: 'blocked', url: 'https://blocked.example', title: 'Blocked', allowed: false }] }, async metrics() { return { x: 0, y: 0, width: 800, height: 600, scale: 1 } } }
  const targets = await new BrowserDeviceDriver(browser).targets()
  assert.equal(targets.length, 1); assert.equal(targets[0].id, 'allowed'); assert.equal(targets[0].appId, 'browser:test:https://example.com')
})

test('release cancels browser input, rejects old epochs and does not revoke a newer owner lease', async () => {
  let entered, nativeSignal
  const inputStarted = new Promise(resolve => { entered = resolve })
  const browser = { async act(_target, _action, signal, guard) { nativeSignal = signal; guard(); entered(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) }, async close() {} }
  const driver = new BrowserDeviceDriver(browser)
  await driver.lease(10)
  const action = driver.act(10, 'tab', { kind: 'type', text: 'fixture' }), rejected = assert.rejects(action)
  await inputStarted; await driver.release(10); await rejected
  assert.equal(nativeSignal.aborted, true)
  await driver.lease(11); await driver.release(10)
  await assert.rejects(driver.act(10, 'tab', { kind: 'key', key: 'Enter' }), { code: 'CONTROL_CHANGED' })
  await assert.rejects(driver.lease(11), { code: 'STALE_EPOCH' })
  await driver.dispose()
})

test('browser executables have fixed Chrome and Edge candidates on supported systems', () => {
  assert.ok(browserExecutableCandidates('chrome', 'darwin')[0].endsWith('/Google Chrome'))
  assert.ok(browserExecutableCandidates('edge', 'darwin')[0].endsWith('/Microsoft Edge'))
})

test('pause waits for an already issued browser input and its cleanup before acknowledging release', async () => {
  let entered, finish
  const started = new Promise(resolve => { entered = resolve }), nativeReply = new Promise(resolve => { finish = resolve })
  let released = false
  const browser = { async act(_tab, _action, _signal, guard) { guard(); entered(); await nativeReply; return { applied: true } }, invalidateObservations() {}, async close() {} }
  const driver = new BrowserDeviceDriver(browser)
  await driver.lease(1)
  const action = driver.act(1, 'tab', { kind: 'key', key: 'Enter' }), rejected = assert.rejects(action, { code: 'CONTROL_CHANGED' })
  await started
  const stopping = driver.release(1).then(() => { released = true })
  await new Promise(resolve => setImmediate(resolve)); assert.equal(released, false)
  finish(); await rejected; await stopping; assert.equal(released, true)
  await driver.dispose()
})
