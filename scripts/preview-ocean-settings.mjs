/** Render the real shared theme settings and verify both themes in a browser. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { themeArtFixture } from './theme-art-fixture.mjs'
import { createThemeVideoFixture } from './theme-video-fixture.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const output = resolve(root, 'artifacts/ocean-scene')
await mkdir(output, { recursive: true })

// Only Harness primitives and feature installation boundaries are adapted.
// The complete settings markup, labels, events, and styles come from production.
const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {QiuYaToolsSettings} from './src/client/index.tsx';
import {zh} from './src/client/locales.ts';
import {installQTheme as installRealQTheme} from './src/client/q-theme.ts';
import css from './src/client/styles.css';
import {OCEAN_SCENE_DATA_URL} from './src/client/brand-assets.ts';
const style=document.createElement('style');style.textContent=css.replaceAll('__QYT_OCEAN_SCENE__',OCEAN_SCENE_DATA_URL);document.head.append(style);
const listeners=new Set(),mutations=[];
const initial=JSON.parse(localStorage.getItem('qyt.ocean.preview.settings')||'null')||{qThemeEnabled:true,qThemeId:'ocean',qThemeSettings:{ocean:{motion:'dynamic'},futureTheme:{motion:'static'}}};
let snapshot={status:'ready',writable:true,value:initial,revision:1},failure=false;
const form={getSnapshot:()=>snapshot,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn)},async mutate(operations){
  mutations.push(structuredClone(operations));await new Promise(resolve=>setTimeout(resolve,25));if(failure)return false;
  const value=structuredClone(snapshot.value);for(const operation of operations){if(operation.op!=='set')throw Error('Unsupported fixture operation');let parent=value;for(const key of operation.path.slice(0,-1))parent=parent[key]??={};parent[operation.path.at(-1)]=operation.value}
  snapshot={...snapshot,value,revision:snapshot.revision+1};localStorage.setItem('qyt.ocean.preview.settings',JSON.stringify(value));for(const listener of [...listeners])listener();return true;
}};
const support={status:'ready',harnessVersion:'0.2.1-rc.2',minimumHarnessVersion:'0.2.1-rc.2',versionSupported:true};
const artRpc=${await themeArtFixture()};
const ctx={sessionWindowSupport:{getSnapshot:()=>support,subscribe:()=>()=>{}},connection:{rpc:{async call(channel,endpoint,payload,signal){if(endpoint==='qiuya-tools/theme-art/get')return artRpc(channel,endpoint,payload);if(!/^[/][A-Za-z0-9._~-]+$/.test(channel))throw Error('Invalid native RPC channel');const response=await fetch(channel+'/'+endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method:endpoint,payload}),signal});if(!response.ok)throw Error('unavailable');return(await response.json()).result}}},get(name){return name==='connection'?this.connection:undefined}};
installRealQTheme(ctx,form);
createRoot(document.querySelector('[data-slot="settings.section"]')).render(React.createElement(QiuYaToolsSettings,{form,ctx,t:key=>zh[key]}));
window.__oceanSettingsFixture={mutations,getSnapshot:()=>structuredClone(snapshot),setFailure(value){failure=value}};
const observer=new MutationObserver(()=>{const tab=[...document.querySelectorAll('[role="tab"]')].find(node=>node.textContent==='Q 主题');if(!tab)return;observer.disconnect();tab.click();window.__oceanSettingsReady=true});observer.observe(document.querySelector('[data-slot="settings.section"]'),{childList:true,subtree:true});
`
const bundle = await build({
  stdin: { contents: fixture, resolveDir: root, sourcefile: 'ocean-settings-preview.tsx', loader: 'tsx' },
  bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2022',
  jsx: 'automatic', loader: { '.css': 'text' },
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{ name: 'settings-preview-host-boundaries', setup(builder) {
    builder.onResolve({ filter: /^\.\/features\.ts$/ }, () => ({ path: 'features', namespace: 'preview-boundary' }))
    builder.onResolve({ filter: /^\.\/q-theme\.ts$/ }, ({ importer }) => importer.replaceAll('\\', '/').endsWith('/src/client/index.tsx') ? ({ path: 'theme', namespace: 'preview-boundary' }) : undefined)
    builder.onResolve({ filter: /^\.\/session-window-support\.ts$/ }, () => ({ path: 'support', namespace: 'preview-boundary' }))
    builder.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: 'primitives', namespace: 'preview-boundary' }))
    builder.onLoad({ filter: /.*/, namespace: 'preview-boundary' }, ({ path }) => ({
      contents: path === 'features' ? 'export function installFeatures(){}'
        : path === 'theme' ? 'export function installQTheme(){return()=>{}}'
          : path === 'support' ? 'export function getSessionWindowSupport(ctx){return ctx.sessionWindowSupport}'
            : `import React from 'react';export function Switch({checked,disabled,label,onChange,className}){return React.createElement('button',{type:'button',role:'switch','aria-label':label,'aria-checked':checked,disabled,className,onClick:()=>onChange(!checked)},React.createElement('span'))}export function Modal(){return null}export function MenuSurface(){return null}export function MenuItemButton(){return null}export function useAnchoredPosition(){return{}}export function useDismissOnOutsidePointer(){}`,
      resolveDir: root,
    }))
    builder.onLoad({ filter: /\.module\.css$/ }, async ({ path }) => ({ contents: await (await import('node:fs/promises')).readFile(path, 'utf8'), loader: 'local-css' }))
  } }],
})
const script = bundle.outputFiles.find(file => file.path.endsWith('.js'))?.text ?? bundle.outputFiles[0].text
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Q 主题 · 共享主题设置</title><style>
:root{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#25292c;background:#e9eeeb;--dsw-alias-bg-layer-2:#fafbf9;--dsw-alias-label-primary:#25292c;--dsw-alias-label-secondary:#616b6e;--dsw-alias-border-l3:#d9dfdc;--dsw-alias-interactive-bg-active:#bfcac7}
*{box-sizing:border-box}body{margin:0;min-height:100vh;padding:28px;display:grid;place-items:center}button,input{font:inherit}button{cursor:pointer}button:disabled{cursor:default}.preview-shell{width:min(920px,100%)}.preview-nav{margin:0 0 12px 4px;font-size:12px}.preview-nav a{color:#116d83;text-decoration:none}.preview-nav a:hover{text-decoration:underline}[data-shortcut-modal="settings"]{width:100%;height:min(820px,calc(100vh - 90px));min-height:540px;padding:20px;border:1px solid #d3ddd7;border-radius:18px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 18px 60px #253f3220}.harness-options{height:100%}[data-slot="settings.section"]{display:contents}.qyt-switch{border:0;border-radius:999px;width:34px;height:20px;background:#bdc9c5;padding:2px;display:flex}.qyt-switch>span{display:block;width:16px;height:16px;border-radius:50%;background:white}.qyt-switch[aria-checked="true"]{justify-content:flex-end}
@media(max-width:620px){body{padding:12px}[data-shortcut-modal="settings"]{padding:14px;height:calc(100vh - 58px)}}
</style></head><body><main class="preview-shell"><nav class="preview-nav" aria-label="预览导航"><a href="/">← 返回海面</a></nav><div data-shortcut-modal="settings" role="dialog" aria-label="QiuYaTools 设置"><div class="harness-options"><div data-slot="settings.section"></div></div></div></main><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`
const htmlPath = join(output, 'settings-preview.html')
await writeFile(htmlPath, html)
if (process.argv.includes('--generate-only')) {
  console.log(JSON.stringify({ html: htmlPath }))
} else {
  const videoHost = await createThemeVideoFixture(resolve(root, 'artifacts/video-theme/profile'))
  const server = createServer(async (request, response) => {
    if (await videoHost.handle(request, response)) return
    if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return }
    response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  let browser
  try {
    browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}) })
    const page = await browser.newPage({ viewport: { width: 1080, height: 920 }, deviceScaleFactor: 1 })
    const errors = []; page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.address().port}/settings`)
    await page.getByRole('tab', { name: 'Q 主题', exact: true }).click()
    const group = page.getByRole('radiogroup', { name: '鲸与海背景效果' })
    await group.getByRole('radio', { name: '动态', exact: true }).waitFor()
    assert.equal(await group.getByRole('radio', { name: '动态', exact: true }).isChecked(), true)
    const previewFrame = page.frameLocator('iframe[data-qyt-theme-preview]')
    await previewFrame.locator('canvas[data-qyt-ocean-scene][data-ready="true"]').waitFor({ state: 'visible' })
    const oceanFrameA = await page.locator('iframe[data-qyt-theme-preview]').screenshot()
    await page.waitForTimeout(1200)
    const oceanFrameB = await page.locator('iframe[data-qyt-theme-preview]').screenshot()
    assert.ok(!oceanFrameA.equals(oceanFrameB), 'The real Ocean preview changes visually, rather than only selecting a dynamic radio')
    await writeFile(join(output, 'ocean-preview-dynamic-a.png'), oceanFrameA)
    await writeFile(join(output, 'ocean-preview-dynamic-b.png'), oceanFrameB)
    const geometry = await page.locator('.qyt-theme-title').evaluate(row => {
      const bounds = node => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } }
      return { heading: bounds(row.querySelector('h4')), control: bounds(row.querySelector('[role="radiogroup"]')), name: bounds(row.querySelector('.qyt-theme-name')) }
    })
    assert.ok(geometry.control.left >= geometry.heading.right && geometry.control.left - geometry.heading.right <= 16, 'Motion selector must immediately follow the left heading')
    assert.ok(geometry.name.left > geometry.control.right, 'Original theme name must remain at the far right')
    assert.ok(Math.abs((geometry.heading.top + geometry.heading.bottom) / 2 - (geometry.control.top + geometry.control.bottom) / 2) < 2, 'Heading and motion selector must align vertically')
    const assertFullWidthPreview = () => page.locator('.qyt-theme-panel').evaluate(panel => {
      const preview = panel.querySelector('.qyt-theme-card').getBoundingClientRect()
      return Math.abs(preview.width - panel.getBoundingClientRect().width) < 1
    })
    assert.equal(await assertFullWidthPreview(), true, 'The preview spans the panel without the old side picker')
    await page.locator('.qyt-settings').screenshot({ path: join(output, 'ocean-settings.png') })
    await page.locator('.qyt-theme-card').screenshot({ path: join(output, 'ocean-settings-card.png') })
    await group.getByText('静态', { exact: true }).click()
    await page.waitForFunction(() => window.__oceanSettingsFixture.getSnapshot().value.qThemeSettings.ocean.motion === 'static')
    assert.equal(await group.getByRole('radio', { name: '静态', exact: true }).isChecked(), true)
    assert.equal(await previewFrame.locator('canvas').count(), 0, 'Static preview stops and removes its actual scene')
    await page.locator('.qyt-theme-card').screenshot({ path: join(output, 'ocean-settings-static.png') })
    let result = await page.evaluate(() => ({ snapshot: window.__oceanSettingsFixture.getSnapshot(), mutations: window.__oceanSettingsFixture.mutations }))
    assert.deepEqual(result.mutations, [[{ op: 'set', path: ['qThemeSettings', 'ocean', 'motion'], value: 'static' }]])
    assert.equal(result.snapshot.value.qThemeSettings.futureTheme.motion, 'static')
    await page.reload(); await page.getByRole('tab', { name: 'Q 主题', exact: true }).click()
    assert.equal(await group.getByRole('radio', { name: '静态', exact: true }).isChecked(), true, 'Accepted preference survives reopening')
    await group.getByText('动态', { exact: true }).click()
    await page.waitForFunction(() => window.__oceanSettingsFixture.getSnapshot().value.qThemeSettings.ocean.motion === 'dynamic')
    result = await page.evaluate(() => ({ snapshot: window.__oceanSettingsFixture.getSnapshot(), mutations: window.__oceanSettingsFixture.mutations }))
    assert.deepEqual(result.mutations, [[{ op: 'set', path: ['qThemeSettings', 'ocean', 'motion'], value: 'dynamic' }]])
    assert.equal(result.snapshot.value.qThemeEnabled, true)
    await page.setViewportSize({ width: 420, height: 900 })
    await page.locator('.qyt-settings').screenshot({ path: join(output, 'ocean-settings-narrow.png') })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'Narrow settings must not overflow horizontally')
    const oceanMutation = result.mutations[0]
    await page.setViewportSize({ width: 1080, height: 1160 })
    await page.locator('[data-shortcut-modal="settings"]').evaluate(element => { element.style.height = '980px' })
    const entry = page.getByRole('button', { name: '主题广场', exact: true })
    const gallery = page.getByRole('dialog', { name: '主题广场', exact: true })
    const choices = gallery.locator('.qyt-theme-gallery-card')
    const openGallery = async () => { if (!await gallery.isVisible()) await entry.click() }
    const closeGallery = () => gallery.getByRole('button', { name: '关闭', exact: true }).click()
    const chooseTheme = async (id, keepOpen = false) => {
      await openGallery()
      await gallery.locator(`.qyt-theme-gallery-card[data-theme="${id}"]`).click()
      if (!keepOpen) {
        await gallery.locator(`.qyt-theme-gallery-card[data-theme="${id}"][aria-pressed="true"]`).waitFor()
        await closeGallery()
      }
    }
    const checkSelection = async id => {
      await openGallery()
      await gallery.locator(`.qyt-theme-gallery-card[data-theme="${id}"][aria-pressed="true"]`).waitFor()
      assert.deepEqual(await gallery.locator('.qyt-theme-gallery-card[aria-pressed="true"]').evaluateAll(cards => cards.map(card => card.dataset.theme)), [id])
      await closeGallery()
    }
    await openGallery()
    assert.equal(await choices.count(), 8, 'Each theme has one card in the gallery')
    assert.deepEqual(await gallery.getByRole('heading', { level: 4 }).allTextContents(), ['联动主题', '视频主题', '主题'])
    assert.deepEqual(await gallery.getByRole('region', { name: '视频主题', exact: true }).getByRole('button').allTextContents(), ['伽罗 · 月下冰弦', '桃华白狐'])
    assert.equal(await gallery.getByRole('button', { name: '＋ 新建主题', exact: true }).isEnabled(), true)
    await gallery.screenshot({ path: join(output, 'theme-gallery.png') })
    await page.keyboard.press('Escape')
    await gallery.waitFor({ state: 'detached' })
    assert.equal(await entry.evaluate(el => el === document.activeElement), true)
    await checkSelection('ocean')
    await chooseTheme('begonia', true)
    await checkSelection('begonia')
    await page.waitForFunction(() => window.__oceanSettingsFixture.getSnapshot().value.qThemeId === 'begonia')
    assert.equal(await page.locator('body').getAttribute('data-qyt-q-theme'), 'begonia', 'The real theme installer follows the accepted card selection')
    const begoniaGroup = page.getByRole('radiogroup', { name: '大鱼海棠背景效果', exact: true })
    assert.equal(await begoniaGroup.getByRole('radio', { name: '动态', exact: true }).isChecked(), true, 'A new theme inherits its own dynamic default')
    await checkSelection('begonia')
    await previewFrame.locator('canvas[data-qyt-begonia-petals]').waitFor({ state: 'visible' })
    const begoniaFrameA = await page.locator('iframe[data-qyt-theme-preview]').screenshot()
    await page.waitForTimeout(1200)
    const begoniaFrameB = await page.locator('iframe[data-qyt-theme-preview]').screenshot()
    assert.ok(!begoniaFrameA.equals(begoniaFrameB), 'Begonia preview shows actual moving petals')
    await writeFile(join(output, 'begonia-preview-dynamic-a.png'), begoniaFrameA)
    await writeFile(join(output, 'begonia-preview-dynamic-b.png'), begoniaFrameB)
    await begoniaGroup.getByText('静态', { exact: true }).click()
    await page.waitForFunction(() => window.__oceanSettingsFixture.getSnapshot().value.qThemeSettings.begonia?.motion === 'static')
    assert.equal(await previewFrame.locator('canvas').count(), 0)
    let both = await page.evaluate(() => window.__oceanSettingsFixture.getSnapshot().value)
    assert.equal(both.qThemeSettings.ocean.motion, 'dynamic', 'Begonia motion leaves Ocean unchanged')
    assert.equal(both.qThemeSettings.begonia.motion, 'static')
    assert.equal(both.qThemeSettings.futureTheme.motion, 'static', 'Unknown future theme options are preserved')
    await page.locator('.qyt-tab-panel:not([hidden])').evaluate(element => { element.scrollTop = 0 })
    await page.locator('.qyt-settings').screenshot({ path: join(output, 'begonia-settings.png') })
    await page.locator('.qyt-theme-card').screenshot({ path: join(output, 'begonia-settings-card.png') })
    await page.reload(); await page.getByRole('tab', { name: 'Q 主题', exact: true }).click()
    await page.locator('[data-shortcut-modal="settings"]').evaluate(element => { element.style.height = '980px' })
    await checkSelection('begonia')
    assert.equal(await begoniaGroup.getByRole('radio', { name: '静态', exact: true }).isChecked(), true, 'Selected theme motion survives reopening')
    await chooseTheme('ocean')
    await page.waitForFunction(() => window.__oceanSettingsFixture.getSnapshot().value.qThemeId === 'ocean')
    assert.equal(await group.getByRole('radio', { name: '动态', exact: true }).isChecked(), true, 'Returning to Ocean restores its independent motion')
    await chooseTheme('begonia')
    await page.waitForFunction(() => window.__oceanSettingsFixture.getSnapshot().value.qThemeId === 'begonia')
    assert.equal(await begoniaGroup.getByRole('radio', { name: '静态', exact: true }).isChecked(), true)
    await page.evaluate(() => window.__oceanSettingsFixture.setFailure(true))
    await chooseTheme('ocean', true)
    await gallery.getByRole('alert').filter({ hasText: '保存失败' }).waitFor()
    assert.equal(await gallery.getByRole('button', { name: '大鱼海棠 · 椿', exact: true }).getAttribute('aria-pressed'), 'true', 'Rejected saves keep the accepted selection')
    assert.equal(await page.locator('body').getAttribute('data-qyt-q-theme'), 'begonia', 'Rejected saves keep the installed theme')
    await closeGallery()
    assert.equal(await begoniaGroup.getByRole('radio', { name: '静态', exact: true }).isChecked(), true)
    await page.evaluate(() => window.__oceanSettingsFixture.setFailure(false))
    await page.reload(); await page.getByRole('tab', { name: 'Q 主题', exact: true }).click()
    await page.locator('[data-shortcut-modal="settings"]').evaluate(element => { element.style.height = '980px' })
    await checkSelection('begonia')
    const lightPalette = await page.locator('body').evaluate(element => ({ base: getComputedStyle(element).getPropertyValue('--qyt-q-base').trim(), ink: getComputedStyle(element).getPropertyValue('--qyt-q-ink').trim() }))
    await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
    await checkSelection('begonia')
    const darkPalette = await page.locator('body').evaluate(element => ({ base: getComputedStyle(element).getPropertyValue('--qyt-q-base').trim(), ink: getComputedStyle(element).getPropertyValue('--qyt-q-ink').trim() }))
    assert.notEqual(darkPalette.base, lightPalette.base, 'The real installer adapts Begonia surfaces to native dark mode')
    assert.notEqual(darkPalette.ink, lightPalette.ink, 'Dark mode also adapts text for readable contrast')
    await page.locator('.qyt-tab-panel:not([hidden])').evaluate(element => { element.scrollTop = 0 })
    await page.locator('.qyt-settings').screenshot({ path: join(output, 'begonia-settings-dark.png') })
    await chooseTheme('ocean')
    await page.waitForFunction(() => window.__oceanSettingsFixture.getSnapshot().value.qThemeId === 'ocean')
    await checkSelection('ocean')
    await chooseTheme('begonia')
    await page.waitForFunction(() => window.__oceanSettingsFixture.getSnapshot().value.qThemeId === 'begonia')
    await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))
    await page.locator('[data-shortcut-modal="settings"]').evaluate(element => { element.style.height = '' })
    await page.setViewportSize({ width: 420, height: 900 })
    assert.equal(await assertFullWidthPreview(), true, 'The preview stays full width in a narrow settings window')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'Begonia narrow settings must not overflow horizontally')
    await page.locator('.qyt-tab-panel:not([hidden])').evaluate(element => { element.scrollTop = 0 })
    await page.locator('.qyt-settings').screenshot({ path: join(output, 'begonia-settings-narrow.png') })
    await openGallery()
    const narrow = await gallery.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }))
    assert.equal(narrow.scrollWidth, narrow.width, 'The gallery fits the narrow viewport')
    await gallery.screenshot({ path: join(output, 'theme-gallery-narrow.png') })
    await closeGallery()
    both = await page.evaluate(() => window.__oceanSettingsFixture.getSnapshot().value)
    assert.equal(both.qThemeSettings.ocean.motion, 'dynamic')
    assert.equal(both.qThemeSettings.begonia.motion, 'static')
    await page.setViewportSize({ width: 1080, height: 1160 })
    await chooseTheme('moonfrost')
    await page.waitForFunction(() => window.__oceanSettingsFixture.getSnapshot().value.qThemeId === 'moonfrost')
    await page.locator('.qyt-tab-panel:not([hidden])').evaluate(element => { element.scrollTop = 0 })
    await checkSelection('moonfrost')
    const moonfrostGroup = page.getByRole('radiogroup', { name: '月阙清霜背景效果', exact: true })
    assert.equal(await moonfrostGroup.getByRole('radio', { name: '动态', exact: true }).isChecked(), true)
    await previewFrame.locator('canvas[data-qyt-moonfrost-cloth][data-ready="true"]').waitFor({ state: 'visible' })
    assert.equal(await previewFrame.locator('[data-qyt-landscape-art]').evaluate(node => getComputedStyle(node).backgroundPosition), '100% 0%', 'Dynamic preview preserves the face at the top of the wallpaper')
    const moonfrostA = await previewFrame.locator('[data-qyt-landscape-scene] i').first().evaluate(node => node.style.transform)
    await page.waitForFunction(previous => document.querySelector('iframe[data-qyt-theme-preview]').contentDocument.querySelector('[data-qyt-landscape-scene] i')?.style.transform !== previous, moonfrostA)
    await page.locator('.qyt-settings').screenshot({ path: join(output, 'moonfrost-settings.png') })
    await page.locator('.qyt-theme-card').screenshot({ path: join(output, 'moonfrost-settings-card.png') })
    await moonfrostGroup.getByText('静态', { exact: true }).click()
    await page.waitForFunction(() => window.__oceanSettingsFixture.getSnapshot().value.qThemeSettings.moonfrost?.motion === 'static')
    assert.equal(await previewFrame.locator('[data-qyt-landscape-scene]').count(), 0)
    assert.ok((await previewFrame.locator('[data-phase]').evaluate(node => getComputedStyle(node).backgroundPosition)).endsWith('100% 0%'), 'Static preview keeps the same subject framing')
    await page.reload(); await page.getByRole('tab', { name: 'Q 主题', exact: true }).click()
    await checkSelection('moonfrost')
    assert.equal(await moonfrostGroup.getByRole('radio', { name: '静态', exact: true }).isChecked(), true)
    await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
    await page.locator('.qyt-settings').screenshot({ path: join(output, 'moonfrost-settings-dark.png') })
    await page.setViewportSize({ width: 420, height: 900 })
    await page.locator('.qyt-settings').screenshot({ path: join(output, 'moonfrost-settings-narrow.png') })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    both = await page.evaluate(() => window.__oceanSettingsFixture.getSnapshot().value)
    assert.equal(both.qThemeSettings.ocean.motion, 'dynamic')
    assert.equal(both.qThemeSettings.begonia.motion, 'static')
    assert.equal(both.qThemeSettings.moonfrost.motion, 'static')
    await page.setViewportSize({ width: 1080, height: 1160 })
    await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))
    await chooseTheme('buliangren')
    await page.waitForFunction(() => window.__oceanSettingsFixture.getSnapshot().value.qThemeId === 'buliangren')
    await page.locator('.qyt-tab-panel:not([hidden])').evaluate(element => { element.scrollTop = 0 })
    await checkSelection('buliangren')
    const buliangrenGroup = page.getByRole('radiogroup', { name: '不良人背景效果', exact: true })
    assert.equal(await buliangrenGroup.getByRole('radio', { name: '动态', exact: true }).isChecked(), true)
    await previewFrame.locator('canvas[data-qyt-buliangren-art][data-ready="true"]').waitFor({ state: 'visible' })
    assert.equal(await previewFrame.locator('[data-qyt-leaf="maple"]').count(), 36)
    await page.locator('.qyt-settings').screenshot({ path: join(output, 'buliangren-settings.png') })
    await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
    await page.waitForFunction(() => document.querySelector('iframe[data-qyt-theme-preview]').contentDocument.body.hasAttribute('data-ds-dark-theme'))
    await checkSelection('buliangren')
    await page.locator('.qyt-settings').screenshot({ path: join(output, 'buliangren-settings-dark.png') })
    await buliangrenGroup.getByRole('radio', { name: '静态', exact: true }).click()
    await page.waitForFunction(() => window.__oceanSettingsFixture.getSnapshot().value.qThemeSettings.buliangren?.motion === 'static')
    assert.equal(await previewFrame.locator('[data-qyt-landscape-scene]').count(), 0)
    await page.reload(); await page.getByRole('tab', { name: 'Q 主题', exact: true }).click()
    await checkSelection('buliangren')
    assert.equal(await buliangrenGroup.getByRole('radio', { name: '静态', exact: true }).isChecked(), true)
    await page.setViewportSize({ width: 420, height: 900 })
    await page.locator('.qyt-settings').screenshot({ path: join(output, 'buliangren-settings-narrow.png') })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    both = await page.evaluate(() => window.__oceanSettingsFixture.getSnapshot().value)
    assert.equal(both.qThemeSettings.moonfrost.motion, 'static')
    assert.equal(both.qThemeSettings.buliangren.motion, 'static')
    // Audio controls and hint text are intentionally absent; previews stay muted.
    await page.setViewportSize({ width: 1080, height: 920 })
    await chooseTheme('fox')
    await page.locator('.qyt-theme-card[data-theme="fox"]').waitFor()
    assert.equal(await page.getByRole('switch', { name: '视频静音', exact: true }).count(), 0)
    assert.equal(await page.locator('.qyt-theme-caption').count(), 0)
    await previewFrame.locator('video[data-ready="true"]').waitFor({ state: 'visible' })
    assert.equal(await previewFrame.locator('video').evaluate(video => video.muted), true)
    assert.equal(await previewFrame.locator('video').count(), 1)
    const videoPreview = await previewFrame.locator('video').evaluate(video => {
      const rect=video.getBoundingClientRect(),sidebar=document.querySelector('[data-slot="sidebar"] > :first-child')
      return {fullWidth:Math.abs(rect.width-innerWidth)<1,fullHeight:Math.abs(rect.height-innerHeight)<1,sharesSidebar:video.parentElement.contains(sidebar),staticSidebar:getComputedStyle(sidebar).backgroundImage.includes('data:image/')}
    })
    assert.deepEqual(videoPreview,{fullWidth:true,fullHeight:true,sharesSidebar:true,staticSidebar:false})

    const foxMotion = page.getByRole('radiogroup', { name: '桃华白狐背景效果', exact: true })
    await foxMotion.getByRole('radio', { name: '静态', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('iframe[data-qyt-theme-preview]').contentDocument.querySelector('video'))
    await foxMotion.getByRole('radio', { name: '动态', exact: true }).click()
    await previewFrame.locator('video[data-ready="true"]').waitFor({ state: 'visible' })
    await page.locator('.qyt-settings').screenshot({ path: join(output, 'fox-settings-dark.png') })
    await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))
    await page.locator('.qyt-settings').screenshot({ path: join(output, 'fox-settings-light.png') })
    await page.setViewportSize({ width: 420, height: 900 })
    await page.locator('.qyt-settings').screenshot({ path: join(output, 'fox-settings-narrow.png') })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.evaluate(() => { window.__detachedVideo = document.querySelector('iframe[data-qyt-theme-preview]').contentDocument.querySelector('video') })
    await page.evaluate(() => { window.__detachedThemePreview = document.querySelector('iframe[data-qyt-theme-preview]').contentDocument })
    await page.getByRole('tab', { name: '附件增强', exact: true }).click()
    assert.equal(await page.locator('iframe[data-qyt-theme-preview]').count(), 0)
    assert.equal(await page.evaluate(() => window.__detachedThemePreview.querySelectorAll('canvas, video, style[data-qyt-q-theme]').length), 0, 'Leaving the theme settings disposes the preview document scene and its palette')
    assert.equal(await page.evaluate(() => window.__detachedVideo.paused && !window.__detachedVideo.hasAttribute('src')), true)

    await page.setViewportSize({ width: 1080, height: 920 })
    await page.getByRole('tab', { name: 'Q 主题', exact: true }).click()
    await chooseTheme('garo')
    const garoMotion = page.getByRole('radiogroup', { name: '月下冰弦背景效果', exact: true })
    const garoVideo = previewFrame.locator('body[data-qyt-q-theme="garo"] video[data-ready="true"]')
    await garoVideo.waitFor({ state: 'visible', timeout: 120_000 })
    assert.equal(await garoVideo.evaluate(video => video.muted && video.loop && video.videoWidth === 1920 && video.videoHeight === 1080), true)
    assert.equal(await page.locator('.qyt-theme-caption').count(), 0)
    await page.locator('.qyt-settings').screenshot({ path: join(output, 'garo-settings-light.png') })
    await garoMotion.getByRole('radio', { name: '静态', exact: true }).click()
    await garoVideo.waitFor({ state: 'detached' })
    assert.equal(await previewFrame.locator('[data-slot="sidebar"] > :first-child').evaluate(node => getComputedStyle(node).backgroundImage.includes('data:image/')), true)
    await page.locator('.qyt-settings').screenshot({ path: join(output, 'garo-settings-static.png') })
    await chooseTheme('bluefish', true)
    const linked = gallery.getByRole('region', { name: '联动主题' })
    await linked.getByRole('button', { name: /蓝色大肥鱼.*鼠标互动.*会话联动/ }).and(linked.locator('[aria-pressed="true"]')).waitFor()
    await gallery.screenshot({ path: join(output, 'bluefish-gallery.png') })
    await closeGallery()
    const mascot = previewFrame.locator('.qyt-bluefish-mascot')
    await mascot.waitFor()
    const character = mascot.locator('.qyt-bluefish-character')
    await character.waitFor()
    await mascot.locator('.qyt-bluefish-character[data-renderer="mesh"] > canvas').waitFor()
    assert.equal(await character.locator('canvas').count(), 1)
    const water = previewFrame.locator('.qyt-bluefish-water > canvas[data-ready="true"]')
    await water.waitFor()
    assert.equal(await previewFrame.locator('.qyt-bluefish-emitted-bubble').count(), 0)
    const waterBefore = await water.evaluate(canvas => canvas.toDataURL())
    await page.waitForTimeout(170)
    assert.notEqual(await water.evaluate(canvas => canvas.toDataURL()), waterBefore)
    const frameBounds = await page.locator('iframe[data-qyt-theme-preview]').boundingBox()
    await page.mouse.move(frameBounds.x + 10, frameBounds.y + 15)
    await page.waitForTimeout(250)
    const leftGaze = Number((await character.getAttribute('data-gaze')).split(',')[0])
    await page.mouse.move(frameBounds.x + frameBounds.width - 10, frameBounds.y + frameBounds.height - 10)
    await page.waitForTimeout(250)
    const rightGaze = Number((await character.getAttribute('data-gaze')).split(',')[0])
    assert.ok(leftGaze < -.003 && rightGaze > .003, 'The iris offsets track the pointer in both directions')
    const bounds = await mascot.boundingBox()
    const x = bounds.x + bounds.width * .46, y = bounds.y + bounds.height * .42
    await page.mouse.move(x, y)
    await previewFrame.locator('.qyt-bluefish-mascot[data-pose="look"]').waitFor()
    await page.mouse.click(bounds.x + bounds.width * .48, bounds.y + bounds.height * .62)
    await previewFrame.locator('.qyt-bluefish-mascot[data-mode="feed"][data-pose="chew"]').waitFor()
    await page.getByRole('button', { name: '逗她玩', exact: true }).click()
    await previewFrame.locator('.qyt-bluefish-mascot[data-mode="idle"]').waitFor()
    const recordAt = process.argv.indexOf('--record-bluefish')
    const recording = recordAt > 0 ? await page.context().newCDPSession(page) : undefined
    const captured = []
    if (recording) {
      recording.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
        captured.push({ data, time: metadata.timestamp })
        recording.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
      })
      await recording.send('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 4 })
    }
    await page.getByRole('button', { name: '逗她玩', exact: true }).click()
    await previewFrame.locator('.qyt-bluefish-mascot[data-mode="play"][data-affect="happy"]').waitFor()
    await previewFrame.locator('.qyt-bluefish-mascot[data-travel-phase="rise"][data-choreography="play"]').waitFor()
    assert.ok(Math.abs((await mascot.boundingBox()).x - bounds.x) < 1, 'The pet gets up before moving')
    const chaseFrames = mascot.evaluate(async pet => {
      const butterfly = pet.parentElement.querySelector('.qyt-bluefish-butterfly')
      const character = pet.querySelector('.qyt-bluefish-character')
      const frames = []
      while (pet.dataset.mode === 'play' && frames.length < 500) {
        await new Promise(requestAnimationFrame)
        const box = pet.getBoundingClientRect()
        const target = butterfly.getBoundingClientRect()
        const [handX, handY] = character.dataset.hand.split(',').map(Number)
        const [footX = NaN] = (character.dataset.support ?? '').split(',').filter(Boolean).map(Number)
        frames.push({
          phase: pet.dataset.travelPhase, stage: pet.dataset.actionStage, x: box.left,
          targetX: target.x + target.width / 2, targetY: target.y + target.height / 2,
          opacity: Number(butterfly.style.opacity), foot: box.left + footX * box.width,
          fingertipGap: Math.hypot(box.left + handX * box.width - target.x - target.width / 2,
            box.top + handY * box.height - target.y - target.height / 2),
          progress: character.dataset.artProgress,
          gaze: character.dataset.gaze,
        })
      }
      const walk = frames.filter(frame => frame.stage === 'step' && Number.isFinite(frame.foot))
      const reach = frames.filter(frame => frame.stage === 'reach' && frame.opacity > .9)
      const land = frames.filter(frame => frame.stage === 'land' && frame.opacity > .7)
      return {
        stages: [...new Set(frames.map(frame => frame.stage).filter(Boolean))],
        phases: [...new Set(frames.map(frame => frame.phase).filter(Boolean))],
        steps: new Set(walk.map(frame => frame.progress)).size,
        plantedDriftPx: Math.max(...walk.map(frame => frame.foot)) - Math.min(...walk.map(frame => frame.foot)),
        moved: Math.min(...walk.map(frame => frame.x)) < frames[0].x - 10,
        closestReachPx: Math.min(...reach.map(frame => frame.fingertipGap)),
        escapeRisePx: reach[0]?.targetY - land.at(-1)?.targetY,
        looksUp: land.some(frame => Number(frame.gaze.split(',')[1]) < -.004),
        returned: Math.abs(pet.getBoundingClientRect().left - frames[0].x) < 1,
      }
    })
    await previewFrame.locator('.qyt-bluefish-mascot[data-action-stage="step"]').waitFor()
    await page.waitForTimeout(590)
    await page.locator('iframe[data-qyt-theme-preview]').screenshot({ path: join(output, 'bluefish-walk.png') })
    await previewFrame.locator('.qyt-bluefish-mascot[data-action-stage="reach"]').waitFor()
    await page.waitForTimeout(320)
    await page.locator('iframe[data-qyt-theme-preview]').screenshot({ path: join(output, 'bluefish-chase.png') })
    const chase = await chaseFrames
    if (recording) {
      await recording.send('Page.stopScreencast')
      await recording.detach()
      await writeFile(resolve(process.argv[recordAt + 1]), JSON.stringify({ bounds: frameBounds, frames: captured }))
    }
    assert.deepEqual(chase.stages.slice(0, 6), ['discover', 'plant', 'step', 'jump', 'reach', 'land'])
    assert.deepEqual(chase.phases, ['rise', 'walk', 'jump', 'reach', 'land', 'return', 'sit'])
    assert.ok(chase.steps >= 12 && chase.plantedDriftPx < 1.1, JSON.stringify(chase))
    assert.ok(chase.moved && chase.closestReachPx < 31 && chase.escapeRisePx > 22 && chase.looksUp && chase.returned, JSON.stringify(chase))
    await page.getByRole('button', { name: '演示工作状态', exact: true }).click()
    await previewFrame.locator('.qyt-bluefish-mascot[data-mode="working"][data-pose="chew"]').waitFor()
    await page.locator('.qyt-settings').screenshot({ path: join(output, 'bluefish-settings.png') })
    for (const meal of ['pork', 'eggs', 'cookies']) {
      await previewFrame.locator(`.qyt-bluefish-mascot[data-mode="working"][data-pose="chew"][data-meal="${meal}"]`).waitFor()
      await mascot.locator(`.qyt-bluefish-character[data-art-to="${meal}2"]`).waitFor()
      await page.locator('iframe[data-qyt-theme-preview]').screenshot({ path: join(output, `bluefish-meal-${meal}.png`) })
    }
    await previewFrame.locator('body').evaluate(body => { body.dataset.qytBluefishDemoStarted = String(Date.now() - 71 * 60_000) })
    await previewFrame.getByText('求你啦，先休息一会儿。我们回来再继续，好不好？', { exact: true }).waitFor()
    await previewFrame.locator('.qyt-bluefish-mascot[data-mode="working"][data-affect="worried"]').waitFor()
    assert.equal(await previewFrame.locator('[data-phase]').evaluate(phase => phase.getAnimations().some(animation => animation.effect.getKeyframes().some(frame => frame.translate === '-3px 0px' || frame.translate === '-3px'))), true)
    await previewFrame.locator('[data-phase]').evaluate(phase => Promise.allSettled(phase.getAnimations().map(animation => animation.finished)))
    await page.locator('.qyt-settings').screenshot({ path: join(output, 'bluefish-reminder.png') })
    await page.getByRole('button', { name: '结束演示', exact: true }).click()
    await previewFrame.locator('.qyt-bluefish-mascot[data-mode="idle"]').waitFor()
    await mascot.evaluate(node => {
      const { x, y, width, height } = node.getBoundingClientRect()
      const phase = node.parentElement
      for (let i = 0; i < 4; i++) phase.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1, clientX: x + width * .46, clientY: y + height * .42 }))
    })
    await previewFrame.locator('.qyt-bluefish-mascot[data-affect="grumpy"]').waitFor()
    const fishMotion = page.getByRole('radiogroup', { name: '蓝色大肥鱼背景效果', exact: true })
    await fishMotion.getByRole('radio', { name: '静态', exact: true }).click()
    await mascot.waitFor({ state: 'detached' })
    assert.equal(await page.getByRole('button', { name: '演示工作状态', exact: true }).count(), 0)
    assert.equal(await previewFrame.locator('[data-phase]').evaluate(node => getComputedStyle(node, '::after').backgroundImage.includes('data:image/png')), true)
    await fishMotion.getByRole('radio', { name: '动态', exact: true }).click()
    await mascot.waitFor()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await mascot.waitFor({ state: 'detached' })
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await mascot.waitFor()
    await page.clock.install()
    await fishMotion.getByRole('radio', { name: '静态', exact: true }).click()
    await mascot.waitFor({ state: 'detached' })
    await fishMotion.getByRole('radio', { name: '动态', exact: true }).click()
    await mascot.waitFor()
    await page.clock.fastForward(40_000)
    await previewFrame.locator('.qyt-bluefish-mascot[data-mode="nap"]').waitFor()
    await page.mouse.move(frameBounds.x + 16, frameBounds.y + 24)
    await previewFrame.locator('.qyt-bluefish-mascot[data-mode="idle"]').waitFor()
    await page.clock.fastForward(23_000)
    await previewFrame.locator('.qyt-bluefish-mascot[data-mode="fish"]').waitFor()
    await page.clock.fastForward(3050)
    await previewFrame.locator('.qyt-bluefish-mascot[data-mode="fish"][data-affect="happy"]').waitFor()
    await page.clock.fastForward(2100)
    await previewFrame.locator('.qyt-bluefish-mascot[data-mode="idle"]').waitFor()
    await page.mouse.move(frameBounds.x + 22, frameBounds.y + 26)
    await page.clock.fastForward(26_000)
    await previewFrame.locator('.qyt-bluefish-mascot[data-mode="desk"]').waitFor()
    await page.clock.fastForward(490)
    await previewFrame.locator('.qyt-bluefish-mascot[data-action-stage="clear"]').waitFor()
    await page.clock.fastForward(760)
    await previewFrame.locator('.qyt-bluefish-mascot[data-action-stage="open"]').waitFor()
    await page.clock.fastForward(710)
    await previewFrame.locator('.qyt-bluefish-mascot[data-action-stage="write"]').waitFor()
    const writing = await character.getAttribute('data-art-progress')
    await page.clock.runFor(180)
    assert.notEqual(await character.getAttribute('data-art-progress'), writing)
    await page.locator('iframe[data-qyt-theme-preview]').screenshot({ path: join(output, 'bluefish-writing.png') })
    await page.clock.fastForward(5500)
    await previewFrame.locator('.qyt-bluefish-mascot[data-mode="idle"]').waitFor()
    await page.clock.fastForward(40_000)
    await previewFrame.locator('.qyt-bluefish-mascot[data-mode="nap"]').waitFor()
    await page.clock.fastForward(1100)
    await previewFrame.locator('.qyt-bluefish-mascot[data-action-stage="doze"]').waitFor()
    await page.clock.fastForward(2700)
    await previewFrame.locator('.qyt-bluefish-mascot[data-action-stage="bed"]').waitFor()
    await page.clock.fastForward(620)
    await previewFrame.locator('.qyt-bluefish-mascot[data-action-stage="knee"]').waitFor()
    await page.locator('iframe[data-qyt-theme-preview]').screenshot({ path: join(output, 'bluefish-bed-knee.png') })
    await page.clock.fastForward(500)
    await previewFrame.locator('.qyt-bluefish-mascot[data-action-stage="climb"]').waitFor()
    await page.clock.fastForward(600)
    await previewFrame.locator('.qyt-bluefish-mascot[data-action-stage="lie"]').waitFor()
    await page.clock.fastForward(580)
    await previewFrame.locator('.qyt-bluefish-mascot[data-action-stage="cover"]').waitFor()
    await page.locator('iframe[data-qyt-theme-preview]').screenshot({ path: join(output, 'bluefish-bed-cover.png') })
    await page.clock.fastForward(800)
    await previewFrame.locator('.qyt-bluefish-mascot[data-action-stage="sleep"]').waitFor()
    await page.locator('iframe[data-qyt-theme-preview]').screenshot({ path: join(output, 'bluefish-bed.png') })
    await page.mouse.move(frameBounds.x + 28, frameBounds.y + 30)
    await page.clock.fastForward(2250)
    await previewFrame.locator('.qyt-bluefish-mascot[data-mode="idle"]').waitFor()
    for (const [tool, movement] of [['gun', 'bubbles'], ['wand', 'bubbles'], ['gun', 'bubbleRun'], ['wand', 'bubbleRun']]) {
      await page.getByRole('button', { name: '玩泡泡', exact: true }).click()
      await previewFrame.locator('.qyt-bluefish-mascot[data-mode="bubbles"]').waitFor()
      await page.clock.runFor(1210)
      const emitted = previewFrame.locator(`.qyt-bluefish-emitted-bubble[data-source="${tool}"][data-choreography="${movement}"]`).first()
      await emitted.waitFor()
      const originError = await emitted.evaluate(bubble => {
        const scene = bubble.parentElement
        const pet = scene.querySelector('.qyt-bluefish-mascot')
        const character = pet.querySelector('.qyt-bluefish-character')
        const [x, y] = character.dataset.nozzle.split(',').map(Number)
        const bounds = pet.getBoundingClientRect(), area = scene.getBoundingClientRect()
        return Math.hypot(parseFloat(bubble.style.left) + parseFloat(bubble.style.width) / 2 - (bounds.left - area.left + bounds.width * x),
          parseFloat(bubble.style.top) + parseFloat(bubble.style.height) / 2 - (bounds.top - area.top + bounds.height * y))
      })
      assert.ok(originError < 11, `${movement}/${tool} spawn error ${originError}px`)
      assert.ok(await emitted.evaluate(bubble => bubble.getAnimations().some(animation => animation.effect.getKeyframes().at(-1).transform.includes('px, -'))))
      await page.locator('iframe[data-qyt-theme-preview]').screenshot({ path: join(output, `bluefish-${movement}-${tool}.png`) })
      await page.clock.fastForward(6200)
      await previewFrame.locator('.qyt-bluefish-mascot[data-mode="idle"]').waitFor()
    }
    assert.deepEqual(errors, [])
    const report = { passed: true, source: 'src/client/index.tsx::QiuYaToolsSettings + src/client/q-theme.ts::installQTheme', html: htmlPath, chase, geometry, nestedMutation: oceanMutation, lightPalette, darkPalette, narrow, preferences: both, screenshots: ['ocean-settings.png', 'ocean-settings-card.png', 'ocean-settings-static.png', 'ocean-settings-narrow.png', 'begonia-settings.png', 'begonia-settings-card.png', 'begonia-settings-dark.png', 'begonia-settings-narrow.png', 'theme-gallery.png', 'theme-gallery-narrow.png', 'moonfrost-settings.png', 'moonfrost-settings-card.png', 'moonfrost-settings-dark.png', 'moonfrost-settings-narrow.png', 'buliangren-settings.png', 'buliangren-settings-dark.png', 'buliangren-settings-narrow.png', 'fox-settings-light.png', 'fox-settings-dark.png', 'fox-settings-narrow.png', 'garo-settings-light.png', 'garo-settings-static.png', 'bluefish-walk.png', 'bluefish-chase.png', 'bluefish-writing.png', 'bluefish-bed.png'] }
    await writeFile(join(output, 'settings-preview-result.json'), JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report, null, 2))
  } finally {
    videoHost.stop()
    await browser?.close(); await new Promise(resolve => server.close(resolve))
  }
}
