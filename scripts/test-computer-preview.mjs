import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
const reproduceOldPause = process.argv.includes('--stale-pause-repro')
const outputArg = process.argv.indexOf('--output')
const output = resolve(outputArg < 0 ? reproduceOldPause ? 'artifacts/computer-use/preview-stale-pause-repro' : 'artifacts/computer-use/preview-web' : process.argv[outputArg + 1])
await mkdir(output, { recursive: true })
const compiled = await build({ entryPoints: [fileURLToPath(new URL('../src/features/computer-use/host.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })
const { installComputerHost } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
const browser = await chromium.launch({ ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : { channel: 'msedge' }), headless: true })
let host, captureFailure = false, errorReplies = 0, enterOldError, releaseOldError, completeAutoPause
const oldErrorEntered = new Promise(done => { enterOldError = done }), oldErrorRelease = new Promise(done => { releaseOldError = done }), automaticPauseCompleted = new Promise(done => { completeAutoPause = done })
const automaticPauses = []
const routes = new Map(), received = [], actFrames = [], target = { id: 'test-window', appId: 'test-app', title: 'Preview fixture', pid: 1, x: 0, y: 0, width: 320, height: 180, scale: 1 }
const server = createServer(async (req, res) => {
  try {
    const route = routes.get(new URL(req.url, 'http://127.0.0.1').pathname)
    if (!route) { res.writeHead(404).end(); return }
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const input = req.method === 'POST' ? JSON.parse(Buffer.concat(chunks)) : undefined
    if (input?.payload?.op === 'act') actFrames.push(input.payload.request.frameId)
    const response = await route.fetch(new Request(`http://127.0.0.1${req.url}`, { method: req.method, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) }))
    const bytes = Buffer.from(await response.arrayBuffer())
    if (input?.payload?.sessionId === 'preview-race') {
      if (input.payload.op === 'frame' && JSON.parse(bytes).result?.ok === false && ++errorReplies === 5) { enterOldError(); await oldErrorRelease }
      if (input.payload.op === 'pause' && captureFailure) { automaticPauses.push({ expectedEpoch: input.payload.expectedEpoch }); completeAutoPause() }
    }
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(bytes)
  } catch (e) { res.writeHead(500).end(String(e)) }
})
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  const imageBase64 = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 320; c.height = 180; const x = c.getContext('2d'); x.fillStyle = '#174f59'; x.fillRect(0, 0, 320, 180); x.fillStyle = '#fff'; x.font = '20px sans-serif'; x.fillText('Live preview fixture', 35, 90); return c.toDataURL('image/jpeg').split(',')[1] })
  let frame = 0, liveCursor, invalidNext = false
  const driver = { status: async () => ({ available: true }), targets: async () => [target], lease: async epoch => received.push({ op: 'lease', epoch }), release: async epoch => received.push({ op: 'release', epoch }),
    observe: async () => { if (captureFailure) throw new Error('synthetic capture failure'); return ({ targetId: target.id, frameId: String(++frame), imageBase64: invalidNext ? (invalidNext = false, 'aW52YWxpZC1qcGVn') : imageBase64, mediaType: 'image/jpeg', width: 320, height: 180, elements: '', geometry: target, ...(liveCursor ? { aiCursor: { ...liveCursor, actor: 'ai' } } : {}) }) }, act: async (epoch, id, action) => { received.push({ op: 'act', epoch, id, action }); return {} }, openPreview: async () => ({}), closePreview: async () => {}, dispose() {} }
  host = await installComputerHost({ get: name => name === 'sessions' ? { get: () => ({}) } : undefined, webServer: { port: 1 }, connection: { browserPeer: { principal: { kind: 'owner' } }, authenticatedUrl: value => value, fetch: { register(route) { routes.set(route.path, route); return async () => routes.delete(route.path) } } } }, () => true, { driver })
  await host.service.start('preview-test', target.id, { allowOnce: true })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  await page.addInitScript(() => {
    const created = new WeakSet(), closed = new WeakSet(), close = ImageBitmap.prototype.close, decode = window.createImageBitmap.bind(window)
    window.__previewResources = { created: 0, closed: 0, doubleClosed: 0, decodeErrors: 0, frames: [] }
    ImageBitmap.prototype.close = function() { if (created.has(this)) { if (closed.has(this)) window.__previewResources.doubleClosed++; else { closed.add(this); window.__previewResources.closed++ } } return close.call(this) }
    window.createImageBitmap = async (...args) => {
      let bitmap
      try { bitmap = await decode(...args) }
      catch (error) { window.__previewResources.decodeErrors++; if (window.__holdAfterError) { window.__holdAfterError = false; window.__holdNextBitmap = true } throw error }
      created.add(bitmap); window.__previewResources.created++
      if (window.__holdNextBitmap) { window.__holdNextBitmap = false; await new Promise(done => { window.__releaseBitmap = () => { window.__releaseBitmap = undefined; done() } }) }
      return bitmap
    }
    document.addEventListener('qiuya-preview-frame', event => { window.__previewResources.frames.push(event.detail.frameId) })
  })
  await page.goto(`${endpoint}/api/qiuya-tools.computer.preview?session=preview-test`)
  await page.waitForFunction(() => document.querySelector('#screen').width === 320 && window.__previewResources.closed >= 2)
  assert.equal(await page.getByRole('img', { name: '实时电脑画面', exact: true }).count(), 1)
  assert.equal(await page.locator('#screen').evaluate(node => node.tagName), 'CANVAS')
  await page.getByRole('button', { name: '接管', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'humanControl')
  await page.locator('#screen').click({ position: { x: 100, y: 80 } })
  await page.waitForFunction(() => document.querySelector('#message').hidden)
  assert.equal(received.filter(e => e.op === 'act').length, 1)
  const oldGestureActions = actFrames.length, rectangle = await page.locator('#screen').boundingBox()
  await page.mouse.move(rectangle.x + 30, rectangle.y + 30); await page.mouse.down()
  await page.getByRole('button', { name: '暂停', exact: true }).evaluate(button => button.click())
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'paused')
  await page.getByRole('button', { name: '接管', exact: true }).evaluate(button => button.click())
  const takeoverFrameCount = await page.evaluate(() => window.__previewResources.frames.length)
  await page.waitForFunction(count => document.querySelector('#status').textContent === 'humanControl' && window.__previewResources.frames.length > count, takeoverFrameCount)
  await page.mouse.move(rectangle.x + 160, rectangle.y + 100); await page.mouse.up()
  await page.waitForTimeout(100)
  assert.equal(actFrames.length, oldGestureActions, 'Pointer down from before Pause cannot become a drag in a new takeover epoch')
  await page.mouse.move(rectangle.x + 30, rectangle.y + 30); await page.mouse.down()
  await page.mouse.move(rectangle.x + 180, rectangle.y + 110, { steps: 4 }); await page.mouse.up()
  const dragDeadline = Date.now() + 5000
  while (actFrames.length === oldGestureActions && Date.now() < dragDeadline) await new Promise(done => setTimeout(done, 10))
  assert.equal(actFrames.length, oldGestureActions + 1)
  assert.equal(received.filter(event => event.op === 'act').at(-1).action.kind, 'drag', 'A normal same-epoch canvas drag still reaches the driver')

  const cursorAt = position => page.waitForFunction(point => {
    const cursor = document.querySelector('#cursor'), image = document.querySelector('#screen'), stage = document.querySelector('#stage')
    if (!point) return getComputedStyle(cursor).display === 'none'
    const r = image.getBoundingClientRect(), g = stage.getBoundingClientRect()
    return getComputedStyle(cursor).display !== 'none' && Math.abs(parseFloat(cursor.style.left) - (r.left - g.left + point.x * r.width / 320)) < 1 && Math.abs(parseFloat(cursor.style.top) - (r.top - g.top + point.y * r.height / 180)) < 1
  }, position)
  liveCursor = { x: 250, y: 40, visible: true }; await cursorAt(null)
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'ready')
  await cursorAt(liveCursor)
  liveCursor = { x: 260, y: 50, visible: true }; await cursorAt(liveCursor)
  liveCursor.visible = false; await cursorAt(null)
  liveCursor = undefined
  const dragFrame = await host.service.preview('preview-test')
  await host.service.act('preview-test', { actionId: crypto.randomUUID(), frameId: (await host.service.observe('preview-test')).frameId, action: { kind: 'drag', x: 20, y: 20, toX: 240, toY: 130 } })
  await cursorAt({ x: 240, y: 130 })
  assert.equal(await page.locator('#cursor svg path').count(), 1)
  await page.screenshot({ path: join(output, 'ai-arrow-preview.png') })
  await page.getByRole('button', { name: '接管', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'humanControl')
  await cursorAt(null)
  await page.locator('#text').fill('实时接管 中文 ✓')
  await page.getByRole('button', { name: '输入', exact: true }).click()
  await page.waitForTimeout(200)
  assert.ok(received.some(e => e.action?.text === '实时接管 中文 ✓'))
  await page.evaluate(() => { window.__holdAfterError = true })
  invalidNext = true
  await page.waitForFunction(() => window.__previewResources.decodeErrors >= 1 && typeof window.__releaseBitmap === 'function')
  const actionsBeforeDecodeFailure = actFrames.length
  await page.locator('#screen').click({ position: { x: 100, y: 80 } })
  await page.waitForTimeout(100)
  assert.equal(actFrames.length, actionsBeforeDecodeFailure, 'A failed or pending decode cannot expose its unseen frame for input')
  await page.evaluate(() => window.__releaseBitmap())
  await page.waitForFunction(() => window.__previewResources.closed === window.__previewResources.created)
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'ready')
  await page.evaluate(() => { window.__holdNextBitmap = true })
  await page.waitForFunction(() => typeof window.__releaseBitmap === 'function')
  const framesBeforeStop = await page.evaluate(() => window.__previewResources.frames.length)
  await page.getByRole('button', { name: '停止', exact: true }).click()
  const stopDeadline = Date.now() + 5000
  while (host.service.get('preview-test').state !== 'stopped' && Date.now() < stopDeadline) await new Promise(done => setTimeout(done, 10))
  assert.equal(host.service.get('preview-test').state, 'stopped')
  await page.evaluate(() => window.__releaseBitmap())
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'stopped')
  await page.waitForFunction(() => window.__previewResources.closed === window.__previewResources.created)
  const bitmapResources = await page.evaluate(() => window.__previewResources)
  assert.equal(bitmapResources.frames.length, framesBeforeStop, 'A bitmap decoded before Stop must not repaint or restore an actionable frame afterward')
  assert.equal(bitmapResources.doubleClosed, 0)
  assert.equal(bitmapResources.created, bitmapResources.closed)

  await host.service.start('preview-race', target.id, { allowOnce: true })
  const racePage = await browser.newPage(), oldEpoch = host.service.get('preview-race').epoch
  await racePage.goto(`${endpoint}/api/qiuya-tools.computer.preview?session=preview-race`)
  await racePage.waitForFunction(() => document.querySelector('#screen').width === 320)
  captureFailure = true
  let deadline
  await Promise.race([oldErrorEntered, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Old fifth frame error was not reached')), 5000) })]).finally(() => clearTimeout(deadline))
  await host.service.stop('preview-race'); await host.service.start('preview-race', target.id, { allowOnce: true })
  const freshEpoch = host.service.get('preview-race').epoch
  releaseOldError()
  await Promise.race([automaticPauseCompleted, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Automatic pause did not arrive')), 5000) })]).finally(() => clearTimeout(deadline))
  const afterLateError = host.service.get('preview-race'), stalePauseRace = { oldEpoch, freshEpoch, afterLateError: { state: afterLateError.state, epoch: afterLateError.epoch }, automaticPauses, oldErrorsBeforeRestart: errorReplies, expectedVulnerable: reproduceOldPause }
  await writeFile(join(output, 'stale-pause-race.json'), JSON.stringify(stalePauseRace, null, 2))
  if (reproduceOldPause) assert.equal(afterLateError.state, 'paused', 'Diagnostic must actually reproduce the unfenced old automatic pause')
  else { assert.equal(afterLateError.state, 'ready'); assert.equal(afterLateError.epoch, freshEpoch); assert.equal(automaticPauses[0].expectedEpoch, oldEpoch) }
  captureFailure = false; await host.service.stop('preview-race'); await racePage.close()

  await host.service.start('inline-test', target.id, { allowOnce: true })
  const inlinePage = await browser.newPage({ viewport: { width: 300, height: 180 } })
  await inlinePage.goto(`${endpoint}/api/qiuya-tools.computer.preview?session=inline-test&view=inline`)
  await inlinePage.waitForFunction(() => document.querySelector('#screen').width === 320)
  assert.equal(await inlinePage.locator('header').evaluate(node => getComputedStyle(node).display), 'none')
  await inlinePage.close(); await new Promise(done => setTimeout(done, 150))
  assert.equal(host.service.get('inline-test').state, 'ready', 'Switching chat/unmounting its small frame must not pause background input')
  await host.service.stop('inline-test')
  await host.service.start('redock-test', target.id, { allowOnce: true })
  const redockPage = await browser.newPage()
  await redockPage.goto(`${endpoint}/api/qiuya-tools.computer.preview?session=redock-test`)
  await redockPage.waitForFunction(() => document.querySelector('#screen').width === 320)
  await redockPage.evaluate(() => { window.__qytPreserveSessionOnClose = true })
  await redockPage.close(); await new Promise(done => setTimeout(done, 150))
  assert.equal(host.service.get('redock-test').state, 'ready', 'Acknowledged explicit redock must preserve its session')
  await host.service.stop('redock-test')
  await page.screenshot({ path: join(output, 'preview.png') })
  await writeFile(join(output, 'report.json'), JSON.stringify({ status: reproduceOldPause ? 'reproduced' : 'passed', kind: 'real-Chromium-UI-with-deterministic-driver', stalePauseRace, tests: ['frames-rendered', 'takeover', 'scaled-click', 'native-ai-cursor-overrides-old-action', 'ai-cursor-moves-with-new-frames', 'off-target-ai-cursor-hidden', 'human-takeover-hides-ai-arrow', 'inline-unmount-preserves-background-task', 'explicit-redock-preserves-session', 'completed-drag-fallback-at-destination', 'Unicode-input', 'resume', 'stop', 'accessible-canvas-image-role', 'bitmap-close-after-every-draw', 'real-JPEG-decode-failure-does-not-expose-frame', 'stop-fences-pending-bitmap-and-closes-it', 'control-drops-old-pointer-down', 'same-epoch-canvas-drag', ...(reproduceOldPause ? [] : ['old-frame-error-cannot-pause-new-epoch'])], frames: frame, bitmapResources, actFrames, received }, null, 2))
  console.log(`${reproduceOldPause ? '旧帧错误自动暂停竞态已复现' : '预览浏览器测试通过'}，证据：${output}`)
} catch (error) { await writeFile(join(output, 'report.json'), JSON.stringify({ status: 'failed', reason: error.message })); throw error }
finally { releaseOldError(); await host?.dispose(); server.closeAllConnections(); await new Promise(done => server.close(done)); await browser.close() }
