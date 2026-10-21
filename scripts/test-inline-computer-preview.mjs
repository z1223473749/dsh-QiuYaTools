/** Production React/CSS in headless Chromium. No native driver, OS input or real account. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
const base = fileURLToPath(new URL('../', import.meta.url)), index = process.argv.indexOf('--output'), output = resolve(index < 0 ? 'artifacts/computer-use/inline-image-first-web' : process.argv[index + 1])
await mkdir(output, { recursive: true })
const source = (await build({ stdin: { resolveDir: base, loader: 'tsx', contents: `
import React from 'react';import{createRoot}from'react-dom/client';import{installInlineComputerPreview}from'./src/features/computer-use/inline-preview.tsx';import{computerVisualStyles}from'./src/features/computer-use/visual-style.ts';
const style=document.createElement('style');style.textContent=computerVisualStyles;document.head.append(style);
let View,pendingRequests=[],native={platform:'win32',available:true};const states=new Map([['owned','ready'],['other','ready']]),detached=new Map;window.__ownerCalls=[];
const rpc={async call(channel,endpoint,input){
  window.__ownerCalls.push(input);
  if(input.op==='takeover')states.set(input.sessionId,'humanControl');else if(input.op==='pause')states.set(input.sessionId,'paused');
  if(input.op==='preview'||input.op==='redock')detached.set(input.sessionId,input.op==='preview');
  return{ok:true,value:{native,pendingRequests,sessions:[...states].map(([sessionId,state])=>({sessionId,state,epoch:1,target:{title:'Private fixture title'}})),environments:[...detached].map(([sessionId,previewDetached])=>({sessionId,previewDetached}))}};
}};
const ctx={get:()=>({rpc}),slots:{inject:(_name,register)=>register(),register:(_entry,component)=>{View=component;return()=>{}}}};
const snapshot={status:'ready',value:{enabled:true,computerUseEnabled:true}},form={getSnapshot:()=>snapshot,subscribe:()=>()=>{}};
installInlineComputerPreview(ctx,form);const root=createRoot(document.querySelector('#root'));window.__switch=sessionId=>root.render(<View sessionId={sessionId}/>);window.__switch('owned');window.__request=()=>{states.delete('other');native={platform:'darwin',permissions:{screenRecording:false,accessibility:false,inputMonitoring:false}};pendingRequests=[{requestId:'own-request',requestVersion:1,sessionId:'other',appId:'fixture.app',appName:'自有应用',reason:'在这台测试电脑里填写表格',createdAt:Date.now(),expiresAt:Date.now()+60000,state:'pending'}]};
` }, bundle: true, write: false, platform: 'browser', format: 'iife', minify: false })).outputFiles[0].text
const styles = await readFile(join(base, 'src/client/styles.css'), 'utf8')
const frame = '<!doctype html><meta charset=utf-8><style>html,body{margin:0;height:100%;overflow:hidden}canvas{display:block;width:100%;height:100%}</style><canvas id="fixture" width="300" height="180"></canvas><script>const canvas=document.querySelector("canvas"),p=canvas.getContext("2d");p.fillStyle="#b4d8d2";p.fillRect(0,0,300,180);p.fillStyle="#174f59";p.font="18px sans-serif";p.fillText("Owned preview pixels",50,96);window.__inputs=[];window.__actions=[];let down;const xy=event=>{const r=canvas.getBoundingClientRect();return{x:(event.clientX-r.left)*300/r.width,y:(event.clientY-r.top)*180/r.height}};for(const type of ["mousedown","mouseup"])canvas.addEventListener(type,event=>{const r=canvas.getBoundingClientRect();window.__inputs.push({type,x:event.clientX,y:event.clientY,width:r.width,height:r.height});if(type==="mousedown"){event.preventDefault();down=xy(event)}else if(down){const to=xy(event);window.__actions.push({kind:Math.hypot(to.x-down.x,to.y-down.y)>4?"drag":"click",from:down,to});down=undefined}});</script>'
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname
  res.setHeader('Cache-Control', 'no-store')
  if (path === '/client.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(source) }
  else if (path === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end(styles) }
  else if (path === '/api/qiuya-tools.computer.preview') { res.setHeader('Content-Type', 'text/html'); res.end(frame) }
  else res.end('<!doctype html><meta charset=utf-8><link rel="stylesheet" href="/style.css"><style>body{margin:0;background:#eef3f1}@media(prefers-color-scheme:dark){body{background:#172127}}#root{position:absolute;right:32px;top:32px}</style><div id="root"></div><script src="/client.js"></script>')
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const browser = await chromium.launch({ ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : { channel: 'msedge' }), headless: true }), tests = []
let page
try {
  page = await browser.newPage({ viewport: { width: 800, height: 600 }, colorScheme: 'light' })
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  const card = page.locator('[data-qyt-computer-inline]'), actions = card.locator('.qyt-computer-inline-actions')
  await card.waitFor(); await card.locator('iframe').waitFor()
  await card.locator('iframe').contentFrame().locator('#fixture').waitFor()
  await card.locator('iframe').evaluate(node => new Promise(done => node.contentWindow.requestAnimationFrame(() => node.contentWindow.requestAnimationFrame(done))))
  const capture = async name => {
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
    const box = await card.boundingBox(), bytes = await page.screenshot({ path: join(output, name) })
    const pixel = await page.evaluate(async ({ image, x, y }) => {
      const blob = await (await fetch('data:image/png;base64,' + image)).blob(), bitmap = await createImageBitmap(blob)
      try { const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height; const painter = canvas.getContext('2d'); painter.drawImage(bitmap, 0, 0); return [...painter.getImageData(x, y, 1, 1).data] } finally { bitmap.close() }
    }, { image: bytes.toString('base64'), x: Math.round(box.x + 20), y: Math.round(box.y + Math.min(110, box.height - 15)) })
    for (const [index, expected] of [180, 216, 210].entries()) assert.ok(Math.abs(pixel[index] - expected) <= 2, 'The actual exported screenshot must include the independently known fixture pixels')
  }
  const opacity = value => page.waitForFunction(expected => getComputedStyle(document.querySelector('.qyt-computer-inline-actions')).opacity === expected, value)
  await opacity('0')
  assert.equal(await card.locator('.qyt-computer-inline-title,.qyt-computer-status-badge,.qyt-computer-inline-settings').count(), 0)
  const idle = await card.evaluate(node => ({ border: getComputedStyle(node).borderTopWidth, shadow: getComputedStyle(node).boxShadow, rect: { width: node.clientWidth, height: node.clientHeight } }))
  assert.equal(idle.border, '1px'); assert.notEqual(idle.shadow, 'none'); assert.equal(idle.rect.height, 178)
  assert.deepEqual(await card.evaluate(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })), { width: 300, height: 180 })
  await capture('image-only-light.png'); tests.push('default-image-only-with-thin-border-soft-shadow')
  await card.hover(); await opacity('1'); tests.push('mouse-hover-reveals-controls')
  await page.mouse.move(0, 0); await page.keyboard.press('Tab'); await opacity('1')
  assert.equal(await page.getByRole('button', { name: '拖动电脑小预览', exact: true }).evaluate(node => document.activeElement === node), true)
  tests.push('keyboard-tab-focus-within-reveals-controls')
  await page.evaluate(() => document.activeElement.blur()); await opacity('0')
  let bounds = await card.boundingBox()
  await page.mouse.move(bounds.x + 150, bounds.y + 100); await page.mouse.down(); await page.mouse.move(-600, 1500, { steps: 6 })
  await page.waitForFunction(() => document.querySelector('[data-qyt-computer-inline]').dataset.dragging === 'true')
  const during = await card.evaluate(node => ({ shadow: getComputedStyle(node).boxShadow, x: node.getBoundingClientRect().x, bottom: node.getBoundingClientRect().bottom }))
  assert.notEqual(during.shadow, idle.shadow, 'dragging strengthens the same soft shadow'); assert.equal(during.x, 8); assert.ok(during.bottom <= 592); await capture('dragging-light.png')
  await page.mouse.up(); assert.equal(await card.getAttribute('data-dragging'), 'false')
  assert.equal(await page.evaluate(() => window.__ownerCalls.filter(call => call.op !== 'status').length), 0)
  assert.equal(await card.locator('iframe').evaluate(node => node.contentWindow.__inputs.length), 0)
  tests.push('AI-image-drag-stays-in-viewport-and-sends-no-native-or-frame-input')
  await card.hover(); await opacity('1'); await page.getByRole('button', { name: '接管电脑任务', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[data-qyt-computer-inline]').dataset.state === 'humanControl')
  assert.equal(await card.locator('.qyt-computer-inline-drag-surface').count(), 0)
  bounds = await card.boundingBox(); const beforeHuman = { x: bounds.x, y: bounds.y }
  const target = card.locator('iframe').contentFrame().locator('#fixture')
  await target.click({ position: { x: 140, y: 100 } })
  await page.mouse.move(bounds.x + 100, bounds.y + 90); await page.mouse.down(); await page.mouse.move(bounds.x + 220, bounds.y + 150, { steps: 5 }); await page.mouse.up()
  const inputs = await target.evaluate(node => window.__inputs)
  assert.deepEqual(inputs.map(row => row.type), ['mousedown', 'mouseup', 'mousedown', 'mouseup'])
  bounds = await card.boundingBox(); assert.equal(bounds.x, beforeHuman.x); assert.equal(bounds.y, beforeHuman.y)
  tests.push('human-canvas-receives-real-browser-click-and-drag-without-moving-widget')
  const frameBox = await card.locator('iframe').boundingBox(), toolbarBox = await actions.boundingBox()
  assert.equal(frameBox.height, 178, 'Human controls never resize the full picture inside its fixed 300×180 border')
  assert.ok(toolbarBox.y >= frameBox.y && toolbarBox.y + toolbarBox.height < frameBox.y + frameBox.height)
  await page.getByRole('button', { name: '隐藏预览控件', exact: true }).click(); await opacity('0')
  assert.equal(await card.getAttribute('data-controls-hidden'), 'true'); assert.deepEqual(await card.locator('iframe').boundingBox(), frameBox)
  await target.click({ position: { x: 140, y: 2 } })
  const topClick = await target.evaluate(() => window.__actions.at(-1))
  assert.equal(topClick.kind, 'click'); assert.ok(topClick.to.y < 5, 'The independently mapped top target pixels must receive the click')
  tests.push('human-can-dismiss-overlay-and-click-top-target-pixels-with-full-frame')
  await page.mouse.move(frameBox.x + 140, frameBox.y + 105); await page.mouse.down()
  await page.mouse.move(frameBox.x + 140, frameBox.y + 2, { steps: 6 }); await page.mouse.up()
  const topDrag = await target.evaluate(() => window.__actions.at(-1))
  assert.equal(topDrag.kind, 'drag'); assert.ok(topDrag.from.y > 100 && topDrag.to.y < 5)
  tests.push('human-drag-to-top-target-pixels-receives-mouseup')
  await page.mouse.move(frameBox.x + 140, frameBox.y + 100); await page.mouse.down()
  const heldFrame = await card.locator('iframe').boundingBox()
  await page.mouse.move(0, 0)
  const outsideHeld = await card.evaluate(node => ({ hover: node.matches(':hover'), hitOutside: !node.contains(document.elementFromPoint(0, 0)) }))
  assert.equal(outsideHeld.hitOutside, true, 'The physical browser pointer is outside the preview, regardless of Chromium active-hover retention')
  assert.deepEqual(await card.locator('iframe').boundingBox(), heldFrame, 'Leaving the card during down must not change screenshot coordinates')
  await page.mouse.move(frameBox.x + 170, frameBox.y + 2); assert.deepEqual(await card.locator('iframe').boundingBox(), heldFrame)
  assert.equal(await card.getAttribute('data-controls-hidden'), 'true', 'A returning held gesture must not reveal controls over its release point')
  await page.mouse.up()
  const heldDrag = await target.evaluate(() => window.__actions.at(-1))
  assert.equal(heldDrag.kind, 'drag'); assert.ok(heldDrag.to.y < 5)
  await page.screenshot({ path: join(output, 'human-full-frame-controls-hidden.png') })
  tests.push('human-held-return-keeps-controls-hidden-and-frame-geometry-stable')
  const humanInputCount = await target.evaluate(() => window.__inputs.length)
  await page.mouse.move(0, 0); await card.hover(); await opacity('1')
  assert.equal(await card.getAttribute('data-controls-hidden'), 'false')
  await page.getByRole('button', { name: '隐藏预览控件', exact: true }).click(); await opacity('0')
  await page.keyboard.press('Shift+Tab'); await opacity('1')
  assert.equal(await actions.evaluate(node => node.contains(document.activeElement)), true)
  tests.push('dismissed-controls-restore-with-unpressed-reentry-and-keyboard-focus')
  await page.getByRole('button', { name: '弹出电脑预览', exact: true }).click()
  await page.getByRole('button', { name: '收回电脑预览', exact: true }).waitFor()
  assert.equal(await card.locator('iframe').count(), 1); assert.equal(await target.evaluate(() => window.__inputs.length), humanInputCount)
  assert.deepEqual(await card.locator('iframe').boundingBox(), frameBox)
  await page.screenshot({ path: join(output, 'detached-still-live-full-frame.png') })
  await page.getByRole('button', { name: '收回电脑预览', exact: true }).click()
  await page.getByRole('button', { name: '弹出电脑预览', exact: true }).waitFor()
  assert.equal(await target.evaluate(() => window.__inputs.length), humanInputCount, 'Detach/redock must preserve the original live frame document')
  tests.push('detached-and-redocked-preview-keeps-the-same-live-full-frame')
  await card.hover(); await opacity('1'); const grip = page.getByRole('button', { name: '拖动电脑小预览', exact: true }), gripBox = await grip.boundingBox()
  await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2); await page.mouse.down(); await page.mouse.move(1800, -800, { steps: 6 }); await page.mouse.up()
  bounds = await card.boundingBox(); assert.ok(bounds.x + bounds.width <= 792); assert.equal(bounds.y, 8)
  assert.equal(await target.evaluate(() => window.__inputs.length), humanInputCount); tests.push('human-grip-only-drag-does-not-inject-canvas-events')
  await page.mouse.move(0, 0); await page.evaluate(() => document.activeElement.blur()); await opacity('0')
  assert.equal((await card.locator('iframe').boundingBox()).height, 178, 'An idle human preview retains the same image-only full height')
  await page.setViewportSize({ width: 350, height: 220 })
  await page.waitForFunction(() => { const r = document.querySelector('[data-qyt-computer-inline]').getBoundingClientRect(); return r.right <= innerWidth - 8 && r.bottom <= innerHeight - 8 })
  await page.evaluate(() => window.__switch('other')); await page.locator('[data-qyt-computer-inline="other"]').waitFor()
  bounds = await card.boundingBox(); assert.ok(bounds.x >= 8 && bounds.y >= 8 && bounds.x + bounds.width <= 342 && bounds.y + bounds.height <= 212)
  tests.push('resize-and-session-switch-recheck-window-containment')
  await page.mouse.move(0, 0); await page.evaluate(() => document.activeElement.blur()); await opacity('0'); await page.emulateMedia({ colorScheme: 'dark' }); await capture('image-only-dark-small-viewport.png')
  await page.evaluate(() => window.__request()); await page.locator('[data-qyt-computer-request="own-request"]').waitFor()
  await page.waitForFunction(() => !document.querySelector('[data-qyt-computer-inline] iframe'))
  bounds = await card.boundingBox(); assert.ok(bounds.x >= 8 && bounds.y >= 8 && bounds.x + bounds.width <= 342 && bounds.y + bounds.height <= 212)
  const deny = page.getByRole('button', { name: '拒绝', exact: true }); await deny.scrollIntoViewIfNeeded(); assert.equal(await deny.isVisible(), true)
  assert.equal(await page.getByRole('button', { name: '允许一次', exact: true }).isDisabled(), true)
  assert.equal(await page.getByRole('button', { name: '前往开启屏幕录制', exact: true }).count(), 1)
  assert.equal(await card.evaluate(node => getComputedStyle(node).overflowY), 'auto')
  await page.screenshot({ path: join(output, 'permission-card-small-viewport.png') }); tests.push('authorization-and-permission-card-remains-visible-scrollable-and-actionable')
  await writeFile(join(output, 'report.json'), JSON.stringify({ status: 'passed', tests, browser: 'real headless Chromium', fixtureInput: inputs, topClick, topDrag, heldDrag, heldFrame, outsideHeld, ownerCalls: await page.evaluate(() => window.__ownerCalls), nativeDriversStarted: 0, osInputSent: false, boundary: 'Production React+CSS events in an owned browser fixture. No native or real desktop input, no physical HID claim.' }, null, 2))
  console.log(JSON.stringify({ status: 'passed', tests: tests.length, output }))
} catch (error) { await page?.screenshot({ path: join(output, 'failed.png') }).catch(() => {}); await writeFile(join(output, 'report.json'), JSON.stringify({ status: 'failed', error: error.message, tests }, null, 2)); throw error }
finally { await browser.close(); server.closeAllConnections(); await new Promise(done => server.close(done)) }
