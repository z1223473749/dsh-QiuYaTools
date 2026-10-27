/** Render the real plugin settings component and verify Ocean's own motion option. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

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
import css from './src/client/styles.css';
import {OCEAN_SCENE_DATA_URL} from './src/client/brand-assets.ts';
const style=document.createElement('style');style.textContent=css.replaceAll('__QYT_OCEAN_SCENE__',OCEAN_SCENE_DATA_URL);document.head.append(style);
const listeners=new Set(),mutations=[];
const initial=JSON.parse(localStorage.getItem('qyt.ocean.preview.settings')||'null')||{qThemeEnabled:true,qThemeSettings:{ocean:{motion:'dynamic'},futureTheme:{motion:'static'}}};
let snapshot={status:'ready',writable:true,value:initial,revision:1},failure=false;
const form={getSnapshot:()=>snapshot,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn)},async mutate(operations){
  mutations.push(structuredClone(operations));await new Promise(resolve=>setTimeout(resolve,25));if(failure)return false;
  const value=structuredClone(snapshot.value);for(const operation of operations){if(operation.op!=='set')throw Error('Unsupported fixture operation');let parent=value;for(const key of operation.path.slice(0,-1))parent=parent[key]??={};parent[operation.path.at(-1)]=operation.value}
  snapshot={...snapshot,value,revision:snapshot.revision+1};localStorage.setItem('qyt.ocean.preview.settings',JSON.stringify(value));for(const listener of [...listeners])listener();return true;
}};
const support={status:'ready',harnessVersion:'0.2.1-rc.2',minimumHarnessVersion:'0.2.1-rc.2',versionSupported:true};
const ctx={sessionWindowSupport:{getSnapshot:()=>support,subscribe:()=>()=>{}},get(){return undefined}};
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
    builder.onResolve({ filter: /^\.\/q-theme\.ts$/ }, () => ({ path: 'theme', namespace: 'preview-boundary' }))
    builder.onResolve({ filter: /^\.\/session-window-support\.ts$/ }, () => ({ path: 'support', namespace: 'preview-boundary' }))
    builder.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: 'primitives', namespace: 'preview-boundary' }))
    builder.onLoad({ filter: /.*/, namespace: 'preview-boundary' }, ({ path }) => ({
      contents: path === 'features' ? 'export function installFeatures(){}'
        : path === 'theme' ? 'export function installQTheme(){}'
          : path === 'support' ? 'export function getSessionWindowSupport(ctx){return ctx.sessionWindowSupport}'
            : `import React from 'react';export function Switch({checked,disabled,label,onChange,className}){return React.createElement('button',{type:'button',role:'switch','aria-label':label,'aria-checked':checked,disabled,className,onClick:()=>onChange(!checked)},React.createElement('span'))}export function Modal(){return null}export function MenuSurface(){return null}export function MenuItemButton(){return null}export function useAnchoredPosition(){return{}}export function useDismissOnOutsidePointer(){}`,
      resolveDir: root,
    }))
    builder.onLoad({ filter: /\.module\.css$/ }, async ({ path }) => ({ contents: await (await import('node:fs/promises')).readFile(path, 'utf8'), loader: 'local-css' }))
  } }],
})
const script = bundle.outputFiles.find(file => file.path.endsWith('.js'))?.text ?? bundle.outputFiles[0].text
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>鲸与海 · 主题设置</title><style>
:root{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#25292c;background:#e9eeeb;--dsw-alias-bg-layer-2:#fafbf9;--dsw-alias-label-primary:#25292c;--dsw-alias-label-secondary:#616b6e;--dsw-alias-border-l3:#d9dfdc;--dsw-alias-interactive-bg-active:#bfcac7}
*{box-sizing:border-box}body{margin:0;min-height:100vh;padding:28px;display:grid;place-items:center}button,input{font:inherit}button{cursor:pointer}button:disabled{cursor:default}.preview-shell{width:min(920px,100%)}.preview-nav{margin:0 0 12px 4px;font-size:12px}.preview-nav a{color:#116d83;text-decoration:none}.preview-nav a:hover{text-decoration:underline}[data-shortcut-modal="settings"]{width:100%;height:min(820px,calc(100vh - 90px));min-height:540px;padding:20px;border:1px solid #d3ddd7;border-radius:18px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 18px 60px #253f3220}.harness-options{height:100%}[data-slot="settings.section"]{display:contents}.qyt-switch{border:0;border-radius:999px;width:34px;height:20px;background:#bdc9c5;padding:2px;display:flex}.qyt-switch>span{display:block;width:16px;height:16px;border-radius:50%;background:white}.qyt-switch[aria-checked="true"]{justify-content:flex-end}
@media(max-width:620px){body{padding:12px}[data-shortcut-modal="settings"]{padding:14px;height:calc(100vh - 58px)}}
</style></head><body><main class="preview-shell"><nav class="preview-nav" aria-label="预览导航"><a href="/">← 返回海面</a></nav><div data-shortcut-modal="settings" role="dialog" aria-label="QiuYaTools 设置"><div class="harness-options"><div data-slot="settings.section"></div></div></div></main><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`
const htmlPath = join(output, 'settings-preview.html')
await writeFile(htmlPath, html)
if (process.argv.includes('--generate-only')) {
  console.log(JSON.stringify({ html: htmlPath }))
} else {
  const server = createServer((request, response) => {
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
    const geometry = await page.locator('.qyt-theme-title').evaluate(row => {
      const bounds = node => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } }
      return { heading: bounds(row.querySelector('h4')), control: bounds(row.querySelector('[role="radiogroup"]')), name: bounds(row.querySelector('.qyt-theme-name')) }
    })
    assert.ok(geometry.control.left >= geometry.heading.right && geometry.control.left - geometry.heading.right <= 16, 'Motion selector must immediately follow the left heading')
    assert.ok(geometry.name.left > geometry.control.right, 'Original theme name must remain at the far right')
    assert.ok(Math.abs((geometry.heading.top + geometry.heading.bottom) / 2 - (geometry.control.top + geometry.control.bottom) / 2) < 2, 'Heading and motion selector must align vertically')
    await page.locator('.qyt-settings').screenshot({ path: join(output, 'ocean-settings.png') })
    await page.locator('.qyt-theme-card').screenshot({ path: join(output, 'ocean-settings-card.png') })
    await group.getByText('静态', { exact: true }).click()
    await page.waitForFunction(() => window.__oceanSettingsFixture.getSnapshot().value.qThemeSettings.ocean.motion === 'static')
    assert.equal(await group.getByRole('radio', { name: '静态', exact: true }).isChecked(), true)
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
    assert.deepEqual(errors, [])
    const report = { passed: true, source: 'src/client/index.tsx::QiuYaToolsSettings', html: htmlPath, geometry, nestedMutation: result.mutations[0], screenshots: ['ocean-settings.png', 'ocean-settings-card.png', 'ocean-settings-static.png', 'ocean-settings-narrow.png'] }
    await writeFile(join(output, 'settings-preview-result.json'), JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report, null, 2))
  } finally {
    await browser?.close(); await new Promise(resolve => server.close(resolve))
  }
}
