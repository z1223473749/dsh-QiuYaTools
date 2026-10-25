import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const source = (await build({ entryPoints: [fileURLToPath(new URL('../src/features/computer-use/browser.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })).outputFiles[0].text
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

function cdpFixture() {
  const state = { failRelease: true, keyHeld: false, mouseHeld: false, releases: 0, downs: 0, disconnected: false }
  const browser = new BrowserSession({ allowedOrigins: ['https://fixture.example'], cdpEndpoint: 'http://127.0.0.1:9222' })
  browser.connection = {
    async send(method, params) {
      if (method === 'Target.getTargetInfo') return { targetInfo: { type: 'page', targetId: 'tab', title: 'Fixture', url: 'https://fixture.example' } }
      if (method === 'Target.attachToTarget') return { sessionId: 'session-tab' }
      if (method === 'Runtime.evaluate') return { result: { value: { x: 40, y: 30, width: 80, height: 60 } } }
      if (method === 'Input.dispatchKeyEvent' && ['rawKeyDown', 'keyDown'].includes(params.type)) { state.keyHeld = true; state.downs++ }
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') { state.mouseHeld = true; state.downs++ }
      if (params.type === 'keyUp' || params.type === 'mouseReleased') {
        state.releases++
        if (state.failRelease) throw new Error('CDP release response lost')
        if (params.type === 'keyUp') state.keyHeld = false; else state.mouseHeld = false
      }
      return {}
    }, async drainCaptures() {}, close() { state.disconnected = true },
  }
  return { browser, state }
}

for (const kind of ['key', 'mouse', 'selectorType']) test(`failed CDP ${kind} release blocks new leases and retains exact cleanup for a retry`, async () => {
  const { browser, state } = cdpFixture(), driver = new BrowserDeviceDriver(browser)
  await driver.lease(1)
  const action = kind === 'key' ? { kind: 'key', key: 'Control+A' } : kind === 'selectorType' ? { kind: 'selectorType', selector: '#input', text: 'fixture' } : { kind: 'selectorClick', selector: '#button' }
  await assert.rejects(driver.act(1, 'tab', action), { code: 'BROWSER_CLEANUP_FAILED' })
  assert.equal(kind === 'key' ? state.keyHeld : state.mouseHeld, true)
  await assert.rejects(driver.release(1), { code: 'BROWSER_CLEANUP_FAILED' })
  await assert.rejects(driver.lease(2), { code: 'BROWSER_CLEANUP_FAILED' })
  assert.equal(state.downs, 1, 'uncertain cleanup must not permit additional input')
  state.failRelease = false; await driver.release(1)
  assert.equal(state.keyHeld, false); assert.equal(state.mouseHeld, false)
  await driver.lease(3)
  await driver.dispose(); assert.equal(state.disconnected, true)
})

test('attached user browser keeps its cleanup channel open when disposal cannot release owned input', async () => {
  const { browser, state } = cdpFixture(), driver = new BrowserDeviceDriver(browser)
  await driver.lease(1)
  await assert.rejects(driver.act(1, 'tab', { kind: 'key', key: 'Enter' }), { code: 'BROWSER_CLEANUP_FAILED' })
  await assert.rejects(driver.dispose(), { code: 'BROWSER_CLEANUP_FAILED' })
  assert.equal(state.disconnected, false, 'closing the CDP connection would discard the only cleanup channel')
  state.failRelease = false; await driver.dispose()
  assert.equal(state.keyHeld, false); assert.equal(state.disconnected, true)
})

test('a cancellation before key-down dispatch does not invent a held key or send a key-up', async () => {
  const { browser, state } = cdpFixture()
  await assert.rejects(browser.act('tab', { kind: 'key', key: 'Enter' }, undefined, () => { throw new Error('lease revoked') }), /lease revoked/)
  assert.equal(state.downs, 0); assert.equal(state.releases, 0)
  await browser.close()
})
