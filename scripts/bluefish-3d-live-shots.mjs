// Snapshot the live model's action stages from the running preview.
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'

const out = 'artifacts/ocean-scene/bluefish-3d/live'
await mkdir(out, { recursive: true })
const browser = await chromium.launch({
  headless: true,
  ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}),
})
try {
  const page = await browser.newPage({ viewport: { width: 1160, height: 900 }, deviceScaleFactor: 2 })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('http://127.0.0.1:58385/')
  await page.waitForFunction(() => window.bluefishWorld && window.bluefishFrame, { timeout: 15000 })
  const stage = page.locator('.stage')
  async function snap(name, action, wait) {
    await page.getByRole('button', { name: action, exact: true }).click()
    await page.waitForTimeout(wait)
    await stage.screenshot({ path: join(out, `${name}.png`) })
    return page.evaluate(() => window.bluefishFrame)
  }
  await snap('idle', '岸边待机', 1600)
  await snap('swim', '入海游泳', 5300)
  await snap('fish', '下潜抓鱼', 5500)
  console.log(JSON.stringify({ errors }))
} finally {
  await browser.close()
}
