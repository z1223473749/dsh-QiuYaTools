/** Account-free visual preview and browser acceptance for the living Ocean theme. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('..', import.meta.url))
const output = resolve(root, 'artifacts/ocean-scene')
const serve = process.argv.includes('--serve')
const portArgument = process.argv.find(argument => argument.startsWith('--port='))
const requestedPort = portArgument ? Number(portArgument.split('=')[1]) : serve ? 4317 : 0
assert.ok(Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65535, 'Use --port=0..65535')
await mkdir(output, { recursive: true })

const fixture = `
import {installQTheme} from ${JSON.stringify(join(root, 'src/client/q-theme.ts'))};
const listeners=new Set();
let themeEnabled=true, manualReduced;
const nativeMatchMedia=window.matchMedia.bind(window), nativeReduced=nativeMatchMedia('(prefers-reduced-motion: reduce)');
const motionEvents=new EventTarget();
const reduced={get matches(){return manualReduced??nativeReduced.matches},media:nativeReduced.media,onchange:null,addEventListener:(...args)=>motionEvents.addEventListener(...args),removeEventListener:(...args)=>motionEvents.removeEventListener(...args),addListener:fn=>motionEvents.addEventListener('change',fn),removeListener:fn=>motionEvents.removeEventListener('change',fn)};
function motionChanged(){const event=new Event('change');Object.defineProperty(event,'matches',{value:reduced.matches});motionEvents.dispatchEvent(event);reduced.onchange?.(event);document.getElementById('preview-motion').setAttribute('aria-pressed',String(!reduced.matches))}
nativeReduced.addEventListener('change',motionChanged);
window.matchMedia=query=>query==='(prefers-reduced-motion: reduce)'?reduced:nativeMatchMedia(query);
const form={getSnapshot:()=>({status:'ready',value:{qThemeEnabled:themeEnabled}}),subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}};
let cleanup;
const main=document.querySelector('[data-slot="main.conversation"]');
const hero=()=>'<section data-phase="hero"><div class="hero-copy"><h1><span class="brand-whale">◕</span> 探索未知之境 <small>预览版</small></h1><div class="composer-meta"><span>▱ attest⌄</span><span>♧ 创造模式⌄</span><span>⑂ main⌄</span></div><div class="preview-composer" data-composer-card><textarea aria-label="描述你想构建的内容" placeholder="描述你想构建的内容，/ 调用指令，@ 文件或对话"></textarea><footer><div><button aria-label="添加附件">＋</button><span>♧ 工作区内修改⌄</span><span>▣ 这台电脑⌄</span></div><div class="model">DeepSeek-V4.1-Flash <em>1017</em> High⌄ <button class="send" aria-label="发送">↑</button></div></footer></div></div></section>';
const reading=()=>'<section data-phase="active"><div data-slot="conversation.header"><header>让背景像海风一样呼吸</header></div><div class="reading-content" data-conversation-content><div class="reading-scroll" data-conversation-scroll><article><div class="user-message">让天上的云、海水、鲸鱼和人物的细节都动起来。</div><p>微风掠过海面，远处的云缓慢舒展。少年坐在鲸鱼背上，衣角与发梢轻轻摆动。</p><p>移动鼠标，可以感受画面不同距离之间的细微变化。聊天区域保持安静，让注意力自然留在文字上。</p><h2>一片始终流动的海</h2><p>海水有自己的节奏。鲸鱼随浪轻轻起伏，近处的浪花更鲜明，远处的水面更平缓。</p><pre><code>const ocean = { wind: "gentle", waves: "slow" };</code></pre><p>这是本地效果预览。输入框和按钮仍然可以正常使用。</p></article><div data-composer-seat><div class="preview-composer" data-composer-card><textarea aria-label="描述你想构建的内容" placeholder="继续聊聊你的想法…"></textarea><footer><div><button aria-label="添加附件">＋</button><span>♧ 工作区内修改⌄</span></div><button class="send" aria-label="发送">↑</button></footer></div></div></div></div></section>';
function rebuild(mode='hero'){main.innerHTML=mode==='active'?reading():hero();document.getElementById('preview-reading').setAttribute('aria-pressed',String(mode==='active'))}
function setTheme(value){themeEnabled=value;for(const listener of [...listeners])listener()}
function setMotion(value){manualReduced=!value;motionChanged()}
rebuild();cleanup=installQTheme({},form);motionChanged();
document.getElementById('preview-motion').addEventListener('click',()=>setMotion(reduced.matches));
document.getElementById('preview-dark').addEventListener('click',()=>{const dark=!document.body.hasAttribute('data-ds-dark-theme');document.body.toggleAttribute('data-ds-dark-theme',dark);document.getElementById('preview-dark').setAttribute('aria-pressed',String(dark))});
document.getElementById('preview-reading').addEventListener('click',()=>rebuild(main.firstElementChild?.dataset.phase==='active'?'hero':'active'));
window.__oceanFixture={setTheme,setMotion,rebuild,dispose(){cleanup();nativeReduced.removeEventListener('change',motionChanged);window.matchMedia=nativeMatchMedia}};
window.__oceanFixtureReady=true;
`
const bundle = await build({
  stdin: { contents: fixture, resolveDir: root, sourcefile: 'ocean-preview.ts', loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  loader: { '.css': 'text' },
})
const js = bundle.outputFiles[0].text
const css = `
:root{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#24282b;background:#fafaf8}
*{box-sizing:border-box}body{margin:0;color:var(--qyt-q-ink,#24282b);overflow:hidden}button,textarea{font:inherit}button{color:inherit;cursor:pointer;border:0;background:transparent}button:focus-visible,textarea:focus-visible{outline:2px solid #116d83;outline-offset:3px}
.app{display:flex;width:100vw;height:100vh;overflow:hidden}.sidebar-shell{width:280px;flex:none;border-right:1px solid rgba(40,55,50,.08);z-index:1}.sidebar{height:100%;padding:18px 14px;display:flex;flex-direction:column;overflow:hidden}.traffic{display:flex;gap:8px;height:35px}.traffic i{width:13px;height:13px;border-radius:50%;background:#ff6059;border:1px solid #e5443d}.traffic i:nth-child(2){background:#ffbf2f;border-color:#e3a51e}.traffic i:nth-child(3){background:#2bca41;border-color:#1aaf30}.logo{font-size:19px;font-weight:700;letter-spacing:.4px;padding:7px 2px 20px}.logo small{font-size:10px;background:#24282b;color:white;letter-spacing:.5px;padding:1px 4px;border-radius:2px}.new-chat{border:1px solid var(--qyt-q-line,#d9dedc);background:rgba(255,255,255,.6);border-radius:10px;height:38px;margin-bottom:12px}.nav-row{padding:9px 8px;display:block;text-align:left}.workspaces{margin-top:17px;color:var(--qyt-q-secondary,#53595f);display:flex;justify-content:space-between}.workspace{padding:15px 7px 7px}.session{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:7px 13px 7px 24px;min-height:33px}.session small{float:right;color:#81918c;font-size:10px}.session.selected{background:var(--qyt-q-selected,#d6e7e1);border-radius:8px;box-shadow:inset 3px 0 #116d83}.sidebar-foot{margin-top:auto;padding-top:20px}.avatar{display:inline-flex;justify-content:center;align-items:center;width:23px;height:23px;background:#d6c7a7;border-radius:50%;margin-right:6px;font-size:11px}
main{flex:1;min-width:0;height:100%;overflow:hidden}main>section{width:100%;height:100%;overflow:hidden;display:flex;flex-direction:column}section[data-phase="hero"]{justify-content:center;padding:0 clamp(28px,5vw,70px) 1.5vh}.hero-copy{margin-top:3vh}.hero-copy h1{font-size:25px;font-weight:650;line-height:1.4;text-align:center;letter-spacing:1px;margin:0 0 26px}.brand-whale{font-size:30px;vertical-align:-1px}.hero-copy h1 small{font-size:11px;font-weight:500;letter-spacing:0;color:#225e6d;background:#d7eced;border-radius:20px;vertical-align:middle;padding:3px 8px;display:inline-block}.composer-meta{display:flex;gap:23px;font-size:13px;margin:0 12px 12px}.preview-composer{padding:11px 13px 10px;border:1px solid var(--qyt-q-line,#d9dedc);min-height:116px;display:flex;flex-direction:column}.preview-composer textarea{resize:none;background:transparent;border:0;outline:none;min-height:55px;width:100%;color:var(--qyt-q-ink,#24282b);font-size:13px;padding:2px 0}.preview-composer textarea::placeholder{color:var(--qyt-q-secondary,#53595f)}.preview-composer footer{display:flex;justify-content:space-between;gap:10px;font-size:12px;color:var(--qyt-q-secondary,#53595f)}.preview-composer footer>div{display:flex;gap:17px;align-items:center}.preview-composer footer button:first-child{font-size:21px;background:var(--qyt-q-selected,#d6e7e1);width:28px;height:28px;border-radius:50%;padding:0;line-height:28px}.preview-composer footer .send{border-radius:50%;background:#a8c9ce;color:white;font-size:28px;width:33px;height:33px;line-height:30px;padding:0}.model{white-space:nowrap}.model em{font-style:normal;font-size:10px;background:var(--qyt-q-selected,#d6e7e1);color:#116d83;border-radius:10px;padding:2px 7px;margin-left:-11px}
.preview-tools{position:fixed;top:14px;right:16px;display:flex;align-items:center;gap:4px;z-index:20;padding:4px;border:1px solid rgba(92,119,113,.16);background:var(--qyt-q-paper,rgba(250,250,248,.9));border-radius:12px;box-shadow:0 2px 10px rgba(36,40,43,.04);font-size:11px;color:var(--qyt-q-secondary,#53595f)}.preview-tools span{padding:3px 8px}.preview-tools button{border-radius:8px;padding:5px 9px}.preview-tools button[aria-pressed="true"]{background:var(--qyt-q-selected,#d6e7e1);color:var(--qyt-q-sea,#116d83)}.preview-caption{position:fixed;bottom:13px;right:20px;pointer-events:none;font-size:10px;letter-spacing:2px;color:var(--qyt-q-secondary,#53595f);opacity:.7}
[data-slot="conversation.header"] header{padding:17px 25px;font-size:13px}.reading-content{flex:1;min-height:0}.reading-scroll{height:100%;overflow:auto;padding:30px 24px}.reading-scroll article{max-width:700px;margin:0 auto;padding:0 18px;font-size:15px;line-height:1.9}.reading-scroll article p{margin:24px 0}.reading-scroll article h2{font-size:21px;margin-top:35px}.user-message{padding:13px 18px;background:var(--qyt-q-selected,#d6e7e1);border-radius:16px;max-width:88%;margin-left:auto}.reading-scroll pre{padding:18px;background:var(--qyt-q-raised,#f1f2f1);border-radius:12px;overflow:auto;font-size:13px}[data-composer-seat]{position:relative;isolation:isolate;max-width:736px;margin:50px auto 0}
@media(max-width:800px){.sidebar-shell{width:225px}.preview-composer footer .model{display:none}.composer-meta{gap:15px}.hero-copy h1{font-size:21px}.preview-tools span{display:none}.preview-caption{display:none}}
@media(max-width:560px){.sidebar-shell{display:none}section[data-phase="hero"]{padding:0 18px}.hero-copy{margin-top:7vh}.preview-tools{top:10px;right:10px}.reading-scroll{padding:25px 12px}.reading-scroll article{padding:0 8px}}
`
const html = `<!doctype html><html data-platform="darwin" lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ocean · 动态背景预览</title><style>${css}</style></head><body><div class="app"><div data-slot="sidebar" class="sidebar-shell"><aside class="sidebar"><div class="traffic"><i></i><i></i><i></i></div><div class="logo">◕ deepseek <small>HARNESS</small></div><button class="new-chat">⊕ 新会话</button><button class="nav-row">♧ 插件</button><button class="nav-row">◷ 自动化任务</button><button class="nav-row">▤ 上下文洞察</button><button class="nav-row">⁙ 更多</button><div class="workspaces"><span>工作区</span><span>⌕　⚙　⊞</span></div><div class="workspace">▱ whats-page</div><div class="session">查看浏览器已打开的页面 <small>1天</small></div><div class="session">分析 WhatsApp 唤起链接生… <small>5天</small></div><div class="workspace">▱ whatsapp-page-local</div><div class="session">复制 ovruliz 站点并保持一致 <small>18小时</small></div><div class="workspace">▱ go-whatsapp-web-multidevice</div><div class="workspace">▱ attest</div><div class="session selected">新会话</div><div class="session">Unclear message fragment <small>21小时</small></div><div class="session">测试上下文 <small>6天</small></div><div class="session">本地通过但服务器报 503 原因 <small>26天</small></div><div class="session">Vasama 搭建梯子教程 <small>1个月</small></div><div class="workspace">▱ whatsApp_yw</div><div class="session">待办清单网页实现方案 <small>6天</small></div><div class="session">审查最后一个提交 <small>6天</small></div><div class="sidebar-foot"><span class="avatar">Q</span>QiuYa</div></aside></div><main data-slot="main.conversation"></main></div><div class="preview-tools"><span>本地效果预览</span><button id="preview-motion" aria-pressed="true">动态</button><button id="preview-dark" aria-pressed="false">深色</button><button id="preview-reading" aria-pressed="false">阅读</button></div><div class="preview-caption">OCEAN · 随海风呼吸</div><script type="module">${js.replaceAll('</script', '<\\/script')}</script></body></html>`
await writeFile(join(output, 'preview.html'), html)
const server = createServer((request, response) => {
  if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return }
  response.setHeader('Content-Type', 'text/html; charset=utf-8')
  response.end(html)
})
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(requestedPort, '127.0.0.1', resolve) })
const url = `http://127.0.0.1:${server.address().port}/`

if (serve) {
  console.log(`Ocean preview: ${url}`)
  console.log('Local fixture only. Ctrl+C stops the preview.')
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)))
} else {
  let browser
  try {
    browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}) })
    const errors = [], warnings = []
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
    const page = await context.newPage()
    page.setDefaultTimeout(12_000)
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); if (message.type() === 'warning') warnings.push(message.text()) })
    await page.goto(url)
    await page.waitForFunction(() => window.__oceanFixtureReady === true)
    const ready = async () => page.waitForFunction(() => document.querySelector('canvas[data-qyt-ocean-scene][data-ready="true"]') && document.querySelector('[data-phase][data-qyt-ocean-live]'))
    await ready()
    assert.equal(await page.locator('canvas[data-qyt-ocean-scene]').count(), 1)
    const initial = await page.evaluate(() => {
      const canvas = document.querySelector('canvas[data-qyt-ocean-scene]'), style = getComputedStyle(canvas)
      const rect = canvas.getBoundingClientRect(), phase = canvas.parentElement.getBoundingClientRect()
      return { width: canvas.width, height: canvas.height, cssWidth: rect.width, cssHeight: rect.height, phaseWidth: phase.width, phaseHeight: phase.height, pointerEvents: style.pointerEvents, ariaHidden: canvas.getAttribute('aria-hidden'), role: canvas.getAttribute('role') }
    })
    assert.ok(initial.width > 0 && initial.height > 0, 'Scene must have a real drawing buffer')
    assert.equal(initial.pointerEvents, 'none', 'Background cannot intercept the composer')
    await page.screenshot({ path: join(output, 'ocean-home.png') })
    const scene = page.locator('[data-phase="hero"]')
    const firstFrame = await scene.screenshot()
    // Capture the real background canvas in-browser. This keeps the preview
    // self-contained and does not require Playwright's optional ffmpeg binary.
    const recording = page.evaluate(async () => {
      const canvas = document.querySelector('canvas[data-qyt-ocean-scene]')
      if (!canvas?.captureStream || typeof MediaRecorder === 'undefined') return null
      const stream = canvas.captureStream(30), chunks = []
      const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type))
      if (!mimeType) { stream.getTracks().forEach(track => track.stop()); return null }
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 3_000_000 })
      recorder.addEventListener('dataavailable', event => { if (event.data.size) chunks.push(event.data) })
      const stopped = new Promise((resolve, reject) => { recorder.addEventListener('stop', resolve, { once: true }); recorder.addEventListener('error', reject, { once: true }) })
      recorder.start()
      await new Promise(resolve => setTimeout(resolve, 10_000))
      recorder.stop(); await stopped
      stream.getTracks().forEach(track => track.stop())
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(',')[1])
        reader.onerror = reject
        reader.readAsDataURL(new Blob(chunks, { type: mimeType }))
      })
    })
    const detailFrames = (async () => {
      // A full buoyancy cycle helps reveal discontinuities at flexible edges.
      for (let index = 1; index <= 4; index++) {
        await page.waitForTimeout(2000)
        await page.screenshot({ path: join(output, `tail-detail-${index}.png`), clip: { x: 1030, y: 320, width: 360, height: 180 } })
      }
    })()
    await page.mouse.move(900, 750, { steps: 35 }); await page.waitForTimeout(1300)
    const secondFrame = await scene.screenshot()
    assert.equal(firstFrame.equals(secondFrame), false, 'The scene must change across live frames')
    await page.mouse.move(1290, 340, { steps: 40 }); await page.waitForTimeout(900)
    await page.mouse.move(540, 720, { steps: 40 }); await page.waitForTimeout(900)
    const video = await recording
    await detailFrames
    if (video) await writeFile(join(output, 'ocean-motion.webm'), Buffer.from(video, 'base64'))
    else warnings.push('The browser does not support recording the background canvas.')
    const composer = page.getByRole('textbox', { name: '描述你想构建的内容' })
    await composer.fill('海风、云朵和鲸鱼，都在慢慢呼吸。')
    assert.equal(await composer.inputValue(), '海风、云朵和鲸鱼，都在慢慢呼吸。')
    await composer.fill(''); await composer.blur()
    await page.getByRole('button', { name: '深色', exact: true }).click()
    await page.screenshot({ path: join(output, 'ocean-dark.png') })
    await page.getByRole('button', { name: '阅读', exact: true }).click(); await ready()
    await page.screenshot({ path: join(output, 'ocean-reading.png') })
    await page.getByRole('button', { name: '深色', exact: true }).click()
    await page.screenshot({ path: join(output, 'ocean-reading-light.png') })
    await page.getByRole('button', { name: '阅读', exact: true }).click(); await ready()
    await page.evaluate(() => window.__oceanFixture.rebuild('hero')); await ready()
    assert.equal(await page.locator('canvas[data-qyt-ocean-scene]').count(), 1, 'DOM replacement cannot duplicate canvases')
    await page.evaluate(() => window.__oceanFixture.setTheme(false))
    await page.waitForFunction(() => !document.querySelector('canvas[data-qyt-ocean-scene]') && !document.querySelector('[data-qyt-ocean-live]'))
    await page.evaluate(() => window.__oceanFixture.setTheme(true)); await ready()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.waitForFunction(() => !document.querySelector('[data-qyt-ocean-live]'))
    await page.screenshot({ path: join(output, 'ocean-reduced-motion.png') })
    await page.emulateMedia({ reducedMotion: 'no-preference' }); await ready()
    await page.emulateMedia({ forcedColors: 'active' })
    await page.waitForFunction(() => !document.querySelector('[data-qyt-ocean-live]'))
    await page.emulateMedia({ forcedColors: 'none' }); await ready()
    await page.getByRole('button', { name: '动态', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('[data-qyt-ocean-live]'))
    await page.getByRole('button', { name: '动态', exact: true }).click(); await ready()
    await page.setViewportSize({ width: 480, height: 820 }); await ready()
    await page.screenshot({ path: join(output, 'ocean-mobile.png') })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Small viewport must not overflow')
    await page.evaluate(() => window.__oceanFixture.dispose())
    await page.waitForFunction(() => !document.querySelector('canvas[data-qyt-ocean-scene]') && !document.querySelector('[data-qyt-ocean-live]'))
    const fallback = await context.newPage()
    fallback.on('pageerror', error => errors.push(error.message))
    await fallback.addInitScript(() => {
      const native = HTMLCanvasElement.prototype.getContext
      HTMLCanvasElement.prototype.getContext = function(type, ...args) {
        return /webgl/iu.test(type) ? null : native.call(this, type, ...args)
      }
    })
    await fallback.goto(url)
    await fallback.waitForFunction(() => window.__oceanFixtureReady === true)
    await fallback.waitForTimeout(400)
    assert.equal(await fallback.locator('[data-qyt-ocean-live]').count(), 0, 'Unavailable WebGL must retain static fallback')
    assert.match(await fallback.locator('[data-phase]').evaluate(element => getComputedStyle(element).backgroundImage), /data:image\/webp;base64/u)
    await fallback.getByRole('textbox', { name: '描述你想构建的内容' }).fill('静态回退仍然可以输入')
    await fallback.evaluate(() => window.__oceanFixture.dispose())
    await fallback.close()
    assert.deepEqual(errors, [], 'Preview cannot log browser errors')
    await context.close()
    const report = { passed: true, browser: await browser.version(), initial, checks: ['live rendering', 'mouse movement', 'composer input', 'native dark palette', 'reading phase', 'DOM replacement', 'theme toggle cleanup', 'system reduced motion', 'forced colors', 'preview motion toggle', 'small viewport', 'WebGL unavailable fallback', 'unload cleanup'], screenshots: ['ocean-home.png', 'ocean-dark.png', 'ocean-reading.png', 'ocean-reading-light.png', 'ocean-reduced-motion.png', 'ocean-mobile.png'], video: video ? 'ocean-motion.webm' : null, warnings, errors, evidenceBoundary: 'Runs the actual theme installer and WebGL renderer in Chromium with an account-free fixture. The video records the background canvas, without the fixture UI or CSS color wash. Does not assert installation in the live Harness app.' }
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report, null, 2))
  } finally {
    await browser?.close()
    await new Promise(resolve => server.close(resolve))
  }
}
