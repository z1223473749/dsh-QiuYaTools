import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
const output = resolve('artifacts/computer-use/preview-web')
await mkdir(output, { recursive: true })
const compiled = await build({ entryPoints: [fileURLToPath(new URL('../src/features/computer-use/host.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })
const { installComputerHost } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
const browser = await chromium.launch({ ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : { channel: 'msedge' }), headless: true })
let host
const routes = new Map(), received = [], target = { id: 'test-window', appId: 'test-app', title: 'Preview fixture', pid: 1, x: 0, y: 0, width: 320, height: 180, scale: 1 }
const server = createServer(async (req, res) => {
  try {
    const route = routes.get(new URL(req.url, 'http://127.0.0.1').pathname)
    if (!route) { res.writeHead(404).end(); return }
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const response = await route.fetch(new Request(`http://127.0.0.1${req.url}`, { method: req.method, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) }))
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()))
  } catch (e) { res.writeHead(500).end(String(e)) }
})
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  const imageBase64 = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 320; c.height = 180; const x = c.getContext('2d'); x.fillStyle = '#174f59'; x.fillRect(0, 0, 320, 180); x.fillStyle = '#fff'; x.font = '20px sans-serif'; x.fillText('Live preview fixture', 35, 90); return c.toDataURL('image/jpeg').split(',')[1] })
  let frame = 0, liveCursor
  const driver = { status: async () => ({ available: true }), targets: async () => [target], lease: async epoch => received.push({ op: 'lease', epoch }), release: async epoch => received.push({ op: 'release', epoch }),
    observe: async () => ({ targetId: target.id, frameId: String(++frame), imageBase64, mediaType: 'image/jpeg', width: 320, height: 180, elements: '', geometry: target, ...(liveCursor ? { cursor: { ...liveCursor } } : {}) }), act: async (epoch, id, action) => { received.push({ op: 'act', epoch, id, action }); return {} }, openPreview: async () => ({}), closePreview: async () => {}, dispose() {} }
  host = await installComputerHost({ get: name => name === 'sessions' ? { get: () => ({}) } : undefined, webServer: { port: 1 }, connection: { browserPeer: { principal: { kind: 'owner' } }, authenticatedUrl: value => value, fetch: { register(route) { routes.set(route.path, route); return async () => routes.delete(route.path) } } } }, () => true, { driver })
  await host.service.start('preview-test', target.id, { allowOnce: true })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  await page.goto(`${endpoint}/api/qiuya-tools.computer.preview?session=preview-test`)
  await page.waitForFunction(() => document.querySelector('img').naturalWidth === 320)
  await page.getByRole('button', { name: '接管', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'humanControl')
  await page.locator('img').click({ position: { x: 100, y: 80 } })
  await page.waitForFunction(() => document.querySelector('#message').hidden)
  assert.equal(received.filter(e => e.op === 'act').length, 1)
  const cursorAt = position => page.waitForFunction(point => {
    const cursor = document.querySelector('#cursor'), image = document.querySelector('#screen'), stage = document.querySelector('#stage')
    if (!point) return getComputedStyle(cursor).display === 'none'
    const r = image.getBoundingClientRect(), g = stage.getBoundingClientRect()
    return getComputedStyle(cursor).display !== 'none' && Math.abs(parseFloat(cursor.style.left) - (r.left - g.left + point.x * r.width / 320)) < 1 && Math.abs(parseFloat(cursor.style.top) - (r.top - g.top + point.y * r.height / 180)) < 1
  }, position)
  liveCursor = { x: 250, y: 40, visible: true }; await cursorAt(liveCursor)
  liveCursor = { x: 260, y: 50, visible: true }; await cursorAt(liveCursor)
  liveCursor.visible = false; await cursorAt(null)
  liveCursor = undefined
  const dragFrame = await host.service.preview('preview-test')
  await host.service.humanAct('preview-test', { actionId: crypto.randomUUID(), frameId: dragFrame.frameId, action: { kind: 'drag', x: 20, y: 20, toX: 240, toY: 130 } })
  await cursorAt({ x: 240, y: 130 })
  await page.locator('#text').fill('实时接管 中文 ✓')
  await page.getByRole('button', { name: '输入', exact: true }).click()
  await page.waitForTimeout(200)
  assert.ok(received.some(e => e.action?.text === '实时接管 中文 ✓'))
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'ready')
  await page.getByRole('button', { name: '停止', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'stopped')
  await page.screenshot({ path: join(output, 'preview.png') })
  await writeFile(join(output, 'report.json'), JSON.stringify({ status: 'passed', kind: 'real-Chromium-UI-with-deterministic-driver', tests: ['frames-rendered', 'takeover', 'scaled-click', 'live-cursor-overrides-old-action', 'cursor-moves-with-new-frames', 'off-target-cursor-hidden', 'completed-drag-fallback-at-destination', 'Unicode-input', 'resume', 'stop'], frames: frame, received }, null, 2))
  console.log(`预览浏览器测试通过，证据：${output}`)
} catch (error) { await writeFile(join(output, 'report.json'), JSON.stringify({ status: 'failed', reason: error.message })); throw error }
finally { await host?.dispose(); server.closeAllConnections(); await new Promise(done => server.close(done)); await browser.close() }
