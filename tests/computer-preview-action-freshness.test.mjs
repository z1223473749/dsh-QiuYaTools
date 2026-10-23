import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { build } from 'esbuild'

const source = (await build({ entryPoints: [fileURLToPath(new URL('../src/features/computer-use/host.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })).outputFiles[0].text
const { installComputerHost } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(done => setImmediate(done)) }

// Execute the actual emitted preview page against the actual Host/session.
// Only the OS driver, bitmap decoder and page's polling clock are substitutes.
async function fixture(t) {
  const routes = new Map(), requests = [], inputs = [], timers = new Map(), gates = new Set()
  const target = { id: 'owned-window', appId: 'owned-app', title: 'Owned preview test', pid: 1, x: 0, y: 0, width: 320, height: 180, scale: 1 }
  let frameSequence = 0, timerSequence = 0, nextFrame, nextAction, painted = 0
  const driver = {
    async status() { return { available: true } }, async targets() { return [target] }, async lease() {}, async release() {}, async dispose() {},
    async observe() { return { targetId: target.id, frameId: `frame-${++frameSequence}`, imageBase64: '/9j/2Q==', mediaType: 'image/jpeg', width: 320, height: 180, elements: '', geometry: target } },
    async act(epoch, targetId, action) { inputs.push({ epoch, targetId, action }); if (nextAction) { const gate = nextAction; nextAction = undefined; gate.entered.resolve(); await gate.release.promise } return { performed: true } },
  }
  const host = await installComputerHost({ webServer: { port: 1 }, connection: { browserPeer: { principal: { kind: 'owner' } }, authenticatedUrl: value => value, fetch: { register(route) { routes.set(route.path, route); return async () => routes.delete(route.path) } } } }, () => true, { driver })
  await host.service.start('owned-chat', target.id, { allowOnce: true }); await host.service.takeover('owned-chat')
  const html = await (await routes.get('/api/qiuya-tools.computer.preview').fetch(new Request('http://127.0.0.1/api/qiuya-tools.computer.preview?session=owned-chat'))).text()
  const frames = []
  const dom = new JSDOM(html, { url: 'http://127.0.0.1/api/qiuya-tools.computer.preview?session=owned-chat', runScripts: 'dangerously', beforeParse(window) {
    window.setTimeout = fn => { const id = ++timerSequence; timers.set(id, fn); return id }
    window.clearTimeout = id => timers.delete(id)
    window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() { painted++ } })
    window.HTMLCanvasElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, width: 320, height: 180 })
    window.createImageBitmap = async () => ({ width: 320, height: 180, close() {} })
    window.fetch = async (_url, init) => {
      const envelope = JSON.parse(init.body), input = envelope.payload
      requests.push(input)
      const response = await routes.get('/api/qiuya-tools.computer.control').fetch(new Request('http://127.0.0.1/api/qiuya-tools.computer.control', { method: 'POST', body: init.body }))
      if (input.op === 'frame') {
        const result = (await response.clone().json()).result
        if (result.ok) frames.push(result.value.frameId)
        if (nextFrame) { const gate = nextFrame; nextFrame = undefined; gate.entered.resolve(); await gate.release.promise }
      }
      return response
    }
  } })
  const document = dom.window.document
  await settle()
  assert.equal(document.getElementById('type').disabled, false)
  const hold = kind => { const gate = { entered: deferred(), release: deferred() }; gates.add(gate); if (kind === 'frame') nextFrame = gate; else nextAction = gate; return gate }
  const poll = async () => { const callbacks = [...timers.values()]; timers.clear(); await Promise.all(callbacks.map(fn => fn())); await settle() }
  const clickCanvas = () => { const canvas = document.getElementById('screen'); for (const type of ['mousedown', 'mouseup']) canvas.dispatchEvent(new dom.window.MouseEvent(type, { clientX: 50, clientY: 60, button: 0 })) }
  t.after(async () => { dom.window.dispatchEvent(new dom.window.Event('pagehide')); for (const gate of gates) gate.release.resolve(); await settle(); dom.window.close(); await host.dispose() })
  return { host, document, dom, inputs, requests, frames, hold, poll, clickCanvas, painted: () => painted }
}

test('a frame captured during an outstanding human action cannot resurrect the consumed frame or admit duplicate input', async t => {
  const f = await fixture(t), frameGate = f.hold('frame'), actionGate = f.hold('action')
  const refreshing = f.poll(); await frameGate.entered.promise
  const paintsBeforeAction = f.painted()
  f.clickCanvas(); await actionGate.entered.promise
  assert.equal(f.inputs.length, 1)
  assert.equal(f.document.getElementById('type').disabled, true)
  f.document.getElementById('text').value = '中文接管'
  // Invoke the handler too: correctness must not rely on a disabled button.
  f.document.getElementById('type').onclick()
  f.document.getElementById('enter').onclick()
  assert.equal(f.requests.filter(x => x.op === 'act').length, 1)
  frameGate.release.resolve(); await refreshing
  assert.equal(f.painted(), paintsBeforeAction, 'the pre-action capture must not paint after its generation changed')
  await f.poll()
  assert.equal(f.requests.filter(x => x.op === 'frame').length, 2, 'polling while input is pending does not capture another actionable frame')
  actionGate.release.resolve(); await settle()
  assert.equal(f.document.getElementById('type').disabled, true, 'an ACK alone does not make the consumed frame usable again')
  await f.poll()
  assert.equal(f.document.getElementById('type').disabled, false)
  f.document.getElementById('type').click(); await settle()
  assert.deepEqual(f.inputs.map(x => x.action.kind), ['click', 'type'])
  assert.equal(f.inputs[1].action.text, '中文接管')
  const acts = f.requests.filter(x => x.op === 'act')
  assert.notEqual(acts[0].request.frameId, acts[1].request.frameId)
  assert.equal(acts.length, 2, 'each explicit user action was dispatched once')
})

test('an actual Host stale-frame rejection stays visible across successful preview refreshes and never retries the input', async t => {
  const f = await fixture(t)
  await f.host.service.humanAct('owned-chat', { actionId: 'independent-human-action', frameId: f.frames[0], action: { kind: 'click', x: 10, y: 10 } })
  f.document.getElementById('text').value = '不能自动重复的中文'
  f.document.getElementById('type').click(); await settle()
  const message = f.document.getElementById('message'), error = message.textContent
  assert.ok(error.length > 0); assert.equal(message.hidden, false)
  assert.equal(f.inputs.length, 1, 'stale rejection precedes native input')
  for (let i = 0; i < 2; i++) await f.poll()
  assert.equal(message.textContent, error); assert.equal(message.hidden, false)
  assert.equal(f.requests.filter(x => x.op === 'act').length, 1, 'refresh is not an input retry')
  f.document.getElementById('type').click(); await settle()
  assert.equal(f.inputs.length, 2); assert.equal(f.inputs[1].action.text, '不能自动重复的中文')
  assert.equal(message.hidden, true, 'the next explicit successful action clears its preceding error')
})

test('a late frame from before pause cannot enable text or Enter in the paused epoch', async t => {
  const f = await fixture(t), gate = f.hold('frame'), refreshing = f.poll()
  await gate.entered.promise
  f.document.getElementById('pause').click(); await settle()
  assert.equal(f.host.service.get('owned-chat').state, 'paused')
  gate.release.resolve(); await refreshing; await f.poll()
  assert.equal(f.document.getElementById('type').disabled, true)
  assert.equal(f.document.getElementById('enter').disabled, true)
  f.document.getElementById('type').onclick(); await settle()
  assert.equal(f.requests.filter(x => x.op === 'act').length, 0)
  assert.equal(f.inputs.length, 0)
})
