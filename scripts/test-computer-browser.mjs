import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Real installed Chrome/Edge, private profile, synthetic login and local website. */
export async function runBrowserSmoke({ browser = 'chrome', executable, artifacts = 'artifacts/browser-e2e', modulePath } = {}) {
  let moduleUrl
  if (modulePath) moduleUrl = pathToFileURL(resolve(modulePath)).href
  else {
    const { build } = await import('esbuild')
    const source = (await build({ stdin: { contents: 'export { BrowserSession, BrowserDeviceDriver } from "./src/features/computer-use/browser.ts";export { ComputerSessionService } from "./src/features/computer-use/session.ts";export { installComputerTools } from "./src/features/computer-use/tools.ts";', resolveDir: fileURLToPath(new URL('../', import.meta.url)), sourcefile: 'browser-test-entry.ts' }, bundle: true, write: false, platform: 'node', format: 'esm' })).outputFiles[0].text
    moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  }
  const { BrowserSession, BrowserDeviceDriver, ComputerSessionService, installComputerTools } = await import(moduleUrl)
  if (!ComputerSessionService || !installComputerTools) throw new Error('--module must export BrowserSession, BrowserDeviceDriver, ComputerSessionService and installComputerTools')
  const profile = await mkdtemp(join(tmpdir(), 'qiuya-browser-e2e-')), checks = [], output = resolve(artifacts)
  await mkdir(output, { recursive: true })
  const events = []
  const page = `<!doctype html><html><head><title>QiuYa Browser Fixture</title></head><body><h1>Browser fixture 中文</h1><label>Name <input id="name"></label><button id="login">Login</button><button id="count" style="position:fixed;left:300px;top:50px;width:100px;height:50px">Count: 0</button><p id="state"></p><div style="height:2000px">scroll fixture</div><script>let count=0;const state=document.querySelector('#state');function refresh(){state.textContent=document.cookie.includes('fixture_login=yes')?'Signed in fixture':'Signed out fixture'}refresh();document.querySelector('#login').onclick=()=>{document.cookie='fixture_login=yes; Max-Age=86400; SameSite=Lax; Path=/';refresh()};document.querySelector('#count').onclick=()=>document.querySelector('#count').textContent='Count: '+(++count);window.addEventListener('scroll',()=>fetch('/events',{method:'POST',body:JSON.stringify({scrollY:window.scrollY})}))</script></body></html>`
  const server = createServer((request, response) => { if (request.url === '/events') { let body = ''; request.on('data', chunk => { body += chunk }); request.on('end', () => { events.push(JSON.parse(body)); response.end('ok') }); return }; response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(page) })
  let session, connected, restored
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const origin = `http://127.0.0.1:${server.address().port}`
    const options = { browser, executable, profileDir: profile, headless: true, allowedOrigins: [origin], timeoutMs: 15_000 }
    session = new BrowserSession(options); await session.launch()
    const tab = await session.open(`${origin}/fixture`)
    let observation = await session.observe(tab.id)
    assert.ok(observation.width > 0 && observation.height > 0); assert.match(observation.elements, /Browser fixture/)
    await writeFile(join(output, 'before.jpg'), Buffer.from(observation.imageBase64, 'base64')); checks.push('actual screenshot and AX tree')
    await session.act(tab.id, { kind: 'type', selector: '#name', text: '你好🙂 QiuYa' })
    observation = await session.observe(tab.id); assert.match(observation.elements, /你好🙂 QiuYa/); checks.push('selector Unicode input')
    await session.act(tab.id, { kind: 'click', selector: '#login' })
    observation = await session.observe(tab.id); assert.match(observation.elements, /Signed in fixture/); checks.push('synthetic login cookie')
    await session.act(tab.id, { kind: 'click', selector: '#count' })
    observation = await session.observe(tab.id); assert.match(observation.elements, /Count: 1/); checks.push('selector click actual page state')
    const driver = new BrowserDeviceDriver(session)
    await driver.lease(10)
    const targets = await driver.targets(); assert.ok(targets.some(target => target.id === tab.id))
    const decision = await driver.observe(tab.id)
    const preview = await driver.preview(tab.id); assert.equal(preview.elements, '')
    await driver.act(10, tab.id, { kind: 'click', x: 350 * decision.width / decision.geometry.width, y: 75 * decision.height / decision.geometry.height })
    observation = await driver.observe(tab.id); assert.match(observation.elements, /Count: 2/); checks.push('screenshot-pixel coordinate mapping and AX-free preview')
    await driver.act(10, tab.id, { kind: 'scroll', x: 100, y: 100, deltaY: 200 })
    const scrollDeadline = Date.now() + 2000
    while (!events.some(event => event.scrollY > 0) && Date.now() < scrollDeadline) await new Promise(resolve => setTimeout(resolve, 25))
    assert.ok(events.some(event => event.scrollY > 0), 'website independently reported actual scroll')
    await driver.release(10)
    await assert.rejects(driver.act(10, tab.id, { kind: 'key', key: 'Enter' }), { code: 'CONTROL_CHANGED' }); checks.push('same Agent driver input and lease fencing')
    session.setAllowedOrigins([])
    await assert.rejects(session.observe(tab.id), { code: 'SITE_NOT_ALLOWED' })
    await assert.rejects(session.act(tab.id, { kind: 'type', text: 'blocked' }), { code: 'SITE_NOT_ALLOWED' })
    await assert.rejects(session.open('https://example.com/'), { code: 'SITE_NOT_ALLOWED' }); checks.push('website revoke and denied navigation')
    session.setAllowedOrigins([origin])
    const [port] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n')
    connected = new BrowserSession({ allowedOrigins: [origin], cdpEndpoint: `http://127.0.0.1:${port}` })
    await connected.connect(); const attached = await connected.observe(tab.id); assert.match(attached.elements, /Signed in fixture/)
    await connected.close(); connected = undefined
    assert.ok((await session.list()).some(value => value.id === tab.id)); checks.push('explicit existing CDP preserves profile and does not close owner browser')
    await writeFile(join(output, 'after.jpg'), Buffer.from(attached.imageBase64, 'base64'))
    await session.close(); session = undefined
    restored = new BrowserSession(options); await restored.launch()
    const restoredTab = await restored.open(`${origin}/fixture`), saved = await restored.observe(restoredTab.id)
    assert.match(saved.elements, /Signed in fixture/); checks.push('persistent isolated profile login reuse')
    // Exercise the actual registered Agent callbacks through the real session
    // service and actual browser. Provider/model reasoning is a separate gate.
    const workflow = new ComputerSessionService(new BrowserDeviceDriver(restored)), tools = new Map()
    const disposeTools = installComputerTools({ tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } }, attachments: { async saveImage(input) { return { attachmentId: 'browser-smoke-frame', mediaType: input.mediaType, bytes: input.data.length, width: saved.width, height: saved.height } } } }, workflow)
    try {
      await workflow.start('browser-smoke-chat', restoredTab.id, { allowOnce: true })
      let callId = 0
      const exec = () => ({ callId: `browser-smoke-${++callId}`, agent: { id: 'browser-smoke-chat' }, signal: new AbortController().signal })
      const observe = () => tools.get('qiuya_computer_observe').execute({}, exec())
      const act = async action => { const frame = await observe(); return tools.get('qiuya_computer_act').execute({ frameId: frame.frameId, action }, exec()) }
      await act({ kind: 'navigate', url: `${origin}/next` })
      await act({ kind: 'selectorType', selector: '#name', text: 'Agent 工具🙂' })
      let frame = await observe(); assert.match(frame.elements, /Agent 工具🙂/)
      await act({ kind: 'selectorClick', selector: '#count' })
      frame = await observe(); assert.match(frame.elements, /Count: 1/)
      const sourceId = workflow.get('browser-smoke-chat').target.id
      await act({ kind: 'openTab', url: `${origin}/new-tab` })
      assert.notEqual(workflow.get('browser-smoke-chat').target.id, sourceId)
      await act({ kind: 'closeTab' })
      assert.equal(workflow.get('browser-smoke-chat').state, 'stopped')
      checks.push('registered Agent navigate/selector/newtab/closetab through frame and lease-fenced service')
    } finally { disposeTools(); await workflow.dispose(); restored = undefined }
    const report = { status: 'passed', browser, platform: process.platform, architecture: process.arch, actualBrowser: true, checks, screenshotWidth: saved.width, screenshotHeight: saved.height }
    await writeFile(join(output, 'summary.json'), JSON.stringify(report, null, 2)); return report
  } catch (error) {
    await writeFile(join(output, 'summary.json'), JSON.stringify({ status: 'failed', browser, platform: process.platform, checks, error: error instanceof Error ? error.message : String(error) }, null, 2)); throw error
  } finally {
    await connected?.close().catch(() => {}); await session?.close().catch(() => {}); await restored?.close().catch(() => {})
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(profile, { recursive: true, force: true })
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--browser'), browser = index >= 0 ? process.argv[index + 1] : 'chrome'
  if (!['chrome', 'edge'].includes(browser)) throw new Error('--browser must be chrome or edge')
  const executableIndex = process.argv.indexOf('--executable'), artifactsIndex = process.argv.indexOf('--artifacts'), moduleIndex = process.argv.indexOf('--module')
  runBrowserSmoke({ browser, executable: executableIndex >= 0 ? process.argv[executableIndex + 1] : undefined, artifacts: artifactsIndex >= 0 ? process.argv[artifactsIndex + 1] : undefined, modulePath: moduleIndex >= 0 ? process.argv[moduleIndex + 1] : undefined }).then(report => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)).catch(error => { process.stderr.write(`${error instanceof Error ? error.stack : error}\n`); process.exitCode = 1 })
}
