import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const path = fileURLToPath(new URL('../src/features/computer-use/browser.ts', import.meta.url))
const bundle = (await build({ entryPoints: [path], bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'internal-wire-test-export', setup(builder) { builder.onLoad({ filter: /\/computer-use\/browser\.ts$/ }, async () => {
  let contents = await readFile(path, 'utf8')
  // The red baseline uses the unchanged original dispatch path. This switch
  // exists only in this test transform and is never shipped or model-visible.
  if (process.env.QYT_CAPTURE_TEST_BASELINE === '1') contents = contents.replace("    if (method === 'Page.captureScreenshot' && sessionId) return this.captures.capture<T>(sessionId, params, signal)\n", '')
  if (process.env.QYT_ATTACH_TEST_BASELINE === '1') {
    // Restore the prior per-caller attach body to prove the cross-lifetime
    // admission regression on the same real WebSocket, without changing files.
    const start = contents.indexOf('  private async tabSession('), end = contents.indexOf('  /** Separate flattened session;', start)
    assert(start > 0 && end > start)
    contents = contents.slice(0, start) + `  private async tabSession(tabId: string, signal?: AbortSignal): Promise<string> {
    const lifetime = this.tabLifetime(tabId)
    const old = this.sessions.get(tabId); if (old) return old
    signal?.throwIfAborted()
    const pin = { tabId }; this.tabAttachPins.add(pin)
    try {
      const result = await this.cdp().send('Target.attachToTarget', { targetId: tabId, flatten: true }, undefined, signal)
      const session = requireIdentity(result.sessionId)
      this.sessions.set(tabId, session); this.tabAttachPins.delete(pin)
      this.assertTabLifetime(tabId, lifetime)
      return session
    } catch (error) {
      if (error instanceof ComputerError && error.code === 'BROWSER_CDP_FAILED') this.tabAttachPins.delete(pin)
      throw error
    }
  }
` + contents.slice(end)
  }
  return { contents: contents + '\nexport { CdpConnection, createBrowserAnnotationView }\n', loader: 'ts' }
}) } }] })).outputFiles[0].text
const { CdpConnection, BrowserSession, BrowserDeviceDriver, createBrowserAnnotationView } = await import(`data:text/javascript;base64,${Buffer.from(bundle).toString('base64')}`)
const sessionSource = (await build({ entryPoints: [fileURLToPath(new URL('../src/features/computer-use/session.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })).outputFiles[0].text
const { ComputerSessionService } = await import(`data:text/javascript;base64,${Buffer.from(sessionSource).toString('base64')}`)
const HOLD = Symbol('hold'), params = { format: 'jpeg', quality: 65, fromSurface: true, captureBeyondViewport: false }
// Protocol-only dimensions fixture; actual screenshots/pixels are verified by
// the installed cross-platform acceptance runner, outside this unit suite.
const protocolJpeg = Buffer.from([255, 216, 255, 192, 0, 8, 8, 0, 100, 0, 100, 0, 255, 217]).toString('base64')
function annotationReply(message) {
  if (message.method === 'Target.getTargetInfo') return { targetInfo: { targetId: message.params.targetId, type: 'page', url: 'https://owned.example/' } }
  if (message.method === 'Target.attachToTarget') return { sessionId: `annotation-${message.params.targetId}` }
  if (message.method === 'Target.closeTarget') return { success: true }
  if (message.method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: 'loader', url: 'https://owned.example/' } } }
  if (message.method === 'Page.createIsolatedWorld') return { executionContextId: 1 }
  if (message.method === 'Runtime.evaluate') return { result: { value: message.params.expression.includes('.read()') ? { closed: false, dom: 0, scroll: 0, x: 0, y: 0, width: 100, height: 100, dpr: 1 } : message.params.expression.includes('delete globalThis') ? { closed: true } : { ready: true } } }
  if (message.method === 'DOM.getDocument') return { root: { backendNodeId: 1 } }
  if (message.method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 100, clientHeight: 100 }, cssVisualViewport: { pageX: 0, pageY: 0, offsetX: 0, offsetY: 0, clientWidth: 100, clientHeight: 100, scale: 1 } }
  if (message.method === 'Page.getNavigationHistory') return { currentIndex: 0, entries: [{ id: 1, url: 'https://owned.example/' }] }
  if (message.method === 'Page.captureScreenshot') return { data: protocolJpeg }
}
const turn = () => new Promise(resolve => setImmediate(resolve))
async function fixture(t, handler = () => undefined, timeout = 1000) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }), packets = [], sockets = new Set()
  await once(server, 'listening')
  server.on('connection', socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket))
    socket.on('message', bytes => {
      const message = JSON.parse(bytes.toString())
      Object.defineProperty(message, 'reply', { value(result = {}, error) { if (socket.readyState === 1) socket.send(JSON.stringify({ id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}), ...(error ? { error } : { result }) })) } })
      Object.defineProperty(message, 'emit', { value(event) { if (socket.readyState === 1) socket.send(JSON.stringify(event)) } })
      packets.push(message)
      const result = handler(message)
      if (result !== HOLD) message.reply(result ?? (message.method === 'Page.captureScreenshot' ? { data: `original-jpeg-${message.id}` } : {}))
    })
  })
  const connection = await CdpConnection.open(`ws://127.0.0.1:${server.address().port}`, timeout)
  t.after(async () => { connection.close(); for (const socket of sockets) socket.terminate(); await new Promise(resolve => server.close(resolve)) })
  const count = method => packets.filter(row => row.method === method).length
  const wait = async predicate => { const until = Date.now() + 1500; while (Date.now() < until) { const result = predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 2)) }; assert.fail('The actual loopback CDP packet did not arrive') }
  return { connection, packets, sockets, count, wait, packet: (method, index = 0) => packets.filter(row => row.method === method)[index] }
}

test('same-session transport starts one shared stream, keeps independent original captures and waits for the final stop receipt', async t => {
  const f = await fixture(t, message => ['Page.captureScreenshot', 'Page.stopScreencast'].includes(message.method) ? HOLD : undefined)
  let settled = 0
  const a = f.connection.send('Page.captureScreenshot', params, 'owned-A').then(value => { settled++; return value }), b = f.connection.send('Page.captureScreenshot', params, 'owned-A').then(value => { settled++; return value })
  void a.catch(() => {}); void b.catch(() => {})
  await f.wait(() => f.count('Page.captureScreenshot') === 2)
  assert.equal(f.packets[0].method, 'Page.startScreencast'); assert.equal(f.count('Page.startScreencast'), 1)
  const [one, two] = f.packets.filter(row => row.method === 'Page.captureScreenshot')
  assert.notEqual(one.id, two.id); assert.deepEqual(one.params, params); assert.deepEqual(two.params, params)
  one.reply({ data: 'real-independent-A' }); assert.deepEqual(await a, { data: 'real-independent-A' })
  assert.equal(f.count('Page.stopScreencast'), 0)
  two.reply({ data: 'real-independent-B' }); await f.wait(() => f.count('Page.stopScreencast') === 1)
  assert.equal(settled, 1); f.packet('Page.stopScreencast').reply(); assert.deepEqual(await b, { data: 'real-independent-B' })
  await f.connection.drainCaptures()
})

test('caller cancellation rejects promptly but cannot release the issued screenshot before its original wire ACK', async t => {
  const f = await fixture(t, message => message.method === 'Page.captureScreenshot' ? HOLD : undefined), controller = new AbortController()
  const call = f.connection.send('Page.captureScreenshot', params, 'owned-A', controller.signal), rejected = assert.rejects(call, { name: 'AbortError' })
  await f.wait(() => f.count('Page.captureScreenshot') === 1); controller.abort(); await rejected
  assert.equal(f.count('Page.stopScreencast'), 0)
  let drained = false; const retirement = f.connection.drainCaptures().then(() => { drained = true })
  await turn(); assert.equal(drained, false)
  f.packet('Page.captureScreenshot').reply({ data: 'late-original-reply' }); await retirement
  assert.equal(f.count('Page.captureScreenshot'), 1); assert.equal(f.count('Page.stopScreencast'), 1)
})

test('canceling a shared-start waiter never sends its delayed capture or stops its live sibling', async t => {
  const f = await fixture(t, message => message.method === 'Page.startScreencast' ? HOLD : undefined), controller = new AbortController()
  const a = f.connection.send('Page.captureScreenshot', params, 'owned-A', controller.signal), rejected = assert.rejects(a, { name: 'AbortError' }), b = f.connection.send('Page.captureScreenshot', params, 'owned-A')
  await f.wait(() => f.count('Page.startScreencast') === 1); controller.abort(); await rejected
  assert.equal(f.count('Page.captureScreenshot'), 0); assert.equal(f.count('Page.stopScreencast'), 0)
  f.packet('Page.startScreencast').reply(); await b; await f.connection.drainCaptures()
  assert.equal(f.count('Page.captureScreenshot'), 1); assert.equal(f.count('Page.stopScreencast'), 1)
})

test('a canceled waiter behind an in-progress stop cannot later start a stream or issue a screenshot', async t => {
  const f = await fixture(t, message => message.method === 'Page.stopScreencast' ? HOLD : undefined)
  const a = f.connection.send('Page.captureScreenshot', params, 'owned-A'); await f.wait(() => f.count('Page.stopScreencast') === 1)
  const controller = new AbortController(), b = f.connection.send('Page.captureScreenshot', params, 'owned-A', controller.signal), rejected = assert.rejects(b, { name: 'AbortError' })
  controller.abort(); await rejected; f.packet('Page.stopScreencast').reply(); await a; await f.connection.drainCaptures()
  assert.equal(f.count('Page.startScreencast'), 1); assert.equal(f.count('Page.captureScreenshot'), 1)
})

test('exact-session ACKs contain only the frame token and stop completion still drains issued ACK receipts', async t => {
  const f = await fixture(t, message => {
    if (message.method === 'Page.startScreencast') {
      message.emit({ method: 'Page.screencastFrame', sessionId: 'foreign-session', params: { sessionId: 7, data: 'PRIVATE-NOT-AN-IMAGE-SOURCE' } })
      message.emit({ method: 'Page.screencastFrame', sessionId: message.sessionId, params: { sessionId: 8, data: 'PRIVATE-NOT-AN-IMAGE-SOURCE' } })
    }
    if (message.method === 'Page.screencastFrameAck') return HOLD
  })
  let complete = false
  const call = f.connection.send('Page.captureScreenshot', params, 'owned-A').then(value => { complete = true; return value })
  await f.wait(() => f.count('Page.stopScreencast') === 1); await turn(); assert.equal(complete, false)
  assert.equal(f.count('Page.screencastFrameAck'), 1); assert.deepEqual(f.packet('Page.screencastFrameAck').params, { sessionId: 8 }); assert.equal(f.packet('Page.screencastFrameAck').sessionId, 'owned-A')
  assert.equal(JSON.stringify(f.packets).includes('PRIVATE'), false)
  f.packet('Page.screencastFrameAck').reply(); assert.match((await call).data, /^original-jpeg-/u); await f.connection.drainCaptures()
})

test('stream stop failure rejects capture and blocks uncertain reuse while the exact input release channel stays alive', async t => {
  const f = await fixture(t, message => { if (message.method === 'Page.stopScreencast') { message.reply(undefined, { message: 'fixture stop refused' }); return HOLD } })
  await assert.rejects(f.connection.send('Page.captureScreenshot', params, 'owned-A'), { code: 'BROWSER_CLEANUP_FAILED' })
  const previous = f.packets.length
  await assert.rejects(f.connection.send('Page.captureScreenshot', params, 'owned-A'), { code: 'BROWSER_CLEANUP_FAILED' }); assert.equal(f.packets.length, previous)
  await f.connection.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control' }, 'owned-A')
  assert.equal(f.count('Input.dispatchKeyEvent'), 1); assert.equal(f.sockets.size, 1)
  await assert.rejects(f.connection.drainCaptures(), { code: 'BROWSER_CLEANUP_FAILED' })
})

test('a missing ACK stays failed and quarantined even after a successful stop', async t => {
  const f = await fixture(t, message => {
    if (message.method === 'Page.startScreencast') message.emit({ method: 'Page.screencastFrame', sessionId: message.sessionId, params: { sessionId: 1 } })
    if (message.method === 'Page.screencastFrameAck') return HOLD
  }, 60)
  await assert.rejects(f.connection.send('Page.captureScreenshot', params, 'owned-A'))
  assert.equal(f.count('Page.stopScreencast'), 1); await assert.rejects(f.connection.drainCaptures(), { code: 'BROWSER_CLEANUP_FAILED' })
  await f.connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', x: 0, y: 0 }, 'owned-A')
  assert.equal(f.sockets.size, 1)
})

for (const failure of ['cdp-error', 'timeout']) test(`an original screenshot ${failure} is never replayed or returned, but confirmed stream cleanup does not permanently occupy its slot`, async t => {
  let attempts = 0
  const f = await fixture(t, message => {
    if (message.method === 'Page.captureScreenshot' && ++attempts === 1) { if (failure === 'cdp-error') message.reply(undefined, { message: 'fixture screenshot failed' }); return HOLD }
  }, 60)
  await assert.rejects(f.connection.send('Page.captureScreenshot', params, 'owned-A'), { code: failure === 'cdp-error' ? 'BROWSER_CDP_FAILED' : 'BROWSER_TIMEOUT' })
  assert.equal(f.count('Page.captureScreenshot'), 1, 'The failed original is never retried')
  assert.equal(f.count('Page.stopScreencast'), 1)
  const newer = await f.connection.send('Page.captureScreenshot', params, 'owned-A'); assert.match(newer.data, /^original-jpeg-/u)
  if (failure === 'timeout') f.packet('Page.captureScreenshot', 0).reply({ data: 'late-failed-first-image' })
  assert.notEqual(newer.data, 'late-failed-first-image'); assert.equal(f.count('Page.captureScreenshot'), 2)
  await f.connection.drainCaptures()
})

for (const failure of ['cdp-error', 'timeout']) test(`a stream start ${failure} keeps the call failed, but a confirmed stop lets its external BrowserSession close normally`, async t => {
  const f = await fixture(t, message => {
    if (message.method === 'Page.startScreencast') { if (failure === 'cdp-error') message.reply(undefined, { message: 'fixture start refused' }); return HOLD }
  }, 60)
  const owner = new BrowserSession({ allowedOrigins: [] }); owner.connection = f.connection
  await assert.rejects(f.connection.send('Page.captureScreenshot', params, 'owned-A'), { code: failure === 'cdp-error' ? 'BROWSER_CDP_FAILED' : 'BROWSER_TIMEOUT' })
  assert.equal(f.count('Page.captureScreenshot'), 0, 'An unconfirmed or rejected start never dispatches the original screenshot')
  assert.equal(f.count('Page.startScreencast'), 1); assert.equal(f.count('Page.stopScreencast'), 1)
  await owner.close()
  await assert.rejects(f.connection.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control' }, 'owned-A'), { code: 'BROWSER_DISCONNECTED' })
})

test('a negative frame ACK fails its original call but confirmed stream stop releases the slot without replay', async t => {
  let starts = 0
  const f = await fixture(t, message => {
    if (message.method === 'Page.startScreencast' && ++starts === 1) message.emit({ method: 'Page.screencastFrame', sessionId: message.sessionId, params: { sessionId: 9 } })
    if (message.method === 'Page.screencastFrameAck') { message.reply(undefined, { message: 'fixture ACK refused' }); return HOLD }
  })
  await assert.rejects(f.connection.send('Page.captureScreenshot', params, 'owned-A'), { code: 'BROWSER_CDP_FAILED' })
  const firstShots = f.count('Page.captureScreenshot'); assert(firstShots <= 1); assert.equal(f.count('Page.stopScreencast'), 1)
  assert.match((await f.connection.send('Page.captureScreenshot', params, 'owned-A')).data, /^original-jpeg-/u)
  assert.equal(f.count('Page.startScreencast'), 2); assert.equal(f.count('Page.captureScreenshot'), firstShots + 1)
  await f.connection.drainCaptures()
})

test('a frame burst cannot exceed eight pending ACKs and is failed instead of returning an image', async t => {
  const f = await fixture(t, message => {
    if (message.method === 'Page.startScreencast') for (let frame = 0; frame < 9; frame++) message.emit({ method: 'Page.screencastFrame', sessionId: message.sessionId, params: { sessionId: frame } })
    if (message.method === 'Page.screencastFrameAck') return HOLD
  })
  const call = f.connection.send('Page.captureScreenshot', params, 'owned-A'), rejected = assert.rejects(call, { code: 'BROWSER_CDP_FAILED' })
  await f.wait(() => f.count('Page.stopScreencast') === 1)
  assert.equal(f.count('Page.screencastFrameAck'), 8)
  for (const packet of f.packets.filter(row => row.method === 'Page.screencastFrameAck')) packet.reply()
  await rejected; await f.connection.drainCaptures()
})

test('annotation detach drains its exact issued screenshot while another session keeps its own stream', async t => {
  const f = await fixture(t, message => message.method === 'Page.captureScreenshot' ? HOLD : undefined), controller = new AbortController()
  const a = f.connection.send('Page.captureScreenshot', params, 'annotation-A', controller.signal), rejected = assert.rejects(a, { name: 'AbortError' }), b = f.connection.send('Page.captureScreenshot', params, 'other-task')
  await f.wait(() => f.count('Page.captureScreenshot') === 2); controller.abort(); await rejected
  const detaching = f.connection.send('Target.detachFromTarget', { sessionId: 'annotation-A' })
  await turn(); assert.equal(f.count('Target.detachFromTarget'), 0)
  f.packets.find(row => row.method === 'Page.captureScreenshot' && row.sessionId === 'annotation-A').reply({ data: 'annotation-late-original' }); await detaching
  assert.equal(f.count('Target.detachFromTarget'), 1)
  assert.deepEqual(f.packets.filter(row => row.method === 'Page.stopScreencast').map(row => row.sessionId), ['annotation-A'])
  f.packets.find(row => row.method === 'Page.captureScreenshot' && row.sessionId === 'other-task').reply({ data: 'different-task-original' }); assert.deepEqual(await b, { data: 'different-task-original' })
  await f.connection.drainCaptures()
})

test('the actual annotation snapshot entry also acquires and retires the exact tiny stream around its unmodified original screenshot', async t => {
  // Only transport/lifecycle is under test here. The existing annotation source
  // suite executes its real watcher in isolated DOM realms; this finite CDP
  // fixture provides protocol geometry and JPEG dimensions, not visual proof.
  const f = await fixture(t, annotationReply)
  const signal = new AbortController().signal, view = await createBrowserAnnotationView({ cdp: f.connection, sessionId: 'annotation-own', tabId: 'own-tab', signal, guard() {}, assertConnection() {}, async permission() {}, onClosed() {}, runtimeRetired: () => false })
  const snapshot = await view.snapshot(signal, () => {})
  assert.equal(snapshot.observation.imageBase64, protocolJpeg); assert.equal(snapshot.observation.targetId, 'own-tab')
  assert.deepEqual(f.packets.filter(row => ['Page.startScreencast', 'Page.captureScreenshot', 'Page.stopScreencast'].includes(row.method)).map(row => ({ method: row.method, sessionId: row.sessionId })), [
    { method: 'Page.startScreencast', sessionId: 'annotation-own' }, { method: 'Page.captureScreenshot', sessionId: 'annotation-own' }, { method: 'Page.stopScreencast', sessionId: 'annotation-own' },
  ])
  assert.deepEqual(f.packet('Page.captureScreenshot').params, params)
  await view.close(); assert.equal(f.count('Target.detachFromTarget'), 1); assert.equal(f.packets.some(row => row.method.startsWith('Input.')), false)
  await f.connection.drainCaptures()
})

test('closing an owned target retires only that target annotation and drains its original physical screenshot before destroying the target', async t => {
  const f = await fixture(t, message => message.method === 'Page.captureScreenshot' ? HOLD : annotationReply(message))
  const owner = new BrowserSession({ allowedOrigins: ['https://owned.example'] }); owner.connection = f.connection
  owner.sessions.set('tab-A', 'primary-A'); owner.ownedTabs.add('tab-A')
  const signal = new AbortController().signal, a = await owner.annotationView('tab-A', 'https://owned.example', signal, () => {}), b = await owner.annotationView('tab-B', 'https://owned.example', signal, () => {})
  const shotA = a.snapshot(signal, () => {}), shotB = b.snapshot(signal, () => {}); void shotA.catch(() => {}); void shotB.catch(() => {})
  await f.wait(() => f.count('Page.captureScreenshot') === 2)
  const closing = owner.closeOwnedTab('tab-A'); void closing.catch(() => {})
  await turn(); assert.equal(f.count('Target.closeTarget'), 0); assert.equal(f.count('Page.stopScreencast'), 0)
  const rejected = assert.rejects(shotA, { name: 'AbortError' })
  await assert.rejects(owner.annotationView('tab-A', 'https://owned.example', signal, () => {}), { code: 'CONTROL_CHANGED' })
  const attachments = f.count('Target.attachToTarget'); assert.equal(attachments, 2)
  f.packets.find(row => row.method === 'Page.captureScreenshot' && row.sessionId === 'annotation-tab-A').reply({ data: protocolJpeg })
  await rejected; await closing
  assert.deepEqual(f.packets.filter(row => row.method === 'Target.closeTarget').map(row => row.params.targetId), ['tab-A'])
  assert.deepEqual(f.packets.filter(row => row.method === 'Target.detachFromTarget').map(row => row.params.sessionId), ['annotation-tab-A'])
  assert.deepEqual(f.packets.filter(row => row.method === 'Page.stopScreencast').map(row => row.sessionId), ['annotation-tab-A'])
  f.packets.find(row => row.method === 'Page.captureScreenshot' && row.sessionId === 'annotation-tab-B').reply({ data: protocolJpeg })
  assert.equal((await shotB).observation.targetId, 'tab-B'); await owner.close()
})

test('an unknown annotation attach pin blocks owned-target destruction instead of silently ignoring that resource', async t => {
  const f = await fixture(t, message => message.method === 'Target.attachToTarget' ? HOLD : annotationReply(message))
  const owner = new BrowserSession({ allowedOrigins: ['https://owned.example'] }); owner.connection = f.connection; owner.ownedTabs.add('owned-tab')
  const signal = new AbortController().signal, opening = owner.annotationView('owned-tab', 'https://owned.example', signal, () => {}), rejected = assert.rejects(opening, { code: 'CONTROL_CHANGED' })
  await f.wait(() => f.count('Target.attachToTarget') === 1)
  await assert.rejects(owner.closeOwnedTab('owned-tab'), { code: 'ANNOTATION_CLEANUP_UNCONFIRMED' })
  assert.equal(f.count('Target.closeTarget'), 0)
  f.packet('Target.attachToTarget').reply({ sessionId: 'annotation-owned-tab' }); await rejected
  assert.equal(f.count('Target.detachFromTarget'), 1)
  await owner.closeOwnedTab('owned-tab'); assert.equal(f.count('Target.closeTarget'), 1); await owner.close()
})

test('a primary preview cannot enter while its exact target annotation is retiring', async t => {
  const f = await fixture(t, message => message.method === 'Page.captureScreenshot' ? HOLD : annotationReply(message))
  const owner = new BrowserSession({ allowedOrigins: ['https://owned.example'] }); owner.connection = f.connection; owner.ownedTabs.add('tab-A')
  const signal = new AbortController().signal, view = await owner.annotationView('tab-A', 'https://owned.example', signal, () => {})
  const screenshot = view.snapshot(signal, () => {}), rejected = assert.rejects(screenshot, { name: 'AbortError' })
  await f.wait(() => f.count('Page.captureScreenshot') === 1)
  const closing = owner.closeOwnedTab('tab-A'); await turn()
  await assert.rejects(owner.preview('tab-A'), { code: 'CONTROL_CHANGED' })
  assert.equal(f.count('Target.attachToTarget'), 1); assert.equal(f.count('Target.closeTarget'), 0)
  f.packet('Page.captureScreenshot').reply({ data: protocolJpeg }); await rejected; await closing
  assert.equal(f.count('Page.captureScreenshot'), 1); assert.equal(f.count('Target.closeTarget'), 1); await owner.close()
})

test('an already-issued primary attach keeps target destruction blocked and its late receipt cannot continue the stale preview', async t => {
  const f = await fixture(t, message => message.method === 'Target.attachToTarget' ? HOLD : annotationReply(message))
  const owner = new BrowserSession({ allowedOrigins: ['https://owned.example'] }); owner.connection = f.connection; owner.ownedTabs.add('tab-A')
  const screenshot = owner.preview('tab-A'), rejected = assert.rejects(screenshot, { code: 'CONTROL_CHANGED' })
  void rejected.catch(() => {})
  await f.wait(() => f.count('Target.attachToTarget') === 1)
  await assert.rejects(owner.closeOwnedTab('tab-A'), { code: 'BROWSER_CLEANUP_FAILED' }); assert.equal(f.count('Target.closeTarget'), 0)
  await assert.rejects(owner.preview('tab-A'), { code: 'BROWSER_CLEANUP_FAILED' })
  assert.equal(f.count('Target.attachToTarget'), 1, 'A new lifetime cannot issue a second attach whose ACK could be overwritten by the older pin')
  f.packet('Target.attachToTarget').reply({ sessionId: 'primary-A' }); await rejected
  assert.equal(f.count('Page.startScreencast'), 0); assert.equal(f.count('Page.captureScreenshot'), 0)
  await owner.closeOwnedTab('tab-A'); assert.equal(f.count('Target.closeTarget'), 1); await owner.close()
})

test('same-lifetime cold previews share one physical attach and canceling its first caller preserves its sibling receipt', async t => {
  const f = await fixture(t, message => message.method === 'Target.attachToTarget' ? HOLD : annotationReply(message))
  const owner = new BrowserSession({ allowedOrigins: ['https://owned.example'] }); owner.connection = f.connection
  const controller = new AbortController(), first = owner.preview('tab-A', controller.signal), rejected = assert.rejects(first, { name: 'AbortError' })
  await f.wait(() => f.count('Target.attachToTarget') === 1)
  const second = owner.preview('tab-A'); await f.wait(() => f.count('Target.getTargetInfo') >= 2); await turn()
  controller.abort(); await rejected; assert.equal(f.count('Target.attachToTarget'), 1)
  f.packet('Target.attachToTarget').reply({ sessionId: 'one-primary-session' })
  const observation = await second; assert.equal(observation.targetId, 'tab-A'); assert.equal(observation.imageBase64, protocolJpeg)
  assert.equal(f.count('Target.attachToTarget'), 1); assert.equal(f.count('Page.captureScreenshot'), 1); await owner.close()
})

test('a permission read completed after target retirement cannot attach or capture a newly stale primary session', async t => {
  const f = await fixture(t, message => message.method === 'Target.getTargetInfo' ? HOLD : annotationReply(message))
  const owner = new BrowserSession({ allowedOrigins: ['https://owned.example'] }); owner.connection = f.connection; owner.ownedTabs.add('tab-A')
  const screenshot = owner.preview('tab-A'), rejected = assert.rejects(screenshot, { code: 'CONTROL_CHANGED' })
  await f.wait(() => f.count('Target.getTargetInfo') === 1)
  await owner.closeOwnedTab('tab-A'); assert.equal(f.count('Target.closeTarget'), 1)
  f.packet('Target.getTargetInfo').reply({ targetInfo: { targetId: 'tab-A', type: 'page', url: 'https://owned.example/' } }); await rejected
  assert.equal(f.count('Target.attachToTarget'), 0); assert.equal(f.count('Page.captureScreenshot'), 0); await owner.close()
})

test('closing an owned tab cannot destroy the exact session before its issued screenshot and stop receipts finish', async t => {
  const f = await fixture(t, message => {
    if (['Page.captureScreenshot', 'Page.stopScreencast'].includes(message.method)) return HOLD
    if (message.method === 'Target.closeTarget') return { success: true }
  })
  const owner = new BrowserSession({ allowedOrigins: [] }); owner.connection = f.connection; owner.sessions.set('owned-tab', 'owned-A'); owner.ownedTabs.add('owned-tab')
  const captured = f.connection.send('Page.captureScreenshot', params, 'owned-A'); void captured.catch(() => {})
  await f.wait(() => f.count('Page.captureScreenshot') === 1)
  const closing = owner.closeOwnedTab('owned-tab'); void closing.catch(() => {})
  await turn(); assert.equal(f.count('Target.closeTarget'), 0)
  f.packet('Page.captureScreenshot').reply({ data: 'original-before-target-close' })
  await f.wait(() => f.count('Page.stopScreencast') === 1); assert.equal(f.count('Target.closeTarget'), 0)
  f.packet('Page.stopScreencast').reply(); assert.deepEqual(await captured, { data: 'original-before-target-close' }); await closing
  assert.equal(f.count('Target.closeTarget'), 1); await owner.close()
})

test('canceling a tab close during its read drain never dispatches a delayed target close', async t => {
  const f = await fixture(t, message => {
    if (message.method === 'Page.captureScreenshot') return HOLD
    if (message.method === 'Target.getTargetInfo') return { targetInfo: { targetId: 'owned-tab', type: 'page', url: 'https://owned.example/' } }
    if (message.method === 'Target.closeTarget') return { success: true }
  })
  const owner = new BrowserSession({ allowedOrigins: ['https://owned.example'] }); owner.connection = f.connection; owner.sessions.set('owned-tab', 'owned-A')
  const captured = f.connection.send('Page.captureScreenshot', params, 'owned-A'), controller = new AbortController()
  await f.wait(() => f.count('Page.captureScreenshot') === 1)
  const closing = owner.closeTab('owned-tab', controller.signal), rejected = assert.rejects(closing, { name: 'AbortError' })
  await f.wait(() => f.count('Target.getTargetInfo') === 1); await turn(); controller.abort()
  f.packet('Page.captureScreenshot').reply({ data: 'original-before-aborted-close' }); await captured; await rejected
  assert.equal(f.count('Target.closeTarget'), 0); assert.equal(f.count('Page.stopScreencast'), 1); await owner.close()
})

for (const change of ['site-revoked', 'target-navigated', 'owner-changed']) test(`a normal tab close rechecks ${change} after the exact read drain and never dispatches to the stale target`, async t => {
  let url = 'https://owned.example/', current = true
  const f = await fixture(t, message => {
    if (message.method === 'Page.captureScreenshot') return HOLD
    if (message.method === 'Target.getTargetInfo') return { targetInfo: { targetId: 'owned-tab', type: 'page', url } }
    if (message.method === 'Target.closeTarget') return { success: true }
  })
  const owner = new BrowserSession({ allowedOrigins: ['https://owned.example'] }); owner.connection = f.connection; owner.sessions.set('owned-tab', 'owned-A')
  const capture = f.connection.send('Page.captureScreenshot', params, 'owned-A'); await f.wait(() => f.count('Page.captureScreenshot') === 1)
  const closing = owner.closeTab('owned-tab', undefined, () => { if (!current) throw Object.assign(Error('owner retired'), { code: 'CONTROL_CHANGED' }) })
  const rejected = assert.rejects(closing, { code: change === 'owner-changed' ? 'CONTROL_CHANGED' : 'SITE_NOT_ALLOWED' }); void rejected.catch(() => {})
  await f.wait(() => f.count('Target.getTargetInfo') === 1); await turn()
  if (change === 'site-revoked') owner.setAllowedOrigins([])
  else if (change === 'target-navigated') url = 'https://unapproved.example/'
  else current = false
  f.packet('Page.captureScreenshot').reply({ data: 'original-before-authority-change' }); await capture; await rejected
  assert.equal(f.count('Target.closeTarget'), 0); assert.equal(f.count('Page.stopScreencast'), 1); await owner.close()
})

test('external BrowserSession disposal releases exact owned input before it waits for its active read stream', async t => {
  const f = await fixture(t, message => message.method === 'Page.captureScreenshot' ? HOLD : undefined)
  const owner = new BrowserSession({ allowedOrigins: [] }); owner.connection = f.connection
  owner.ownedInput.set(1, { sessionId: 'owned-A', tabId: 'owned-tab', method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: 'Control' } })
  const captured = f.connection.send('Page.captureScreenshot', params, 'owned-A'); await f.wait(() => f.count('Page.captureScreenshot') === 1)
  let closed = false; const closing = owner.close().then(() => { closed = true })
  await f.wait(() => f.count('Input.dispatchKeyEvent') === 1); await turn()
  assert.equal(closed, false); assert.equal(f.count('Page.stopScreencast'), 0)
  f.packet('Page.captureScreenshot').reply({ data: 'original-receipt-before-disposal' }); await captured; await closing
  const methods = f.packets.map(row => row.method); assert(methods.indexOf('Input.dispatchKeyEvent') < methods.indexOf('Page.stopScreencast'))
  assert.equal(owner.ownedInput.size, 0); assert.equal(owner.connection, undefined)
})

test('disconnect and late old replies cannot dispatch cleanup to a replacement connection', async t => {
  const old = await fixture(t, message => message.method === 'Page.captureScreenshot' ? HOLD : undefined)
  const a = old.connection.send('Page.captureScreenshot', params, 'same-text-session'), rejected = assert.rejects(a, { code: 'BROWSER_DISCONNECTED' })
  await old.wait(() => old.count('Page.captureScreenshot') === 1)
  old.connection.close(); await rejected; await old.connection.drainCaptures()
  const next = await fixture(t)
  assert.match((await next.connection.send('Page.captureScreenshot', params, 'same-text-session')).data, /^original-jpeg-/u)
  await next.connection.drainCaptures(); assert.equal(next.count('Page.startScreencast'), 1); assert.equal(next.count('Page.stopScreencast'), 1)
  assert.equal(old.count('Page.stopScreencast'), 0)
})

test('finite capture session slots reject without opening unrelated streams', async t => {
  const f = await fixture(t, message => message.method === 'Page.startScreencast' ? HOLD : undefined)
  const calls = []
  for (let index = 0; index < 16; index++) calls.push(f.connection.send('Page.captureScreenshot', params, 'owned-' + index).catch(error => error))
  await f.wait(() => f.count('Page.startScreencast') === 16)
  await assert.rejects(f.connection.send('Page.captureScreenshot', params, 'seventeenth'), { code: 'BROWSER_QUEUE_FULL' })
  for (const packet of f.packets.filter(row => row.method === 'Page.startScreencast')) packet.reply()
  const values = await Promise.all(calls); assert(values.every(value => typeof value.data === 'string'))
  await f.connection.drainCaptures(); assert.equal(f.count('Page.startScreencast'), 16)
})

test('128 pending original callers share one stream and the 129th cannot issue another command', async t => {
  const f = await fixture(t, message => ['Page.startScreencast', 'Page.captureScreenshot'].includes(message.method) ? HOLD : undefined)
  const calls = Array.from({ length: 128 }, () => f.connection.send('Page.captureScreenshot', params, 'owned-A'))
  for (const call of calls) void call.catch(() => {})
  await f.wait(() => f.count('Page.startScreencast') === 1)
  await assert.rejects(f.connection.send('Page.captureScreenshot', params, 'owned-A'), { code: 'BROWSER_QUEUE_FULL' })
  assert.equal(f.count('Page.startScreencast'), 1); assert.equal(f.count('Page.captureScreenshot'), 0)
  f.packet('Page.startScreencast').reply()
  await f.wait(() => f.count('Page.captureScreenshot') === 128)
  for (const packet of f.packets.filter(row => row.method === 'Page.captureScreenshot')) packet.reply({ data: `independent-original-${packet.id}` })
  const images = await Promise.all(calls); assert.equal(new Set(images.map(value => value.data)).size, 128)
  assert.equal(f.count('Page.stopScreencast'), 1); await f.connection.drainCaptures()
})

test('different compiled BrowserSessions get distinct opaque first frames and a foreign task frame never authorizes service input', async t => {
  const jpeg = Buffer.from([255, 216, 255, 192, 0, 17, 8, 0, 100, 0, 100, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0, 255, 217]).toString('base64')
  const make = () => {
    const session = new BrowserSession({ allowedOrigins: ['https://fixture.example'] })
    const geometry = { x: 0, y: 0, width: 100, height: 100, scale: 1 }
    session.connection = { async send(method) {
      if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: 'same-tab', type: 'page', title: 'Own fixture', url: 'https://fixture.example' } }
      if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'same-tab', type: 'page', title: 'Own fixture', url: 'https://fixture.example' }] }
      if (method === 'Target.attachToTarget') return { sessionId: 'own-session' }
      if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 100, clientHeight: 100 }, cssVisualViewport: { clientWidth: 100, clientHeight: 100, scale: 1 } }
      if (method === 'Accessibility.getFullAXTree') return { nodes: [] }
      if (method === 'Page.captureScreenshot') return { data: jpeg }
      return {}
    }, async drainCaptures() {}, close() {} }
    return { session, service: new ComputerSessionService(new BrowserDeviceDriver(session)), geometry }
  }
  const a = make(), b = make(); t.after(async () => { await a.service.dispose(); await b.service.dispose() })
  await a.service.start('task-A', 'same-tab', { allowOnce: true }); await b.service.start('task-B', 'same-tab', { allowOnce: true })
  const first = await a.service.observe('task-A'), second = await b.service.observe('task-B')
  assert.notEqual(first.frameId, second.frameId)
  assert.throws(() => b.service.act('task-B', { actionId: 'foreign-frame-attempt', frameId: first.frameId, action: { kind: 'move', x: 5, y: 5 } }), { code: 'STALE_OBSERVATION' })
})
