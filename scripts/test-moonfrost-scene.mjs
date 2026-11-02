/** Deterministic GPU evidence: cloth changes while the woman and scenery stay fixed. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const output = resolve('artifacts/moonfrost-scene')
await mkdir(output, { recursive: true })
const bundle = await build({ stdin: { contents: `
import { createMoonfrostArt } from './src/client/moonfrost-scene.ts';
const art=createMoonfrostArt(document);if(!art)throw Error('GPU unavailable');document.body.append(art.element);window.__art=art;
window.__capture=time=>{art.draw(time);const canvas=art.element,gl=canvas.getContext('webgl'),pixels=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);return {pixels,width:canvas.width,height:canvas.height}};
`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'browser', format: 'iife' })
const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}</style></head><body><script>${bundle.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script></body></html>`
const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html) })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
  browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}) })
  const page = await browser.newPage({ viewport: { width: 1672, height: 941 } })
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.waitForFunction(() => { window.__art?.draw(0); return document.querySelector('canvas[data-ready="true"]') })
  const frames = []
  for (const time of [0, 1.4, 2.8]) {
    await page.evaluate(time => { window.__frames ??= []; window.__frames.push(window.__capture(time)) }, time)
    const path = `cloth-${time}.png`; frames.push(path)
    await page.screenshot({ path: join(output, path) })
  }
  const regions = await page.evaluate(() => {
    const [a, b] = window.__frames
    const regions = { train: [790, 530, 335, 325], face: [1235, 45, 95, 110], bodice: [1245, 160, 95, 145], leftHeel: [1164, 766, 61, 111], rightHeel: [1264, 753, 93, 105], mountains: [150, 160, 500, 400] }
    return Object.fromEntries(Object.entries(regions).map(([name, [x,y,w,h]]) => {
      let changed=0,total=0,sum=0
      for(let py=Math.floor(y*a.height/941);py<(y+h)*a.height/941;py++)for(let px=Math.floor(x*a.width/1672);px<(x+w)*a.width/1672;px++){
        const index=((a.height-1-py)*a.width+px)*4;let delta=0
        for(let c=0;c<3;c++)delta+=Math.abs(a.pixels[index+c]-b.pixels[index+c])
        if(delta>6)changed++;sum+=delta;total++
      }
      return [name,{changed,total,ratio:changed/total,meanDelta:sum/total}]
    }))
  })
  assert.ok(regions.train.ratio > .1, 'The fabric itself must visibly change without pointer movement or snow')
  for (const name of ['face','bodice','leftHeel','rightHeel','mountains']) assert.equal(regions[name].changed, 0, name + ' stays fixed')
  await page.evaluate(() => { window.__art.dispose(); window.__art.dispose() })
  assert.equal(await page.locator('canvas').count(), 0)
  assert.deepEqual(errors, [])
  const result = { passed: true, regions, screenshots: frames, errors }
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2)+'\n')
  console.log(JSON.stringify(result, null, 2))
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)) }
