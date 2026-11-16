// Capture the live model at the turnaround angles used by the design sheet.
// Usage: node scripts/bluefish-3d-angles.mjs [outDir] [url]
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const out = resolve(process.argv[2] ?? 'artifacts/ocean-scene/bluefish-3d/angles')
const url = process.argv[3] ?? 'http://127.0.0.1:58385/'
await mkdir(out, { recursive: true })

const browser = await chromium.launch({
  headless: true,
  ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}),
})
try {
  const page = await browser.newPage({ viewport: { width: 1160, height: 900 }, deviceScaleFactor: 2 })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(url)
  await page.waitForFunction(() => window.bluefishWorld && window.bluefishFrame, { timeout: 15000 })
  await page.evaluate(() => {
    window.bluefishWorld.play('review')
    const label = document.querySelector('output')
    if (label) label.style.display = 'none'
  })
  await page.waitForTimeout(400)
  const stage = page.locator('.stage')
  const shots = { front: 0, 'front-quarter': 45, left: 90, 'rear-quarter': 135, rear: 180, right: 270 }
  for (const [name, degrees] of Object.entries(shots)) {
    await page.evaluate(deg => {
      window.bluefishWorld.play('review')
      window.bluefishWorld.restoreCamera(deg * Math.PI / 180, 0)
    }, degrees)
    await page.waitForTimeout(120)
    await stage.screenshot({ path: join(out, `${name}.png`) })
  }
  await page.evaluate(() => window.bluefishWorld.restoreCamera(0, 0))
  console.log(JSON.stringify({ out, url, errors }))
  if (errors.length) process.exitCode = 1
} finally {
  await browser.close()
}
