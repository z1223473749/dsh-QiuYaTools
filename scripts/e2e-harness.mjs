/** Real installed Harness + isolated profile + deterministic local model + Chrome. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import { build } from 'esbuild'
import { captureHarnessComputerDiagnostic, HARNESS_COMPUTER_DIAGNOSTIC_CODES } from '../tests/fixtures/harness-e2e-provider.mjs'
import { captureSettingsTabs, createHarnessImageLayout } from './harness-settings-acceptance.mjs'
import { waitForHarnessComputerPipeline, matchesHarnessPreviewControlState, harnessFailedComputerDrained, finalizeHarnessOwnedResources } from './harness-computer-pipeline.mjs'
import { fixturePlanRevisionText, archiveCollectionEvidence, planRevisionEvidence, waitForInlinePaint } from './harness-feature-evidence.mjs'
import { readOwnHarnessPastedText } from './harness-pasted-text-evidence.mjs'
import { captureHarnessWorkspaceDom, registerHarnessWorkspace, selectedHarnessWorkspaceSession, waitForHarnessNewBlankSession, navigateHarnessPage, sanitizeHarnessDiagnostic } from '../tests/fixtures/harness-workspace-prerequisite.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const arg = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1] }
const output = resolve(arg('--output', 'artifacts/harness-e2e'))
const screenshotDirectoryArgument = arg('--screenshots-dir')
if (process.argv.includes('--screenshots-dir') && (!screenshotDirectoryArgument || screenshotDirectoryArgument.startsWith('--'))) throw new Error('--screenshots-dir requires an explicit directory')
const imageLayout = createHarnessImageLayout(output, screenshotDirectoryArgument)
const imagePath = imageLayout.path, imageReference = imageLayout.reference
const candidate = arg('--package')
const featureEvidenceOnly = process.argv.includes('--feature-evidence-only') || process.argv.includes('--pasted-text-only')
const pastedTextOnly = process.argv.includes('--pasted-text-only')
const featureEvidenceCases = new Set(['account-menu-settings-and-all-feature-tabs', 'settings-persist-thresholds-and-theme', 'real-local-model-session', 'paste-browser-event-to-official-txt-upload', ...pastedTextOnly ? [] : ['native-independent-window-and-reuse', 'computer-main-agent-tools-and-image-adapter-pipeline', 'batch-archive-real-sessions', 'plan-review-comment-and-draft-preservation']])
const windowStateDiagnostic = process.argv.includes('--preview-window-state-diagnostic')
if (windowStateDiagnostic && process.platform !== 'win32') throw new Error('Window-state diagnostics require the actual Windows Host')
const cli = JSON.parse(arg('--cli-json', JSON.stringify(['/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'])))
if (!Array.isArray(cli) || !cli.length || !cli.every(value => typeof value === 'string')) throw new Error('--cli-json must be a nonempty JSON array')
if (!candidate && !arg('--url')) throw new Error('Pass --package <candidate.tgz> or --url <isolated-fixture-URL>')
await mkdir(output, { recursive: true })
await mkdir(imageLayout.directory, { recursive: true })
const candidateSHA256 = candidate ? createHash('sha256').update(await readFile(resolve(candidate))).digest('hex') : null
const temporary = await mkdtemp(join(tmpdir(), 'qiuya-harness-e2e-'))
const profileHome = join(temporary, 'qiuya-harness-home')
const env = { ...process.env, DSH_HOME: profileHome, QIUYA_HARNESS_E2E: '1' }
const tests = [], errors = [], screenshots = [], windowRpc = []
let host, browser, page, driver, macPreviewRetirement, diagnosticComplete = false
let macTargetFixture, macTargetBinding, macTargetEvidenceSequence = 0
let blankSessionSequence = 0
class PreviewWindowDiagnosticStop extends Error {}
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const execute = (args, timeoutMs = 120000) => new Promise((resolve, reject) => {
  const child = spawn(cli[0], [...cli.slice(1), ...args], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
  const timer = setTimeout(() => { child.kill(); reject(new Error('Isolated Harness command timed out')) }, timeoutMs)
  child.once('error', error => { clearTimeout(timer); reject(error) }); child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(sanitizeHarnessDiagnostic(output).slice(-12000))) })
})
const nativeCommand = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''; child.stdout.on('data', chunk => { out += chunk }); child.stderr.on('data', chunk => { err += chunk })
  const timeout = setTimeout(() => { child.kill(); reject(new Error('Native evidence command timed out')) }, 30000)
  child.once('error', error => { clearTimeout(timeout); reject(error) })
  child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve(out) : reject(new Error(err || `${command} exited ${code}`)) })
})
async function ownMacTarget(op, label, extra = {}) {
  assert.ok(process.platform === 'darwin' && candidate && host?.pid && host.exitCode === null, 'Mac fixture preparation requires this runner’s live isolated Host')
  if (!macTargetFixture) {
    macTargetFixture = join(temporary, 'harness-target-macos')
    await nativeCommand('/usr/bin/swiftc', ['-parse-as-library', '-framework', 'AppKit', '-framework', 'ApplicationServices', join(root, 'tests/fixtures/harness-target-macos.swift'), '-o', macTargetFixture])
  }
  const request = op === 'bind' ? { op, label, ancestorPid: host.pid, profileRoot: profileHome,
    targetExecutable: await realpath(join(profileHome, 'profiles/web/node_modules/dsh-qiuya-tools/lib/QiuYaTools Sessions.app/Contents/MacOS/qiuya-session-window')), ...extra }
    : { op, label, binding: macTargetBinding }
  const result = JSON.parse(await nativeCommand(macTargetFixture, ['--request', JSON.stringify(request)]))
  await writeFile(join(output, `mac-target-${String(++macTargetEvidenceSequence).padStart(2, '0')}-${op}.json`), JSON.stringify(result, null, 2))
  assert.equal(result.ok, true, `Owned Mac target ${op} failed: ${result.error ?? 'unknown'}`)
  if (op === 'bind') macTargetBinding = result.result.binding
  return result.result
}
async function screenshot(name, target = page) { const filename = `${name}.png`, path = imagePath(filename); await target.screenshot({ path }); screenshots.push(path); return imageReference(filename) }
async function test(name, operation) {
  if (featureEvidenceOnly && !featureEvidenceCases.has(name)) return true
  const start = Date.now()
  try { const details = await operation(); const status = details?.diagnostic ? 'diagnostic' : 'passed'; tests.push({ name, status, elapsedMs: Date.now() - start, ...(details ? { details } : {}) }); console.log(`${status === 'passed' ? 'PASS' : 'DIAGNOSTIC'} ${name}`); return true }
  catch (error) {
    tests.push({ name, status: 'failed', elapsedMs: Date.now() - start, error: sanitizeHarnessDiagnostic(error.message) })
    await screenshot(`failed-${tests.length}`).catch(() => {})
    // A failure inside Settings must not leave its modal covering later cases.
    const close = page?.getByRole('button', { name: '关闭', exact: true })
    if (await close?.isVisible().catch(() => false)) await close.click().catch(() => {})
    await page?.keyboard.press('Escape').catch(() => {})
    console.log(`FAIL ${name}: ${sanitizeHarnessDiagnostic(error.message)}`); return false
  }
}
async function waitFor(predicate, message, milliseconds = 15000) {
  const until = Date.now() + milliseconds
  while (Date.now() < until) { const result = await predicate(); if (result) return result; await sleep(100) }
  throw new Error(message)
}
async function waitForInputWindow() {
  const faults = JSON.parse(arg('--input-faults-json', '[]'))
  assert.ok(Array.isArray(faults) && faults.length <= 12 && faults.every(value => typeof value === 'string' && Number.isFinite(Date.parse(value))), '--input-faults-json must contain explicit scheduled test fault times')
  // Another isolated renderer endurance test can restart its own helper at
  // fixed times. Never begin this real desktop input case near that test's
  // short recovery lease; wait without holding any native input lease.
  for (;;) {
    const blocked = faults.map(Date.parse).sort((a, b) => a - b).find(at => Date.now() >= at - 120000 && Date.now() < at + 20000)
    if (!blocked) return
    const until = blocked + 20000
    console.log(`WAIT native-input-slot until ${new Date(until).toISOString()}`)
    await sleep(Math.max(1, until - Date.now()))
  }
}
const editor = () => page.locator('[data-composer-input][contenteditable="true"]:visible').first()
const row = label => page.locator('[data-row-key^="session:"]').filter({ hasText: label }).first()
async function openSettings() {
  await page.getByRole('button', { name: '账号菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: 'QiuYaTools', exact: true }).click()
  await page.getByRole('heading', { name: 'QiuYa 增强工具箱', exact: true }).waitFor()
}
async function blankSession() {
  const sequence = ++blankSessionSequence
  const before = await page.evaluate(captureHarnessWorkspaceDom)
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
  let sessionId
  try { sessionId = await waitForHarnessNewBlankSession(() => page.evaluate(captureHarnessWorkspaceDom), before) }
  finally { await writeFile(join(output, 'blank-session-dom-' + String(sequence).padStart(3, '0') + '.json'), JSON.stringify({ before, after: await page.evaluate(captureHarnessWorkspaceDom), readySessionId: sessionId }, null, 2)) }
  return sessionId
}
async function newSession(label) {
  const blank = await blankSession()
  assert.match(blank, /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,159}$/u)
  const region = page.locator(`[data-conversation-content][data-conversation-session="${blank}"]:visible`)
  const input = region.locator('[data-composer-input][contenteditable="true"]')
  await input.pressSequentially(label, { delay: 8 })
  await waitFor(async () => await input.innerText() === label && await region.getByRole('button', { name: '发送消息', exact: true }).isEnabled(), 'The settled Session draft did not become sendable')
  await region.getByRole('button', { name: '发送消息', exact: true }).click()
  await page.getByText(`已完成本地测试回复：${label}`, { exact: true }).waitFor({ timeout: 15000 })
  await row(label).waitFor()
  const id = (await row(label).getAttribute('data-row-key')).slice('session:'.length)
  assert.equal(id, blank, 'The first prompt must enter the exact settled blank Session')
  return id
}
async function menu(label) { await row(label).click({ button: 'right' }); await page.getByRole('menuitem', { name: '复制会话标题', exact: true }).waitFor() }
async function ownFeatureEvidence(kind) {
  return page.evaluate(async kind => {
    const response = await fetch('/api/qiuya-e2e-owned-feature', { method: 'POST', signal: AbortSignal.timeout(5000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind }) })
    if (!response.ok) throw new Error('The exact own feature evidence is unavailable')
    return response.json()
  }, kind)
}
async function ownPastedTextEvidence(operation, expectedSHA256, expectedBytes, name) {
  if (process.platform !== 'win32') return readOwnHarnessPastedText({ profileHome: await realpath(profileHome), operation, expectedSHA256, expectedBytes, name })
  return JSON.parse(await nativeCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'tests/fixtures/harness-pasted-file-windows.ps1'), '-ProfileRoot', profileHome, '-Operation', operation, '-ExpectedSHA256', expectedSHA256, '-ExpectedBytes', String(expectedBytes), ...name ? ['-FileName', name] : []]))
}
try {
  let url = arg('--url')
  if (!url) {
    await execute(['--profile', 'web', '--dump-config'])
    await execute(['plugin', '--profile', 'web', 'add', resolve(candidate)])
    assert.equal(createHash('sha256').update(await readFile(resolve(candidate))).digest('hex'), candidateSHA256, 'The candidate changed while Harness was installing it')
    const fixture = join(temporary, 'provider'); await mkdir(fixture)
    await build({ entryPoints: [join(root, 'tests/fixtures/harness-e2e-provider.mjs')], outfile: join(fixture, 'index.mjs'), bundle: true, platform: 'node', format: 'esm' })
    await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'qiuya-harness-e2e-fixture', version: '1.0.0', type: 'module' }))
    const overlay = join(temporary, 'overlay.yml')
    await writeFile(overlay, JSON.stringify([
      { id: 'agent-default-model', config: { provider: 'qiuya-e2e', model: 'fixture' } },
      { id: 'session-title-llm', disabled: true }, { id: 'session-telemetry-otel', disabled: true },
      { insert: [{ id: 'qiuya-harness-e2e-provider', name: join(fixture, 'index.mjs') }] },
    ], null, 2))
    host = spawn(cli[0], [...cli.slice(1), '--profile', 'web', '--patch', overlay, '--no-open', '--port', '0'], { env, cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
    let log = ''; let exited = false
    const accept = chunk => { log += chunk }; host.stdout.on('data', accept); host.stderr.on('data', accept); host.once('exit', () => { exited = true })
    try {
      url = await waitFor(() => { if (exited) throw new Error(sanitizeHarnessDiagnostic(log)); return log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/u)?.[0] }, 'Isolated Harness did not start', 90000)
    } finally {
      await writeFile(join(output, 'host-startup.log'), sanitizeHarnessDiagnostic(log))
    }
  }
  browser = await chromium.launch({ channel: arg('--browser', 'chrome'), headless: !process.argv.includes('--headed') })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  // The isolated browser owns this API spy; the user's system clipboard is never read or changed.
  await context.addInitScript(() => { window.__e2eClipboard = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText(text) { window.__e2eClipboard = text } } }) })
  await context.route('**/*', route => { const requestURL = new URL(route.request().url()); return ['http:', 'https:'].includes(requestURL.protocol) && !['127.0.0.1', 'localhost'].includes(requestURL.hostname) ? route.abort() : route.continue() })
  page = await context.newPage(); page.on('pageerror', error => errors.push(sanitizeHarnessDiagnostic(error.message))); page.setDefaultTimeout(15000)
  page.on('response', response => {
    const endpoint = new URL(response.url()).pathname
    if (!endpoint.startsWith('/api/qiuya-tools.session-windows.')) return
    void response.json().then(envelope => {
      const payload = response.request().postDataJSON()?.payload
      windowRpc.push({ endpoint, status: response.status(), result: envelope.result, ...(payload ? { request: { sessionId: payload.sessionId, source: payload.source, action: payload.action } } : {}) })
    }).catch(() => {})
  })
  await navigateHarnessPage(page, url, evidence => writeFile(join(output, 'initial-navigation.json'), JSON.stringify(evidence, null, 2)))
  const onboarding = page.getByRole('button', { name: '继续', exact: true })
  await onboarding.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})
  if (await onboarding.isVisible()) await onboarding.click()
  await page.getByRole('button', { name: '账号菜单', exact: true }).waitFor()
  // First-use default-workspace restoration can be cancelled by navigation.
  // Register only this test's existing UUID directory through the documented
  // Workspace API, then select it through the actual public workspace menu.
  const workspacePath = join(temporary, 'workspace-' + randomUUID()); await mkdir(workspacePath)
  const workspaceBefore = await page.evaluate(captureHarnessWorkspaceDom)
  let ownedWorkspace, workspaceSessionId
  try {
    ownedWorkspace = await registerHarnessWorkspace(page, await realpath(workspacePath))
    await waitFor(async () => (await page.evaluate(captureHarnessWorkspaceDom)).rows.some(row => row.key === 'workspace:' + ownedWorkspace.workspaceId && row.visible), 'The registered own workspace did not appear in the public workspace list')
    await page.getByRole('button', { name: '选择工作区', exact: true }).click()
    await page.getByRole('menuitem', { name: ownedWorkspace.title, exact: true }).click()
    workspaceSessionId = await waitFor(async () => selectedHarnessWorkspaceSession(await page.evaluate(captureHarnessWorkspaceDom), ownedWorkspace), 'The explicitly selected own workspace did not expose its ready blank Session')
  } finally {
    await writeFile(join(output, 'workspace-prerequisite.json'), JSON.stringify({ ownedWorkspace, workspaceSessionId, before: workspaceBefore, after: await page.evaluate(captureHarnessWorkspaceDom), boundary: 'One documented owner workspace/create RPC for a fresh test-owned directory, then an actual public workspace menu selection. No user workspace is adopted or read; no prompt is sent during setup.' }, null, 2))
  }
  const suffix = Date.now().toString(36), alpha = `E2E:Alpha-${suffix}`, beta = `E2E:Beta-${suffix}`, gamma = `E2E:Gamma-${suffix}`
  await test('account-menu-settings-and-all-feature-tabs', async () => {
    await openSettings()
    const details = await captureSettingsTabs(page, { screenshot })
    await screenshot('settings')
    return details
  })
  await test('settings-persist-thresholds-and-theme', async () => {
    await page.getByRole('tab', { name: '长文本', exact: true }).click()
    await page.getByRole('spinbutton').nth(0).fill('60'); await page.getByRole('spinbutton').nth(1).fill('4')
    await page.getByRole('button', { name: '保存阈值', exact: true }).click()
    await waitFor(async () => (await page.locator('.qyt-status').innerText()).includes('已保存'), 'Threshold save was not acknowledged')
    await page.getByRole('tab', { name: 'Q 主题', exact: true }).click()
    const toggle = page.getByRole('switch', { name: '启用 Q 主题', exact: true }); if (await toggle.getAttribute('aria-checked') !== 'true') await toggle.click()
    await waitFor(() => page.locator('body').getAttribute('data-qyt-q-theme').then(value => value === 'ocean'), 'Theme did not apply')
    await screenshot('theme'); await page.getByRole('button', { name: '关闭', exact: true }).click()
    await openSettings(); await page.getByRole('tab', { name: '长文本', exact: true }).click()
    assert.equal(await page.getByRole('spinbutton').nth(0).inputValue(), '60')
    assert.equal(await page.getByRole('spinbutton').nth(1).inputValue(), '4')
    await page.getByRole('button', { name: '关闭', exact: true }).click()
  })
  let alphaId
  await test('real-local-model-session', async () => { alphaId = await newSession(alpha); await screenshot('conversation'); return { sessionId: alphaId } })
  await test('prompt-suggestion-tab-and-escape', async () => {
    const ghost = page.locator('.qyt-prompt-suggestion-text').first(); await ghost.waitFor({ state: 'visible', timeout: 15000 })
    assert.equal(await ghost.innerText(), '继续检查本地测试结果。')
    await editor().focus(); await editor().press('Tab'); assert.equal(await editor().innerText(), '继续检查本地测试结果。')
    await sleep(150)
    await editor().press('ControlOrMeta+A'); await editor().press('Backspace')
    await waitFor(async () => (await editor().innerText()).trim() === '', 'Accepted suggestion could not be cleared')
    await editor().press('Escape'); assert.equal((await editor().innerText()).trim(), '')
  })
  await test('paste-browser-event-to-official-txt-upload', async () => {
    await editor().focus(); await editor().press('ControlOrMeta+A'); await editor().press('Backspace')
    const payload = `E2E attachment ${randomUUID()} line 1\nline 2\nline 3\nline 4\n` + '保留原始文本。'.repeat(15)
    const bytes = Buffer.from(payload, 'utf8'), sha256 = createHash('sha256').update(bytes).digest('hex')
    const before = await ownPastedTextEvidence('before', sha256, bytes.length)
    assert.equal(before.nonceBucketAbsent, true)
    const uploaded = context.waitForEvent('response', { timeout: 15000, predicate: response => {
      const url = new URL(response.url())
      return url.pathname === '/api/session/uploadFileBinary' && url.searchParams.get('sessionId') === alphaId && /^粘贴文本-.*\.txt$/u.test(url.searchParams.get('name') ?? '')
    } })
    void uploaded.catch(() => {}) // the awaited original rejection still fails this case
    await editor().evaluate((element, text) => { const data = new DataTransfer(); data.setData('text/plain', text); element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })) }, payload)
    const response = await uploaded
    assert.equal(response.status(), 200, 'The real official TXT upload must complete with HTTP 200')
    // The official dedicated Worker terminates after delivering its response
    // to the composer. CDP body access can already be retired; observe HTTP
    // metadata, independent Host bytes and official ready UI instead.
    const name = new URL(response.url()).searchParams.get('name')
    assert.equal(response.request().headers()['content-type'], 'application/octet-stream')
    const stored = await ownPastedTextEvidence('after', sha256, bytes.length, name)
    assert.ok(Number.isSafeInteger(stored.linkCount) && stored.linkCount >= 1, 'The immutable stored object must retain a valid stable link count')
    assert.deepEqual(stored, { operation: 'after', name, bytes: bytes.length, sha256, storedBytesVerified: true, profileBound: true, uniqueFile: true, reparseRejected: true, linkCount: stored.linkCount, handleIdentityVerified: true, readOnly: true, source: 'independent-own-file-handle' })
    await page.getByText(name, { exact: true }).first().waitFor()
    const card = page.locator('[data-composer-card]')
    await waitFor(async () => {
      if (await card.getByText('上传失败，点击重试', { exact: true }).count()) throw new Error('The actual TXT upload UI reports failure')
      return await card.getByText('上传中…', { exact: true }).count() === 0 && await card.getByRole('button', { name: '移除文件 ' + name, exact: true }).count() === 1 && await card.getByRole('button', { name: '重试上传 ' + name, exact: true }).count() === 0
    }, 'The actual TXT upload did not reach the ready UI')
    assert.equal((await editor().innerText()).trim(), '')
    await writeFile(join(output, 'pasted-text-upload-evidence.json'), JSON.stringify({ source: 'Actual browser ClipboardEvent → nonce File → official binary upload HTTP metadata → independent own profile/file-handle read → official composer ready UI', sessionId: alphaId, httpSessionBound: true, httpStatus: response.status(), binaryUpload: true, before, stored, expectedBytes: bytes.length, expectedSHA256: sha256, receiptIdReadDirectly: false, responseBodyRead: false, readyUI: true, inputReplayed: false }, null, 2))
    await screenshot('pasted-txt')
    await card.getByRole('button', { name: '移除文件 ' + name, exact: true }).click()
    return { input: 'browser ClipboardEvent', path: 'actual Harness attachment intake, binary upload and ready UI', storedBytesVerified: true, bytes: bytes.length, sha256 }
  })
  const betaId = pastedTextOnly ? undefined : await newSession(beta), gammaId = pastedTextOnly ? undefined : await newSession(gamma)
  const featureBinding = { workspaceId: ownedWorkspace.workspaceId, workspacePath: await realpath(workspacePath), selectedSessionIds: [betaId, gammaId], preservedSessionIds: [alphaId] }
  await test('session-menus-copy-unread-and-pin', async () => {
    await menu(alpha); await page.getByRole('menuitem', { name: '复制会话标题', exact: true }).click()
    assert.equal(await page.evaluate(() => window.__e2eClipboard), alpha)
    await menu(alpha); await page.getByRole('menuitem', { name: '标记为未读', exact: true }).click()
    await row(alpha).locator('[data-qyt-manual-unread="true"]').waitFor()
    await row(alpha).click(); await waitFor(async () => (await row(alpha).locator('[data-qyt-manual-unread="true"]').count()) === 0, 'Explicit revisit did not clear manual unread')
    await menu(alpha); await page.getByRole('menuitem', { name: '置顶会话', exact: true }).click()
    await menu(alpha); await page.getByRole('menuitem', { name: '取消置顶', exact: false }).waitFor(); await page.keyboard.press('Escape')
    return { clipboard: 'browser-local writeText spy, system clipboard untouched' }
  })
  let independentTarget
  await test('native-independent-window-and-reuse', async () => {
    const compiled = await build({ stdin: { contents: "export {NativeCompanionDriver} from './src/features/computer-use/native.ts'", resolveDir: root }, bundle: true, write: false, platform: 'node', format: 'esm' })
    const { NativeCompanionDriver } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
    const macCandidateHelper = candidate && process.argv.includes('--manual-preview-e2e') ? join(profileHome, 'profiles/web/node_modules/dsh-qiuya-tools/lib/QiuYaTools Computer.app/Contents/MacOS/qiuya-computer') : join(root, 'lib/QiuYaTools Computer.app/Contents/MacOS/qiuya-computer')
    const executable = arg('--native', process.platform === 'darwin' ? macCandidateHelper : join(root, `lib/native/win32-${process.arch}/qiuya-windows.exe`))
    driver = new NativeCompanionDriver({ executable, args: process.platform === 'win32' ? ['--computer'] : [] })
    await menu(alpha); await page.getByRole('menuitem', { name: '新窗口打开', exact: true }).click()
    let ownedTargets = []
    let target
    try {
      target = await waitFor(async () => {
        const targets = await driver.targets()
        ownedTargets = targets.filter(target => target.title.includes(alpha) || process.platform === 'win32' && target.appId.toLowerCase().startsWith(profileHome.toLowerCase() + '\\'))
        return targets.find(target => target.title.includes(alpha))
      }, 'Native session window did not appear', 35000)
    } finally {
      await writeFile(join(output, 'independent-window-targets.json'), JSON.stringify({ alpha, targets: ownedTargets }, null, 2))
      if (process.platform === 'win32') {
        const owned = await nativeCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'tests/fixtures/harness-owned-windows.ps1'), '-ProfileRoot', profileHome])
        await writeFile(join(output, 'independent-os-windows.json'), owned)
      }
      if (!target) for (const [index, item] of ownedTargets.entries()) {
        const observation = await driver.observe(item.id).catch(() => undefined)
        if (!observation) continue
        await writeFile(imagePath(`independent-window-debug-${index}.jpg`), Buffer.from(observation.imageBase64, 'base64'))
        await writeFile(join(output, `independent-window-debug-${index}.json`), JSON.stringify({ target: item, elements: observation.elements }, null, 2))
      }
    }
    independentTarget = target
    if (process.platform === 'darwin' && candidate) await ownMacTarget('bind', alpha, { targetPid: target.pid, targetWindowId: Number(target.id.replace('mac-window:', '')) })
    const observation = await driver.observe(target.id)
    await writeFile(imagePath('independent-window.jpg'), Buffer.from(observation.imageBase64, 'base64'))
    assert.ok(observation.elements.includes(alpha), 'The independent WebKit/Windows window should expose the exact target session')
    await menu(alpha); await page.getByRole('menuitem', { name: '新窗口打开', exact: true }).click()
    if (process.platform === 'darwin' && macTargetBinding) await ownMacTarget('wait', alpha)
    else await sleep(500)
    const second = (await driver.targets()).filter(target => target.title.includes(alpha))
    assert.equal(second.length, 1); assert.equal(second[0].id, target.id)
    return { targetId: target.id, pid: target.pid, screenshotWidth: observation.width }
  })
  if (process.argv.includes('--drag-window-e2e')) await test('trusted-browser-drag-to-native-window', async () => {
    const betaId = (await row(beta).getAttribute('data-row-key')).slice('session:'.length)
    await page.evaluate(sessionId => {
      window.__e2eDragFacts = []
      for (const kind of ['dragstart', 'drop', 'dragend']) document.addEventListener(kind, event => {
        const source = event.target instanceof Element ? event.target.closest('[data-row-key^="session:"]')?.getAttribute('data-row-key') : null
        if (kind === 'dragstart' && source === 'session:' + sessionId && event.isTrusted) window.__e2eDraggedSession = sessionId
        if (window.__e2eDraggedSession === sessionId) window.__e2eDragFacts.push({ kind, isTrusted: event.isTrusted, clientX: event.clientX, clientY: event.clientY, dropEffect: event.dataTransfer?.dropEffect })
        if (kind === 'dragend') window.__e2eDraggedSession = null
      }, true)
    }, betaId)
    const bounds = await row(beta).boundingBox(), viewport = page.viewportSize()
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await page.mouse.down()
    await page.mouse.move(bounds.x + bounds.width + 35, bounds.y + bounds.height / 2, { steps: 12 })
    await page.mouse.move(viewport.width * 0.6, viewport.height * 0.45, { steps: 15 })
    await page.mouse.move(viewport.width * 0.6 + 4, viewport.height * 0.45 + 4)
    await sleep(250); await page.mouse.up()
    const facts = await page.evaluate(() => window.__e2eDragFacts)
    await writeFile(join(output, 'drag-browser-events.json'), JSON.stringify(facts, null, 2))
    const target = await waitFor(async () => (await driver.targets()).find(target => target.title.includes(beta)), 'The real browser drag did not reveal its native session window', 35000)
    assert.ok(facts.some(event => event.kind === 'dragstart' && event.isTrusted), 'The browser must generate an actual trusted dragstart')
    assert.ok(facts.some(event => event.kind === 'drop' && event.isTrusted), 'The browser must generate an actual trusted drop')
    await waitFor(() => windowRpc.some(request => request.request?.sessionId === betaId && request.request.source === 'drag' && request.result?.value?.opened), 'The dragged native window did not acknowledge its exact session', 35000)
    const rpc = windowRpc.filter(request => request.request?.sessionId === betaId && request.request.source === 'drag')
    assert.ok(rpc.some(request => request.request.action === 'prepare' && request.result?.ok))
    assert.ok(rpc.some(request => request.request.action !== 'prepare' && request.result?.value?.opened))
    const observation = await driver.observe(target.id)
    await writeFile(imagePath('drag-native-window.jpg'), Buffer.from(observation.imageBase64, 'base64'))
    await writeFile(join(output, 'drag-native-window-evidence.json'), JSON.stringify({ kind: 'real browser drag outside sidebar; not OS desktop HID drag', facts, rpc, target }, null, 2))
    return { targetId: target.id, trustedDrag: true, boundary: 'client outside sidebar, not physical desktop drop' }
  })
  const computerPipelinePassed = await test('computer-main-agent-tools-and-image-adapter-pipeline', async () => {
    // Bind the exact own Agent before the native prerequisite can fail. This
    // authorizes only the finite cleanup oracle, never target input.
    assert.ok(alphaId, 'The own Alpha session must exist before computer control')
    await writeFile(join(profileHome, 'e2e-computer-target.json'), JSON.stringify({ sessionId: alphaId, ...independentTarget ? { targetId: independentTarget.id } : {} }), { mode: 0o600 })
    await waitForInputWindow()
    assert.ok(independentTarget && alphaId, 'The fixture session window must exist before computer control')
    await row(alpha).click(); await sleep(300)
    if (process.platform === 'win32') {
      // Beta's preceding drag case may cover Alpha. Reuse the exact own
      // window through the public command before the unchanged real hit test.
      const reuseStart = windowRpc.length
      await menu(alpha); await page.getByRole('menuitem', { name: '新窗口打开', exact: true }).click()
      await waitFor(() => windowRpc.slice(reuseStart).some(row => row.request?.sessionId === alphaId && row.result?.ok && row.result?.value?.opened), 'Own Alpha public window reuse did not acknowledge')
      const reused = (await driver.targets()).filter(target => target.id === independentTarget.id)
      assert.equal(reused.length, 1); assert.equal(reused[0].pid, independentTarget.pid); assert.equal(reused[0].appId, independentTarget.appId)
      await writeFile(join(output, 'fixture-public-window-reuse.json'), JSON.stringify({ sessionId: alphaId, exactTargetId: independentTarget.id, acknowledged: true, sameIdentity: true, authorizationStarted: false }, null, 2))
      await editor().fill('E2E:computer-move')
      const beforeSetup = independentTarget
      const activation = JSON.parse(await nativeCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'tests/fixtures/harness-activate-windows.ps1'), '-WindowId', independentTarget.id, '-ProfileRoot', profileHome, '-DiagnosticPath', join(output, 'fixture-user-activation-diagnostic.json')]))
      assert.equal(activation.active, true)
      await writeFile(join(output, 'fixture-user-activation.json'), JSON.stringify(activation, null, 2))
      independentTarget = (await driver.targets()).find(target => target.id === beforeSetup.id)
      assert.ok(independentTarget && independentTarget.pid === beforeSetup.pid && independentTarget.appId === beforeSetup.appId, 'Own fixture identity must remain stable after pre-authorization setup')
      await writeFile(join(output, 'fixture-setup-target-geometry.json'), JSON.stringify({ beforeSetup, afterSetup: independentTarget, authorizationStarted: false }, null, 2))
    }
    const application = (await driver.applications()).find(app => app.appId === independentTarget.appId)
    assert.ok(application, 'The own synthetic fixture must be discoverable without window contents')
    await writeFile(join(profileHome, 'e2e-computer-target.json'), JSON.stringify({ sessionId: alphaId, query: application.name, targetId: independentTarget.id }), { mode: 0o600 })
    await openSettings()
    await page.getByRole('tab', { name: '电脑操控', exact: true }).click()
    const enable = page.getByRole('switch', { name: '启用电脑操控', exact: true })
    if (!await enable.isChecked()) await enable.click()
    await waitFor(() => enable.isChecked(), 'Computer-use setting did not persist')
    assert.equal(await page.getByRole('combobox', { name: /^关联聊天/u }).count(), 0, 'Normal setup must not require linking a chat')
    assert.equal(await page.getByRole('button', { name: '允许本次并开始', exact: true }).count(), 0, 'Starting belongs to the calling chat')
    await waitFor(async () => !(await page.getByRole('region', { name: '系统权限', exact: true }).innerText()).includes('正在检查本机状态'), 'The permission preflight did not finish before the setup screenshot')
    await screenshot('computer-settings-before-chat-request')
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    if (process.platform === 'darwin') {
      // Finish the browser composer before the explicit own-window activation.
      // The subsequent public send click runs in-page and cannot steal OS focus.
      await editor().fill('E2E:computer-move')
      if (!macTargetBinding) await ownMacTarget('bind', alpha, { targetPid: independentTarget.pid, targetWindowId: Number(independentTarget.id.replace('mac-window:', '')) })
      const beforeSetup = independentTarget, activation = await ownMacTarget('activate', alpha)
      assert.equal(activation.stableOnscreen, true)
      independentTarget = (await driver.targets()).find(target => target.id === beforeSetup.id)
      assert.ok(independentTarget && independentTarget.pid === beforeSetup.pid && independentTarget.appId === beforeSetup.appId, 'Own Mac fixture identity must remain stable after pre-authorization activation')
      await writeFile(join(output, 'fixture-setup-target-geometry.json'), JSON.stringify({ beforeSetup, afterSetup: independentTarget, authorizationStarted: false, inputEventsPosted: 0 }, null, 2))
    }
    // Submit before any computer session exists. The model must discover and
    // request its own current chat, then wait for the real owner approval card.
    await page.evaluate(() => {
        const send = [...document.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === '发送消息' || button.title === '发送消息')
        if (!send || send.disabled) throw new Error('Fixture composer send button was not ready')
        send.click()
    })
    const inlinePreview = page.locator(`[data-qyt-computer-inline="${alphaId}"]`)
    const approval = inlinePreview.getByRole('region', { name: '电脑操作授权', exact: true })
    await approval.waitFor({ timeout: 25000 })
    await screenshot('chat-application-approval')
    const beforeApproval = await page.evaluate(async sessionId => {
      const response = await fetch('/api/qiuya-tools.computer.control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'qiuya-tools.computer.control', payload: { op: 'status', sessionId } }) })
      const result = (await response.json()).result
      if (!response.ok || !result.ok) throw new Error('Pre-approval status failed')
      return { sessions: result.value.sessions.filter(row => row.sessionId === sessionId), pending: result.value.pendingRequests.map(row => ({ requestId: row.requestId, sessionId: row.sessionId, appName: row.appName })) }
    }, alphaId)
    assert.deepEqual(beforeApproval.sessions, [], 'No control session may start before the owner approves')
    assert.equal(beforeApproval.pending.length, 1); assert.equal(beforeApproval.pending[0].sessionId, alphaId)
    await writeFile(join(output, 'chat-authorization-before-owner.json'), JSON.stringify(beforeApproval, null, 2))
    await approval.getByRole('button', { name: '允许一次', exact: true }).click()
    const pipelineProgress = []
    try {
      await waitForHarnessComputerPipeline(async remainingMs => {
        const raw = await readFile(join(profileHome, 'e2e-adapter-requests.jsonl'), 'utf8')
        // The provider appends complete JSONL rows synchronously. A concurrent
        // read may see only the unfinished tail, never treat that as a row.
        const lines = raw.split('\n'); if (lines.at(-1) !== '') lines.pop()
        const records = lines.filter(Boolean).map(JSON.parse).filter(record => record.sessionId === alphaId && record.marker === 'E2E:computer-move')
        const live = await page.evaluate(async ({ sessionId, timeoutMs }) => {
          const response = await fetch('/api/qiuya-tools.computer.control', { method: 'POST', signal: AbortSignal.timeout(timeoutMs), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'qiuya-tools.computer.control', payload: { op: 'status', sessionId } }) })
          const result = (await response.json()).result
          if (!response.ok || !result?.ok) throw new Error('The owned computer pipeline status could not be read')
          const session = result.value.sessions.find(row => row.sessionId === sessionId)
          return { state: session?.state, hasError: !!session?.error, nativeAvailable: result.value.native?.available }
        }, { sessionId: alphaId, timeoutMs: Math.max(1, Math.min(10000, remainingMs)) })
        const complete = await page.getByText(/E2E_ADAPTER_IMAGE_CONFIRMED:/u).isVisible()
        const hasImage = records.some(record => record.imageBlocks.length > 0)
        const hasAction = records.some(record => record.actionResults.some(result => result.performed))
        const failed = live.hasError || records.some(record => record.toolErrors?.length || record.actionResults.some(result => result.performed === false))
        return { complete, failed, state: live.state, nativeAvailable: live.nativeAvailable, turns: records.length, hasImage, hasAction,
          stage: complete ? 'complete' : hasAction ? 'action-received' : hasImage ? 'image-received' : live.state ? 'model-turn' : 'awaiting-session' }
      }, { onProgress: value => { if (pipelineProgress.length < 512) pipelineProgress.push(value) } })
    }
    finally {
      await writeFile(join(output, 'computer-pipeline-progress.json'), JSON.stringify({ budgetMs: 90000, deadlineResets: 0, actionsReplayed: 0, samples: pipelineProgress }, null, 2))
      const diagnostic = await page.evaluate(captureHarnessComputerDiagnostic, { sessionId: alphaId, codes: HARNESS_COMPUTER_DIAGNOSTIC_CODES }).catch(() => ({ status: 'unavailable', code: 'SNAPSHOT_UNAVAILABLE' }))
      await writeFile(join(output, 'agent-computer-session-snapshot.json'), JSON.stringify(diagnostic, null, 2))
      const records = (await readFile(join(profileHome, 'e2e-adapter-requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
      await writeFile(join(output, 'agent-computer-adapter-requests.json'), JSON.stringify(records.filter(record => record.sessionId === alphaId && record.marker === 'E2E:computer-move'), null, 2))
    }
    const requests = (await readFile(join(profileHome, 'e2e-adapter-requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    const images = requests.filter(request => request.sessionId === alphaId && request.marker === 'E2E:computer-move' && request.imageBlocks.length > 0)
    assert.ok(images.length, 'The main Agent adapter must actually receive image blocks after the computer tool')
    assert.ok(images.flatMap(request => request.imageBlocks).every(image => image.attachmentId && image.width > 0 && image.height > 0))
    assert.ok(images.flatMap(request => request.actionResults).some(result => result?.performed), 'The main Agent must receive a successful native move-action receipt')
    await writeFile(join(output, 'agent-image-adapter-evidence.json'), JSON.stringify(images, null, 2))
    await screenshot('agent-computer-image')
    const smallFrame = inlinePreview.locator('iframe')
    assert.equal(await smallFrame.getAttribute('src'), `/api/qiuya-tools.computer.preview?session=${encodeURIComponent(alphaId)}&view=inline`)
    await smallFrame.contentFrame().getByRole('img', { name: '实时电脑画面', exact: true }).waitFor()
    const inlinePaint = await smallFrame.contentFrame().locator('#screen').evaluate(waitForInlinePaint, { timeoutMs: 10000 })
    assert.equal(inlinePaint.painted, true); assert.ok(inlinePaint.frameId && inlinePaint.width > 1 && inlinePaint.height > 1)
    await writeFile(join(output, 'inline-preview-painted-frame.json'), JSON.stringify(inlinePaint, null, 2))
    await page.mouse.move(300, 950)
    await waitFor(() => inlinePreview.locator('.qyt-computer-inline-actions').evaluate(node => getComputedStyle(node).opacity === '0'), 'Inline controls must hide when the mouse leaves')
    assert.equal(await inlinePreview.locator('.qyt-computer-inline-title,.qyt-computer-inline-settings').count(), 0, 'The default small preview must contain the image without persistent title/settings text')
    await screenshot('chat-inline-preview')
    await inlinePreview.hover()
    await waitFor(() => inlinePreview.locator('.qyt-computer-inline-actions').evaluate(node => getComputedStyle(node).opacity === '1'), 'Inline controls must appear on hover')
    await screenshot('chat-inline-preview-hover')
    await openSettings(); await page.getByRole('tab', { name: '电脑操控', exact: true }).click()
    let previewTimeline
    if (windowStateDiagnostic) {
      const ready = join(output, 'preview-window-timeline-ready.json')
      const path = join(output, 'preview-window-timeline.json')
      await rm(ready, { force: true }); await rm(path, { force: true })
      const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
      // Compile, bind the exact disposable-profile --computer process and enter
      // the 10ms read-only loop before opening the native preview. No UIA client
      // arrives until this bounded first-show trace has completed.
      previewTimeline = nativeCommand(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'tests/fixtures/harness-window-timeline-windows.ps1'), '-ProfileRoot', profileHome, '-ReadyPath', ready, '-OutputPath', path])
      let timelineError
      previewTimeline.catch(error => { timelineError = error })
      await waitFor(async () => {
        if (timelineError) throw timelineError
        return readFile(ready, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
      }, 'The profile-bound read-only preview timeline did not become ready', 20000)
    }
    try { await page.getByRole('button', { name: '弹出预览', exact: true }).click() }
    finally { if (previewTimeline) await previewTimeline }
    await sleep(1000)
    const nativeStatus = await page.evaluate(async sessionId => {
      const response = await fetch('/api/qiuya-tools.computer.control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'qiuya-tools.computer.control', payload: { op: 'status', sessionId } }) })
      return (await response.json()).result.value.native
    }, alphaId)
    await writeFile(join(output, 'preview-native-status.json'), JSON.stringify(nativeStatus, null, 2))
    const previewPath = imagePath('floating-computer-preview.jpg')
    let preview, observer, windowsPreview, observeWindowState, macPreview
    if (process.platform === 'darwin') {
      if (process.argv.includes('--manual-preview-e2e')) {
        const { waitForOwnedMacPreview } = await import('../tests/fixtures/harness-preview-readiness.mjs')
        assert.ok(candidate && host?.pid, 'Mac manual input requires this runner’s own installed profile and Host process')
        const interactor = join(temporary, 'harness-preview-macos')
        await nativeCommand('/usr/bin/swiftc', ['-parse-as-library', '-framework', 'AppKit', '-framework', 'ScreenCaptureKit', '-framework', 'Vision', join(root, 'tests/fixtures/harness-preview-macos.swift'), '-o', interactor])
        const request = async value => {
          const answer = JSON.parse(await nativeCommand(interactor, ['--request', JSON.stringify(value)]))
          assert.equal(answer.ok, true, `Owned Mac preview operation failed: ${answer.error}`)
          return answer.result
        }
        const library = join(profileHome, 'profiles/web/node_modules/dsh-qiuya-tools/lib')
        const bound = await request({ op: 'bind', ancestorPid: host.pid, targetPid: independentTarget.pid,
          targetWindowId: Number(independentTarget.id.replace(/^mac-window:/u, '')),
          previewExecutable: await realpath(join(library, 'QiuYaTools Computer.app/Contents/MacOS/qiuya-computer')),
          targetExecutable: await realpath(join(library, 'QiuYaTools Sessions.app/Contents/MacOS/qiuya-session-window')),
          previewTitle: 'QiuYaTools · 电脑操控' })
        await writeFile(join(output, 'mac-preview-owned-binding.json'), JSON.stringify(bound, null, 2))
        macPreview = (op, extra = {}) => request({ op, binding: bound.binding, diagnosticOutput: join(output, 'mac-preview-physical-hit.json'), ...extra })
        macPreviewRetirement = () => macPreview('retirement')
        // AX may publish the buttons before a first frame and omit WebKit's
        // small metrics text entirely. Keep the same visible latency oracle
        // as the non-manual path, from this exact owned window's footer pixels.
        const attempts = []
        let view
        try { view = await waitForOwnedMacPreview(() => macPreview('observe', { output: previewPath }), { onAttempt: value => attempts.push(value) }) }
        finally { await writeFile(join(output, 'mac-preview-readiness-attempts.json'), JSON.stringify(attempts, null, 2)) }
        preview = { ...view, id: bound.binding.previewWindowId, pid: bound.binding.preview.pid, accessibility: view.labels }
      } else {
        observer = join(temporary, 'harness-window-evidence')
        await nativeCommand('/usr/bin/swiftc', ['-parse-as-library', '-framework', 'AppKit', '-framework', 'ScreenCaptureKit', '-framework', 'Vision', join(root, 'src/native/macos/fixtures/HarnessWindowEvidence.swift'), '-o', observer])
        await sleep(1500)
        preview = JSON.parse(await nativeCommand(observer, ['QiuYaTools · 电脑操控', previewPath]))
      }
      await writeFile(join(output, 'floating-preview-evidence.json'), JSON.stringify(preview, null, 2))
      const text = [...preview.accessibility, ...preview.recognizedText].join('\n')
      for (const label of ['暂停', '接管', '继续', '停止']) assert.ok(text.includes(label), `The actual floating preview must expose ${label}`)
      assert.ok(!text.includes('unauthorized'), 'The floating preview must complete the real Harness owner-cookie bootstrap')
      assert.match(text, /\d+\s*ms/u, 'The live preview must display a successful frame latency, not just an empty image element')
      assert.equal(nativeStatus.preview.httpStatus, 200)
    } else {
      preview = await waitFor(async () => (await driver.targets()).find(target => target.title.startsWith('QiuYaTools · 电脑操控') && target.appId.toLowerCase().startsWith(profileHome.toLowerCase() + '\\')), 'Native floating preview did not appear')
      const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
      const windowStages = []
      observeWindowState = async stage => {
        const snapshot = JSON.parse(await nativeCommand(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'tests/fixtures/harness-window-state-windows.ps1'), '-WindowId', preview.id, '-ProfileRoot', profileHome]))
        const observation = { stage, target: preview, ...snapshot }
        windowStages.push(observation)
        await writeFile(join(output, `preview-window-${stage}.json`), JSON.stringify(observation, null, 2))
        return observation
      }
      const firstWindowState = await observeWindowState('before-uia')
      if (!windowStateDiagnostic) assert.equal(firstWindowState.state.window.topmost, true, 'The native floating preview must already be TOPMOST before the first UIA observation')
      windowsPreview = (button, options = []) => nativeCommand(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'tests/fixtures/harness-preview-windows.ps1'), '-WindowId', preview.id, ...(button ? ['-Button', button] : []), ...options])
      // WebView2 enables its renderer accessibility tree after the first UIA
      // client arrives. Wait for the actual controls and successful frame.
      let controls
      const attempts = []
      for (let attempt = 0; attempt < 3; attempt++) {
        controls = JSON.parse(await windowsPreview())
        attempts.push(controls)
        const text = controls.labels.join('\n')
        if (['暂停', '接管', '继续', '停止', '实时电脑画面'].every(label => text.includes(label)) && /\d+\s*ms/u.test(text)) break
        await sleep(750)
      }
      await writeFile(join(output, 'floating-preview-uia-attempts.json'), JSON.stringify(attempts, null, 2))
      await writeFile(join(output, 'floating-preview-evidence.json'), JSON.stringify(controls, null, 2))
      if (windowStateDiagnostic) await observeWindowState('after-uia')
      const previewImage = await driver.observe(preview.id)
      await writeFile(previewPath, Buffer.from(previewImage.imageBase64, 'base64'))
      if (windowStateDiagnostic) await observeWindowState('after-native-observe')
      const text = controls.labels.join('\n')
      for (const label of ['暂停', '接管', '继续', '停止', '实时电脑画面']) assert.ok(text.includes(label), `The actual floating preview must expose ${label}`)
      assert.ok(!text.includes('unauthorized'), 'The floating preview must complete the real Harness owner-cookie bootstrap')
      assert.match(text, /\d+\s*ms/u, 'The live preview must display a successful frame latency')
      if (windowStateDiagnostic) {
        diagnosticComplete = true
        return { diagnostic: true, timeline: JSON.parse(await readFile(join(output, 'preview-window-timeline.json'), 'utf8')), stages: windowStages, boundary: 'The pre-click 10ms Win32 timeline and three read-only preview phases follow the first eight UI prerequisites and real main-Agent Move; no preview controls/manual actions or later cases are run.' }
      }
    }
    const computerSnapshot = () => page.evaluate(async sessionId => {
      const response = await fetch('/api/qiuya-tools.computer.control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'qiuya-tools.computer.control', payload: { op: 'status', sessionId } }) })
      const result = (await response.json()).result
      if (!response.ok || !result.ok) throw new Error('The owned computer status failed')
      return { session: result.value.sessions.find(value => value.sessionId === sessionId), native: result.value.native }
    }, alphaId)
    const controlSteps = macPreview ? [['暂停', 'paused'], ['继续', 'ready'], ['接管', 'humanControl'], ['继续', 'ready'], ['暂停', 'paused'], ['停止', 'stopped'], ['停止', 'stopped']] : [['暂停', 'paused'], ['继续', 'ready'], ['接管', 'humanControl'], ['停止', 'stopped']]
    const macLifecycle = [], beforeRetirement = [], controlStateEvidence = []
    for (const [step, [button, state]] of controlSteps.entries()) {
      const previous = macPreview ? await computerSnapshot() : undefined
      if (macPreview) {
        const receipt = await macPreview('button', { label: button })
        assert.equal(receipt.pressed, true)
        await writeFile(join(output, `preview-control-${step}-${state}.json`), JSON.stringify(receipt, null, 2))
      } else if (observer) {
        const receipt = JSON.parse(await nativeCommand(observer, ['QiuYaTools · 电脑操控', imagePath(`preview-control-${state}.jpg`), button]))
        await writeFile(join(output, `preview-control-${state}.json`), JSON.stringify(receipt, null, 2))
      }
      else {
        const receipt = JSON.parse(await windowsPreview(button))
        assert.equal(receipt.pressed, true)
        await writeFile(join(output, `preview-control-${state}.json`), JSON.stringify(receipt, null, 2))
      }
      try {
        await waitFor(async () => {
          const backend = await computerSnapshot()
          // A successful Stop removes this terminal task from Settings. Read
          // the public DOM without an element auto-wait, then require both the
          // backend transition and the intended visible list lifecycle.
          const tasks = await page.evaluate(sessionId => [...document.querySelectorAll('[data-qyt-computer-session]')].filter(node => node.getAttribute('data-qyt-computer-session') === sessionId).map(node => node.getAttribute('data-state')), alphaId)
          const current = { step, button, expectedState: state, settingsVisible: await page.getByRole('heading', { name: 'QiuYa 增强工具箱', exact: true }).isVisible(), backendState: backend.session?.state ?? null, taskCount: tasks.length, taskState: tasks.length === 1 ? tasks[0] : null }
          const previous = controlStateEvidence.at(-1)
          if (JSON.stringify(previous) !== JSON.stringify(current)) controlStateEvidence.push(current)
          return matchesHarnessPreviewControlState(current, state)
        }, `Computer ${button} did not enter ${state} with the expected public task lifecycle`)
        await writeFile(join(output, 'preview-control-state-lifecycle.json'), JSON.stringify(controlStateEvidence, null, 2))
        if (state === 'stopped') {
          const native = windowsPreview ? JSON.parse(await windowsPreview()) : macPreview ? await macPreview('observe', { output: imagePath(`preview-control-${step}-stopped.jpg`) }) : JSON.parse(await nativeCommand(observer, ['QiuYaTools · 电脑操控', imagePath(`preview-control-${step}-stopped.jpg`)]))
          const labels = [...(native.labels ?? []), ...(native.accessibility ?? []), ...(native.recognizedText ?? [])]
          assert.ok(labels.join('\n').includes('已停止'), 'The owned native preview must visibly acknowledge Stop')
          await writeFile(join(output, `preview-control-${step}-stopped-visible.json`), JSON.stringify({ labels, backendState: 'stopped', taskRemoved: true }, null, 2))
        }
      } catch (error) {
        // Preserve the actual backend state and native error before case cleanup
        // can change focus or pause the session. A timeout alone is not a cause.
        const backend = await page.evaluate(async sessionId => {
          const response = await fetch('/api/qiuya-tools.computer.control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'qiuya-tools.computer.control', payload: { op: 'status', sessionId } }) })
          return { httpStatus: response.status, body: await response.json() }
        }, alphaId).catch(failure => ({ error: failure.message }))
        const native = windowsPreview ? await windowsPreview().then(JSON.parse).catch(failure => ({ error: failure.message })) : macPreview ? await macPreview('observe', { output: imagePath(`preview-control-${state}-failed.jpg`) }).catch(failure => ({ error: failure.message })) : undefined
        const panelText = await page.locator(`[data-qyt-computer-session="${alphaId}"]`).innerText().catch(failure => failure.message)
        await writeFile(join(output, `preview-control-${state}-failure.json`), JSON.stringify({ button, expectedState: state, error: sanitizeHarnessDiagnostic(error.message), backend, native, panelText }, null, 2))
        const pixels = windowsPreview ? await driver.observe(preview.id).catch(() => undefined) : undefined
        if (pixels) await writeFile(imagePath(`preview-control-${state}-failed.jpg`), Buffer.from(pixels.imageBase64, 'base64'))
        throw error
      }
      if (macPreview) {
        const current = await computerSnapshot()
        macLifecycle.push({ step, button, previous, current })
        if (state === 'stopped') {
          assert.equal(current.native.inputState.mouseHeld, false)
          assert.equal(current.native.inputState.keysHeld, 0)
          assert.equal(current.native.inputState.leftButtonDown, false)
          if (previous.session.state === 'stopped') {
            assert.equal(current.session.epoch, previous.session.epoch, 'Repeated Stop must not create another control epoch')
            assert.deepEqual(current.session.lastAction, previous.session.lastAction, 'Repeated Stop must not replay target input')
          }
          beforeRetirement.push(current)
        }
        await writeFile(join(output, 'mac-preview-control-lifecycle.json'), JSON.stringify(macLifecycle, null, 2))
      }
      if (state === 'humanControl' && (windowsPreview || macPreview) && process.argv.includes('--manual-preview-e2e')) {
        const marker = `E2E:manual-preview-${suffix}-你好`
        const evidence = { marker, mouseSource: macPreview ? 'CGEvent HID tap OS-synthetic; not hardware' : 'Win32 SendInput OS-synthetic; not Parallels hardware', receipts: [], actions: [], states: [] }
        const completed = kind => waitFor(async () => {
          const current = await page.evaluate(async sessionId => {
            const response = await fetch('/api/qiuya-tools.computer.control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'qiuya-tools.computer.control', payload: { op: 'status', sessionId } }) })
            return (await response.json()).result.value.sessions.find(value => value.sessionId === sessionId)
          }, alphaId)
          const previous = evidence.states.at(-1)
          if (JSON.stringify(previous) !== JSON.stringify(current)) evidence.states.push(current)
          if (current?.lastAction?.action.kind === kind && current.lastAction.phase === 'failed') throw new Error(`The real native preview ${kind} failed: ${current.error?.code ?? ''} ${current.error?.message ?? ''}`)
          return current?.lastAction?.phase === 'completed' && current.lastAction.action.kind === kind ? current.lastAction : undefined
        }, `The real native preview ${kind} did not complete`)
        try {
          evidence.receipts.push(macPreview ? await macPreview('click-composer') : JSON.parse(await windowsPreview('', ['-Operation', 'click-image', '-ImageLabel', '实时电脑画面', '-X', '0.5', '-Y', '0.85'])))
          evidence.actions.push(await completed('click'))
          if (observeWindowState) {
            const afterTargetClick = await observeWindowState('after-manual-target-click')
            assert.equal(afterTargetClick.state.window.topmost, true, 'The native floating preview must remain TOPMOST after the completed target click')
          }
          const footer = macPreview ? await macPreview('type-footer', { text: marker }) : JSON.parse(await windowsPreview('', ['-Operation', 'set-text', '-TextLabel', '接管后输入文字', '-Text', marker]))
          evidence.receipts.push(footer)
          assert.equal(macPreview ? footer.click?.clicked : footer.clicked, true, 'The user must actually activate the own preview footer before typing')
          assert.equal(footer.textValue, marker)
          evidence.receipts.push(macPreview ? await macPreview('button', { label: '输入' }) : JSON.parse(await windowsPreview('输入', ['-MouseButton'])))
          evidence.actions.push(await completed('type'))
          evidence.receipts.push(macPreview ? await macPreview('button', { label: 'Enter' }) : JSON.parse(await windowsPreview('Enter', ['-MouseButton'])))
          evidence.actions.push(await completed('key'))
          await page.getByText(`已完成本地测试回复：${marker}`, { exact: true }).waitFor({ timeout: 20000 })
          if (macPreview) {
            const delivered = (await readFile(join(profileHome, 'e2e-adapter-requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse).filter(record => record.sessionId === alphaId && record.marker === marker && record.purpose === null)
            assert.equal(delivered.length, 1, 'The independent fixture provider must receive exactly one actual Chinese prompt after the native preview Enter')
            evidence.providerReceipts = delivered
          }
          evidence.actualTargetSubmission = true
          const after = await driver.observe(independentTarget.id)
          await writeFile(imagePath('manual-preview-target-result.jpg'), Buffer.from(after.imageBase64, 'base64'))
          if (macPreview) await macPreview('observe', { output: imagePath('manual-preview-window.jpg') })
          else { const floatingAfter = await driver.observe(preview.id); await writeFile(imagePath('manual-preview-window.jpg'), Buffer.from(floatingAfter.imageBase64, 'base64')) }
        } finally {
          if (!evidence.actualTargetSubmission) {
            evidence.failurePreview = macPreview ? await macPreview('observe', { output: imagePath('manual-preview-failed-floating.jpg') }).catch(error => ({ error: sanitizeHarnessDiagnostic(error.message) })) : await windowsPreview().then(JSON.parse).catch(error => ({ error: sanitizeHarnessDiagnostic(error.message) }))
            for (const [name, targetId] of [['target', independentTarget.id], ...macPreview ? [] : [['floating', preview.id]]]) {
              const failed = await driver.observe(targetId).catch(() => undefined)
              if (failed) await writeFile(imagePath(`manual-preview-failed-${name}.jpg`), Buffer.from(failed.imageBase64, 'base64'))
            }
          }
          await writeFile(join(output, 'manual-preview-input-evidence.json'), JSON.stringify(evidence, null, 2))
        }
      }
    }
    if (macPreview) {
      const closed = await macPreview('close'), repeated = await macPreview('close')
      assert.equal(closed.closed, true); assert.equal(repeated.closed, true); assert.equal(repeated.alreadyClosed, true)
      const after = await computerSnapshot(), stopped = beforeRetirement.at(-1)
      assert.equal(after.session.state, 'stopped'); assert.equal(after.session.epoch, stopped.session.epoch)
      assert.deepEqual(after.session.lastAction, stopped.session.lastAction)
      assert.equal(after.native.inputState.mouseHeld, false); assert.equal(after.native.inputState.keysHeld, 0); assert.equal(after.native.inputState.leftButtonDown, false)
      await writeFile(join(output, 'mac-preview-natural-retirement.json'), JSON.stringify({ closed, repeated, after, noKillOrSignal: true, note: 'The NSPanel closes naturally; the native companion remains owned by this live Host until Host disposal.' }, null, 2))
    }
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    return { preview, adapterRequestsWithImages: images.length, imageBlocks: images.flatMap(request => request.imageBlocks).length,
      model: 'Local deterministic adapter verifies actual main-Agent image transport, not external vision reasoning' }
  })
  if (!computerPipelinePassed) {
    // Preserve the original failed result. Cancel only its own main Agent and
    // revoke only its own computer task before another case can send input.
    const cleanup = { sessionId: alphaId, passed: false, samples: [], inputEventsPosted: 0 }
    try {
      cleanup.started = await page.evaluate(async sessionId => {
        const rpc = async (method, payload) => {
          const rpcId = crypto.randomUUID(), response = await fetch('/api/' + method, { method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId, method, payload }) })
          const envelope = await response.json()
          if (!response.ok || envelope.rpcId !== rpcId || envelope.result?.ok !== true) throw new Error('Own failed computer cleanup RPC failed')
          return envelope.result.value
        }
        await rpc('session/cancel', { args: { request: { sessionId } } })
        const before = await rpc('qiuya-tools.computer.control', { op: 'status', sessionId })
        const started = before.sessions.some(row => row.sessionId === sessionId)
        for (const request of before.pendingRequests.filter(row => row.sessionId === sessionId)) await rpc('qiuya-tools.computer.control', { op: 'cancelRequest', sessionId, requestId: request.requestId, requestVersion: request.requestVersion })
        if (started) await rpc('qiuya-tools.computer.control', { op: 'stop', sessionId })
        return started
      }, alphaId)
      let stableDrained = 0
      await waitFor(async () => {
        const value = await page.evaluate(async sessionId => {
          const own = await fetch('/api/qiuya-e2e-owned-agent', { method: 'POST', signal: AbortSignal.timeout(5000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }) })
          if (!own.ok) throw new Error('Owned Agent drain could not be read')
          const agent = await own.json()
          const response = await fetch('/api/qiuya-tools.computer.control', { method: 'POST', signal: AbortSignal.timeout(5000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'qiuya-tools.computer.control', payload: { op: 'status', sessionId } }) })
          const envelope = await response.json()
          if (!response.ok || envelope.result?.ok !== true) throw new Error('Owned computer drain could not be read')
          const value = envelope.result.value, computer = value.sessions.find(row => row.sessionId === sessionId)
          return { agent, computer: computer ? { sessionId: computer.sessionId, state: computer.state } : null, pending: value.pendingRequests.filter(row => row.sessionId === sessionId).length,
            input: value.native?.inputState ?? null, leaseEpoch: value.native?.leaseEpoch ?? null }
        }, alphaId)
        if (cleanup.samples.length < 160) cleanup.samples.push(value)
        stableDrained = harnessFailedComputerDrained(value, alphaId, cleanup.started) ? stableDrained + 1 : 0
        return stableDrained >= 2
      }, 'The failed computer case did not drain its own Agent/queue and stop its own task', 15000)
      if (process.platform === 'win32') {
        cleanup.os = JSON.parse(await nativeCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'tests/fixtures/harness-input-state-windows.ps1')]))
        assert.deepEqual(cleanup.os.heldKeys, []); assert.equal(cleanup.os.leaseLockFree, true); assert.equal(cleanup.os.journalPresent, false)
      } else {
        const last = cleanup.samples.at(-1)
        if (!cleanup.started) { const current = await driver.status(); last.input = current.inputState; last.leaseEpoch = current.leaseEpoch ?? null }
        assert.equal(last.input?.mouseHeld, false); assert.equal(last.input?.keysHeld, 0); assert.equal(last.input?.leftButtonDown, false); assert.equal(last.leaseEpoch, null)
      }
      cleanup.passed = true
    } finally { await writeFile(join(output, 'failed-computer-owned-cleanup.json'), JSON.stringify(cleanup, null, 2)) }
  }
  if (windowStateDiagnostic) throw new PreviewWindowDiagnosticStop()
  await test('batch-archive-real-sessions', async () => {
    await writeFile(join(profileHome, 'e2e-feature-target.json'), JSON.stringify(featureBinding), { mode: 0o600 })
    const before = await ownFeatureEvidence('archive'); let after
    try {
    await row(beta).click(); await row(gamma).click({ modifiers: ['Shift'] })
    await row(beta).click({ button: 'right' })
    await page.getByRole('menuitem', { name: /归档所选|归档.*2|批量归档/u }).first().click()
    await waitFor(async () => (await row(beta).count()) === 0 && (await row(gamma).count()) === 0, 'Selected real sessions were not archived')
    await waitFor(async () => { after = await ownFeatureEvidence('archive'); return archiveCollectionEvidence(before, after).passed }, 'The exact Host archive set did not add only Beta/Gamma and preserve Alpha')
    assert.equal(await row(alpha).count(), 1, 'Alpha must remain visible after the exact batch archive')
    await screenshot('archived')
    return archiveCollectionEvidence(before, after)
    } finally { await writeFile(join(output, 'archive-exact-collection-evidence.json'), JSON.stringify({ before, after, result: archiveCollectionEvidence(before, after) }, null, 2)) }
  })
  await test('plan-review-comment-and-draft-preservation', async () => {
    const planSessionId = await blankSession()
    await editor().fill('/plan on'); await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await waitFor(async () => (await page.locator('body').innerText()).includes('计划模式已开启') || (await page.getByRole('button', { name: /计划模式已开启/u }).count()) > 0, 'Plan mode did not activate')
    await editor().fill('E2E:plan'); await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await sleep(100)
    await editor().fill('E2E original draft must survive')
    await page.locator('[data-plan-review-surface]').waitFor({ timeout: 15000 })
    const paragraph = page.locator('[data-rightbar-col]').getByText('检查真实会话和插件菜单。', { exact: true }).first()
    await paragraph.waitFor(); await paragraph.evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })) })
    const quote = '检查真实会话和插件菜单。', note = 'E2E 请增加真实回归测试'
    await page.getByPlaceholder('输入评论…').fill(note)
    await page.getByRole('button', { name: '保存', exact: true }).click()
    const saved = page.locator('[data-plan-comment-item]').filter({ hasText: note })
    await saved.waitFor(); assert.ok((await saved.innerText()).includes(quote))
    await screenshot('plan-comment-saved')
    await writeFile(join(profileHome, 'e2e-feature-target.json'), JSON.stringify({ ...featureBinding, plan: { sessionId: planSessionId, expectedText: fixturePlanRevisionText(quote, note), quote, note } }), { mode: 0o600 })
    const before = await ownFeatureEvidence('plan'); let after
    try {
    await page.getByRole('button', { name: '修正计划', exact: true }).click()
    await waitFor(async () => { after = await ownFeatureEvidence('plan'); return planRevisionEvidence(before, after).passed }, 'The complete revision was not received as a new ordinary user/message in the exact plan session')
    assert.equal(await editor().innerText(), 'E2E original draft must survive')
    await screenshot('plan-comments')
    return planRevisionEvidence(before, after)
    } finally { await writeFile(join(output, 'plan-revision-durable-evidence.json'), JSON.stringify({ before, after, result: planRevisionEvidence(before, after) }, null, 2)) }
  })
  if (process.argv.includes('--file-exchange-e2e')) await test('packaged-file-exchange-real-host-upload-download-and-no-overwrite', async () => {
    assert.ok(candidate, 'File exchange must use the exact installed candidate bundle')
    const bundled = await nativeCommand(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-xOf', resolve(candidate), 'package/lib/computer-agent.js'])
    const modulePath = join(temporary, 'candidate-computer-agent.mjs')
    await writeFile(modulePath, bundled)
    const { createComputerAgentServer } = await import(pathToFileURL(modulePath).href)
    const directory = join(temporary, 'manual-file-exchange'); await mkdir(directory)
    const calls = { status: 0, targets: 0, observe: 0, lease: 0, release: 0, act: 0, preview: 0 }
    const forbidden = name => async () => { calls[name]++; throw new Error('The file-only fixture forbids native ' + name) }
    // The final package supplies the actual authenticated HTTP/FS implementation.
    // This fixture grants no desktop lease or input capability to that server.
    const fileOnly = {
      async status() { calls.status++; return { available: true, permissions: {}, capabilities: { capture: false, input: false } } },
      async targets() { calls.targets++; return [] },
      observe: forbidden('observe'), lease: forbidden('lease'), release: forbidden('release'), act: forbidden('act'),
      openPreview: forbidden('preview'), closePreview: forbidden('preview'), async dispose() {},
    }
    const pairing = randomUUID() + randomUUID()
    const server = await createComputerAgentServer(fileOnly, { token: pairing, exchangeDirectory: directory })
    const evidence = { candidateSHA256, source: 'actual packaged server + real Harness SDK owner route + React file input + browser download',
      boundary: 'status/targets-only stub; no native screenshot, input, lease, or external model capability claimed', calls }
    try {
      await row(alpha).click(); await openSettings(); await page.getByRole('tab', { name: '电脑操控', exact: true }).click()
      const enable = page.getByRole('switch', { name: '启用电脑操控', exact: true }); if (!await enable.isChecked()) await enable.click()
      await page.locator('.qyt-computer-advanced > summary').click()
      await page.getByRole('combobox', { name: /^操作环境/u }).selectOption('remote')
      await page.getByLabel('配对地址', { exact: true }).fill(server.endpoint)
      await page.getByLabel('配对密钥', { exact: true }).fill(pairing)
      await page.getByRole('checkbox', { name: /允许连接受信任的私有网络/u }).check()
      await page.getByRole('button', { name: '连接当前聊天的环境', exact: true }).click()
      const pane = page.getByRole('heading', { name: '手动文件交换', exact: true }).locator('..')
      await pane.waitFor()
      await pane.getByRole('button', { name: '检查并刷新交换目录', exact: true }).click()
      const picker = pane.locator('input[type="file"]'); await picker.waitFor()
      const name = 'E2E-共享-你好-' + randomUUID().slice(0, 8) + '.bin', bytes = Buffer.alloc(8 * 1024 * 1024)
      for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 13 + 37) % 251
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      await picker.setInputFiles({ name, mimeType: 'application/octet-stream', buffer: bytes })
      await pane.getByText('文件已上传至远端专用交换目录。', { exact: true }).waitFor({ timeout: 60000 })
      assert.deepEqual(await readFile(join(directory, name)), bytes)
      const fileRow = pane.locator('p').filter({ hasText: name })
      const downloading = page.waitForEvent('download')
      await fileRow.getByRole('button', { name: '下载', exact: true }).click()
      const download = await downloading, saved = join(temporary, 'downloaded-file.bin')
      assert.equal(download.suggestedFilename(), name)
      await download.saveAs(saved)
      assert.deepEqual(await readFile(saved), bytes)
      await pane.getByText('文件已交给本机浏览器下载。', { exact: true }).waitFor()
      const replacement = Buffer.from(bytes); replacement[0] ^= 128
      await picker.setInputFiles({ name, mimeType: 'application/octet-stream', buffer: replacement })
      await pane.getByText(/已存在同名文件/u).waitFor()
      assert.deepEqual(await readFile(join(directory, name)), bytes)
      Object.assign(evidence, { name, size: bytes.length, sha256, uploadedBytesVerified: true, browserDownloadVerified: true, duplicateRejectedWithoutOverwrite: true })
      await screenshot('file-exchange-ui')
      await page.getByRole('combobox', { name: /^操作环境/u }).selectOption('local')
      await page.getByRole('button', { name: '连接当前聊天的环境', exact: true }).click()
      await waitFor(async () => await page.getByRole('heading', { name: '手动文件交换', exact: true }).count() === 0, 'The file-only remote environment did not disconnect')
      await page.getByLabel('设置', { exact: true }).getByRole('button', { name: '关闭', exact: true }).click()
      assert.ok(calls.status > 0)
      for (const key of ['observe', 'lease', 'release', 'act', 'preview']) assert.equal(calls[key], 0, 'File exchange must not invoke desktop ' + key)
      return { size: bytes.length, unicodeFilename: true, sha256, byteVerified: true, noOverwrite: true, nativeInputCalls: 0 }
    } finally {
      await server.close()
      await writeFile(join(output, 'file-exchange-ui-evidence.json'), JSON.stringify(evidence, null, 2))
    }
  })
  assert.equal(errors.length, 0, `Frontend errors: ${errors.join('; ')}`)
} catch (error) {
  if (error instanceof PreviewWindowDiagnosticStop) {
    console.log(`DIAGNOSTIC preview window phases ${diagnosticComplete ? 'completed' : 'stopped after a failure'}; UI12 acceptance was not run`)
  } else {
  tests.push({ name: 'runner', status: 'failed', error: sanitizeHarnessDiagnostic(error.message) }); console.log(`FAIL runner: ${sanitizeHarnessDiagnostic(error.message)}`)
  await screenshot('failed-runner').catch(() => {})
  const requests = await readFile(join(profileHome, 'e2e-adapter-requests.jsonl'), 'utf8').catch(() => '')
  if (requests) await writeFile(join(output, 'runner-adapter-requests.json'), JSON.stringify(requests.trim().split('\n').map(JSON.parse).slice(-40), null, 2))
  }
}
finally {
  await writeFile(join(output, 'session-window-rpc.json'), JSON.stringify(windowRpc, null, 2))
  if (process.platform === 'win32') {
    // A separately packaged diagnostic companion can emit sanitized native
    // presentation phases. Preserve them before shutting down this own Host;
    // the ordinary frozen candidate does not create this optional file.
    await copyFile(join(profileHome, 'native-zorder-trace.jsonl'), join(output, 'native-zorder-trace.jsonl')).catch(error => { if (error.code !== 'ENOENT') errors.push('Native presentation evidence could not be preserved: ' + sanitizeHarnessDiagnostic(error.message)) })
  }
  const ownedCleanupErrors = await finalizeHarnessOwnedResources([
    { name: 'observer-dispose', run: () => driver?.dispose() },
    { name: 'browser-close', run: () => browser?.close() },
    { name: 'host-shutdown', run: () => { host?.stdin.end(); host?.kill('SIGTERM') } },
  ])
  let forcedHostTermination = false
  if (host && macPreviewRetirement) await new Promise(resolve => {
    if (host.exitCode !== null || host.signalCode !== null) return resolve()
    const finish = () => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => { forcedHostTermination = true; host.kill('SIGKILL'); resolve() }, 3000)
    host.once('exit', finish)
  })
  else if (host) await Promise.race([new Promise(resolve => host.once('exit', resolve)), sleep(3000).then(() => host.kill('SIGKILL'))])
  if (macPreviewRetirement) {
    const start = Date.now(); let last, failure
    try {
      last = await waitFor(async () => {
        last = await macPreviewRetirement()
        return last.allRetired ? last : undefined
      }, 'The same owned Host/preview/session process identities did not retire after Host shutdown', 10000)
    } catch (error) { failure = sanitizeHarnessDiagnostic(error.message); errors.push(failure) }
    if (forcedHostTermination) errors.push('The owned Mac Host required SIGKILL instead of graceful retirement')
    await writeFile(join(output, 'mac-preview-process-retirement.json'), JSON.stringify({ elapsedMs: Date.now() - start, last, failure, forcedHostTermination, source: 'read-only proc_pidinfo exact PID + birth + executable; no signal or kill by this observer', boundary: 'Host receives the runner’s existing normal SIGTERM shutdown; helper processes are not directly killed by this oracle.' }, null, 2))
  }
  const diagnosticSucceeded = windowStateDiagnostic && diagnosticComplete && tests.every(test => ['passed', 'diagnostic'].includes(test.status)) && !errors.length && !ownedCleanupErrors.length
  const report = { status: diagnosticSucceeded ? 'diagnostic' : tests.length && tests.every(test => test.status === 'passed') && !errors.length && !ownedCleanupErrors.length ? 'passed' : 'failed', kind: windowStateDiagnostic ? 'official-Harness-preview-window-state-diagnostic' : featureEvidenceOnly ? 'official-Harness-feature-evidence-subset' : 'official-Harness-isolated-profile-real-browser', selection: featureEvidenceOnly ? { scope: pastedTextOnly ? 'strict-pasted-text-evidence' : 'strict-feature-evidence', selectedCases: [...featureEvidenceCases], fullUIAcceptance: false } : { scope: 'complete-configured-suite' }, platform: process.platform, architecture: process.arch, browserChannel: arg('--browser', 'chrome'), candidate: candidate ? resolve(candidate) : null, candidateSHA256, testedAt: new Date().toISOString(), tests, frontendErrors: errors, ownedCleanup: { passed: !ownedCleanupErrors.length, errors: ownedCleanupErrors }, screenshots, screenshotEvidence: await imageLayout.manifest(), profileIsolation: true, model: 'deterministic local fixture, no real account credentials', limitations: ['Paste input is a browser ClipboardEvent; system clipboard API is spied inside the disposable browser to avoid altering the user clipboard.', 'This runner validates plugin UI and Host integration; it does not measure 30-minute preview endurance or claim Windows execution when run on macOS.', 'The local adapter proves actual main-Agent tool/image transport. External vision-model reasoning and physical IME composition require separate evidence.', ...(windowStateDiagnostic ? ['Diagnostic mode stops after the three native window observations; preview controls, manual input, archive/plan and file-exchange acceptance are not run.'] : [])] }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  if (!process.argv.includes('--keep-profile')) await rm(temporary, { recursive: true, force: true })
  console.log(JSON.stringify({ status: report.status, tests: tests.map(({ name, status }) => ({ name, status })), report: join(output, 'report.json') }, null, 2))
  if (!['passed', 'diagnostic'].includes(report.status)) process.exitCode = 1
}
