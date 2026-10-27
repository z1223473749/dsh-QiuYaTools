/** Account-free visual preview and browser acceptance for the living Ocean theme. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { installOceanPerformanceProbe } from './ocean-performance.mjs'
import { inspectSceneMotion, inspectWakeMotion, recordOceanUi } from './ocean-perception.mjs'
import { inspectFaceShape } from './ocean-face-shape.mjs'
import { inspectBodyShape } from './ocean-body-shape.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const output = resolve(root, 'artifacts/ocean-scene')
const serve = process.argv.includes('--serve')
const motionOnly = process.argv.includes('--motion-only')
const wakeOnly = process.argv.includes('--wake-only')
const faceOnly = process.argv.includes('--face-only')
const shapeOnly = process.argv.includes('--shape-only')
const parityOnly = process.argv.includes('--parity-only')
const portArgument = process.argv.find(argument => argument.startsWith('--port='))
const requestedPort = portArgument ? Number(portArgument.split('=')[1]) : serve ? 4317 : 0
assert.ok(Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65535, 'Use --port=0..65535')
await mkdir(output, { recursive: true })
await promisify(execFile)(process.execPath, [join(root, 'scripts/preview-ocean-settings.mjs'), '--generate-only'], { cwd: root })

const fixture = `
import {installQTheme} from ${JSON.stringify(join(root, 'src/client/q-theme.ts'))};
const performanceProbe=(${installOceanPerformanceProbe.toString()})();
const uniformNames=new WeakMap(), currentLayers=new WeakMap(), captureRestorers=[];
let heldTime=null,pendingCapture=null,captureQueued=false,skippedLayers=[];
for(const type of [window.WebGLRenderingContext,window.WebGL2RenderingContext]){
  if(!type)continue;
  for(const operation of ['getUniformLocation','uniform1f','drawArrays','drawElements']){
    const native=type.prototype[operation];
    const wrapped=function(...args){
      if(operation==='uniform1f'&&uniformNames.get(args[0])==='u_time'&&heldTime!==null)args[1]=heldTime;
      if(operation==='uniform1f'&&uniformNames.get(args[0])==='u_layer')currentLayers.set(this,args[1]);
      const drawing=operation==='drawArrays'||operation==='drawElements';
      const value=drawing&&skippedLayers.includes(currentLayers.get(this))?undefined:native.apply(this,args);
      if(operation==='getUniformLocation'&&value)uniformNames.set(value,args[1]);
      if((operation==='drawArrays'||operation==='drawElements')&&pendingCapture&&!captureQueued&&this.canvas?.hasAttribute('data-qyt-ocean-scene')){captureQueued=true;const canvas=this.canvas;queueMicrotask(()=>{captureQueued=false;if(pendingCapture){const capture=pendingCapture;pendingCapture=null;clearTimeout(capture.timer);capture.resolve(canvas.toDataURL('image/png'))}})}
      return value;
    };
    type.prototype[operation]=wrapped;
    captureRestorers.push(()=>{if(type.prototype[operation]===wrapped)type.prototype[operation]=native});
  }
}
function captureAt(time,options={}){if(pendingCapture)throw Error('Finish the previous frame capture first');heldTime=time;skippedLayers=options.skipLayers??[];return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pendingCapture=null;reject(Error('Timed out capturing a deterministic Ocean frame'))},3000);pendingCapture={resolve,reject,timer}})}
const listeners=new Set();
const settingsKey='qyt.ocean.preview.settings';
function storedSettings(){try{const value=JSON.parse(localStorage.getItem(settingsKey)||'null');return value&&typeof value==='object'?{...value,qThemeEnabled:value.qThemeEnabled??true}:{qThemeEnabled:true,qThemeSettings:{ocean:{motion:'dynamic'}}}}catch{return{qThemeEnabled:true,qThemeSettings:{ocean:{motion:'dynamic'}}}}}
let preferences=storedSettings();
const form={getSnapshot:()=>({status:'ready',value:preferences}),subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}};
let cleanup;
const main=document.querySelector('[data-slot="main.conversation"]');
const hero=()=>'<section data-phase="hero"><div class="hero-copy"><h1><span class="brand-whale">◕</span> 探索未知之境 <small>预览版</small></h1><div class="composer-meta"><span>▱ attest⌄</span><span>♧ 创造模式⌄</span><span>⑂ main⌄</span></div><div class="preview-composer" data-composer-card><textarea aria-label="描述你想构建的内容" placeholder="描述你想构建的内容，/ 调用指令，@ 文件或对话"></textarea><footer><div><button aria-label="添加附件">＋</button><span>♧ 工作区内修改⌄</span><span>▣ 这台电脑⌄</span></div><div class="model">DeepSeek-V4.1-Flash <em>1017</em> High⌄ <button class="send" aria-label="发送">↑</button></div></footer></div></div></section>';
const reading=()=>'<section data-phase="active"><div data-slot="conversation.header"><header>让背景像海风一样呼吸</header></div><div class="reading-content" data-conversation-content><div class="reading-scroll" data-conversation-scroll><article><div class="user-message">让天上的云、海水、鲸鱼和人物的细节都动起来。</div><p>微风掠过海面，远处的云缓慢舒展。少年坐在鲸鱼背上，衣角与发梢轻轻摆动。</p><p>移动鼠标，可以感受画面不同距离之间的细微变化。聊天区域保持安静，让注意力自然留在文字上。</p><h2>一片始终流动的海</h2><p>海水有自己的节奏。鲸鱼随浪轻轻起伏，近处的浪花更鲜明，远处的水面更平缓。</p><pre><code>const ocean = { wind: "gentle", waves: "slow" };</code></pre><p>这是本地效果预览。输入框和按钮仍然可以正常使用。</p>'+'<p>海风掠过书页，远处的鲸鱼与海浪继续起伏。文字沿着原来的阅读区域滚动，输入区保持在窗口底部。</p>'.repeat(10)+'</article><div data-composer-seat><div class="preview-composer" data-composer-card><textarea aria-label="描述你想构建的内容" placeholder="继续聊聊你的想法…"></textarea><footer><div><button aria-label="添加附件">＋</button><span>♧ 工作区内修改⌄</span></div><button class="send" aria-label="发送">↑</button></footer></div><div data-composer-dock><div class="preview-dock" data-slot="conversation.composer.dock"><span data-composer-stat="activity"><span>1 轮 2 步 · 147 tok/s</span></span><span data-composer-stat="usage"><button>88.8K tok · 缓存命中 76%</button></span></div></div></div></div></div></section>';
function rebuild(mode='hero'){main.innerHTML=mode==='active'?reading():hero()}
function notify(){for(const listener of [...listeners])listener()}
function persist(){localStorage.setItem(settingsKey,JSON.stringify(preferences));notify()}
function setTheme(value){preferences={...preferences,qThemeEnabled:value};persist()}
function setMotion(value){preferences={...preferences,qThemeSettings:{...preferences.qThemeSettings,ocean:{...preferences.qThemeSettings?.ocean,motion:value?'dynamic':'static'}}};persist()}
function setDark(value){document.body.toggleAttribute('data-ds-dark-theme',value)}
rebuild(new URLSearchParams(location.search).get('view')==='conversation'?'active':'hero');cleanup=installQTheme({},form);
function syncStoredSettings(event){if(event.key===settingsKey){preferences=storedSettings();notify()}}
window.addEventListener('storage',syncStoredSettings);
document.getElementById('open-theme-settings').addEventListener('click',()=>location.assign('/settings'));
const performanceTimer=setInterval(()=>{const stats=performanceProbe.snapshot();document.documentElement.dataset.oceanFps=String(stats.webglDraws.fps);document.documentElement.dataset.oceanFrameP95=String(stats.webglDraws.p95Ms??0);document.documentElement.dataset.oceanRafFps=String(stats.browserRaf.fps)},500);
window.__oceanFixture={setTheme,setMotion,setDark,rebuild,captureAt,resumeTime(){heldTime=null;skippedLayers=[]},performance:performanceProbe,dispose(){cleanup();clearInterval(performanceTimer);captureRestorers.reverse().forEach(restore=>restore());performanceProbe.dispose();window.removeEventListener('storage',syncStoredSettings)}};
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
[data-slot="conversation.header"] header{padding:17px 25px;font-size:13px}.reading-content{flex:1;min-height:0}.reading-scroll{position:relative;isolation:isolate;height:100%;overflow:auto;padding:30px 0 0}.reading-scroll article{max-width:700px;margin:0 auto;padding:0 18px;font-size:15px;line-height:1.9}.reading-scroll article p{margin:24px 0}.reading-scroll article h2{font-size:21px;margin-top:35px}.user-message{padding:13px 18px;background:var(--qyt-q-selected,#d6e7e1);border-radius:16px;max-width:88%;margin-left:auto}.reading-scroll pre{padding:18px;background:var(--qyt-q-raised,#f1f2f1);border-radius:12px;overflow:auto;font-size:13px}[data-composer-seat]{position:sticky;bottom:0;isolation:isolate;z-index:7;width:100%;margin:50px auto 0;padding:16px 24px 6px}.reading-scroll [data-composer-card]{max-width:940px;margin:0 auto}.preview-dock{display:flex;justify-content:center;gap:8px;margin:7px auto 0;font-size:11px;color:var(--qyt-q-secondary)}
@media(max-width:800px){.sidebar-shell{width:225px}.preview-composer footer .model{display:none}.composer-meta{gap:15px}.hero-copy h1{font-size:21px}}
@media(max-width:560px){.sidebar-shell{display:none}section[data-phase="hero"]{padding:0 18px}.hero-copy{margin-top:7vh}.reading-scroll{padding:25px 12px}.reading-scroll article{padding:0 8px}}
`
const html = `<!doctype html><html data-platform="darwin" lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ocean · 动态背景预览</title><style>${css}</style></head><body><div class="app"><div data-slot="sidebar" class="sidebar-shell"><aside class="sidebar"><div class="traffic"><i></i><i></i><i></i></div><div class="logo">◕ deepseek <small>HARNESS</small></div><button class="new-chat">⊕ 新会话</button><button id="open-theme-settings" class="nav-row">♧ 插件</button><button class="nav-row">◷ 自动化任务</button><button class="nav-row">▤ 上下文洞察</button><button class="nav-row">⁙ 更多</button><div class="workspaces"><span>工作区</span><span>⌕　⚙　⊞</span></div><div class="workspace">▱ whats-page</div><div class="session">查看浏览器已打开的页面 <small>1天</small></div><div class="session">分析 WhatsApp 唤起链接生… <small>5天</small></div><div class="workspace">▱ whatsapp-page-local</div><div class="session">复制 ovruliz 站点并保持一致 <small>18小时</small></div><div class="workspace">▱ go-whatsapp-web-multidevice</div><div class="workspace">▱ attest</div><div class="session selected">新会话</div><div class="session">Unclear message fragment <small>21小时</small></div><div class="session">测试上下文 <small>6天</small></div><div class="session">本地通过但服务器报 503 原因 <small>26天</small></div><div class="session">Vasama 搭建梯子教程 <small>1个月</small></div><div class="workspace">▱ whatsApp_yw</div><div class="session">待办清单网页实现方案 <small>6天</small></div><div class="session">审查最后一个提交 <small>6天</small></div><div class="sidebar-foot"><span class="avatar">Q</span>QiuYa</div></aside></div><main data-slot="main.conversation"></main></div><script type="module">${js.replaceAll('</script', '<\\/script')}</script></body></html>`
await writeFile(join(output, 'preview.html'), html)
if (process.argv.includes('--generate-only')) { console.log(join(output, 'preview.html')); process.exit(0) }
const server = createServer(async (request, response) => {
  if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return }
  response.setHeader('Content-Type', 'text/html; charset=utf-8')
  if (request.url?.split('?')[0] === '/settings') {
    try { response.end(await readFile(join(output, 'settings-preview.html'), 'utf8')) }
    catch { response.writeHead(404); response.end('Theme settings preview has not been generated.') }
    return
  }
  response.end(html)
})
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(requestedPort, '127.0.0.1', resolve) })
const url = `http://127.0.0.1:${server.address().port}/`

async function inspectHairMotion(page) {
  const epochs = [0, 2, 5, 8], frames = []
  for (const epoch of epochs) frames.push(await page.evaluate(time => window.__oceanFixture.captureAt(time), epoch))
  const result = await page.evaluate(async ({ frames, epochs }) => {
    const scene = document.querySelector('canvas[data-qyt-ocean-scene]'), bounds = scene.getBoundingClientRect()
    const decoded = await Promise.all(frames.map(async source => {
      const image = new Image(); image.src = source; await image.decode()
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
      const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(image, 0, 0)
      return { canvas, pixels: ctx.getImageData(0, 0, canvas.width, canvas.height).data }
    }))
    const fit = Math.max(innerWidth / 1600, innerHeight / 900), scaleX = scene.width / bounds.width, scaleY = scene.height / bounds.height
    const point = (x, y) => [
      (innerWidth - 1600 * fit + x * fit - bounds.left) * scaleX,
      (innerHeight - 900 * fit + y * fit - bounds.top) * scaleY,
    ]
    const region = ([x1, y1, x2, y2]) => { const [x, y] = point(x1, y1), [right, bottom] = point(x2, y2); return { x: Math.round(x), y: Math.round(y), width: Math.round(right - x), height: Math.round(bottom - y) } }
    const rois = { face: region([1065, 395, 1093, 418]), crown: region([1070, 350, 1120, 378]), back: region([1120, 398, 1145, 425]) }
    function match(target, roi) {
      const reference = decoded[0].pixels, width = scene.width, edgePixels = []
      for (let y = roi.y; y < roi.y + roi.height; y++) for (let x = roi.x; x < roi.x + roi.width; x++) {
        const offset = (y * width + x) * 4
        if (Math.abs(reference[offset] - reference[offset + 4]) + Math.abs(reference[offset] - reference[offset + width * 4]) > 8) edgePixels.push([x, y, offset])
      }
      let best = { dx: 0, dy: 0, meanError: Infinity, edgePixels: edgePixels.length }
      for (let dy = -24; dy <= 24; dy++) for (let dx = -24; dx <= 24; dx++) {
        let error = 0
        for (const [x, y, offset] of edgePixels) {
          const shifted = ((y + dy) * width + x + dx) * 4
          error += Math.abs(reference[offset] - target[shifted]) + Math.abs(reference[offset + 1] - target[shifted + 1]) + Math.abs(reference[offset + 2] - target[shifted + 2])
        }
        const meanError = error / Math.max(1, edgePixels.length * 3)
        if (meanError < best.meanError) best = { dx, dy, meanError, edgePixels: edgePixels.length }
      }
      return best
    }
    const comparisons = decoded.slice(1).map((frame, index) => {
      const matches = Object.fromEntries(Object.entries(rois).map(([name, roi]) => [name, match(frame.pixels, roi)]))
      const relative = name => ({ dx: matches[name].dx - matches.face.dx, dy: matches[name].dy - matches.face.dy, distance: Math.hypot(matches[name].dx - matches.face.dx, matches[name].dy - matches.face.dy) })
      return { epoch: epochs[index + 1], matches, relativeCrown: relative('crown'), relativeBack: relative('back') }
    })
    const crop = region([1038, 338, 1160, 445]), strip = document.createElement('canvas'), zoom = 3
    strip.width = crop.width * zoom * decoded.length; strip.height = crop.height * zoom + 30
    const ctx = strip.getContext('2d'); ctx.fillStyle = '#fafaf8'; ctx.fillRect(0, 0, strip.width, strip.height); ctx.font = '16px sans-serif'; ctx.fillStyle = '#24282b'
    decoded.forEach((frame, index) => { ctx.drawImage(frame.canvas, crop.x, crop.y, crop.width, crop.height, index * crop.width * zoom, 30, crop.width * zoom, crop.height * zoom); ctx.fillText(`t = ${epochs[index]}s`, index * crop.width * zoom + 12, 21) })
    return { epochs, rois, comparisons, maxRelativeCrownPx: Math.max(...comparisons.map(value => value.relativeCrown.distance)), maxRelativeBackPx: Math.max(...comparisons.map(value => value.relativeBack.distance)), strip: strip.toDataURL('image/png') }
  }, { frames, epochs })
  await page.evaluate(() => window.__oceanFixture.resumeTime())
  const { strip, ...report } = result
  await writeFile(join(output, 'hair-wind-comparison.png'), Buffer.from(strip.split(',')[1], 'base64'))
  await writeFile(join(output, 'hair-motion.json'), JSON.stringify(report, null, 2) + '\n')
  assert.ok(result.maxRelativeCrownPx >= 2, `Crown hair must move independently of the face: ${result.maxRelativeCrownPx}px`)
  assert.ok(result.maxRelativeBackPx >= 2, `Back hair must move independently of the face: ${result.maxRelativeBackPx}px`)
  return report
}

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
    if (parityOnly) {
      const { inspectOceanStyleParity } = await import('./ocean-style-parity.mjs')
      const styleParity = await inspectOceanStyleParity(page, output)
      assert.deepEqual(errors, [])
      await page.evaluate(() => window.__oceanFixture.dispose())
      await context.close()
      console.log(JSON.stringify({ passed: true, styleParity, errors, warnings }, null, 2))
    } else if (shapeOnly) {
      const bodyShape = await inspectBodyShape(page, output)
      const faceShape = await inspectFaceShape(page, output)
      await page.evaluate(() => window.__oceanFixture.dispose())
      await context.close()
      console.log(JSON.stringify({ passed: true, fidelity: faceShape.fidelity, faceDistanceChangePx: faceShape.maxPairDistanceChangePx, bodyResidualsArtPx: bodyShape.normalResidualsArtPx, bodyLocalShape: bodyShape.localShape, bodyConcerns: bodyShape.concerns }, null, 2))
    } else if (faceOnly) {
      const faceShape = await inspectFaceShape(page, output)
      await page.evaluate(() => window.__oceanFixture.dispose())
      await context.close()
      console.log(JSON.stringify({ passed: true, fidelity: faceShape.fidelity, maxPairDistanceChangePx: faceShape.maxPairDistanceChangePx }, null, 2))
    } else if (wakeOnly) {
      const wakeMotion = await inspectWakeMotion(page, output)
      await page.evaluate(() => window.__oceanFixture.dispose())
      await context.close()
      console.log(JSON.stringify({ passed: true, fin: wakeMotion.fin.relative, coreLengthVariationPx: wakeMotion.fin.coreLengthVariationPx, foam: wakeMotion.foam }, null, 2))
    } else if (motionOnly) {
      const bodyShape = await inspectBodyShape(page, output)
      const faceShape = await inspectFaceShape(page, output)
      const wakeMotion = await inspectWakeMotion(page, output)
      const sceneMotion = await inspectSceneMotion(page, output)
      await page.screenshot({ path: join(output, 'ocean-home.png') })
      const uiRecording = await recordOceanUi(page, output)
      await copyFile(join(output, 'ocean-ui-motion.webm'), join(output, 'ocean-motion.webm'))
      assert.deepEqual(errors, [])
      const supplement = { passed: true, bodyShape, faceShape, wakeMotion, sceneMotion, uiRecording, errors, warnings, evidenceBoundary: 'Supplemental motion validation after a shader-only change: original face fidelity and rigid landmark distances, body bending/local cross-section diagnostics, fin movement, contact phase screenshots, direction, visible cloud/body/tail movement, fixed 60/180/600 second screenshots, and a fresh 16-second recording of the normal UI. Performance and lifecycle results are retained from the preceding full three-pass browser suite.' }
      await writeFile(join(output, 'motion-final.json'), JSON.stringify(supplement, null, 2) + '\n')
      const previous = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'))
      await writeFile(join(output, 'report.json'), JSON.stringify({ ...previous, bodyShape, faceShape, wakeMotion, sceneMotion, uiRecording, supplementalValidation: supplement.evidenceBoundary }, null, 2) + '\n')
      await page.evaluate(() => window.__oceanFixture.dispose())
      await context.close()
      console.log(JSON.stringify({ passed: true, cloudDirection: sceneMotion.cloudDriftDirection, ranges: sceneMotion.ranges, longTermEpochs: sceneMotion.longTermEpochs, uiRecording, errors, warnings }, null, 2))
    } else {
    await page.waitForTimeout(500)
    await page.evaluate(() => window.__oceanFixture.performance.start())
    await page.waitForTimeout(6000)
    const performance = await page.evaluate(() => window.__oceanFixture.performance.stop())
    await writeFile(join(output, 'performance-current.json'), JSON.stringify(performance, null, 2) + '\n')
    assert.ok(performance.webglDraws.fps >= performance.browserRaf.fps * .85, `The background must follow browser refresh: ${performance.webglDraws.fps} actual WebGL FPS / ${performance.browserRaf.fps} browser rAF FPS`)
    assert.ok(performance.webglDraws.p95Ms <= performance.browserRaf.p95Ms * 1.8 + 4, `The background frame interval is uneven: P95 ${performance.webglDraws.p95Ms}ms`)
    const bodyShape = await inspectBodyShape(page, output)
    const faceShape = await inspectFaceShape(page, output)
    const wakeMotion = await inspectWakeMotion(page, output)
    const sceneMotion = await inspectSceneMotion(page, output)
    const hairMotion = await inspectHairMotion(page)
    await page.screenshot({ path: join(output, 'ocean-home.png') })
    const scene = page.locator('[data-phase="hero"]')
    const firstFrame = await scene.screenshot()
    const uiRecording = await recordOceanUi(page, output)
    await copyFile(join(output, 'ocean-ui-motion.webm'), join(output, 'ocean-motion.webm'))
    await page.mouse.move(900, 750, { steps: 35 }); await page.waitForTimeout(1300)
    const secondFrame = await scene.screenshot()
    assert.equal(firstFrame.equals(secondFrame), false, 'The scene must change across live frames')
    await page.mouse.move(1290, 340, { steps: 40 }); await page.waitForTimeout(900)
    await page.mouse.move(540, 720, { steps: 40 }); await page.waitForTimeout(900)
    const composer = page.getByRole('textbox', { name: '描述你想构建的内容' })
    await composer.fill('海风、云朵和鲸鱼，都在慢慢呼吸。')
    assert.equal(await composer.inputValue(), '海风、云朵和鲸鱼，都在慢慢呼吸。')
    await composer.fill(''); await composer.blur()
    await page.evaluate(() => window.__oceanFixture.setDark(!document.body.hasAttribute('data-ds-dark-theme')))
    await page.screenshot({ path: join(output, 'ocean-dark.png') })
    await page.evaluate(() => window.__oceanFixture.rebuild(document.querySelector('[data-phase]')?.dataset.phase === 'active' ? 'hero' : 'active')); await ready()
    await page.screenshot({ path: join(output, 'ocean-reading.png') })
    await page.evaluate(() => window.__oceanFixture.setDark(!document.body.hasAttribute('data-ds-dark-theme')))
    await page.screenshot({ path: join(output, 'ocean-reading-light.png') })
    await page.evaluate(() => window.__oceanFixture.rebuild(document.querySelector('[data-phase]')?.dataset.phase === 'active' ? 'hero' : 'active')); await ready()
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
    await page.evaluate(() => window.__oceanFixture.setMotion(false))
    await page.waitForFunction(() => !document.querySelector('[data-qyt-ocean-live]'))
    await page.evaluate(() => window.__oceanFixture.setMotion(true)); await ready()
    await page.setViewportSize({ width: 480, height: 820 }); await ready()
    await page.screenshot({ path: join(output, 'ocean-mobile.png') })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Small viewport must not overflow')
    // The settings page uses the real plugin component. Persist its radio
    // choice, then return through a fresh page load to verify the whole path.
    {
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.locator('#open-theme-settings').click()
      await page.waitForURL('**/settings')
      await page.getByRole('radio', { name: '静态', exact: true }).click()
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('qyt.ocean.preview.settings')).qThemeSettings.ocean.motion === 'static')
      await page.goto(url); await page.waitForFunction(() => window.__oceanFixtureReady)
      assert.equal(await page.locator('canvas[data-qyt-ocean-scene]').count(), 0, 'Saved static preference must survive navigation')
      await page.locator('#open-theme-settings').click(); await page.waitForURL('**/settings')
      assert.equal(await page.getByRole('radio', { name: '静态', exact: true }).isChecked(), true)
      await page.getByRole('radio', { name: '动态', exact: true }).click()
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('qyt.ocean.preview.settings')).qThemeSettings.ocean.motion === 'dynamic')
      await page.goto(url); await ready()
    }
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
    const report = { passed: true, browser: await browser.version(), initial, performance, faceShape, bodyShape, hairMotion, wakeMotion, sceneMotion, uiRecording, checks: ['live rendering', 'actual WebGL frame cadence', 'original face skin coverage', 'face and ear shape preservation', 'body spine bend diagnostics', 'local cross-section shape diagnostics', 'hair motion relative to the face', 'fin stroke relative to the body', 'contact-phase screenshots for visual review', 'visible monotonic cloud drift', 'visible body buoyancy', 'tail motion relative to the body', 'normal UI continuous recording', 'mouse movement', 'composer input', 'native dark palette', 'reading phase', 'DOM replacement', 'theme toggle cleanup', 'system reduced motion', 'forced colors', 'per-theme dynamic/static preference', 'settings navigation and persistence', 'small viewport', 'WebGL unavailable fallback', 'unload cleanup'], screenshots: ['ocean-home.png', 'ocean-dark.png', 'ocean-reading.png', 'ocean-reading-light.png', 'ocean-reduced-motion.png', 'ocean-mobile.png'], video: 'ocean-ui-motion.webm', warnings, errors, evidenceBoundary: 'Runs the actual theme installer and WebGL renderer in Chromium with an account-free fixture. WebGL draw submission timing is measured separately from recording and screenshots. The video continuously records the actual composed UI, including the text, input controls and CSS color wash; mouse movement is tested after recording. Does not assert installation in the live Harness app or physical display presentation timing.' }
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify({
      passed: report.passed, browser: report.browser, checks: report.checks.length,
      performance, faceShape: { fidelity: faceShape.fidelity, maxPairDistanceChangePx: faceShape.maxPairDistanceChangePx }, bodyBend: bodyShape.normalResidualsArtPx, bodyConcerns: bodyShape.concerns, finStroke: { inner: { x: wakeMotion.fin.relative.inner.x, y: wakeMotion.fin.relative.inner.y }, tip: { x: wakeMotion.fin.relative.tip.x, y: wakeMotion.fin.relative.tip.y }, coreLengthVariationPx: wakeMotion.fin.coreLengthVariationPx },
      cloudDirection: sceneMotion.cloudDriftDirection, sceneRanges: sceneMotion.ranges, uiRecording,
      video: report.video, report: join(output, 'report.json'), warnings, errors,
    }, null, 2))
    }
  } finally {
    await browser?.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}
