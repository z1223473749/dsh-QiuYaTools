import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

// Real browser/React/CSS; synthetic application catalog and permission RPCs.
// This test never enumerates or changes permissions on the user's computer.
const root = fileURLToPath(new URL('../', import.meta.url))
const output = resolve(root, 'artifacts/computer-use/permissions')
await mkdir(output, { recursive: true })
const fixture = `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {ComputerPanel} from './src/features/computer-use/panel.tsx';import css from './src/client/styles.css';
import {computerVisualStyles} from './src/features/computer-use/visual-style.ts';
const style=document.createElement('style');style.textContent=computerVisualStyles+css;document.head.append(style);
const applications=Array.from({length:60},(_,i)=>({appId:'fixture.'+i,name:i<55?'已授权应用 '+i:'待授权应用 '+i,running:false}));
const status={sessions:[],allowedApps:applications.slice(0,55).map(app=>app.appId),native:{platform:'win32',available:true}};
const calls=[],failures=new Map();window.permissionsFixture={calls,failures,status};
const ctx={get(name){if(name==='connection')return{rpc:{async call(channel,endpoint,input){
calls.push(input);if(input.op==='applications')return{ok:true,value:structuredClone(applications)};
if(input.op==='status')return{ok:true,value:structuredClone(status)};
if(input.op==='allow'){if(failures.has(input.appId)){const message=failures.get(input.appId);failures.delete(input.appId);return{ok:false,error:{message}}}
status.allowedApps=input.allowed?[...new Set([...status.allowedApps,input.appId])]:status.allowedApps.filter(id=>id!==input.appId);
return{ok:true,value:{allowedApps:[...status.allowedApps]}}}throw Error('Unexpected operation '+input.op);
}}}}};
function App(){const[enabled,setEnabled]=useState(true);return <ComputerPanel ctx={ctx} enabled={enabled} onEnabled={setEnabled} disabled={false}/>}
createRoot(document.getElementById('root')).render(<App/>);
`
const compiled = await build({ stdin: { contents: fixture, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2022', jsx: 'automatic', loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'host-primitives', setup(builder) {
  builder.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: 'primitives', namespace: 'fixture' }))
  builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: "import React from 'react';export function Switch({checked,disabled,label,onChange}){return React.createElement('button',{'role':'switch','aria-label':label,'aria-checked':checked,disabled,onClick:()=>onChange(!checked)},checked?'已启用':'未启用')}", resolveDir: root }))
} }] })
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>持续授权应用批量管理</title><style>
:root{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#25292c;background:#f5f7f6;--dsw-alias-bg-layer-2:#fff;--dsw-alias-label-primary:#25292c;--dsw-alias-label-secondary:#697378;--dsw-alias-label-tertiary:#7a8589;--dsw-alias-border-l3:#e3e7e6;--dsw-alias-interactive-bg-hover:#e5f0ef}*{box-sizing:border-box}body{margin:0;padding:24px 12px}#root{max-width:620px;margin:0 auto;height:auto;overflow:visible}button{font:inherit}
</style><div id="root" class="qyt-settings"></div></html>`
const browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}) })
try {
  const page = await browser.newPage({ viewport: { width: 860, height: 800 } })
  const screenshot = async name => {
    await page.evaluate(() => { scrollTo(0, 0); return new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))) })
    await page.screenshot({ path: join(output, name), fullPage: true })
  }
  const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message))
  await page.setContent(html); await page.addScriptTag({ content: compiled.outputFiles[0].text })
  const section = page.getByRole('region', { name: '始终允许的应用', exact: true })
  const summary = section.locator('summary')
  await summary.filter({ hasText: '已授权应用（55）' }).waitFor()
  assert.equal(await section.locator('details').evaluate(node => node.open), false)
  assert.equal(await section.getByRole('checkbox').count(), 0, '55 rows stay out of the accessible layout while collapsed')
  assert.equal(await page.getByRole('region', { name: '电脑任务概览' }).isVisible(), true)
  await screenshot('collapsed-55.png')
  await page.getByRole('button', { name: '添加应用', exact: true }).click()
  const form = page.getByRole('form', { name: '添加持续授权应用' }), search = page.getByRole('combobox', { name: '搜索应用' })
  assert.equal(await form.getByRole('option').count(), 5)
  await search.press('Enter'); await search.press('Enter')
  assert.equal(await form.getByRole('option', { selected: true }).count(), 0)
  await form.getByRole('option', { name: '待授权应用 55', exact: true }).click()
  await search.fill('56'); await form.getByRole('button', { name: '全选', exact: true }).click()
  await form.getByRole('button', { name: '取消全选', exact: true }).click()
  assert.match(await form.innerText(), /已选择 1 个应用/u)
  await form.getByRole('button', { name: '全选', exact: true }).click(); await search.fill('')
  assert.match(await form.innerText(), /已选择 2 个应用/u)
  assert.equal(await page.evaluate(() => window.permissionsFixture.calls.filter(row => row.op === 'allow').length), 0)
  await screenshot('multi-select.png')
  await page.setViewportSize({ width: 360, height: 800 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await screenshot('multi-select-narrow.png')
  await page.evaluate(() => window.permissionsFixture.failures.set('fixture.56', '模拟保存失败'))
  await form.getByRole('button', { name: '始终允许', exact: true }).click()
  await section.getByRole('alert').filter({ hasText: '已添加 1 个应用；1 个应用未完成或需检查' }).waitFor()
  assert.equal(await form.getByRole('option', { selected: true }).count(), 1)
  assert.equal(await form.getByRole('option').count(), 4)
  assert.match(await summary.innerText(), /（56）/u)
  await screenshot('partial-add.png')
  await form.getByRole('button', { name: '始终允许', exact: true }).click(); await form.waitFor({ state: 'detached' })
  assert.deepEqual(await page.evaluate(() => window.permissionsFixture.calls.filter(row => row.op === 'allow').map(row => row.appId)), ['fixture.55', 'fixture.56', 'fixture.56'])
  await page.getByRole('switch', { name: '启用电脑操控' }).click()
  await summary.click()
  for (const id of [0, 1, 2]) await section.getByRole('checkbox', { name: '选择撤销 已授权应用 ' + id, exact: true }).check()
  await page.evaluate(() => window.permissionsFixture.failures.set('fixture.1', '模拟撤销失败'))
  await section.getByRole('button', { name: '撤销所选', exact: true }).click()
  await section.getByRole('alert').filter({ hasText: '已撤销 2 个应用；1 个应用未完成或需检查' }).waitFor()
  assert.equal(await section.getByRole('checkbox', { checked: true }).count(), 1)
  assert.equal(await section.getByRole('checkbox', { name: '选择撤销 已授权应用 1', exact: true }).isChecked(), true)
  assert.match(await summary.innerText(), /（55）/u)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await screenshot('partial-revoke-narrow.png')
  await section.getByRole('button', { name: '撤销所选', exact: true }).click()
  await summary.filter({ hasText: '已授权应用（54）' }).waitFor()
  assert.equal(await section.getByRole('checkbox', { checked: true }).count(), 0)
  await summary.click(); assert.equal(await section.getByRole('checkbox').count(), 0)
  assert.deepEqual(pageErrors, [])
  const report = { status: 'passed', checks: ['55 grants collapsed by default', 'only ungranted candidates', 'keyboard toggles', 'search-scoped select/deselect all', 'selection persists across searches', 'explicit confirmation', 'partial add and retry only failures', 'batch revoke while disabled', 'partial revoke and retry only failures', '360px layout without horizontal overflow'], limitations: ['Application discovery and permission RPCs are synthetic; no real application permissions were changed.'] }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ ...report, output }, null, 2))
} finally { await browser.close() }
