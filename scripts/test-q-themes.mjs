/** Account-free browser acceptance of the production Q Theme lifecycle. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('..', import.meta.url))
const output = join(root, 'artifacts/q-themes')
await mkdir(output, { recursive: true })
const fixture = `
import {installQTheme} from './src/client/q-theme.ts';
let preferences={qThemeEnabled:true,qThemeSettings:{ocean:{motion:'static'},begonia:{motion:'static'}}};
const listeners=new Set();
const form={getSnapshot:()=>({status:'ready',value:preferences}),subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener)}};
const main=document.querySelector('[data-slot="main.conversation"]');
function rebuild(phase='hero'){
 main.innerHTML='<section data-phase="'+phase+'"><div data-slot="conversation.header"><header>Q 主题 · 本地效果预览</header></div><div data-conversation-content><div data-conversation-scroll><article><h1>让风景留在阅读之外</h1><p>海棠花瓣轻轻飘落，女孩安静地望向远方。</p><p>同一套主题框架保留阅读留白与半透明纸面，跟随原生浅色和深色外观。</p><pre><code>const theme = { motion: "static" };</code></pre></article><div data-composer-seat><div data-composer-card><textarea aria-label="消息" placeholder="继续聊聊你的想法…"></textarea><button aria-label="发送">↑</button></div></div></div></div></section>';
}
rebuild();
const cleanup=installQTheme({},form);
window.__themes={rebuild,cleanup,update(next){preferences={...preferences,...next};for(const listener of [...listeners])listener()},motion(id,motion){preferences={...preferences,qThemeSettings:{...preferences.qThemeSettings,[id]:{motion}}};for(const listener of [...listeners])listener()}};
`
const built = await build({ stdin: { contents: fixture, resolveDir: root, loader: 'ts' }, bundle: true, write: false, platform: 'browser', format: 'iife', loader: { '.css': 'text' } })
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;font:14px/1.8 -apple-system,BlinkMacSystemFont,sans-serif;color:var(--qyt-q-ink,#24282b)}button,textarea{font:inherit;color:inherit}.app{display:flex;height:100vh;overflow:hidden}[data-slot="sidebar"]{width:220px;flex:none}[data-slot="sidebar"]>aside{height:100%;padding:25px 18px;display:flex;flex-direction:column;gap:18px}.brand{font-weight:700;font-size:19px}.nav{padding:9px;border-radius:9px;background:var(--qyt-q-selected)}.foot{margin-top:auto}main{flex:1;min-width:0}main>section{height:100vh;overflow:hidden;display:flex;flex-direction:column}header{padding:18px 28px}[data-conversation-content]{flex:1;min-height:0;display:flex;flex-direction:column;justify-content:center}[data-conversation-scroll]{height:100%;overflow:auto;display:flex;flex-direction:column;justify-content:center}article{width:min(680px,calc(100% - 70px));margin:0 auto 25px}article h1{font-size:27px;font-weight:600}pre{padding:15px;border-radius:10px;background:var(--qyt-q-raised)}[data-phase="hero"] article p,[data-phase="hero"] pre{display:none}[data-composer-seat]{position:relative;isolation:isolate;padding:20px 25px;flex:none}[data-composer-card]{max-width:760px;margin:auto;padding:14px;display:flex;gap:12px;align-items:flex-end}textarea{flex:1;min-width:0;height:72px;resize:none;border:0;outline:0;background:transparent}button{width:30px;height:30px;border:0;border-radius:50%;background:var(--dsw-alias-button-info-fill);color:white}[data-phase="active"] [data-conversation-scroll]{justify-content:flex-start;padding-top:40px}[data-phase="active"] [data-composer-seat]{margin-top:auto}
@media(max-width:650px){[data-slot="sidebar"]{width:150px}article{width:calc(100% - 30px)}article h1{font-size:22px}[data-composer-seat]{padding:14px}}
</style></head><body><div class="app"><div data-slot="sidebar"><aside><span class="brand">QiuYaTools</span><span>新会话</span><span>工作区</span><span class="nav">主题效果预览</span><span class="foot">Q 主题 · 本地预览</span></aside></div><main data-slot="main.conversation"></main></div><script>${built.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script></body></html>`
await writeFile(join(output, 'preview.html'), html)
if (process.argv.includes('--generate-only')) { console.log(join(output, 'preview.html')); process.exit(0) }
const server = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html) })
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
let browser
try {
  browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}) })
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
  const errors = [], requests = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => requests.push(request.url()))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.waitForFunction(() => window.__themes)
  const marker = () => page.getAttribute('body', 'data-qyt-q-theme')
  assert.equal(await marker(), 'ocean', 'old preferences retain Ocean')
  assert.equal(await page.locator('canvas').count(), 0, 'saved static choice never starts a scene')
  await page.evaluate(() => window.__themes.update({ qThemeId: 'begonia' }))
  assert.equal(await marker(), 'begonia')
  assert.equal(await page.locator('canvas').count(), 0)
  await page.screenshot({ path: join(output, 'begonia-home.png') })
  await page.evaluate(() => window.__themes.motion('begonia', 'dynamic'))
  await page.waitForFunction(() => document.querySelector('canvas[data-qyt-begonia-petals]')?.width > 300)
  const before = await page.locator('canvas').evaluate(canvas => canvas.toDataURL())
  await page.waitForFunction(previous => document.querySelector('canvas')?.toDataURL() !== previous, before)
  const overlay = await page.locator('canvas').evaluate(canvas => ({ hidden: canvas.getAttribute('aria-hidden'), inert: canvas.hasAttribute('inert'), events: getComputedStyle(canvas).pointerEvents, z: getComputedStyle(canvas).zIndex }))
  assert.deepEqual(overlay, { hidden: 'true', inert: true, events: 'none', z: '-1' })
  await page.evaluate(() => window.__themes.rebuild('active'))
  await page.waitForFunction(() => document.querySelector('[data-phase="active"] > canvas[data-qyt-begonia-petals]')?.width > 300)
  await page.getByRole('textbox', { name: '消息' }).fill('花瓣不会阻挡输入')
  assert.equal(await page.getByRole('textbox', { name: '消息' }).inputValue(), '花瓣不会阻挡输入')
  await page.screenshot({ path: join(output, 'begonia-reading.png') })
  await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--qyt-q-base').trim()), '#221b1e')
  await page.screenshot({ path: join(output, 'begonia-dark.png') })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForFunction(() => !document.querySelector('canvas'))
  assert.equal(await marker(), 'begonia', 'reduced motion retains selected static artwork')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.waitForFunction(() => document.querySelector('canvas[data-qyt-begonia-petals]'))
  await page.evaluate(() => window.__themes.update({ qThemeId: 'ocean' }))
  await page.waitForFunction(() => !document.querySelector('canvas'))
  assert.equal(await marker(), 'ocean', 'Ocean retained its own static setting')
  await page.evaluate(() => { document.body.removeAttribute('data-ds-dark-theme'); window.__themes.motion('ocean', 'dynamic') })
  await page.waitForFunction(() => document.querySelector('canvas[data-qyt-ocean-scene][data-ready="true"]'), null, { timeout: 15000 })
  await page.evaluate(() => window.__themes.update({ qThemeId: 'begonia' }))
  await page.waitForFunction(() => document.querySelector('canvas[data-qyt-begonia-petals]'))
  assert.equal(await page.locator('canvas[data-qyt-ocean-scene], [data-qyt-ocean-dock]').count(), 0, 'switching releases all Ocean layers')
  await page.evaluate(() => window.__themes.motion('begonia', 'static'))
  assert.equal(await page.locator('canvas').count(), 0)
  await page.setViewportSize({ width: 420, height: 900 })
  await page.screenshot({ path: join(output, 'begonia-narrow.png') })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.evaluate(() => window.__themes.update({ qThemeEnabled: false }))
  assert.equal(await marker(), null)
  assert.equal(await page.locator('style[data-plugin="dsh-qiuya-tools"]').count(), 0)
  await page.evaluate(() => window.__themes.cleanup())
  assert.deepEqual(errors, [])
  assert.ok(requests.every(url => url.startsWith(`http://127.0.0.1:${server.address().port}`)), 'no external artwork requests')
  const report = { passed: true, staticDynamic: true, realCanvasMotion: true, oceanTransition: true, reducedMotion: true, inputClickable: true, darkAndNarrow: true, errors, screenshots: ['begonia-home.png', 'begonia-reading.png', 'begonia-dark.png', 'begonia-narrow.png'] }
  await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
