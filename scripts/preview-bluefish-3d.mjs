import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('..', import.meta.url))
const outputAt = process.argv.indexOf('--output')
const output = resolve(outputAt < 0 ? join(root, 'artifacts/ocean-scene/bluefish-3d') : process.argv[outputAt + 1])
const modelDigest = createHash('sha256')
for (const file of ['model.ts','face.ts','hair.ts','costume.ts','motion.ts','scene.ts','profile-geometry.ts']) {
  modelDigest.update(await readFile(join(root,'src/client/bluefish-3d',file)))
}
// Include this preview document so UI changes also refresh an already-open pane.
modelDigest.update(await readFile(fileURLToPath(import.meta.url)))
const modelSha256 = modelDigest.digest('hex')
await mkdir(output, { recursive: true })
const source = `
  import {createBluefishWorld} from './src/client/bluefish-3d/scene.ts';
  const canvas = document.querySelector('canvas');
  const message = document.querySelector('output');
  const labels = {
    review:'造型查看', sit:'岸边待机', discover:'发现蝴蝶', plant:'起身踩稳', step:'追上蝴蝶', jump:'起跳伸手', land:'屈膝落地',
    return:'返回岸边', 'walk-to-water':'走向水边', 'enter-water':'入水', dive:'下潜',
    'swim-underwater':'水下划水', 'reach-for-fish':'伸手抓鱼', surface:'浮出海面', 'leave-water':'出水上岸',
  };
  let drag, frame, world;
  const revision = '${modelSha256}';
  // Poll independently of the 3D boot so a transient build error cannot
  // strand an already-open sidebar pane; the next good build reloads it.
  const live = location.protocol === 'http:' ? setInterval(async () => {
    if (drag) return;
    try {
      const response = await fetch('/__bluefish_revision', { cache: 'no-store' });
      const next = response.ok ? (await response.text()).trim() : '';
      if (/^[a-f0-9]{64}$/.test(next) && next !== revision) {
        const current = window.bluefishFrame;
        if (current && window.bluefishWorld) sessionStorage.setItem('bluefish-model-view', JSON.stringify({ yaw: current.cameraYaw, pitch: current.cameraPitch }));
        location.reload();
      }
    } catch {}
  }, 1500) : undefined;
  addEventListener('pagehide', event => {
    if (event.persisted) return;
    clearInterval(live);
    cancelAnimationFrame(frame);
    world?.dispose();
  });
  try {
    world = createBluefishWorld(canvas);
    window.bluefishWorld = world;
    const restoredView = sessionStorage.getItem('bluefish-model-view');
    if (restoredView) {
      sessionStorage.removeItem('bluefish-model-view');
      try { const view = JSON.parse(restoredView); world.restoreCamera(view.yaw, view.pitch); } catch {}
    }
    let lastLabel, lastView;
    const viewButtons = Array.from(document.querySelectorAll('[data-view]'));
    for (const button of document.querySelectorAll('[data-action]')) button.addEventListener('click', () => {
      for (const other of document.querySelectorAll('[data-action]')) other.setAttribute('aria-pressed', String(other === button));
      world.play(button.dataset.action);
    });
    for (const button of viewButtons) button.addEventListener('click', () => {
      for (const other of viewButtons) other.setAttribute('aria-pressed', String(other === button));
      world.play('review');
      world.restoreCamera(Number(button.dataset.view) * Math.PI / 180, 0);
    });
    document.querySelector('#orbit').addEventListener('click', () => world.resetCamera());
    canvas.addEventListener('pointerdown', event => {
      if (!event.isPrimary || event.button !== 0) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove', event => {
      if (drag?.id === event.pointerId) {
        world.orbit(event.clientX - drag.x, event.clientY - drag.y);
        drag.x = event.clientX; drag.y = event.clientY;
        return;
      }
      const bounds = canvas.getBoundingClientRect();
      world.aim(2 * ((event.clientX - bounds.left) / bounds.width) - 1, 1 - 2 * ((event.clientY - bounds.top) / bounds.height));
    });
    canvas.addEventListener('lostpointercapture', event => {
      if (drag?.id === event.pointerId) drag = undefined;
    });
    canvas.addEventListener('pointerleave', () => world.aim(0, 0));
    function draw(now) {
      const result = world.draw(now);
      const label = labels[result.stage] + (result.caught ? ' · 已抓到鱼' : '');
      if (label !== lastLabel) {
        message.textContent = label;
        lastLabel = label;
      }
      canvas.parentElement.classList.toggle('review', result.active === 'review');
      const view = result.active === 'review' && Math.abs(result.cameraPitch) < .035
        ? viewButtons.find(button => {
          const angle = result.cameraYaw - Number(button.dataset.view) * Math.PI / 180;
          return Math.abs(Math.atan2(Math.sin(angle), Math.cos(angle))) < .035;
        })?.dataset.view ?? '' : '';
      if (view !== lastView) {
        for (const button of viewButtons) button.setAttribute('aria-pressed', String(button.dataset.view === view));
        lastView = view;
      }
      window.bluefishFrame = result;
      if (window.bluefishContacts && result.stage === 'step') window.bluefishContacts.push(...result.contacts);
      frame = requestAnimationFrame(draw);
    }
    frame = requestAnimationFrame(draw);
  } catch (error) {
    message.textContent = '当前浏览器未能启动 WebGL。';
    throw error;
  }
`
const bundle = await build({
  stdin: { contents: source, resolveDir: root, loader: 'ts' },
  bundle: true, write: false, target: 'es2022', format: 'iife', legalComments: 'inline', minify: true,
})
const html = join(output, 'bluefish-3d.html')
await writeFile(html, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="bluefish-model-revision" content="${modelSha256}"><title>蓝色大肥鱼 · 实时建模</title><style>
*{box-sizing:border-box}body{margin:0;background:#e9f0f5;color:#193358;font:15px system-ui,-apple-system,sans-serif}
main{width:min(1180px,100%);margin:auto;padding:28px 32px 24px}
header{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:17px}
h1{font-size:25px;margin:0 0 5px}p{margin:0;color:#526b87}
small{padding:8px 11px;border:1px solid #d0dce9;border-radius:8px;font-weight:650;white-space:nowrap}
.stage{position:relative;border-radius:18px;overflow:hidden;box-shadow:0 14px 35px #16386521;
background:radial-gradient(ellipse at 13% 12%,#fff5d8,transparent 31%),linear-gradient(#97c7ed 0%,#dbeef8 55%,#9ac6df 100%)}
.stage.review{background:radial-gradient(ellipse at 48% 32%,#fbfcff 10%,#e1ebfc 76%,#d2dff3 100%)}
canvas{display:block;width:100%;height:clamp(420px,64vh,660px);cursor:grab;touch-action:none}canvas:active{cursor:grabbing}
output{position:absolute;bottom:16px;left:16px;border-radius:7px;background:#102c4bd9;color:white;padding:8px 12px;font-weight:600;pointer-events:none}
.controls{display:flex;flex-wrap:wrap;gap:9px;margin-top:19px}
button{border:1px solid #cad9eb;background:#f7fbff;color:#274770;padding:9px 15px;border-radius:8px;cursor:pointer;font:inherit;font-weight:650}
button[aria-pressed=true]{background:#31589b;color:white;border-color:#31589b}
.views{display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin-top:10px;color:#5b7290;font-size:13px}
.views>span{font-weight:650;margin-right:3px}
.views button{padding:6px 11px;font-size:13px;border-radius:7px}
#orbit{margin-left:auto}
@media(max-width:620px){main{padding:16px}h1{font-size:21px}small{display:none}canvas{height:480px}#orbit{margin-left:0}}
</style><main><header><div><h1>蓝色大肥鱼 · 实时建模</h1><p>拖动旋转视角，或选择下方六个造型角度 · 修改后自动更新</p></div><small>造型已同步</small></header>
<div class="stage"><canvas aria-label="蓝色大肥鱼 3D 场景"></canvas><output>正在准备 3D 场景</output></div>
<div class="controls" aria-label="选择动作"><button data-action="review" aria-pressed="true">造型查看</button><button data-action="idle" aria-pressed="false">岸边待机</button><button data-action="chase" aria-pressed="false">追蝴蝶</button><button data-action="swim" aria-pressed="false">入海游泳</button><button data-action="fish" aria-pressed="false">下潜抓鱼</button><button id="orbit">重置视角</button></div>
<div class="views" aria-label="造型视角"><span>造型视角</span><button data-view="0" aria-pressed="true">正面 00°</button><button data-view="45">左前 45°</button><button data-view="90">左侧 90°</button><button data-view="135">左后 135°</button><button data-view="180">背面 180°</button><button data-view="270">右侧 270°</button></div>
</main><script>${bundle.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script></html>`)
if (process.argv.includes('--generate-only')) {
  console.log(html)
} else {
  const browser = await chromium.launch({
    headless: true,
    ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}),
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1140, height: 800 }, deviceScaleFactor: process.argv.includes('--detail') ? 2 : 1 })
    const errors = []
    const imageRequests = []
    page.on('request', request => { if (request.resourceType() === 'image') imageRequests.push(request.url()) })
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error' && /WebGLProgram|shader/i.test(message.text())) errors.push(message.text()) })
    await page.goto(pathToFileURL(html).href)
    await page.waitForFunction(() => window.bluefishFrame, { timeout: 8000 })
    const stage = page.locator('.stage')
    const projections = {}
    async function captureReview(name) {
      await stage.screenshot({ path: join(output, name + '.png') })
      if (process.argv.includes('--matte')) {
        const { data, projection } = await page.evaluate(() => {
          const world = window.bluefishWorld
          world.draw(performance.now())
          return {
            data: document.querySelector('canvas').toDataURL('image/png').split(',')[1],
            projection: world.reviewProjection(),
          }
        })
        projections[name] = projection
        await writeFile(join(output, name + '-matte.png'), Buffer.from(data, 'base64'))
      }
    }
    const drawState = await page.evaluate(() => {
      const world = window.bluefishWorld
      const canvas = document.querySelector('canvas')
      const now = performance.now()
      world.restoreCamera(0, 0)
      world.draw(now)
      const front = canvas.toDataURL('image/png')
      world.draw(now)
      const repeatedFrameMatches = canvas.toDataURL('image/png') === front
      for (const angle of [Math.PI / 2, Math.PI / 4, 0]) {
        world.restoreCamera(angle, 0)
        world.draw(now)
      }
      return { repeatedFrameMatches, returnedViewMatches: canvas.toDataURL('image/png') === front }
    })
    assert.deepEqual(drawState, { repeatedFrameMatches: true, returnedViewMatches: true },
      'Inspection frames must not retain color, depth or stencil from earlier draws')
    await captureReview('model-front')
    const bounds = await page.locator('canvas').boundingBox()
    const startYaw = await page.evaluate(() => window.bluefishFrame.cameraYaw)
    const angles = { 'model-front': startYaw }
    async function drag(dx, dy, filename) {
      const yaw = await page.evaluate(() => window.bluefishFrame.cameraYaw)
      const x = Math.round(bounds.x + bounds.width * .37), y = Math.round(bounds.y + bounds.height * .43)
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x + dx, y + dy, { steps: 12 })
      await page.mouse.up()
      await page.waitForFunction(({ yaw, dx }) => Math.abs(window.bluefishFrame.cameraYaw - (yaw - dx * .009)) < .012, { yaw, dx })
      const selected = await page.locator('[data-view][aria-pressed="true"]').evaluateAll(buttons => buttons.map(button => button.getAttribute('data-view')))
      const presets = {
        'model-front-quarter': ['45'], 'model-left': ['90'], 'model-back-quarter': ['135'],
        'model-back': ['180'], 'model-back-quarter-opposite': [], 'model-right': ['270'],
      }
      assert.deepEqual(selected, presets[filename], `The angle controls follow the actual dragged view: ${filename}`)
      await captureReview(filename)
      angles[filename] = await page.evaluate(() => window.bluefishFrame.cameraYaw)
    }
    const quarterTurn = -Math.PI / 4 / .009
    await drag(quarterTurn, 0, 'model-front-quarter')
    await drag(quarterTurn, 0, 'model-left')
    await drag(quarterTurn, 0, 'model-back-quarter')
    await drag(quarterTurn, 0, 'model-back')
    await drag(quarterTurn, 0, 'model-back-quarter-opposite')
    await drag(quarterTurn, 0, 'model-right')

    // The narrow live pane must fit the tail throughout a full orbit at
    // the same scale. Read the transparent render before compositing the UI.
    const desktop = page.viewportSize()
    await page.setViewportSize({ width: 360, height: 700 })
    const sidebar = await page.evaluate(() => {
      const canvas = document.querySelector('canvas')
      const world = window.bluefishWorld
      const probe = document.createElement('canvas')
      const context = probe.getContext('2d', { willReadFrequently: true })
      let margin = Infinity
      for (let angle = 0; angle < 360; angle += 22.5) {
        world.restoreCamera(angle * Math.PI / 180, 0)
        world.draw(performance.now())
        probe.width = canvas.width
        probe.height = canvas.height
        context.drawImage(canvas, 0, 0)
        const pixels = context.getImageData(0, 0, probe.width, probe.height).data
        let left = probe.width, right = -1
        for (let y = 0; y < probe.height; y++) {
          for (let x = 0; x < probe.width; x++) {
            if (pixels[(y * probe.width + x) * 4 + 3] < 64) continue
            left = Math.min(left, x)
            right = Math.max(right, x)
          }
        }
        if (right < 0) throw new Error('The sidebar model rendered no pixels')
        margin = Math.min(margin, left, probe.width - 1 - right)
      }
      return { width: canvas.clientWidth, edgeMargin: margin / devicePixelRatio }
    })
    assert.ok(sidebar.edgeMargin >= 4, `The sidebar orbit clips the character: ${JSON.stringify(sidebar)}`)
    await page.setViewportSize(desktop)
    await page.getByRole('button', { name: '重置视角' }).click()
    await page.waitForFunction(yaw => Math.abs(window.bluefishFrame.cameraYaw - yaw) < .02, startYaw)

    assert.deepEqual(errors, [])
    assert.deepEqual(imageRequests, [], 'The modeled character does not request image textures')
    const review = { html, modelSha256, capturedAt: new Date().toISOString(), angles, sidebar, projections, viewControlsVerified: true, drawStateVerified: drawState, errors, imageRequests, visualAcceptance: 'pending' }
    await writeFile(join(output,'review.json'),JSON.stringify(review,null,2)+'\n')
    if (process.argv.includes('--review-only')) console.log(review)
    else {

      async function play(name, action, shots) {
        await page.getByRole('button', { name, exact: true }).click()
        await page.waitForFunction(action => window.bluefishFrame?.active === action, action)
        for (const [time, filename] of shots) {
          await page.waitForFunction(time => window.bluefishFrame.time >= time, time)
          await stage.screenshot({ path: join(output, filename + '.png') })
        }
        const result = await page.evaluate(() => window.bluefishFrame)
        await page.waitForFunction(() => window.bluefishFrame?.active === 'idle')
        return result
      }
      await page.evaluate(() => { window.bluefishContacts = [] })
      const chase = await play('追蝴蝶', 'chase', [[1.12, 'standing'], [1.97, 'walk'], [2.94, 'reach']])
      const soles = await page.evaluate(() => window.bluefishContacts)
      const contacts = Map.groupBy(soles, ({ leg, step }) => `${leg}:${step}`)
      const measured = [...contacts.values()].filter(steps => steps.length >= 5)
      assert.ok(measured.length >= 2, 'The chase has at least two sampled support steps')
      const footDrift = Math.max(...measured.map(points => Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x))))
      assert.ok(footDrift < .025, `Planted foot drifted by ${footDrift} world units`)
      assert.ok(soles.every(({ y }) => Math.abs(y - .10) < .025), 'Planted soles stay at ground height')
      const fish = await play('下潜抓鱼', 'fish', [[3.27, 'enter'], [4.57, 'swim'], [5.47, 'catch'], [8.02, 'surface']])
      const swim = await play('入海游泳', 'swim', [[5.25, 'underwater']])
      assert.deepEqual(errors, [])
      assert.equal(chase.active, 'chase')
      assert.equal(swim.submerged, true, 'The head goes below the rendered surface')
      assert.ok(fish.caught && fish.closest < .32, `The fish should meet the wrist in world space: ${JSON.stringify(fish)}`)
      const report = { passed: true, html, modelSha256, visualAcceptance: 'pending', chase, footDrift, fish, swim }
      await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n')
      console.log(report)
    }
  } finally {
    await browser.close()
  }
}
