/** Exercise the production update panel and Host with a real archive and a paced download. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('..', import.meta.url))
const arg = name => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1] }
const archive = resolve(arg('--package') ?? 'artifacts/candidates/dsh-qiuya-tools-darwin-universal.tgz')
const output = resolve(arg('--output') ?? 'artifacts/update-progress')
const bytes = await readFile(archive)
const metadata = JSON.parse((await promisify(execFile)('tar', ['-xOf', archive, 'package/package.json'])).stdout)
assert.match(metadata.version, /^\d+\.\d+\.\d+$/u)
const [major, minor, patch] = metadata.version.split('.').map(Number)
assert.ok(patch > 0, 'Use an archive with a previous patch version for the fixture')
const previous = `${major}.${minor}.${patch - 1}`
const repository = 'https://github.com/z1223473749/dsh-QiuYaTools'
const assetName = 'dsh-qiuya-tools-darwin-universal.tgz'
const assetUrl = `${repository}/releases/download/v${metadata.version}/${assetName}`
const sha256 = createHash('sha256').update(bytes).digest('hex')
const temporary = await mkdtemp(join(tmpdir(), 'qyt-update-progress-'))
await mkdir(output, { recursive: true })
const hostBundle = join(temporary, 'host.mjs')
await build({ entryPoints: [join(root, 'src/updates/host.ts')], bundle: true, outfile: hostBundle, platform: 'node', format: 'esm' })
const { installPluginUpdatesHost } = await import(pathToFileURL(hostBundle).href)
const routes = new Map(), polls = [], errors = []
let downloads = 0, installs = 0
const stop = installPluginUpdatesHost({
  connection: { browserPeer: { principal: { kind: 'owner' } }, fetch: { register(route) { routes.set(route.path, route); return async () => routes.delete(route.path) } } },
  get(name) {
    if (name === 'profileContext') return { dir: temporary }
    if (name === 'pluginManager') return { async installBundle(spec) {
      installs++
      assert.equal(createHash('sha256').update(await readFile(new URL(spec))).digest('hex'), sha256)
      await new Promise(resolve => setTimeout(resolve, 1000))
      return { changed: true, application: 'restart-required', bundle: metadata.name, version: metadata.version }
    } }
  },
}, {
  repository, version: previous, packageName: metadata.name,
  async fetch(url) {
    if (String(url) === 'https://api.github.com/repos/z1223473749/dsh-QiuYaTools/releases/latest') return Response.json({
      id: 1, tag_name: `v${metadata.version}`, draft: false, prerelease: false,
      url: 'https://api.github.com/repos/z1223473749/dsh-QiuYaTools/releases/1', html_url: `${repository}/releases/tag/v${metadata.version}`,
      published_at: '2026-10-27T00:00:00Z', name: `QiuYa 增强工具箱 v${metadata.version}`, body: '下载期间显示实际百分比，完成后校验并安装。',
      assets: [{ id: 2, name: assetName, state: 'uploaded', size: bytes.length, url: 'https://api.github.com/repos/z1223473749/dsh-QiuYaTools/releases/assets/2', browser_download_url: assetUrl, digest: `sha256:${sha256}` }],
    })
    assert.equal(String(url), assetUrl)
    downloads++
    let offset = 0
    return new Response(new ReadableStream({ async pull(controller) {
      await new Promise(resolve => setTimeout(resolve, 90))
      if (offset >= bytes.length) { controller.close(); return }
      const end = Math.min(offset + 48 * 1024, bytes.length)
      controller.enqueue(bytes.subarray(offset, end)); offset = end
    } })) // Content-Length is intentionally absent: the verified GitHub asset owns the total.
  },
})
const fixture = `
import React from 'react';import {createRoot} from 'react-dom/client';
import {UpdatePanel} from './src/client/updates.tsx';import css from './src/client/styles.css';
const style=document.createElement('style');style.textContent=css;document.head.append(style);
const ctx={get(name){if(name==='connection')return{rpc:{async call(channel,endpoint,payload){
const response=await fetch(channel+'/'+endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method:endpoint,payload})});if(!response.ok)throw Error('Update request failed');return(await response.json()).result;
}}}}};
createRoot(document.getElementById('root')).render(React.createElement(UpdatePanel,{ctx,version:${JSON.stringify(previous)}}));
`
const compiled = await build({ stdin: { contents: fixture, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2022', jsx: 'automatic', loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'host-primitives', setup(builder) {
  builder.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: 'primitives', namespace: 'fixture' }))
  builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export function Switch(){return null}' }))
} }] })
const script = compiled.outputFiles[0].text.replaceAll('</script', '<\\/script')
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>版本更新 · 下载进度</title><style>
:root{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#25292c;background:#f5f7f6;--qyt-ocean:#0c7186;--qyt-ocean-soft:#e9f3f2;--qyt-ocean-line:#d9e6e4;--dsw-alias-bg-layer-2:#fff;--dsw-alias-label-primary:#25292c;--dsw-alias-label-secondary:#697378;--dsw-alias-label-tertiary:#7a8589;--dsw-alias-border-l3:#e3e7e6;--dsw-alias-interactive-bg-hover:#e5f0ef}*{box-sizing:border-box}body{margin:0;padding:36px 20px}#root{max-width:620px;margin:0 auto;height:auto;overflow:visible}button{font:inherit}button:disabled{cursor:default}@media(max-width:450px){body{padding:20px 12px}}
</style><div id="root" class="qyt-settings"></div><script>${script}</script></html>`
const server = createServer(async (incoming, outgoing) => {
  try {
    const route = routes.get(incoming.url)
    if (!route) { outgoing.setHeader('Content-Type', 'text/html; charset=utf-8'); outgoing.end(html); return }
    const parts = []; for await (const chunk of incoming) parts.push(chunk)
    const response = await route.fetch(new Request('http://127.0.0.1' + incoming.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.concat(parts) }))
    const body = await response.text()
    if (incoming.url.endsWith('.progress')) polls.push(JSON.parse(body).result?.value?.progress ?? null)
    outgoing.writeHead(response.status, { 'Content-Type': 'application/json' }); outgoing.end(body)
  } catch (error) { outgoing.writeHead(500); outgoing.end('Fixture failed'); errors.push(error.message) }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
  browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}) })
  const page = await browser.newPage({ viewport: { width: 860, height: 680 }, deviceScaleFactor: 1 })
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByRole('button', { name: '检查更新', exact: true }).click()
  await page.getByRole('button', { name: `更新至 v${metadata.version}`, exact: true }).click()
  await page.waitForFunction(() => { const node=document.querySelector('[role="progressbar"]'); return Number(node?.getAttribute('aria-valuenow')) >= 25 })
  const percent = await page.getByRole('progressbar').getAttribute('aria-valuenow')
  assert.ok(Number(percent) >= 25 && Number(percent) < 100)
  assert.match(await page.locator('.qyt-about-install').innerText(), /\d+%/u)
  await page.screenshot({ path: join(output, 'download-progress.png') })
  await page.setViewportSize({ width: 390, height: 680 })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.screenshot({ path: join(output, 'download-progress-narrow.png') })
  await page.setViewportSize({ width: 860, height: 680 })
  await page.getByRole('button', { name: '正在安装…', exact: true }).waitFor()
  await page.screenshot({ path: join(output, 'installing.png') })
  await page.getByRole('status').filter({ hasText: `v${metadata.version} 已安装` }).waitFor()
  await page.screenshot({ path: join(output, 'complete.png') })
  const settled = polls.length
  await page.waitForTimeout(650)
  assert.equal(polls.length, settled, 'Completed installation must stop polling')
  assert.equal(downloads, 1); assert.equal(installs, 1); assert.deepEqual(errors, [])
  const received = polls.filter(row => row?.stage === 'downloading')
  assert.ok(received.length > 4)
  assert.ok(received.every(row => row.totalBytes === bytes.length && Math.abs(row.percentage - row.downloadedBytes / bytes.length * 100) < 1e-9))
  assert.ok(received.every((row, i) => i === 0 || row.downloadedBytes >= received[i - 1].downloadedBytes))
  const report = { status: 'passed', kind: 'production-Host-and-React-paced-download', version: metadata.version, archiveSha256: sha256, bytes: bytes.length, downloads, installs, polls, screenshots: ['download-progress.png', 'download-progress-narrow.png', 'installing.png', 'complete.png'], limitations: ['The network is a paced fixture; plugin-manager installation is an isolated stub. Archive validation and download hashing use production code.'] }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ status: report.status, bytes: report.bytes, downloads, installs, polls: polls.length, output }))
} finally { await browser?.close(); stop(); await new Promise(resolve => server.close(resolve)); await rm(temporary, { recursive: true, force: true }) }
