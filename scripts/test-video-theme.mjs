/** Exercise real video decoding, audio changes, fallback and lifecycle. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { createThemeVideoFixture } from './theme-video-fixture.mjs'

const output = resolve('artifacts/video-theme')
await mkdir(output, { recursive: true })
const bundle = await build({ stdin: { contents: `
import {installQTheme} from './src/client/q-theme.ts';
let value={qThemeEnabled:true,qThemeId:'fox',qThemeSettings:{fox:{motion:'dynamic',muted:false}}};
const listeners=new Set();
const form={getSnapshot:()=>({status:'ready',value}),subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn)}};
const ctx={get(){return {rpc:{async call(channel,method,payload,signal){const response=await fetch(channel+'/'+method,{method:'POST',body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload}),signal});return(await response.json()).result}}}}};
const stop=installQTheme(ctx,form);
window.fixture={stop,update(next){value={...value,...next};for(const fn of listeners)fn()},audio(muted){this.update({qThemeSettings:{fox:{...value.qThemeSettings.fox,muted}}})},motion(motion){this.update({qThemeSettings:{fox:{...value.qThemeSettings.fox,motion}}})}};
`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'browser', format: 'iife', loader: { '.css': 'text' } })
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;font:15px/1.7 system-ui;color:var(--qyt-q-ink)}.app{display:flex;height:100vh}[data-slot="sidebar"]{width:200px;flex:none}[data-slot="sidebar"] aside{height:100%;padding:28px}main{flex:1;min-width:0}[data-phase]{height:100%;display:grid;place-items:center}.content{width:70%;text-align:center}h1{font-size:32px;text-shadow:0 1px 12px var(--qyt-q-surface)}button,textarea{font:inherit}textarea{width:100%;height:90px;padding:18px;background:var(--qyt-q-composer-fill);color:var(--qyt-q-ink);border:1px solid var(--qyt-q-line);border-radius:16px}button{padding:8px 20px;background:var(--qyt-q-surface);color:var(--qyt-q-ink);border:1px solid var(--qyt-q-line);border-radius:8px}
@media(max-width:600px){[data-slot="sidebar"]{width:100px}.content{width:90%}h1{font-size:24px}}</style></head><body><div class="app"><div data-slot="sidebar"><aside>QiuYaTools<br>新会话<br>工作区<br>Q 主题</aside></div><main data-slot="main.conversation"><section data-phase="hero"><div class="content"><h1>桃华白狐</h1><textarea aria-label="消息" placeholder="继续聊聊你的想法…"></textarea><button id="gesture">视频主题 · 本地预览</button></div></section></main></div><script>${bundle.outputFiles[0].text.replaceAll('</script', '<\/script')}</script></body></html>`
const host = await createThemeVideoFixture(join(output, 'profile'))
const server = createServer(async (req, res) => { if (await host.handle(req, res)) return; res.setHeader('Content-Type', 'text/html'); res.end(html) })
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
let browser
try {
  browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}) })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  const playing = () => page.waitForFunction(() => { const v = document.querySelector('video'); return v?.readyState >= 2 && !v.paused && v.currentTime > .1 }, null, { timeout: 150_000 })
  await playing()
  assert.equal(await page.locator('video').evaluate(v => v.muted && v.loop && v.playsInline), true)
  const first = await page.locator('video').evaluate(v => v.currentTime)
  await page.waitForFunction(first => document.querySelector('video').currentTime > first + .3, first)
  // Compare decoded pixels, not just a CSS marker or running clock.
  const pixels = () => page.locator('video').evaluate(v => { const c = document.createElement('canvas'); c.width = 160; c.height = 90; c.getContext('2d').drawImage(v, 0, 0, 160, 90); return c.toDataURL() })
  const frameA = await pixels()
  await page.waitForTimeout(400)
  assert.notEqual(await pixels(), frameA)
  await page.getByRole('textbox').fill('视频背景不影响输入')
  await page.screenshot({ path: join(output, 'fox-home-light.png') })
  await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
  await page.screenshot({ path: join(output, 'fox-home-dark.png') })
  await page.locator('#gesture').click()
  await page.evaluate(() => { window.savedVideo = document.querySelector('video'); window.fixture.audio(false) })
  assert.equal(await page.locator('video').evaluate(v => v.muted && !v.paused), true, 'legacy unmute preferences are ignored')
  assert.equal(await page.evaluate(() => document.querySelector('video') === window.savedVideo), true)
  // Loop across the actual end of the encoded clip.
  await page.locator('video').evaluate(v => { v.currentTime = v.duration - .15 })
  await page.waitForFunction(() => { const v = document.querySelector('video'); return !v.paused && v.currentTime < 2 })
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
  assert.equal(await page.locator('video').evaluate(v => v.paused), true)
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')) })
  await playing()
  await page.evaluate(() => document.querySelector('main').style.display = 'none')
  await page.waitForFunction(() => document.querySelector('video').paused)
  await page.evaluate(() => document.querySelector('main').style.display = '')
  await playing()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.locator('video').waitFor({ state: 'detached' })
  assert.equal(await page.locator('body').getAttribute('data-qyt-q-theme'), 'fox')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await playing()
  await page.emulateMedia({ forcedColors: 'active' })
  await page.locator('video').waitFor({ state: 'detached' })
  await page.emulateMedia({ forcedColors: 'none' })
  await playing()
  await page.evaluate(() => { window.savedVideo = document.querySelector('video'); window.fixture.motion('static') })
  assert.equal(await page.locator('video').count(), 0)
  assert.equal(await page.evaluate(() => window.savedVideo.paused && !window.savedVideo.hasAttribute('src')), true)
  await page.evaluate(() => window.fixture.motion('dynamic'))
  await playing()
  // Host replaces conversation roots during navigation.
  await page.evaluate(() => { window.savedVideo = document.querySelector('video'); const host = document.querySelector('[data-phase]'); const copy = host.cloneNode(true); copy.querySelectorAll('video,[data-qyt-theme-wash]').forEach(v => v.remove()); copy.removeAttribute('data-qyt-theme-live'); host.replaceWith(copy) })
  await playing()
  assert.equal(await page.evaluate(() => window.savedVideo.paused && !window.savedVideo.hasAttribute('src')), true)
  assert.equal(await page.locator('video').count(), 1)
  await page.setViewportSize({ width: 420, height: 900 })
  await page.screenshot({ path: join(output, 'fox-narrow.png') })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.evaluate(() => { window.savedVideo = document.querySelector('video'); window.fixture.update({ qThemeId: 'ocean', qThemeSettings: { ocean: { motion: 'static' } } }) })
  assert.equal(await page.locator('video').count(), 0)
  assert.equal(await page.evaluate(() => window.savedVideo.paused && !window.savedVideo.hasAttribute('src')), true)
  await page.evaluate(() => window.fixture.update({ qThemeId: 'fox', qThemeSettings: { fox: { motion: 'dynamic' } } }))
  await playing()
  await page.evaluate(() => { window.savedVideo = document.querySelector('video'); window.savedVideo.dispatchEvent(new Event('error')) })
  assert.equal(await page.locator('video').count(), 0)
  assert.equal(await page.locator('[data-qyt-theme-live]').count(), 0, 'decoding failure restores poster')
  await page.evaluate(() => { window.fixture.motion('static'); window.fixture.motion('dynamic') })
  await playing()
  await page.evaluate(() => { window.savedVideo = document.querySelector('video'); window.fixture.stop(); window.fixture.stop() })
  assert.equal(await page.locator('video,style[data-qyt-q-theme]').count(), 0)
  assert.equal(await page.evaluate(() => window.savedVideo.paused && !window.savedVideo.hasAttribute('src')), true)
  assert.deepEqual(errors, [])
  const report = { passed: true, decodedPixelsChanged: true, alwaysMuted: true, loop: true, hiddenPause: true, reducedMotion: true, forcedColors: true, modeSwitch: true, navigationCleanup: true, decodeFallback: true, unload: true, errors }
  await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally { host.stop(); await browser?.close(); await new Promise(resolve => server.close(resolve)) }
