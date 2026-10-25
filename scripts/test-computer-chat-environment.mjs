/** Installed Harness composer-environment acceptance in a disposable profile.
 * Real public owner APIs and installed UI only; no model or desktop input.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { waitForHarnessHostUrl } from './harness-host-readiness.mjs'

const argument = (name, fallback) => {
  const at = process.argv.indexOf(name)
  if (at < 0) return fallback
  const value = process.argv[at + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}
if (process.argv.includes('--help')) {
  console.log('node scripts/test-computer-chat-environment.mjs --package candidate.tgz --output <outside-project-directory> [--cli-json \'["/path/to/dsh"]\'] [--browser chrome|msedge] [--runtime-root <dependency-root>]')
  process.exit(0)
}
const root = fileURLToPath(new URL('../', import.meta.url)), packageArgument = argument('--package')
assert.ok(packageArgument, 'Pass --package <candidate.tgz>')
const candidate = resolve(packageArgument), output = resolve(argument('--output', join(tmpdir(), `qiuya-chat-environment-report-${randomUUID()}`)))
const outputRelative = relative(root, output)
assert.ok(outputRelative && (outputRelative === '..' || outputRelative.startsWith(`..${sep}`) || isAbsolute(outputRelative)), 'Screenshots and reports must be outside the project')
const cli = JSON.parse(argument('--cli-json', JSON.stringify(['/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'])))
assert.ok(Array.isArray(cli) && cli.length && cli.every(value => typeof value === 'string' && value.length), '--cli-json must be a nonempty array of strings')
const channel = argument('--browser', process.platform === 'win32' ? 'msedge' : 'chrome')
assert.ok(['chrome', 'msedge'].includes(channel), '--browser must be chrome or msedge')
const runtimeRequire = createRequire(join(resolve(argument('--runtime-root', root)), 'package.json')), { chromium } = runtimeRequire('playwright')
const sha256 = value => createHash('sha256').update(value).digest('hex'), candidateSha256 = sha256(await readFile(candidate))
await mkdir(output, { recursive: true })
const temporary = await mkdtemp(join(tmpdir(), 'qiuya-chat-environment-')), home = join(temporary, 'home'), profile = join(home, 'profiles', 'web')
const env = { ...process.env, DSH_HOME: home }, checks = [], screenshots = [], requests = [], pageErrors = [], rpcErrors = [], connectReplies = [], sessions = [], sessionWorkspaces = new Map()
const sleep = milliseconds => new Promise(done => setTimeout(done, milliseconds))
const redact = value => String(value).replace(/([?&]token=)[^&\s]+/gu, '$1<redacted>').replace(/(Bearer\s+)[^\s]+/giu, '$1<redacted>')
let host, browser, page, failure, ownedBrowser, ownedBrowserControl, ownedBrowserEndpoint, fixtureServer, ownedBrowserLaunched = false, fixtureHits = 0
let surface = 'bootstrap', cleanup = { browserClosed: false, hostStopped: false, ownedBrowserStopped: false, fixtureServerStopped: false, temporaryRemoved: false }
async function command(args) {
  return new Promise((done, reject) => {
    const child = spawn(cli[0], [...cli.slice(1), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''; child.stdout.on('data', chunk => { log += chunk }); child.stderr.on('data', chunk => { log += chunk })
    const timer = setTimeout(() => { child.kill(); reject(new Error('Isolated official Harness command timed out')) }, 120000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); code === 0 ? done() : reject(new Error(redact(log).slice(-5000))) })
  })
}
async function waitFor(read, message, budget = 15000) {
  const until = Date.now() + budget
  while (Date.now() < until) { const value = await read(); if (value) return value; await sleep(100) }
  throw new Error(message)
}
async function check(name, run) {
  const start = Date.now()
  try { const details = await run(); checks.push({ name, status: 'passed', elapsedMs: Date.now() - start, ...details }); console.log(`PASS ${name}`) }
  catch (error) { checks.push({ name, status: 'failed', elapsedMs: Date.now() - start, reason: redact(error.message) }); throw error }
}
const dialog = () => page.getByRole('dialog', { name: '操作环境', exact: true })
const trigger = () => page.getByRole('button', { name: /^操作环境：/u }).filter({ visible: true }).first()
const editor = () => page.locator('[data-composer-input][contenteditable="true"]:visible').first()
async function openEnvironment() { await trigger().click(); await dialog().waitFor({ state: 'visible' }); await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))) }
async function choose(value) { await dialog().locator(`input[type="radio"][value="${value}"]`).check() }
async function screenshot(name) {
  assert.equal(surface, 'chat', 'Only isolated test conversations may be captured')
  const path = join(output, `${name}.png`)
  await page.screenshot({ path, animations: 'disabled' })
  screenshots.push({ name, path, scope: 'isolated-Harness-page-and-test-owned-conversations-only' })
}
async function ownerRpc(method, request) {
  // The same documented owner RPC envelope used by the public Harness UI.
  // Never reach into the renderer's private context or substitute its app UI.
  return page.evaluate(async ({ method, request }) => {
    const rpcId = crypto.randomUUID(), response = await fetch('/api/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000), body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: { request } } }) })
    if (!response.ok) throw new Error('Isolated owner API HTTP ' + response.status)
    const result = await response.json()
    if (result.type !== 'server-response' || result.rpcId !== rpcId || result.result?.ok !== true) throw new Error('Isolated owner API failed: ' + (result.result?.error?.code ?? 'invalid-response'))
    return result.result.value
  }, { method, request })
}
async function computerRpc(op, sessionId) {
  return page.evaluate(async ({ op, sessionId }) => {
    const rpcId = crypto.randomUUID(), method = 'qiuya-tools.computer.control'
    const response = await fetch('/api/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000), body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { op, sessionId } }) })
    if (!response.ok) throw new Error('Isolated computer read HTTP ' + response.status)
    const envelope = await response.json()
    if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId || envelope.result?.ok !== true) throw new Error('Isolated computer read failed: ' + (envelope.result?.error?.code ?? 'invalid-response'))
    return envelope.result.value
  }, { op, sessionId })
}
async function startOwnedHeadlessBrowser() {
  const browserName = channel === 'msedge' ? 'edge' : 'chrome'
  const suffix = browserName === 'edge' ? ['Microsoft', 'Edge', 'Application', 'msedge.exe'] : ['Google', 'Chrome', 'Application', 'chrome.exe']
  const candidates = process.platform === 'darwin'
    ? [browserName === 'edge' ? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : process.platform === 'win32' ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean).map(directory => join(directory, ...suffix))
      : browserName === 'edge' ? ['/usr/bin/microsoft-edge'] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  let executable
  for (const path of candidates) { try { await access(path); executable = path; break } catch {} }
  assert.ok(executable, 'The selected official Chrome/Edge executable must exist')
  const directory = join(temporary, 'owned-headless-browser'); await mkdir(directory)
  let launchError
  ownedBrowser = spawn(executable, ['--headless=new', '--disable-gpu', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${directory}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  ownedBrowserLaunched = typeof ownedBrowser.pid === 'number'
  ownedBrowser.once('error', error => { launchError = error }); ownedBrowser.stderr?.resume()
  const port = await waitFor(async () => {
    if (launchError || ownedBrowser.exitCode !== null || ownedBrowser.signalCode !== null) throw new Error('The owned headless browser exited before CDP was ready')
    try { const [value] = (await readFile(join(directory, 'DevToolsActivePort'), 'utf8')).trim().split('\n'); return /^\d+$/u.test(value) && Number(value) > 0 && Number(value) <= 65535 ? value : false }
    catch (error) { if (['ENOENT', 'EBUSY'].includes(error.code)) return false; throw error }
  }, 'The test-owned headless browser did not publish its CDP port')
  ownedBrowserEndpoint = `http://127.0.0.1:${port}`
  ownedBrowserControl = await chromium.connectOverCDP(ownedBrowserEndpoint, { timeout: 15000 })
  const context = ownedBrowserControl.contexts()[0]
  assert.ok(context, 'The test-owned CDP browser must expose its isolated default context')
  await context.route('**/*', route => { const target = new URL(route.request().url()); return ['http:', 'https:'].includes(target.protocol) && target.hostname !== '127.0.0.1' ? route.abort() : route.continue() })
  return { browserName, endpoint: ownedBrowserEndpoint }
}
async function stopOwnedHeadlessBrowser() {
  const child = ownedBrowser
  if (!child) return
  if (child.exitCode === null && child.signalCode === null) {
    try { const cdp = await ownedBrowserControl?.newBrowserCDPSession(); await cdp?.send('Browser.close') } catch { /* Natural close often ends CDP before its reply. */ }
    const deadline = Date.now() + 5000
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await sleep(100)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill()
      const retirement = Date.now() + 5000
      while (child.exitCode === null && child.signalCode === null && Date.now() < retirement) await sleep(100)
    }
  }
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'The exact owned headless browser process must exit before its profile can be removed')
  if (ownedBrowserEndpoint) await waitFor(async () => {
    try { const response = await fetch(ownedBrowserEndpoint + '/json/version', { signal: AbortSignal.timeout(500) }); await response.body?.cancel(); return false } catch { return true }
  }, 'The owned browser CDP endpoint remained live after its child exited', 5000)
  await ownedBrowserControl?.close().catch(() => {}); ownedBrowserControl = undefined; ownedBrowser = undefined
}
async function selectSession(sessionId) {
  const row = page.locator(`[data-row-key="session:${sessionId}"]`)
  if (await row.isVisible()) await row.click()
  else {
    // The official tree deliberately hides unselected blank sessions. Select
    // their owned Workspace through its public menu; that flow restores the
    // same reusable blank and retains it as the actual main Conversation.
    const workspace = sessionWorkspaces.get(sessionId)
    assert.ok(workspace, 'Session selection may only restore a known test-owned Workspace')
    await page.getByRole('button', { name: '选择工作区', exact: true }).click()
    await page.getByRole('menuitem', { name: workspace.title, exact: true }).click()
  }
  await waitFor(async () => await page.locator(`[data-conversation-content][data-conversation-session="${sessionId}"]:visible`).count() === 1 && await page.locator(`[data-qyt-computer-environment="${sessionId}"]:visible`).count() === 1, 'The actual requested isolated Session did not become current')
  await trigger().waitFor({ state: 'visible' })
}
async function layout() {
  return dialog().evaluate(node => {
    const box = node.getBoundingClientRect(), controls = [...node.querySelectorAll('input,textarea,select,button')]
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height, viewportWidth: innerWidth, viewportHeight: innerHeight, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, maxHeight: getComputedStyle(node).maxHeight, overflowY: getComputedStyle(node).overflowY, overflowingControls: controls.filter(control => { const rect = control.getBoundingClientRect(); return rect.width > 0 && (rect.left < box.left - 1 || rect.right > box.right + 1) }).length }
  })
}
async function stopOwnedHost() {
  const child = host; host = undefined
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise(done => child.once('exit', done))
  child.stdin.end(); child.kill()
  const stopped = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)])
  if (!stopped) { child.kill('SIGKILL'); await Promise.race([exited, sleep(5000)]) }
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'The owned isolated Host must stop before deleting its temporary profile')
}

try {
  await check('official-manager-installs-candidate-in-disposable-profile', async () => {
    await command(['--profile', 'web', '--dump-config']); await command(['plugin', '--profile', 'web', 'add', candidate])
    await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([{ id: 'qiuya-tools', config: { enabled: true, computerUseEnabled: true } }], null, 2) + '\n')
    const metadata = JSON.parse(await readFile(join(profile, 'node_modules', 'dsh-qiuya-tools', 'package.json'), 'utf8'))
    assert.equal(sha256(await readFile(candidate)), candidateSha256)
    return { version: metadata.version, isolatedSettingsOnly: true, modelConfigured: false }
  })
  let hostLog = ''
  host = spawn(cli[0], [...cli.slice(1), '--profile', 'web', '--no-open', '--port', '0'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const append = chunk => { hostLog += chunk }; host.stdout.on('data', append); host.stderr.on('data', append)
  let hostError; host.once('error', error => { hostError = error })
  const url = await waitForHarnessHostUrl(() => ({ exited: Boolean(hostError) || host.exitCode !== null || host.signalCode !== null, error: redact(hostError?.message ?? hostLog).slice(-5000), url: hostLog.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/u)?.[0] }))
  await check('owner-cookie-bootstrap-and-real-onboarding-dismissal', async () => {
    const bootstrap = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
    assert.equal(bootstrap.status, 303); assert.ok(bootstrap.headers.getSetCookie().length)
    browser = await chromium.launch({ channel, headless: true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' })
    await context.route('**/*', route => { const target = new URL(route.request().url()); return ['http:', 'https:'].includes(target.protocol) && !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ? route.abort() : route.continue() })
    page = await context.newPage(); page.setDefaultTimeout(15000)
    page.on('pageerror', error => pageErrors.push(redact(error.message)))
    page.on('request', request => {
      if (!new URL(request.url()).pathname.endsWith('/qiuya-tools.computer.control')) return
      let payload; try { payload = request.postDataJSON()?.payload } catch { return }
      if (typeof payload?.op === 'string') requests.push({ op: payload.op, surface, ...(typeof payload.sessionId === 'string' ? { sessionId: payload.sessionId } : {}), ...(typeof payload.mode === 'string' ? { mode: payload.mode } : {}) })
    })
    page.on('response', async response => {
      if (!new URL(response.url()).pathname.endsWith('/qiuya-tools.computer.control')) return
      try {
        const result = (await response.json()).result, payload = response.request().postDataJSON()?.payload
        if (result?.ok === false) rpcErrors.push({ code: result.error?.code, message: redact(result.error?.message ?? 'RPC failed') })
        if (payload?.op === 'connect') connectReplies.push({ sessionId: payload.sessionId, mode: payload.mode, ok: result?.ok, available: result?.value?.available })
      } catch {}
    })
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    const onboarding = page.getByRole('button', { name: '继续', exact: true }).first()
    await onboarding.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {}); if (await onboarding.isVisible()) await onboarding.click()
    const credentials = page.getByRole('dialog', { name: '添加一个 API Key 开始使用', exact: true }), account = page.getByRole('dialog', { name: '开始使用', exact: true })
    await credentials.or(account).waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
    if (await account.isVisible()) { await account.getByRole('button', { name: '关闭', exact: true }).click(); await account.waitFor({ state: 'hidden' }) }
    else if (await credentials.isVisible()) { await credentials.getByRole('button', { name: '稍后配置', exact: true }).click(); await credentials.waitFor({ state: 'hidden' }) }
    await page.getByRole('button', { name: '账号菜单', exact: true }).waitFor()
    return { browserChannel: channel, browserVersion: browser.version(), realInstalledHost: true, ownerCookieIssued: true }
  })
  await check('settings-has-global-controls-and-no-advanced-per-chat-environment', async () => {
    surface = 'settings'; await page.getByRole('button', { name: '账号菜单', exact: true }).click(); await page.getByRole('menuitem', { name: 'QiuYaTools', exact: true }).click()
    await page.getByRole('heading', { name: 'QiuYa 增强工具箱', exact: true }).waitFor(); await page.getByRole('tab', { name: '电脑操控', exact: true }).click()
    assert.equal(await page.getByRole('switch', { name: '启用电脑操控', exact: true }).isChecked(), true)
    assert.equal(await page.locator('.qyt-computer-panel').getByText('高级操作环境', { exact: true }).count(), 0)
    assert.equal(await page.locator('.qyt-computer-panel input[type="password"],.qyt-computer-panel select').count(), 0)
    await page.getByRole('button', { name: '关闭', exact: true }).click(); surface = 'chat'
    return { globalSettingsKept: true, advancedEnvironmentRemoved: true }
  })
  await check('two-real-owner-sessions-without-model-or-fake-conversation-ui', async () => {
    for (const suffix of ['A', 'B']) {
      const workspacePath = join(temporary, `电脑环境验收 ${suffix}`); await mkdir(workspacePath)
      const path = await realpath(workspacePath), registered = await ownerRpc('workspace/create', { path }), workspace = registered?.workspace
      assert.equal(workspace?.path, path); assert.equal(typeof workspace.workspaceId, 'string'); assert.ok(workspace.workspaceId)
      await waitFor(() => page.locator(`[data-row-key="workspace:${workspace.workspaceId}"]:visible`).count().then(count => count === 1), 'The real isolated workspace did not appear in the public sidebar')
      await page.getByRole('button', { name: '选择工作区', exact: true }).click(); await page.getByRole('menuitem', { name: workspace.title, exact: true }).click()
      let candidate, stableAt = Date.now()
      const sessionId = await waitFor(async () => {
        const chip = page.getByRole('button', { name: '选择工作区', exact: true })
        if ((await chip.innerText()).trim() !== workspace.title) return false
        const conversations = page.locator('[data-conversation-content][data-conversation-session]:visible')
        if (await conversations.count() !== 1) return false
        const id = await conversations.getAttribute('data-conversation-session')
        const ready = id && !sessions.includes(id) && await conversations.locator('[data-composer-input][contenteditable="true"]:visible').count() === 1 && await page.locator(`[data-qyt-computer-environment="${id}"]:visible`).count() === 1
        if (!ready || candidate !== id) { candidate = ready ? id : undefined; stableAt = Date.now() }
        return candidate && Date.now() - stableAt >= 750 ? candidate : false
      }, 'The actual public Workspace selection did not settle its own editable blank Session')
      assert.equal(typeof sessionId, 'string'); sessions.push(sessionId); sessionWorkspaces.set(sessionId, workspace)
    }
    assert.notEqual(sessions[0], sessions[1]); await selectSession(sessions[0])
    return { sessions: sessions.length, publicWorkspaceMenuCreatesAndRestoresSessions: true, testOwnedWorkspaces: sessionWorkspaces.size, modelConfigured: false, promptsSent: 0 }
  })
  await check('environment-trigger-is-in-the-current-chat-composer-and-defaults-to-local', async () => {
    const owner = await trigger().evaluate(node => { const conversation = node.closest('[data-conversation-content]'), input = conversation?.querySelector('[data-composer-input]'); const button = node.getBoundingClientRect(), editor = input?.getBoundingClientRect(); return { sessionId: conversation?.getAttribute('data-conversation-session'), hasEditableComposer: input?.getAttribute('contenteditable') === 'true', button: { left: button.left, top: button.top, bottom: button.bottom }, editor: editor && { left: editor.left, top: editor.top, bottom: editor.bottom } } })
    assert.equal(owner.sessionId, sessions[0]); assert.equal(owner.hasEditableComposer, true); assert.ok(owner.editor)
    assert.ok(owner.button.top >= owner.editor.top - 2 && owner.button.top - owner.editor.bottom < 130, 'Environment trigger belongs beside the real editor toolbar')
    await openEnvironment(); assert.equal(await dialog().locator('input[type="radio"][value="local"]').isChecked(), true)
    assert.equal(await dialog().getByRole('button', { name: '使用此环境', exact: true }).isEnabled(), true)
    assert.equal(requests.filter(row => ['connect', 'exchange', 'start'].includes(row.op)).length, 0)
    await screenshot('chat-environment-local-light')
    return { placement: owner, defaultMode: 'local', automaticConnections: 0 }
  })
  await check('browser-and-remote-forms-use-explicit-owner-choice-without-connecting', async () => {
    await choose('browser'); await dialog().getByLabel('允许的网站来源（每行一个）', { exact: true }).fill('https://example.com')
    await dialog().getByLabel('起始页面', { exact: true }).fill('https://example.com/')
    await dialog().locator('summary').filter({ hasText: '连接现有浏览器' }).click(); await dialog().getByLabel('本机调试地址（可选）', { exact: true }).fill('http://127.0.0.1:9222')
    assert.equal(await dialog().getByRole('button', { name: '使用此环境', exact: true }).isEnabled(), true)
    await screenshot('chat-environment-browser-light')
    await choose('remote'); await dialog().getByLabel('配对地址', { exact: true }).fill('https://computer.example/v1/computer')
    assert.equal(await dialog().getByRole('button', { name: '使用此环境', exact: true }).isDisabled(), true)
    await dialog().getByLabel('配对密钥', { exact: true }).fill('isolated-unsubmitted-pairing-draft-only')
    assert.equal(await dialog().getByRole('button', { name: '使用此环境', exact: true }).isEnabled(), true)
    assert.equal(await dialog().getByRole('button', { name: '检查并刷新交换目录', exact: true }).count(), 0)
    assert.equal(requests.filter(row => ['connect', 'exchange', 'start'].includes(row.op)).length, 0)
    await screenshot('chat-environment-remote-light')
    return { browserFields: true, remoteFields: true, unconnectedRemoteHasNoExchange: true, draftsNeverConnect: true }
  })
  await check('escape-restores-trigger-focus-and-reopening-reflects-the-current-environment', async () => {
    await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'hidden' })
    assert.equal(await trigger().evaluate(node => document.activeElement === node), true)
    await openEnvironment(); assert.equal(await dialog().locator('input[type="radio"][value="local"]').isChecked(), true)
    assert.equal(await dialog().locator('input[type="password"]').count(), 0)
    return { escapeDismisses: true, triggerFocusRestored: true, unsubmittedDraftDiscardedOnClose: true, actualModeReadOnReopen: 'local' }
  })
  await check('remote-drafts-do-not-cross-real-chat-selection-and-status-is-scoped', async () => {
    await choose('remote'); await dialog().getByLabel('配对地址', { exact: true }).fill('https://computer.example/v1/computer'); await dialog().getByLabel('配对密钥', { exact: true }).fill('isolated-never-transmitted-chat-a-draft')
    await dialog().getByRole('button', { name: '关闭操作环境', exact: true }).click(); await selectSession(sessions[1]); await openEnvironment()
    assert.equal(await dialog().locator('input[type="radio"][value="local"]').isChecked(), true); await choose('remote')
    assert.equal(await dialog().getByLabel('配对地址', { exact: true }).inputValue(), ''); assert.equal(await dialog().getByLabel('配对密钥', { exact: true }).inputValue(), '')
    await page.keyboard.press('Escape'); await selectSession(sessions[0]); await openEnvironment()
    assert.equal(await dialog().locator('input[type="radio"][value="local"]').isChecked(), true)
    await waitFor(() => sessions.every(id => requests.some(row => row.op === 'status' && row.sessionId === id)), 'Both actual chat composer controls must issue scoped status requests')
    return { separateRealSessions: 2, remoteDraftLeaks: 0, perChatStatusObserved: true }
  })
  await check('light-dark-and-narrow-popovers-fit-and-scroll-internally', async () => {
    await choose('browser'); await dialog().locator('summary').filter({ hasText: '连接现有浏览器' }).click()
    const colors = []
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme }); await waitFor(() => page.evaluate(scheme => matchMedia(`(prefers-color-scheme: ${scheme})`).matches, colorScheme), 'Requested system color scheme was not applied')
      await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
      colors.push({ colorScheme, ...await dialog().evaluate(node => ({ background: getComputedStyle(node).backgroundColor, color: getComputedStyle(node).color })) })
      await screenshot(`chat-environment-browser-${colorScheme}-expanded`)
    }
    assert.notEqual(colors[0].background, colors[1].background)
    await page.setViewportSize({ width: 560, height: 620 }); await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
    const dimensions = await layout()
    assert.ok(dimensions.left >= -1 && dimensions.right <= dimensions.viewportWidth + 1 && dimensions.top >= -1 && dimensions.bottom <= dimensions.viewportHeight + 1, 'The actual popover must stay within the narrow viewport')
    assert.ok(dimensions.scrollWidth <= dimensions.clientWidth + 1); assert.equal(dimensions.overflowingControls, 0)
    assert.ok(['auto', 'scroll'].includes(dimensions.overflowY)); assert.ok(dimensions.scrollHeight > dimensions.clientHeight, 'Expanded browser fields must scroll inside a capped popover')
    assert.ok(await dialog().evaluate(node => { node.scrollTop = node.scrollHeight; return node.scrollTop > 0 }))
    await screenshot('chat-environment-browser-dark-narrow-560'); await page.setViewportSize({ width: 1440, height: 1000 })
    return { colors, narrowViewport: { width: 560, height: 620 }, dimensions, internalScrollingVerified: true }
  })
  await check('outside-pointer-dismisses-the-menu-without-affecting-the-composer', async () => {
    // A tall anchored form can legitimately cover the center of the editor.
    // Use a viewport corner outside the 12px-clamped popover, not a forced
    // click through its textarea, so the actual outside-pointer hook runs.
    const outside = await page.evaluate(() => ({ x: innerWidth - 4, y: 4 }))
    assert.equal(await dialog().evaluate((node, point) => node.contains(document.elementFromPoint(point.x, point.y)), outside), false)
    await page.mouse.click(outside.x, outside.y); await dialog().waitFor({ state: 'hidden' }); assert.equal(await trigger().getAttribute('aria-expanded'), 'false')
    assert.equal((await editor().innerText()).trim(), ''); await screenshot('chat-environment-composer-dark')
    return { outsidePointerDismisses: true, editorDraftUnchanged: true }
  })
  await check('scoped-read-only-rpc-no-model-or-desktop-input-and-unchanged-candidate', async () => {
    const chat = requests.filter(row => row.surface === 'chat')
    assert.ok(chat.length > 0); assert.ok(chat.every(row => row.op === 'status' && typeof row.sessionId === 'string' && row.sessionId.length > 0), 'Composer requests must remain scoped read-only status calls')
    assert.equal(requests.filter(row => ['connect', 'exchange', 'start', 'act', 'allow'].includes(row.op)).length, 0)
    assert.deepEqual(rpcErrors, []); assert.deepEqual(pageErrors, []); assert.equal(sha256(await readFile(candidate)), candidateSha256)
    return { composerStatusRequests: chat.length, allScoped: true, automaticConnections: 0, modelConfigured: false, promptsSent: 0, nativeInputSent: false, candidateUnchanged: true }
  })
  await check('explicit-browser-connection-readback-and-real-two-chat-isolation', async () => {
    assert.equal(requests.filter(row => row.op === 'connect').length, 0, 'All preparatory menu acceptance must remain read-only')
    const fixtureTitle = 'QiuYaTools 独立浏览器连接验收', fixturePath = `/fixture-${randomUUID()}`
    fixtureServer = createServer((request, response) => {
      if (request.url !== fixturePath) { response.writeHead(404); response.end(); return }
      fixtureHits++; response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" })
      response.end(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>${fixtureTitle}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#e8f2f2;color:#174753;font:16px system-ui}main{max-width:600px;padding:40px;border:1px solid #bdd4d7;border-radius:18px;background:#fff;box-shadow:0 12px 35px #17475316}h1{font-size:25px}p{line-height:1.8}</style><main><h1>${fixtureTitle}</h1><p>当前聊天已通过已安装的插件连接独立浏览器，并打开这个本机测试页面。</p><p>页面仅用于隔离验收，没有账号、个人数据或外部资源。</p></main></html>`)
    })
    await new Promise((done, reject) => { fixtureServer.once('error', reject); fixtureServer.listen(0, '127.0.0.1', done) })
    const address = fixtureServer.address(); assert.ok(address && typeof address === 'object')
    const fixtureOrigin = `http://127.0.0.1:${address.port}`, fixtureUrl = fixtureOrigin + fixturePath
    const helper = await startOwnedHeadlessBrowser()
    await selectSession(sessions[0]); await openEnvironment(); await choose('browser')
    await dialog().locator('.qyt-computer-fields select').selectOption(helper.browserName)
    await dialog().getByLabel('允许的网站来源（每行一个）', { exact: true }).fill(fixtureOrigin)
    await dialog().getByLabel('起始页面', { exact: true }).fill(fixtureUrl)
    await dialog().locator('summary').filter({ hasText: '连接现有浏览器' }).click()
    await dialog().getByLabel('本机调试地址（可选）', { exact: true }).fill(helper.endpoint)
    await dialog().getByRole('button', { name: '使用此环境', exact: true }).click()
    await dialog().waitFor({ state: 'hidden' })
    await waitFor(async () => await trigger().getAttribute('aria-label') === '操作环境：独立浏览器', 'The installed composer did not read back the successful browser environment')
    const reply = await waitFor(() => connectReplies.find(row => row.sessionId === sessions[0]), 'The explicit real connection had no correlated RPC response')
    assert.deepEqual(reply, { sessionId: sessions[0], mode: 'browser', ok: true, available: true })
    const targets = await computerRpc('targets', sessions[0])
    assert.ok(Array.isArray(targets) && targets.some(target => target.title === fixtureTitle), 'The actual installed driver must enumerate its newly opened test page')
    assert.ok(fixtureHits > 0, 'The owned HTTP fixture must independently receive the browser navigation')
    await openEnvironment(); assert.equal(await dialog().locator('input[type="radio"][value="browser"]').isChecked(), true)
    assert.ok((await dialog().innerText()).includes('当前环境：独立浏览器')); await screenshot('chat-environment-browser-connected-dark')
    await page.keyboard.press('Escape'); await selectSession(sessions[1])
    await waitFor(async () => await trigger().getAttribute('aria-label') === '操作环境：这台电脑', 'The other real chat inherited the browser environment')
    await openEnvironment(); assert.equal(await dialog().locator('input[type="radio"][value="local"]').isChecked(), true)
    const other = await computerRpc('status', sessions[1]), own = await computerRpc('status', sessions[0])
    assert.equal(other.environments?.find(row => row.sessionId === sessions[1])?.mode ?? 'local', 'local')
    assert.equal(own.environments?.find(row => row.sessionId === sessions[0])?.mode, 'browser')
    await screenshot('chat-environment-other-chat-stays-local-dark'); await page.keyboard.press('Escape')
    await selectSession(sessions[0]); await waitFor(async () => await trigger().getAttribute('aria-label') === '操作环境：独立浏览器', 'Returning to the original chat lost its live browser connection')
    const fixturePage = await waitFor(() => ownedBrowserControl.contexts().flatMap(context => context.pages()).find(target => target.url() === fixtureUrl), 'The separate owned CDP browser did not expose the actual fixture tab')
    await fixturePage.waitForFunction(title => document.title === title, fixtureTitle)
    const path = join(output, 'owned-headless-browser-fixture.png'); await fixturePage.screenshot({ path, animations: 'disabled' }); screenshots.push({ name: 'owned-headless-browser-fixture', path, scope: 'owned-headless-browser-local-fixture-only' })
    const mutations = requests.filter(row => !['status', 'applications', 'targets'].includes(row.op))
    assert.deepEqual(mutations, [{ op: 'connect', surface: 'chat', sessionId: sessions[0], mode: 'browser' }], 'Only one explicit current-chat browser connection is permitted')
    assert.ok(requests.filter(row => row.surface === 'chat').every(row => typeof row.sessionId === 'string' && row.sessionId.length > 0), 'Every chat status, connection and target read must be scoped')
    assert.deepEqual(pageErrors, []); assert.deepEqual(rpcErrors, []); assert.equal(sha256(await readFile(candidate)), candidateSha256)
    return { explicitBrowserConnections: 1, connectedSession: sessions[0], otherSession: sessions[1], currentChatReadback: 'browser', otherChatReadback: 'local', actualFixtureTargetEnumerated: true, fixtureHttpRequests: fixtureHits, ownedHeadlessBrowserLaunched: true, browserName: helper.browserName, nativeInputSent: false, modelConfigured: false, promptsSent: 0, allChatRpcsScoped: true, candidateUnchanged: true }
  })
} catch (error) {
  failure = redact(error.message); process.exitCode = 1; console.error(failure)
  console.error(JSON.stringify({ pageErrors, rpcErrors, environmentDiagnostic: await page?.locator('[data-qyt-computer-environment]').evaluateAll(nodes => nodes.map(node => ({ sessionId: node.getAttribute('data-qyt-computer-environment'), visible: Boolean(node.getClientRects().length), buttons: [...node.querySelectorAll('button')].map(button => ({ label: button.getAttribute('aria-label'), disabled: button.disabled })) }))).catch(() => null) }))
} finally {
  try { await browser?.close(); cleanup.browserClosed = true } catch (error) { failure ??= redact(error.message); process.exitCode = 1 }
  try { await stopOwnedHost(); cleanup.hostStopped = true } catch (error) { failure ??= redact(error.message); process.exitCode = 1 }
  try { await stopOwnedHeadlessBrowser(); cleanup.ownedBrowserStopped = true } catch (error) { failure ??= redact(error.message); process.exitCode = 1 }
  try { if (fixtureServer) { fixtureServer.closeAllConnections(); await new Promise((done, reject) => fixtureServer.close(error => error ? reject(error) : done())) }; cleanup.fixtureServerStopped = true } catch (error) { failure ??= redact(error.message); process.exitCode = 1 }
  if (cleanup.browserClosed && cleanup.hostStopped && cleanup.ownedBrowserStopped && cleanup.fixtureServerStopped) try { await rm(temporary, { recursive: true, force: true }); cleanup.temporaryRemoved = true } catch (error) { failure ??= redact(error.message); process.exitCode = 1 }
  await writeFile(join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', kind: 'official-Harness-installed-chat-environment-disposable-profile', testedAt: new Date().toISOString(), platform: process.platform, architecture: process.arch, candidateSha256, browserChannel: channel, checks, screenshots, rpcErrors, rpcSummary: Object.fromEntries([...new Set(requests.map(row => row.op))].map(op => [op, requests.filter(row => row.op === op).length])), scopedComposerSessions: [...new Set(requests.filter(row => row.surface === 'chat').map(row => row.sessionId).filter(Boolean))], isolation: { disposableDSHHome: true, personalProfileTouched: false, systemPermissionsChanged: false, nativeInputSent: false, applicationLaunched: ownedBrowserLaunched, applicationLaunchScope: ownedBrowserLaunched ? 'test-owned-headless-Chrome-or-Edge-private-profile-only' : 'none', modelConfigured: false, promptsSent: 0, externalBrowserNetworkBlocked: true, screenshotScope: 'isolated-owned-profile-page-and-owned-headless-fixture-only', credentialPayloadsRecorded: false }, cleanup, ...(cleanup.temporaryRemoved ? {} : { preservedTemporaryDirectory: temporary }), limitations: ['Focused installed composer UI and one explicit connection to a test-owned headless browser/local HTML fixture; no remote pairing, native desktop input or model-driven application control.'], ...(failure ? { reason: failure } : {}) }, null, 2) + '\n')
}
