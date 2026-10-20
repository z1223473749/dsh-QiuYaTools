/** Pure-browser transport diagnosis: synthetic JPEGs, no native driver or inputs. */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'
const run = promisify(execFile), arg = (key, fallback) => { const at = process.argv.indexOf(key); return at < 0 ? fallback : process.argv[at + 1] }
const seconds = Number(arg('--seconds', '60')), output = resolve(arg('--output', 'artifacts/computer-use/preview-image-memory'))
assert.ok(Number.isFinite(seconds) && seconds >= 10 && seconds <= 180)
const originalHtml = await readFile(resolve(arg('--html')), 'utf8')
const originalTransport = "img.src='data:'+f.mediaType+';base64,'+f.imageBase64"
const modes = arg('--modes', originalHtml.includes(originalTransport) ? 'data-url,object-url-revoke' : 'production').split(',')
assert.ok(modes.length > 0 && modes.length <= 3 && new Set(modes).size === modes.length && modes.every(mode => ['data-url', 'object-url-revoke', 'bitmap-canvas', 'production'].includes(mode)))
assert.ok(modes.every(mode => mode === 'production') || originalHtml.includes(originalTransport), 'Legacy comparison modes require the archived original data URL HTML')
const blobTransport = "const bytes=Uint8Array.from(atob(f.imageBase64),c=>c.charCodeAt(0)),next=URL.createObjectURL(new Blob([bytes],{type:f.mediaType}));img.src=next;if(window.__memoryObjectURL)URL.revokeObjectURL(window.__memoryObjectURL);window.__memoryObjectURL=next"
const bitmapTransport = "const bytes=Uint8Array.from(atob(f.imageBase64),c=>c.charCodeAt(0)),bitmap=await createImageBitmap(new Blob([bytes],{type:f.mediaType}));try{if(img.width!==bitmap.width)img.width=bitmap.width;if(img.height!==bitmap.height)img.height=bitmap.height;img.getContext('2d',{alpha:false}).drawImage(bitmap,0,0);window.__imageMemory.loaded++}finally{bitmap.close()}"
const htmlFor = mode => mode === 'production' || mode === 'data-url' ? originalHtml : mode === 'object-url-revoke' ? originalHtml.replace(originalTransport, blobTransport) : originalHtml.replace('<img id="screen" alt="实时电脑画面">', '<canvas id="screen" role="img" aria-label="实时电脑画面"></canvas>').replace('img{max-width:', 'img,canvas{max-width:').replace(originalTransport, bitmapTransport)
const launch = () => chromium.launch(process.platform === 'win32' ? { channel: 'msedge', headless: true } : { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
await mkdir(output, { recursive: true })
const preparation = await launch()
let images
try {
  const page = await preparation.newPage()
  images = (await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360
    const context = canvas.getContext('2d'), images = []
    for (let frame = 0; frame < 32; frame++) {
      context.fillStyle = '#203744'; context.fillRect(0, 0, 640, 360)
      for (let x = 0; x < 640; x += 8) { context.fillStyle = `rgb(${x % 255},${(x * 3 + frame * 7) % 255},${(x * 7) % 255})`; context.fillRect(x, 90, 5, 240) }
      context.fillStyle = '#fff'; context.font = '24px sans-serif'; context.fillText(`Synthetic preview fixture ${frame}`, 20, 50)
      images.push(canvas.toDataURL('image/jpeg', 0.8).split(',')[1])
    }
    return images
  })).map(value => Buffer.from(value, 'base64'))
} finally { await preparation.close() }
const uniqueJpeg = index => {
  const image = images[index % images.length], comment = Buffer.from(`frame:${index};time:${Date.now()}`), header = Buffer.alloc(4)
  header[0] = 0xff; header[1] = 0xfe; header.writeUInt16BE(comment.length + 2, 2)
  return Buffer.concat([image.subarray(0, 2), header, comment, image.subarray(2)])
}
let active
const server = createServer(async (request, response) => {
  try {
    if (request.method === 'GET') { response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); response.end(htmlFor(active.mode)); return }
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const input = JSON.parse(Buffer.concat(chunks)), op = input.payload.op
    let value
    if (op === 'status') value = { sessions: [{ sessionId: 'memory', state: 'paused', epoch: 1 }] }
    else if (op === 'frame') { const image = uniqueJpeg(++active.sent); value = { targetId: 'synthetic-fixture', frameId: String(active.sent), mediaType: 'image/jpeg', imageBase64: image.toString('base64'), width: 640, height: 360 } }
    else if (op === 'pause') value = { state: 'paused' }
    else throw new Error(`Unexpected operation ${op}`)
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify({ type: 'server-response', rpcId: input.rpcId, result: { ok: true, value } }))
  } catch { response.writeHead(500).end() }
})
const arms = []
let browser
async function processMemory(browserSession) {
  const info = await browserSession.send('SystemInfo.getProcessInfo'), processes = info.processInfo.map(item => ({ pid: Number(item.id), kind: item.type }))
  const ids = processes.map(item => item.pid).filter(Number.isSafeInteger)
  let rows
  if (process.platform === 'win32') {
    const code = `$ids=@(${ids.join(',')});ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process|Where-Object{$ids -contains [int]$_.ProcessId}|ForEach-Object{@{pid=[int]$_.ProcessId;workingSetBytes=[long]$_.WorkingSetSize;createdAtTicks=$_.CreationDate.ToUniversalTime().Ticks.ToString()}}) -Compress`
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000 })
    rows = JSON.parse(stdout.trim())
  } else {
    const { stdout } = await run('/bin/ps', ['-p', ids.join(','), '-o', 'pid=,rss='])
    rows = stdout.trim().split('\n').map(line => { const [pid, kib] = line.trim().split(/\s+/u).map(Number); return { pid, workingSetBytes: kib * 1024 } })
  }
  return rows.map(row => ({ ...row, kind: processes.find(item => item.pid === row.pid)?.kind }))
}
try {
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  for (const mode of modes) {
    active = { mode, sent: 0 }; browser = await launch()
    const page = await browser.newPage(), target = await page.context().newCDPSession(page), browserSession = await browser.newBrowserCDPSession()
    await target.send('Performance.enable')
    await page.addInitScript(() => { window.__imageMemory = { loaded: 0, errors: 0 }; document.addEventListener('load', event => { if (event.target instanceof HTMLImageElement && event.target.id === 'screen') window.__imageMemory.loaded++ }, true); document.addEventListener('qiuya-preview-frame', () => { window.__imageMemory.loaded++ }); document.addEventListener('error', event => { if (event.target instanceof HTMLImageElement) window.__imageMemory.errors++ }, true) })
    await page.goto(`http://127.0.0.1:${server.address().port}/?session=memory`)
    await page.waitForFunction(() => window.__imageMemory.loaded >= 3)
    const start = Date.now(), samples = []
    const sample = async () => {
      const processes = await processMemory(browserSession), metrics = await target.send('Performance.getMetrics'), metric = name => metrics.metrics.find(item => item.name === name)?.value
      samples.push({ elapsedMs: Date.now() - start, processes, browserWorkingSetBytes: processes.reduce((sum, item) => sum + item.workingSetBytes, 0), rendererWorkingSetBytes: processes.filter(item => item.kind === 'renderer').reduce((sum, item) => sum + item.workingSetBytes, 0), jsHeapUsedBytes: metric('JSHeapUsedSize'), jsHeapTotalBytes: metric('JSHeapTotalSize'), nodes: metric('Nodes'), ...(await page.evaluate(() => window.__imageMemory)) })
      await writeFile(join(output, `progress-${mode}.json`), JSON.stringify(samples.at(-1), null, 2))
    }
    await sample()
    let next = start + 5000
    while (Date.now() < start + seconds * 1000) { await new Promise(done => setTimeout(done, Math.min(1000, Math.max(1, next - Date.now())))); if (Date.now() >= next) { await sample(); next += 5000 } }
    await sample(); await page.screenshot({ path: join(output, `${mode}.png`) })
    const arm = { mode, elapsedMs: Date.now() - start, sent: active.sent, loaded: samples.at(-1).loaded, errors: samples.at(-1).errors, samples, changes: mode === 'production' ? 'Exact current production preview HTML without transport or rendering substitutions.' : mode === 'bitmap-canvas' ? 'Diagnostic only: img replaced by role=img canvas, createImageBitmap then drawImage then bitmap.close for every frame; native/accessibility integration is not asserted.' : 'Original production HTML with only the image URL transport expression changed for the object URL arm.', maxBrowserWorkingSetBytes: Math.max(...samples.map(item => item.browserWorkingSetBytes)), maxRendererWorkingSetBytes: Math.max(...samples.map(item => item.rendererWorkingSetBytes)) }
    arms.push(arm); await writeFile(join(output, `${mode}.json`), JSON.stringify(arm, null, 2))
    assert.ok(arm.loaded >= 10 && arm.errors === 0, 'Both variants must actually render frames')
    await browser.close(); browser = undefined
  }
  const report = { status: 'passed', kind: 'synthetic-production-preview-image-transport-diagnosis', purpose: 'Diagnostic experiment only; this is not a resource acceptance gate or native endurance proof.', nativeOps: 0, forcedGarbageCollection: false, decoderCanvas: false, secondsPerMode: seconds, platform: process.platform, architecture: process.arch, generatedJpegBytes: { min: Math.min(...images.map(item => item.length)), max: Math.max(...images.map(item => item.length)) }, arms, testedAt: new Date().toISOString() }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ...report, arms: arms.map(({ samples, ...arm }) => ({ ...arm, samples: samples.length })) }, null, 2))
} catch (error) { await writeFile(join(output, 'report.json'), JSON.stringify({ status: 'failed', reason: error.message, nativeOps: 0, arms }, null, 2)); console.error(error.message); process.exitCode = 1 }
finally { await browser?.close(); server.closeAllConnections(); if (server.listening) await new Promise(done => server.close(done)) }
