/** Exercise the real settings/editor against a local Host fixture. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'
execFileSync(process.execPath, ['scripts/preview-ocean-settings.mjs', '--generate-only'])
const html = await readFile('artifacts/ocean-scene/settings-preview.html')
await mkdir('artifacts/custom-themes', { recursive: true })
const server = createServer((_, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html) })
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
const browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}) })
try {
  const page = await browser.newPage({ viewport: { width: 780, height: 1000 } })
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  // Use the public native markers to check both navigation surfaces against
  // the actual installed stylesheet, including uploaded portrait artwork.
  await page.evaluate(() => {
    const host = document.createElement('div'); host.id = 'navigation-check'
    host.style.cssText = 'position:fixed;left:-1000px;top:0;width:200px;height:800px;'
    host.innerHTML = '<div data-slot="sidebar"><aside style="height:800px">Sidebar</aside></div><div data-shortcut-modal="settings"><nav style="height:640px">Settings</nav></div>'
    document.body.append(host)
  })
  async function checkCurrentThemeEditor(label) {
    await page.getByRole('button', { name: '＋ 新建主题', exact: true }).click()
    const editor = page.getByRole('dialog', { name: '自定义主题', exact: true })
    await editor.waitFor()
    for (const dark of [false, true]) {
      await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), dark)
      const actual = await editor.evaluate(element => {
        const style = getComputedStyle(element), probe = document.createElement('span')
        probe.style.color = getComputedStyle(document.body).getPropertyValue('--qyt-q-accent'); element.append(probe)
        const accent = getComputedStyle(probe).color; probe.remove()
        const navigation = [...document.querySelectorAll('#navigation-check aside,#navigation-check nav')].map(node => {
          const s = getComputedStyle(node); return { size: s.backgroundSize, image: s.backgroundImage, position: s.backgroundPosition }
        })
        return { accent, range: getComputedStyle(element.querySelector('input[type=range]')).accentColor,
          save: getComputedStyle(element.querySelector('.qyt-editor-save')).backgroundColor,
          surface: style.backgroundColor, expectedSurface: getComputedStyle(document.body).getPropertyValue('--qyt-q-surface').trim(), navigation }
      })
      assert.equal(actual.range, actual.accent, label+' range follows active theme')
      assert.equal(actual.save, actual.accent, label+' save follows active theme')
      for (const nav of actual.navigation) {
        assert.equal(nav.size, '100% 100%, cover', label+' navigation fills its height')
        assert.ok(nav.image.includes('data:image/'), label+' uses its own artwork')
      }
      assert.deepEqual(actual.navigation[0], actual.navigation[1], label+' app and settings navigation share presentation')
      if (label === 'moonfrost') await page.screenshot({ path: `artifacts/custom-themes/editor-active-${dark?'dark':'light'}.png` })
    }
    await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))
    await editor.getByRole('button', { name: '取消', exact: true }).click()
  }
  for (const [id, name] of [['moonfrost','月阙清霜'],['begonia','大鱼海棠 · 椿'],['sunset','落日山野'],['ocean','鲸与海']]) {
    await page.getByRole('radio', { name, exact: true }).click()
    await page.waitForFunction(id => document.body.dataset.qytQTheme === id, id)
    await checkCurrentThemeEditor(id)
  }
  const initial = await page.evaluate(() => ({ theme: document.body.dataset.qytQTheme, mutations: window.__oceanSettingsFixture.mutations.length }))
  await page.getByRole('button', { name: '＋ 新建主题', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '自定义主题', exact: true })
  await dialog.getByLabel('主题名称', { exact: true }).fill('我的晚霞')
  await dialog.locator('input[type=file]').setInputFiles('assets/q-sunset-scene.jpg')
  const preview = page.frameLocator('.qyt-custom-dialog iframe')
  await preview.locator('[data-qyt-landscape-scene]').waitFor()
  await dialog.getByRole('button', { name: '缓慢平移', exact: true }).click()
  await dialog.getByRole('button', { name: '飘雪', exact: true }).click()
  const range = dialog.getByLabel('图片缩放', { exact: true }); await range.focus(); await range.press('ArrowRight')
  await dialog.getByRole('button', { name: '深色', exact: true }).click()
  await preview.locator('body[data-ds-dark-theme]').waitFor()
  assert.equal(await page.locator('body').getAttribute('data-ds-dark-theme'), null, 'editor appearance cannot change the real app')
  assert.deepEqual(await page.evaluate(() => ({ theme: document.body.dataset.qytQTheme, mutations: window.__oceanSettingsFixture.mutations.length })), initial, 'drafts never write or apply the main theme')
  await dialog.getByRole('button', { name: '浅色', exact: true }).click()
  await page.screenshot({ path: 'artifacts/custom-themes/editor.png' })
  await page.evaluate(() => window.__oceanSettingsFixture.setFailure(true))
  await dialog.getByRole('button', { name: '保存并应用', exact: true }).click()
  await dialog.getByRole('alert').waitFor()
  assert.equal(await page.evaluate(() => document.body.dataset.qytQTheme), initial.theme, 'refused save keeps current theme')
  await page.evaluate(() => window.__oceanSettingsFixture.setFailure(false))
  await dialog.getByRole('button', { name: '保存并应用', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  const saved = await page.evaluate(() => window.__oceanSettingsFixture.getSnapshot().value)
  assert.match(saved.qThemeId, /^custom:/)
  assert.equal(saved.qCustomThemes.length, 1)
  assert.equal(saved.qCustomThemes[0].movement, 'pan'); assert.equal(saved.qCustomThemes[0].atmosphere, 'snow')
  assert.equal(saved.qCustomThemes[0].zoom, 1.01)
  assert.ok(saved.qCustomThemes[0].image.startsWith('data:image/webp;base64,'))
  assert.ok(saved.qCustomThemes[0].image.length < 350000)
  assert.equal(await page.getByRole('radio', { name: '我的晚霞', exact: true }).getAttribute('aria-checked'), 'true')
  await checkCurrentThemeEditor('custom')
  const add = page.getByRole('button', { name: '＋ 新建主题', exact: true })
  const before = await add.boundingBox()
  const list = page.locator('.qyt-theme-choices')
  const scrolled = await list.evaluate(element => { element.scrollTop = element.scrollHeight; return { top: element.scrollTop, overflow: element.scrollHeight > element.clientHeight } })
  assert.ok(scrolled.overflow && scrolled.top > 0, 'the theme list actually scrolls')
  assert.deepEqual(await add.boundingBox(), before, 'create action stays fixed while cards scroll')
  await page.screenshot({ path: 'artifacts/custom-themes/settings.png' })
  const mode = page.getByRole('radiogroup', { name: '自定义主题背景效果' })
  await mode.getByText('静态', { exact: true }).click()
  await page.frameLocator('iframe[data-qyt-theme-preview]').locator('[data-qyt-landscape-scene]').waitFor({ state: 'detached' })
  await page.reload()
  await page.getByRole('button', { name: '编辑当前主题', exact: true }).waitFor()
  assert.equal(await page.getByRole('radio', { name: '我的晚霞', exact: true }).getAttribute('aria-checked'), 'true')
  assert.equal(await mode.getByRole('radio', { name: '静态', exact: true }).isChecked(), true, 'mode and image persist after reload')
  await page.getByRole('button', { name: '编辑当前主题', exact: true }).click()
  assert.equal(await dialog.getByLabel('主题名称', { exact: true }).inputValue(), '我的晚霞')
  await dialog.locator('input[type=file]').setInputFiles({ name: 'bad.png', mimeType: 'image/png', buffer: Buffer.from('not an image') })
  await dialog.getByRole('alert').waitFor()
  await dialog.getByLabel('主题名称', { exact: true }).fill('未保存名称')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(await page.getByRole('radio', { name: '我的晚霞', exact: true }).getAttribute('aria-checked'), 'true', 'cancel retains saved theme')
  await add.click(); await dialog.waitFor(); await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' })
  await page.getByRole('button', { name: '编辑当前主题', exact: true }).click()
  await dialog.getByLabel('主题名称', { exact: true }).fill('晚霞 · 已编辑')
  await dialog.getByRole('button', { name: '动态', exact: true }).click()
  await dialog.getByRole('button', { name: '微光', exact: true }).click()
  await dialog.getByRole('button', { name: '保存并应用', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  await page.frameLocator('iframe[data-qyt-theme-preview]').locator('[data-qyt-landscape-scene]').waitFor()
  assert.equal(await page.evaluate(() => window.__oceanSettingsFixture.getSnapshot().value.qThemeId), saved.qThemeId, 'editing refreshes the same selected custom ID')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.frameLocator('iframe[data-qyt-theme-preview]').locator('[data-qyt-landscape-scene]').waitFor({ state: 'detached' })
  assert.equal(await page.getByRole('radio', { name: '晚霞 · 已编辑', exact: true }).getAttribute('aria-checked'), 'true')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.frameLocator('iframe[data-qyt-theme-preview]').locator('[data-qyt-landscape-scene]').waitFor()
  // A narrow settings viewport keeps controls reachable and the footer visible.
  await page.setViewportSize({ width: 390, height: 780 })
  await page.getByRole('button', { name: '编辑当前主题', exact: true }).click()
  const box = await dialog.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 390)
  const footer = await dialog.getByRole('button', { name: '保存并应用', exact: true }).boundingBox(); assert.ok(footer.y + footer.height <= 780)
  await page.screenshot({ path: 'artifacts/custom-themes/editor-narrow.png' })
  await dialog.getByRole('button', { name: '删除主题', exact: true }).click()
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  assert.equal(await page.evaluate(() => window.__oceanSettingsFixture.getSnapshot().value.qThemeId), 'moonfrost')
  assert.equal(await page.evaluate(() => window.__oceanSettingsFixture.getSnapshot().value.qCustomThemes.length), 0)
  assert.deepEqual(errors, [])
  console.log('Custom themes: upload, draft isolation, light/dark preview, refusal/retry, persistence, static mode, cancel, delete, narrow layout and fixed create action passed')
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
