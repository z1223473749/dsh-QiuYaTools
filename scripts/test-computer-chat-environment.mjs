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
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { waitForHarnessHostUrl } from './harness-host-readiness.mjs'
import { createCDPMetadataProxy } from './cdp-metadata-proxy.mjs'
import { createOwnedFixtureProxy } from './owned-fixture-network-guard.mjs'
import { inspectOwnedFixtureFrame, ownedFixtureColors } from './owned-fixture-pixels.mjs'
import { createChatEnvironmentRPCDiagnostic, ownedBrowserRenderingPlan, assertNoWorkbenchPreviewTimeouts, createRPCResponseCollector, workbenchRPCMetadata } from './chat-environment-rpc-diagnostic.mjs'

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
const ownedRendering = ownedBrowserRenderingPlan(process.argv.slice(2))
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
const { jpegjs } = runtimeRequire(join(dirname(runtimeRequire.resolve('playwright-core/package.json')), 'lib/utilsBundle.js'))
assert.equal(typeof jpegjs?.decode, 'function', 'The official runtime must provide the pure JPEG decoder')
const sha256 = value => createHash('sha256').update(value).digest('hex'), candidateSha256 = sha256(await readFile(candidate))
await mkdir(output, { recursive: true })
const temporary = await mkdtemp(join(tmpdir(), 'qiuya-chat-environment-')), home = join(temporary, 'home'), profile = join(home, 'profiles', 'web')
const env = { ...process.env, DSH_HOME: home }, checks = [], screenshots = [], requests = [], pageErrors = [], rpcErrors = [], connectReplies = [], sessions = [], sessionWorkspaces = new Map(), workbenchRequests = [], workbenchFrames = [], workbenchErrors = []
const rpcDiagnostic = createChatEnvironmentRPCDiagnostic({ knownSession: id => sessions.includes(id) })
const rpcResponses = createRPCResponseCollector(), forwardedOwnRPCs = new Map(), teardownHeldRPCs = [], rpcTransportFailures = [], uiDeliveryCancellations = [], hostReplyConfirmed = new WeakSet()
const workbenchRpcTimeline = []
let rpcObservationClosing = false, rpcObservationDrained = false
const ownRPCChannel = value => { const url = new URL(value); if (url.search || url.hash) return undefined; return url.pathname === '/api/qiuya-tools.workbench' ? 'workbench' : url.pathname === '/api/qiuya-tools.computer.control' ? 'computer' : undefined }
const sleep = milliseconds => new Promise(done => setTimeout(done, milliseconds))
const redact = value => String(value).replace(/([?&]token=)[^&\s]+/gu, '$1<redacted>').replace(/(Bearer\s+)[^\s]+/giu, '$1<redacted>')
let host, browser, browserServer, page, failure, failureDiagnostic, ownedBrowser, ownedBrowserSocketPath, ownedBrowserEndpoint, ownedBrowserRawEndpoint, ownedFixtureProxy, cdpMetadataProxy, fixtureServer, ownedFixture, multitask, ownedBrowserLaunched = false, fixtureHits = 0
let surface = 'bootstrap', cleanup = { browserClosed: false, hostStopped: false, ownedBrowserStopped: false, fixtureServerStopped: false, ownedFixtureProxyStopped: false, cdpMetadataProxyStopped: false, temporaryRemoved: false }
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
async function bounded(promise, milliseconds, message) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds) })]) }
  finally { clearTimeout(timer) }
}
const exited = child => !child || child.exitCode !== null || child.signalCode !== null
async function stopOwnedProcess(child) {
  if (!child || exited(child)) return
  if (process.platform === 'win32' && child.pid) {
    await bounded(new Promise(done => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.once('error', done); killer.once('exit', done)
    }), 3000, 'Owned process-tree termination timed out').catch(() => {})
  } else {
    try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch {} }
  }
  if (!exited(child)) try { child.kill('SIGKILL') } catch {}
  await waitFor(() => exited(child), 'The exact owned process did not exit after bounded termination', 3000)
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
async function computerRpc(op, sessionId, extra = {}) {
  return page.evaluate(async ({ op, sessionId, extra }) => {
    const rpcId = crypto.randomUUID(), method = 'qiuya-tools.computer.control'
    // The real CDP connection can use its own 30-second startup budget. Do not
    // abort it at 15 seconds on a loaded PD guest; an unknown outcome is never
    // replayed. Other metadata/control calls retain their original budget.
    const budget = op === 'connect' ? 45000 : 15000, started = performance.now()
    let response
    try { response = await fetch('/api/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(budget), body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { ...extra, op, sessionId } }) }) }
    catch { throw new Error(`Isolated computer ${op} response unconfirmed after ${Math.round(performance.now() - started)} ms (budget ${budget} ms; not replayed)`) }
    if (!response.ok) throw new Error(`Isolated computer ${op} HTTP ${response.status}`)
    const envelope = await response.json()
    if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId || envelope.result?.ok !== true) throw new Error(`Isolated computer ${op} failed: ${envelope.result?.error?.code ?? 'invalid-response'}`)
    return envelope.result.value
  }, { op, sessionId, extra })
}
async function workbenchStatus(sessionId) {
  return page.evaluate(async chatSessionId => {
    const rpcId = crypto.randomUUID(), method = 'qiuya-tools.workbench'
    const response = await fetch('/api/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000), body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { op: 'status', chatSessionId } }) })
    const envelope = await response.json()
    if (!response.ok || envelope.type !== 'server-response' || envelope.rpcId !== rpcId || envelope.result?.ok !== true) throw new Error('Isolated workbench status failed: ' + (envelope.result?.error?.code ?? 'invalid-response'))
    return envelope.result.value
  }, sessionId)
}
const taskCard = sessionId => page.locator(`[data-qyt-workbench-chat="${sessionId}"] .qyt-workbench-small:visible`)
async function selectPreviewTask(task) {
  const card = taskCard(sessions[0]), tabs = card.getByRole('tablist', { name: '当前聊天的电脑任务', exact: true })
  await tabs.waitFor({ state: 'visible' })
  const tab = tabs.getByRole('tab').filter({ hasText: task.label })
  // Dots may carry their descriptive label through aria-label/title instead of
  // visible text. Use the actual semantic tab name in that presentation.
  const selected = await tab.count() === 1 ? tab : tabs.getByRole('tab', { name: new RegExp(task.label, 'u') })
  await selected.click()
  await waitFor(async () => await selected.getAttribute('aria-selected') === 'true', 'The actual task tab did not become selected')
  return selected
}
async function previewImage(task) {
  const card = taskCard(sessions[0]), image = card.getByRole('img', { name: '当前授权目标的实时画面', exact: true })
  return waitFor(async () => {
    if (await image.count() !== 1) return false
    const pixels = await image.evaluate(node => {
      if (!node.complete || node.naturalWidth <= 1 || node.naturalHeight <= 1 || !node.currentSrc.startsWith('data:image/jpeg;base64,')) return null
      const analysis = document.createElement('canvas'); analysis.width = 48; analysis.height = 32
      const context = analysis.getContext('2d', { willReadFrequently: true }); if (!context) return null
      context.drawImage(node, 0, 0, 48, 32)
      const data = context.getImageData(0, 0, 48, 32).data, colors = new Set()
      for (let i = 0; i < data.length; i += 4) colors.add(`${data[i]},${data[i + 1]},${data[i + 2]}`)
      return { width: node.naturalWidth, height: node.naturalHeight, sampledColors: colors.size }
    }).catch(() => null)
    if (!pixels || pixels.sampledColors < 8) return false
    const src = await image.getAttribute('src')
    if (!src?.startsWith('data:image/jpeg;base64,')) return false
    const imageBase64 = src.split(',')[1], imageSha256 = sha256(Buffer.from(imageBase64, 'base64'))
    const receipt = workbenchFrames.findLast(row => row.chatSessionId === sessions[0] && row.targetId === task.targetId && row.imageSha256 === imageSha256)
    if (!receipt) return false
    const proof = inspectOwnedFixtureFrame({ targetId: receipt.targetId, frameId: 'displayed-ui', imageBase64, mediaType: 'image/jpeg' }, { targetId: task.targetId, variant: task.variant }, jpegjs.decode)
    return { ...pixels, ...proof, workbenchTabId: receipt.workbenchTabId }
  }, 'The selected task did not display a nonempty JPEG matching its actual workbench frame receipt', 20000)
}
async function startOwnedHeadlessBrowser({ fixtureOrigin, fixturePath }) {
  ownedFixtureProxy = await createOwnedFixtureProxy({ fixtureOrigin, fixturePath })
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
  ownedBrowser = spawn(executable, ['--headless=new', '--disable-gpu', ...ownedRendering.browserArguments, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${directory}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions', `--proxy-server=${ownedFixtureProxy.endpoint}`, '--proxy-bypass-list=<-loopback>', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
  ownedBrowserLaunched = typeof ownedBrowser.pid === 'number'
  ownedBrowser.once('error', error => { launchError = error }); ownedBrowser.stderr?.resume()
  const port = await waitFor(async () => {
    if (launchError || ownedBrowser.exitCode !== null || ownedBrowser.signalCode !== null) throw new Error('The owned headless browser exited before CDP was ready')
    try { const [value, path] = (await readFile(join(directory, 'DevToolsActivePort'), 'utf8')).trim().split('\n'); return /^\d+$/u.test(value) && Number(value) > 0 && Number(value) <= 65535 && /^\/devtools\/browser\/[A-Za-z0-9-]+$/u.test(path) ? { port: value, path } : false }
    catch (error) { if (['ENOENT', 'EBUSY'].includes(error.code)) return false; throw error }
  }, 'The test-owned headless browser did not publish its CDP port')
  ownedBrowserEndpoint = ownedBrowserRawEndpoint = `http://127.0.0.1:${port.port}`; ownedBrowserSocketPath = port.path
  // Only the installed product attaches to these page targets. An independent
  // deny proxy enforces egress without changing target focus or debugger state.
  if (!ownedRendering.rawOwnedCDP) {
    cdpMetadataProxy = await createCDPMetadataProxy(ownedBrowserEndpoint, { preserveCompression: ownedRendering.preserveOwnedCDPCompression })
    ownedBrowserEndpoint = cdpMetadataProxy.endpoint
  }
  return { browserName, endpoint: ownedBrowserEndpoint }
}
async function stopOwnedHeadlessBrowser() {
  const child = ownedBrowser
  if (!child) return
  if (!exited(child)) {
    assert.ok(ownedBrowserRawEndpoint && ownedBrowserSocketPath, 'Owned browser identity is unavailable; never guess a close target')
    const version = await (await fetch(ownedBrowserRawEndpoint + '/json/version', { signal: AbortSignal.timeout(1000) })).json(), url = new URL(version.webSocketDebuggerUrl)
    assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, new URL(ownedBrowserRawEndpoint).port); assert.equal(url.pathname, ownedBrowserSocketPath); assert.equal(url.search + url.hash, '')
    const socket = new WebSocket(url.href)
    try {
      await bounded(new Promise((done, reject) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', () => reject(new Error('Owned close handshake failed')), { once: true }) }), 2000, 'Owned close handshake timed out')
      assert.equal(exited(child), false, 'The original owned browser changed before close')
      socket.send('{"id":1,"method":"Browser.close"}')
      await waitFor(() => exited(child), 'The exact owned browser natural exit is unconfirmed; no replay or broad kill', 8000)
    } finally { socket.close() }
  }
  assert.equal(child.exitCode, 0, 'The owned browser must exit naturally with code zero'); assert.equal(child.signalCode, null)
  if (ownedBrowserRawEndpoint) await waitFor(async () => {
    try { const response = await fetch(ownedBrowserRawEndpoint + '/json/version', { signal: AbortSignal.timeout(500) }); await response.body?.cancel(); return false } catch { return true }
  }, 'The owned browser CDP endpoint remained live after its child exited', 5000)
  ownedBrowser = undefined
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
  const stopped = await Promise.race([exited.then(() => true), sleep(2500).then(() => false)])
  if (!stopped) await stopOwnedProcess(child)
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
  host = spawn(cli[0], [...cli.slice(1), '--profile', 'web', '--no-open', '--port', '0'], { env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
  const append = chunk => { hostLog += chunk }; host.stdout.on('data', append); host.stderr.on('data', append)
  let hostError; host.once('error', error => { hostError = error })
  const url = await waitForHarnessHostUrl(() => ({ exited: Boolean(hostError) || host.exitCode !== null || host.signalCode !== null, error: redact(hostError?.message ?? hostLog).slice(-5000), url: hostLog.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/u)?.[0] }))
  await check('owner-cookie-bootstrap-and-real-onboarding-dismissal', async () => {
    const bootstrap = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
    assert.equal(bootstrap.status, 303); assert.ok(bootstrap.headers.getSetCookie().length)
    browserServer = await chromium.launchServer({ channel, headless: true })
    browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: 15000 })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' })
    const ownerOrigin = new URL(url).origin
    await context.route('**/*', async route => {
      const request = route.request(), target = new URL(request.url()), channel = ownRPCChannel(request.url())
      if (channel && target.origin === ownerOrigin) {
        if (rpcObservationClosing) { await new Promise(done => teardownHeldRPCs.push({ route, done })); return }
        const envelope = request.postDataJSON(), payload = envelope?.payload, issuedAtMs = performance.now(), metadata = { channel, ...(typeof payload?.op === 'string' ? { op: payload.op } : {}) }
        forwardedOwnRPCs.set(request, metadata)
        await rpcResponses.collect(metadata, async () => {
          let upstream
          try {
            assert.equal(request.method(), 'POST', 'Only the original owner RPC method is allowed')
            // Observation may outlive the renderer's 15 s wait so the original
            // Host/CDP failure can still be recorded. It never retries the call
            // or changes any production CDP deadline.
            const timeout = channel === 'computer' && payload?.op === 'connect' ? 45000 : 30000
            // Forward the original request once. Independent APIResponse bodies
            // survive a legitimate renderer AbortController cancellation.
            upstream = await route.fetch({ maxRetries: 0, maxRedirects: 0, timeout })
            assert.equal(upstream.ok(), true, 'Own RPC HTTP response must be successful')
            const reply = await upstream.json(), result = reply.result, receivedAtMs = performance.now()
            assert.equal(reply.type, 'server-response'); assert.equal(reply.rpcId, envelope.rpcId)
            assert.equal(typeof result?.ok, 'boolean', 'Own RPC response must contain a confirmed result')
            if (channel === 'workbench') {
              const task = multitask?.tasks.find(task => task.environmentId === payload?.environmentId && task.workbenchTabId === payload?.workbenchTabId)
              const receipt = workbenchRPCMetadata(envelope, issuedAtMs, receivedAtMs, result, task?.taskId)
              if (workbenchRpcTimeline.length >= 4000) throw Error('Own workbench RPC timeline exceeds the fixed evidence limit')
              workbenchRpcTimeline.push(receipt)
              if (result.ok === false) workbenchErrors.push(receipt)
              const frame = result?.value
              if (payload?.op === 'preview' && result.ok === true && typeof frame?.observation?.imageBase64 === 'string') {
                workbenchFrames.push({ chatSessionId: frame.target?.chatSessionId, targetId: frame.target?.targetId, workbenchTabId: frame.target?.workbenchTabId, imageSha256: sha256(Buffer.from(frame.observation.imageBase64, 'base64')) })
                if (workbenchFrames.length > 500) workbenchFrames.shift()
              }
            } else {
              const classified = rpcDiagnostic.finish(request, result, receivedAtMs)
              if (result.ok === false && classified?.expected !== true) rpcErrors.push({ ...(classified?.error ?? { code: result.error?.code }), message: redact(result.error?.message ?? 'RPC failed') })
              if (payload?.op === 'connect') connectReplies.push({ sessionId: payload.sessionId, mode: payload.mode, ok: result.ok, available: result?.value?.available })
            }
            hostReplyConfirmed.add(request)
            try { await route.fulfill({ response: upstream }) }
            catch (error) {
              if (request.failure()?.errorText !== 'net::ERR_ABORTED') throw error
              uiDeliveryCancellations.push({ ...metadata, code: 'UI_CANCELED_AFTER_HOST_REPLY_CONFIRMED' })
            }
          } catch (error) {
            rpcTransportFailures.push({ ...metadata, code: 'RPC_TRANSPORT_UNCONFIRMED' })
            await route.abort().catch(() => {}); throw error
          } finally { try { await upstream?.dispose() } finally { forwardedOwnRPCs.delete(request) } }
        })
        return
      }
      return ['http:', 'https:'].includes(target.protocol) && !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ? route.abort() : route.continue()
    })
    page = await context.newPage(); page.setDefaultTimeout(15000)
    page.on('pageerror', error => pageErrors.push(redact(error.message)))
    page.on('request', request => {
      const path = new URL(request.url()).pathname
      if (path.endsWith('/qiuya-tools.workbench')) {
        let payload; try { payload = request.postDataJSON()?.payload } catch { return }
        if (typeof payload?.op === 'string') workbenchRequests.push({ op: payload.op, ...(typeof payload.chatSessionId === 'string' ? { chatSessionId: payload.chatSessionId } : {}), ...(typeof payload.operation === 'string' ? { operation: payload.operation } : {}) })
        return
      }
      if (!path.endsWith('/qiuya-tools.computer.control')) return
      let envelope, payload; try { envelope = request.postDataJSON(); payload = envelope?.payload } catch { return }
      rpcDiagnostic.begin(request, envelope, surface)
      if (typeof payload?.op === 'string') requests.push({ op: payload.op, surface, ...(typeof payload.sessionId === 'string' ? { sessionId: payload.sessionId } : {}), ...(typeof payload.taskId === 'string' ? { taskId: payload.taskId } : {}), ...(typeof payload.mode === 'string' ? { mode: payload.mode } : {}) })
    })
    page.on('requestfailed', request => {
      // Renderer cancellation is not a Host RPC receipt. The independent
      // single-forward task remains registered until its real response is read.
      if (!hostReplyConfirmed.has(request)) rpcDiagnostic.failed(request)
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
    assert.ok(chat.length > 0); assert.ok(chat.every(row => ['status', 'pending'].includes(row.op) && typeof row.sessionId === 'string' && row.sessionId.length > 0), 'Composer requests must remain scoped read-only status or pending metadata calls')
    assert.equal(requests.filter(row => ['connect', 'exchange', 'start', 'act', 'allow'].includes(row.op)).length, 0)
    assert.deepEqual(rpcErrors, []); assert.deepEqual(pageErrors, []); assert.equal(sha256(await readFile(candidate)), candidateSha256)
    return { composerStatusRequests: chat.filter(row => row.op === 'status').length, composerPendingRequests: chat.filter(row => row.op === 'pending').length, allScoped: true, automaticConnections: 0, modelConfigured: false, promptsSent: 0, nativeInputSent: false, candidateUnchanged: true }
  })
  await check('explicit-browser-connection-readback-and-real-two-chat-isolation', async () => {
    assert.equal(requests.filter(row => row.op === 'connect').length, 0, 'All preparatory menu acceptance must remain read-only')
    const fixtureTitle = 'QiuYaTools 独立浏览器连接验收', fixturePath = `/fixture-${randomUUID()}`
    fixtureServer = createServer((request, response) => {
      const incoming = new URL(request.url ?? '/', 'http://127.0.0.1'), variant = incoming.searchParams.get('task')
      if (incoming.pathname !== fixturePath || !Object.hasOwn(ownedFixtureColors, variant) || incoming.searchParams.size !== 1) { response.writeHead(404); response.end(); return }
      const title = variant === 'orders' ? 'QiuYaTools · 订单核验' : variant === 'browser' ? 'QiuYaTools · 浏览器整理' : fixtureTitle
      const background = `rgb(${ownedFixtureColors[variant].join(',')})`
      fixtureHits++; response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'" })
      response.end(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>${title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:${background};color:#174753;font:16px system-ui}main{max-width:600px;padding:40px;border:1px solid #bdd4d7;border-radius:18px;background:#fff;box-shadow:0 12px 35px #17475316}h1{font-size:25px}p{line-height:1.8}</style><main><h1>${title}</h1><p>当前聊天已通过已安装的插件连接独立浏览器，并打开这个本机测试页面。</p><p>页面仅用于隔离验收，没有账号、个人数据或外部资源。</p></main></html>`)
    })
    await new Promise((done, reject) => { fixtureServer.once('error', reject); fixtureServer.listen(0, '127.0.0.1', done) })
    const address = fixtureServer.address(); assert.ok(address && typeof address === 'object')
    const fixtureOrigin = `http://127.0.0.1:${address.port}`, fixtureUrl = fixtureOrigin + fixturePath + '?task=default'
    const helper = await startOwnedHeadlessBrowser({ fixtureOrigin, fixturePath })
    ownedFixture = { origin: fixtureOrigin, path: fixturePath, url: fixtureUrl, title: fixtureTitle, browserName: helper.browserName }
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
    const confirmedTargets = await computerRpc('targets', sessions[0])
    assert.equal(confirmedTargets.filter(target => target.title === fixtureTitle).length, 1, 'Installed target metadata must retain the unique real default fixture')
    assert.ok(ownedFixtureProxy.snapshot().variants.default >= 1, 'The actual default page must traverse the deny proxy')
    const mutations = requests.filter(row => !['status', 'pending', 'applications', 'targets'].includes(row.op))
    assert.deepEqual(mutations, [{ op: 'connect', surface: 'chat', sessionId: sessions[0], mode: 'browser' }], 'Only one explicit current-chat browser connection is permitted')
    assert.ok(requests.filter(row => row.surface === 'chat').every(row => typeof row.sessionId === 'string' && row.sessionId.length > 0), 'Every chat status, connection and target read must be scoped')
    assert.deepEqual(pageErrors, []); assert.deepEqual(rpcErrors, []); assert.equal(sha256(await readFile(candidate)), candidateSha256)
    return { explicitBrowserConnections: 1, connectedSession: sessions[0], otherSession: sessions[1], currentChatReadback: 'browser', otherChatReadback: 'local', actualFixtureTargetEnumerated: true, fixtureHttpRequests: fixtureHits, ownedHeadlessBrowserLaunched: true, browserName: helper.browserName, nativeInputSent: false, modelConfigured: false, promptsSent: 0, allChatRpcsScoped: true, candidateUnchanged: true }
  })
  // Keep all additions after the original twelve checks and their strict
  // one-mutation assertion. These deliberately create two explicit new tasks.
  await check('same-chat-two-owned-browser-tasks-are-ready-at-the-same-time', async () => {
    assert.ok(ownedFixture && ownedBrowserEndpoint && ownedFixtureProxy)
    multitask = { chatSessionId: sessions[0], tasks: [], physicalInputSent: false, modelConfigured: false, fixtureSource: 'owned-headless-browser-and-loopback-HTTP-only' }
    for (const [label, variant] of [['订单核验', 'orders'], ['浏览器整理', 'browser']]) {
      const created = await computerRpc('createTask', sessions[0], { label })
      assert.equal(typeof created?.taskId, 'string'); assert.ok(created.taskId)
      const url = `${ownedFixture.origin}${ownedFixture.path}?task=${variant}`
      const connected = await computerRpc('connect', sessions[0], { taskId: created.taskId, mode: 'browser', browser: ownedFixture.browserName, allowedOrigins: [ownedFixture.origin], initialUrl: url, cdpEndpoint: ownedBrowserEndpoint })
      assert.equal(connected.available, true)
      const targets = await computerRpc('targets', sessions[0], { taskId: created.taskId })
      const title = `QiuYaTools · ${label}`, matching = targets.filter(target => target.title === title)
      assert.equal(matching.length, 1, 'Each task must select its unique real owned fixture page')
      assert.ok(ownedFixtureProxy.snapshot().variants[variant] >= 1, 'The real task page must traverse the exact deny proxy')
      const task = { taskId: created.taskId, label, variant, targetId: matching[0].id, title }
      multitask.tasks.push(task)
      const started = await computerRpc('start', sessions[0], { taskId: task.taskId, targetId: task.targetId })
      assert.equal(started.state, 'ready')
    }
    const [a, b] = multitask.tasks
    assert.notEqual(a.taskId, b.taskId); assert.notEqual(a.targetId, b.targetId)
    const status = await computerRpc('status', sessions[0])
    for (const task of multitask.tasks) {
      const actual = status.sessions.find(row => row.taskId === task.taskId)
      assert.equal(actual?.state, 'ready'); assert.equal(actual.chatSessionId, sessions[0]); assert.equal(actual.target?.id, task.targetId)
    }
    const actualViews = (await workbenchStatus(sessions[0])).views.filter(view => multitask.tasks.some(task => task.targetId === view.targetId))
    assert.equal(actualViews.length, 2, 'The real production workbench must expose both task views')
    for (const task of multitask.tasks) {
      const view = actualViews.find(view => view.targetId === task.targetId)
      task.environmentId = view.environmentId; task.workbenchTabId = view.workbenchTabId
    }
    await waitFor(async () => await taskCard(sessions[0]).getByRole('tablist', { name: '当前聊天的电脑任务', exact: true }).getByRole('tab').count() === 2, 'The installed production small preview did not render two task tabs')
    return { tasks: multitask.tasks, bothReadyTogether: true, actualDistinctBrowserPages: true, productionWorkbenchViews: actualViews.length, modelConfigured: false, promptsSent: 0, nativeInputSent: false }
  })
  await check('same-chat-real-task-frames-light-dark-tabs-and-hover-controls', async () => {
    const frames = [], [a, b] = multitask.tasks
    const concurrentFrames = []
    for (let round = 1; round <= 6; round++) {
      // Exercise the three existing product connections concurrently, without
      // another CDP controller, autoAttach, focus emulation or page activation.
      const [first, second, metadata] = await Promise.all([
        computerRpc('frame', sessions[0], { taskId: a.taskId }),
        computerRpc('frame', sessions[0], { taskId: b.taskId }),
        computerRpc('targets', sessions[0]),
      ])
      assert.ok(metadata.some(target => target.id === a.targetId) && metadata.some(target => target.id === b.targetId))
      for (const [task, observation] of [[a, first], [b, second]]) {
        const proof = inspectOwnedFixtureFrame(observation, { targetId: task.targetId, variant: task.variant }, jpegjs.decode)
        const name = `same-chat-round-${round}-${task.variant}`, path = join(output, name + '.jpg')
        await writeFile(path, Buffer.from(observation.imageBase64, 'base64'), { flag: 'wx' })
        screenshots.push({ name, path, scope: 'installed-product-owned-fixture-frame-only' }); concurrentFrames.push({ round, taskId: task.taskId, ...proof })
      }
      assertNoWorkbenchPreviewTimeouts(workbenchErrors)
    }
    assert.equal(concurrentFrames.length, 12)
    for (let index = 0; index < concurrentFrames.length; index += 2) assert.notEqual(concurrentFrames[index].imageSha256, concurrentFrames[index + 1].imageSha256, 'Simultaneous tasks must retain distinct real pixels')
    multitask.concurrentFrames = concurrentFrames
    for (const [colorScheme, task] of [['light', a], ['dark', b]]) {
      await page.emulateMedia({ colorScheme })
      await waitFor(() => page.evaluate(scheme => matchMedia(`(prefers-color-scheme: ${scheme})`).matches, colorScheme), 'The task preview color scheme did not update')
      await selectPreviewTask(task)
      const frame = await previewImage(task)
      frames.push({ colorScheme, taskId: task.taskId, ...frame })
      const card = taskCard(sessions[0])
      assert.equal(await card.locator('.qyt-workbench-surface').getAttribute('data-view-only'), 'true', 'Acceptance must remain in preview mode with no target input')
      await card.hover()
      const overlay = card.locator('.qyt-workbench-small-overlay')
      await waitFor(() => overlay.evaluate(node => Number(getComputedStyle(node).opacity) >= .95 && getComputedStyle(node).pointerEvents !== 'none'), 'The actual preview controls did not appear on hover')
      assert.equal(await card.getByRole('button', { name: '暂停', exact: true }).isEnabled(), true)
      await screenshot(`same-chat-task-${task === a ? 'orders' : 'browser'}-${colorScheme}-hover`)
    }
    assert.notEqual(frames[0].imageSha256, frames[1].imageSha256, 'Switching task tabs must switch actual distinct fixture pixels')
    multitask.frames = frames
    assertNoWorkbenchPreviewTimeouts(workbenchErrors)
    return { frames, decodedRealJPEGs: true, frameReceiptsMatchSelectedTarget: true, selectedTasksHaveDifferentPixels: true, lightAndDarkScreenshots: true, hoverControlsVerified: true, nativeInputSent: false }
  })
  await check('same-chat-selection-survives-workspace-reorder-and-other-chat-hides-preview', async () => {
    const [a, b] = multitask.tasks
    const selected = await selectPreviewTask(a); await previewImage(a)
    const own = sessionWorkspaces.get(sessions[0]), other = sessionWorkspaces.get(sessions[1])
    const receipt = await ownerRpc('workspace/insertBefore', { workspaceId: other.workspaceId, beforeWorkspaceId: own.workspaceId })
    assert.ok(receipt.workspaceIds.indexOf(other.workspaceId) < receipt.workspaceIds.indexOf(own.workspaceId))
    await waitFor(() => page.locator('[data-row-key^="workspace:"]:visible').evaluateAll((nodes, ids) => {
      const order = nodes.map(node => node.getAttribute('data-row-key'))
      return order.indexOf('workspace:' + ids.other) >= 0 && order.indexOf('workspace:' + ids.other) < order.indexOf('workspace:' + ids.own)
    }, { own: own.workspaceId, other: other.workspaceId }), 'The public sidebar did not apply the actual Workspace order mutation')
    assert.equal(await selected.getAttribute('aria-selected'), 'true', 'A Workspace list reorder must not change the selected task')
    await previewImage(a); await screenshot('same-chat-task-after-workspace-reorder')
    await selectSession(sessions[1])
    await waitFor(async () => await taskCard(sessions[0]).count() === 0 && await taskCard(sessions[1]).count() === 0, 'The old chat task preview remained visible in the other chat')
    const beforeReturn = await computerRpc('status', sessions[0])
    for (const task of multitask.tasks) assert.equal(beforeReturn.sessions.find(row => row.taskId === task.taskId)?.state, 'ready', 'Switching chats must not stop a background task')
    await screenshot('same-chat-tasks-hidden-in-other-chat')
    await selectSession(sessions[0]); await selectPreviewTask(b); await previewImage(b)
    assert.equal(await taskCard(sessions[0]).getByRole('tablist', { name: '当前聊天的电脑任务', exact: true }).getByRole('tab').count(), 2)
    await screenshot('same-chat-tasks-restored-after-chat-return')
    return { realWorkspaceReorder: true, selectedTaskStableAcrossReorder: true, oldChatPreviewHidden: true, backgroundTasksRemainReady: 2, bothTaskTabsRestoredOnReturn: true, nativeInputSent: false }
  })
  await check('same-chat-pause-and-stop-one-task-preserve-the-other-task-epoch', async () => {
    const [a, b] = multitask.tasks, before = await computerRpc('status', sessions[0])
    const sibling = before.sessions.find(row => row.taskId === b.taskId)
    assert.equal(sibling?.state, 'ready')
    await selectPreviewTask(a); await previewImage(a)
    await taskCard(sessions[0]).hover(); await taskCard(sessions[0]).getByRole('button', { name: '暂停', exact: true }).click()
    await waitFor(async () => {
      const value = await computerRpc('status', sessions[0])
      return value.sessions.find(row => row.taskId === a.taskId)?.state === 'paused'
    }, 'The actual current-task Pause control did not pause its task')
    const paused = await computerRpc('status', sessions[0]), siblingPaused = paused.sessions.find(row => row.taskId === b.taskId)
    assert.equal(siblingPaused?.state, sibling.state); assert.equal(siblingPaused.epoch, sibling.epoch)
    await waitFor(() => taskCard(sessions[0]).getByRole('button', { name: '暂停', exact: true }).isDisabled(), 'The workbench did not read back the paused task epoch before Stop')
    await taskCard(sessions[0]).hover(); await taskCard(sessions[0]).getByRole('button', { name: '停止', exact: true }).click()
    await waitFor(async () => (await computerRpc('status', sessions[0])).sessions.find(row => row.taskId === a.taskId)?.state === 'stopped', 'The actual current-task Stop control did not stop its task')
    const stopped = await computerRpc('status', sessions[0]), siblingStopped = stopped.sessions.find(row => row.taskId === b.taskId)
    assert.equal(siblingStopped?.state, sibling.state); assert.equal(siblingStopped.epoch, sibling.epoch)
    await previewImage(b)
    assert.equal(requests.some(row => row.op === 'act'), false)
    assert.equal(workbenchRequests.some(row => row.op === 'humanAct'), false)
    assert.ok(workbenchRequests.some(row => row.op === 'control' && row.operation === 'pause'))
    assert.ok(workbenchRequests.some(row => row.op === 'control' && row.operation === 'stop'))
    assert.deepEqual(pageErrors, []); assert.deepEqual(rpcErrors, []); assert.equal(sha256(await readFile(candidate)), candidateSha256)
    await screenshot('same-chat-sibling-remains-ready-after-other-task-stop')
    assertNoWorkbenchPreviewTimeouts(workbenchErrors)
    multitask.siblingIsolation = { stoppedTask: a.taskId, readyTask: b.taskId, beforeEpoch: sibling.epoch, afterEpoch: siblingStopped.epoch }
    return { ...multitask.siblingIsolation, pausedOnlySelectedTask: true, stoppedOnlySelectedTask: true, siblingState: siblingStopped.state, siblingFrameStillUsable: true, browserInputSent: false, nativeInputSent: false, modelConfigured: false, promptsSent: 0, candidateUnchanged: true }
  })
} catch (error) {
  failure = redact(error.message); process.exitCode = 1; console.error(failure)
  const dom = await bounded(Promise.resolve(page?.evaluate(() => {
    const describe = node => {
      const box = node.getBoundingClientRect(), style = getComputedStyle(node)
      return { rect: { x: box.x, y: box.y, width: box.width, height: box.height }, display: style.display, visibility: style.visibility, opacity: style.opacity, position: style.position, overflow: style.overflow, pointerEvents: style.pointerEvents }
    }
    return { viewport: { width: innerWidth, height: innerHeight }, selectedSessions: [...document.querySelectorAll('[data-conversation-session]')].map(node => ({ sessionId: node.getAttribute('data-conversation-session'), ...describe(node) })), anchors: [...document.querySelectorAll('[data-qyt-workbench-chat]')].map(node => ({ chat: node.getAttribute('data-qyt-workbench-chat'), ...describe(node) })), cards: [...document.querySelectorAll('.qyt-workbench-small,.qyt-workbench-approvals,[data-qyt-computer-inline]')].map(node => ({ className: node.className, chat: node.closest('[data-qyt-workbench-chat]')?.getAttribute('data-qyt-workbench-chat'), ...describe(node), tabs: [...node.querySelectorAll('[role="tab"]')].map(tab => ({ label: tab.getAttribute('aria-label'), selected: tab.getAttribute('aria-selected'), ...describe(tab) })), images: [...node.querySelectorAll('img')].map(image => ({ complete: image.complete, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, ...describe(image) })) })), environments: [...document.querySelectorAll('[data-qyt-computer-environment]')].map(node => ({ sessionId: node.getAttribute('data-qyt-computer-environment'), ...describe(node) })) }
  })), 3000, 'Failure DOM diagnostic timed out').catch(error => ({ unavailable: redact(error.message) }))
  failureDiagnostic = { reason: failure, surface, dom, cdp: cdpMetadataProxy?.snapshot(), rpcDiagnostic: rpcDiagnostic.snapshot(), pageErrors, rpcErrors, workbenchErrors, workbenchRpcTimeline: workbenchRpcTimeline.slice(-200), workbenchRequests: workbenchRequests.slice(-100), frames: workbenchFrames.slice(-20) }
  await writeFile(join(output, 'failure-diagnostic.json'), JSON.stringify(failureDiagnostic, null, 2) + '\n').catch(() => {})
  if (page && surface === 'chat') await bounded(screenshot('failed-isolated-chat-state'), 4000, 'Failure screenshot timed out').catch(() => {})
  console.error(JSON.stringify({ failureDiagnostic: join(output, 'failure-diagnostic.json'), cards: dom?.cards?.length, selectedSessions: dom?.selectedSessions, workbenchErrors }))
} finally {
  // Freeze only new owner RPC forwarding. The UI remains alive while every
  // previously forwarded request and received body finishes; held new polls
  // never reach the Host and cannot hide an already-issued timeout response.
  rpcObservationClosing = true
  try {
    const started = Date.now()
    await waitFor(() => forwardedOwnRPCs.size === 0, 'Already forwarded own RPCs did not finish before UI closure', 15000)
    await rpcResponses.drain(Math.max(1, 15000 - (Date.now() - started)))
    assert.deepEqual(rpcTransportFailures, [], 'Forwarded own RPC transport outcomes must be confirmed')
    rpcObservationDrained = true
  } catch (error) { failure ??= redact(error.message); process.exitCode = 1 }
  for (const held of teardownHeldRPCs) { await held.route.abort().catch(() => {}); held.done() }
  try {
    await bounded(Promise.resolve(browser?.close()), 2500, 'Owned UI browser close timed out').catch(() => {})
    await bounded(Promise.resolve(browserServer?.close()), 2500, 'Owned UI browser server close timed out').catch(() => {})
    const child = browserServer?.process(); if (child && !exited(child)) await stopOwnedProcess(child)
    cleanup.browserClosed = !child || exited(child)
  } catch (error) { failure ??= redact(error.message); process.exitCode = 1 }
  try { await stopOwnedHost(); cleanup.hostStopped = true } catch (error) { failure ??= redact(error.message); process.exitCode = 1 }
  try { await stopOwnedHeadlessBrowser(); cleanup.ownedBrowserStopped = true } catch (error) { failure ??= redact(error.message); process.exitCode = 1 }
  try { await ownedFixtureProxy?.close(); cleanup.ownedFixtureProxyStopped = true } catch (error) { failure ??= redact(error.message); process.exitCode = 1 }
  try { await cdpMetadataProxy?.close(); cleanup.cdpMetadataProxyStopped = true } catch (error) { failure ??= redact(error.message); process.exitCode = 1 }
  try { if (fixtureServer) { fixtureServer.closeAllConnections(); await bounded(new Promise((done, reject) => fixtureServer.close(error => error ? reject(error) : done())), 2500, 'Owned fixture server close timed out') }; cleanup.fixtureServerStopped = true } catch (error) { failure ??= redact(error.message); process.exitCode = 1 }
  if (cleanup.browserClosed && cleanup.hostStopped && cleanup.ownedBrowserStopped && cleanup.fixtureServerStopped && cleanup.ownedFixtureProxyStopped && cleanup.cdpMetadataProxyStopped) try { await rm(temporary, { recursive: true, force: true }); cleanup.temporaryRemoved = true } catch (error) { failure ??= redact(error.message); process.exitCode = 1 }
  try { assertNoWorkbenchPreviewTimeouts(workbenchErrors) } catch (error) { failure ??= redact(error.message); process.exitCode = 1 }
  await writeFile(join(output, 'rpc-correlation-diagnostic.json'), JSON.stringify(rpcDiagnostic.snapshot(), null, 2) + '\n')
  await writeFile(join(output, 'workbench-rpc-timeline.json'), JSON.stringify({ records: workbenchRpcTimeline, savedRequestBodies: false, savedCredentials: false, savedResponseBodies: false }, null, 2) + '\n')
  await writeFile(join(output, 'cdp-method-diagnostic.json'), JSON.stringify(cdpMetadataProxy?.snapshot() ?? { status: ownedRendering.rawOwnedCDP ? 'explicit-raw-owned-cdp' : 'not-created' }, null, 2) + '\n')
  await writeFile(join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', kind: 'official-Harness-installed-chat-environment-disposable-profile', testedAt: new Date().toISOString(), platform: process.platform, architecture: process.arch, candidateSha256, browserChannel: channel, ownedBrowserDiagnostics: { ...ownedRendering, candidateModified: false, controlledBrowserPlaywrightClients: 0, networkIsolation: 'exact-owned-origin-path-variant-GET-HEAD-deny-proxy', networkGuard: ownedFixtureProxy?.snapshot(), harnessUIPlaywrightKept: true, ownedPageMetadata: 'installed-product-targets-only', ownedPagePixels: 'installed-product-frame-and-workbench-only' }, rpcObservation: { ...rpcResponses.snapshot(), drainedBeforeUIClosed: rpcObservationDrained, forwardedPending: forwardedOwnRPCs.size, transportFailures: rpcTransportFailures, rendererDeliveryCancellations: uiDeliveryCancellations, observationSource: 'single-route-fetch-independent-APIResponse-before-fulfill', forwardedOnceNoRetries: true, httpObservationBudgetMs: 30000, connectObservationBudgetMs: 45000, productionCDPDeadlineModified: false, rendererWaitDeadlineModified: false, teardownUnforwardedPolls: teardownHeldRPCs.length }, previewTimeouts: { passed: rpcObservationDrained && workbenchErrors.every(row => row.code !== 'BROWSER_TIMEOUT'), count: workbenchErrors.filter(row => row.code === 'BROWSER_TIMEOUT').length }, checks, screenshots, rpcErrors, rpcSummary: Object.fromEntries([...new Set(requests.map(row => row.op))].map(op => [op, requests.filter(row => row.op === op).length])), workbenchRpcSummary: Object.fromEntries([...new Set(workbenchRequests.map(row => row.op))].map(op => [op, workbenchRequests.filter(row => row.op === op).length])), workbenchErrors, ...(multitask ? { sameChatTaskAcceptance: multitask } : {}), scopedComposerSessions: [...new Set(requests.filter(row => row.surface === 'chat').map(row => row.sessionId).filter(Boolean))], isolation: { disposableDSHHome: true, personalProfileTouched: false, systemPermissionsChanged: false, nativeInputSent: false, applicationLaunched: ownedBrowserLaunched, applicationLaunchScope: ownedBrowserLaunched ? 'test-owned-headless-Chrome-or-Edge-private-profile-only' : 'none', modelConfigured: false, promptsSent: 0, externalBrowserNetworkBlocked: true, screenshotScope: 'isolated-owned-profile-page-and-owned-headless-fixture-only', credentialPayloadsRecorded: false }, cleanup, ...(cleanup.temporaryRemoved ? {} : { preservedTemporaryDirectory: temporary }), limitations: ['Focused installed composer UI, one default connection and two same-chat tasks using a test-owned headless browser/local HTML fixtures; no remote pairing, browser input, native desktop input or model-driven application control.'], ...(failure ? { reason: failure } : {}) }, null, 2) + '\n')
}
