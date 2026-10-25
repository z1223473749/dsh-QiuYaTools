/** Real installed Harness application-picker acceptance in a disposable profile.
 * No model, desktop input, application launch, personal profile or OS settings.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
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
  console.log('node scripts/test-computer-application-picker.mjs --package candidate.tgz --output <outside-project-directory> [--cli-json \'["/path/to/dsh"]\'] [--browser chrome|msedge] [--runtime-root <dependency-root>]')
  process.exit(0)
}
const root = fileURLToPath(new URL('../', import.meta.url))
const packageArgument = argument('--package')
assert.ok(packageArgument, 'Pass --package <candidate.tgz>')
const candidate = resolve(packageArgument)
const output = resolve(argument('--output', join(tmpdir(), `qiuya-picker-report-${randomUUID()}`)))
const outputRelative = relative(root, output)
assert.ok(outputRelative && (outputRelative === '..' || outputRelative.startsWith(`..${sep}`) || isAbsolute(outputRelative)), 'Screenshots and reports must be outside the project')
const cli = JSON.parse(argument('--cli-json', JSON.stringify(['/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'])))
assert.ok(Array.isArray(cli) && cli.length && cli.every(value => typeof value === 'string' && value.length), '--cli-json must be a nonempty array of strings')
const channel = argument('--browser', process.platform === 'win32' ? 'msedge' : 'chrome')
assert.ok(['chrome', 'msedge'].includes(channel), '--browser must be chrome or msedge')
const runtimeRoot = resolve(argument('--runtime-root', root))
const runtimeRequire = createRequire(join(runtimeRoot, 'package.json'))
const { chromium } = runtimeRequire('playwright')
const sha256 = value => createHash('sha256').update(value).digest('hex')
const candidateSha256 = sha256(await readFile(candidate))
await mkdir(output, { recursive: true })
const temporary = await mkdtemp(join(tmpdir(), 'qiuya-application-picker-'))
const home = join(temporary, 'home'), profile = join(home, 'profiles', 'web')
const permissionPath = join(profile, 'qiuya-computer', 'permissions.json')
const env = { ...process.env, DSH_HOME: home }
const checks = [], screenshots = [], requests = [], pageErrors = [], rpcErrors = [], catalogReplies = []
const sleep = milliseconds => new Promise(done => setTimeout(done, milliseconds))
const redact = value => String(value).replace(/([?&]token=)[^&\s]+/gu, '$1<redacted>').replace(/(Bearer\s+)[^\s]+/giu, '$1<redacted>')
let host, browser, page, failure, cleanup = { browserClosed: false, hostStopped: false, temporaryRemoved: false }
let safeApplication, selectedAppSha256

async function command(args) {
  return new Promise((done, reject) => {
    const child = spawn(cli[0], [...cli.slice(1), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''; child.stdout.on('data', chunk => { log += chunk }); child.stderr.on('data', chunk => { log += chunk })
    const timer = setTimeout(() => { child.kill(); reject(new Error('Isolated official Harness command timed out')) }, 120000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); code === 0 ? done() : reject(new Error(redact(log).slice(-5000))) })
  })
}
async function permissions() {
  try {
    const value = JSON.parse(await readFile(permissionPath, 'utf8'))
    assert.ok(Array.isArray(value) && value.every(item => typeof item === 'string'), 'The isolated permission store must be an app-ID array')
    return value
  } catch (error) { if (error.code === 'ENOENT') return []; throw error }
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
const form = () => page.getByRole('form', { name: '添加持续授权应用', exact: true })
const search = () => form().getByRole('combobox', { name: '搜索应用', exact: true })
const list = () => form().getByRole('listbox', { name: '应用搜索结果', exact: true })
const allow = () => form().getByRole('button', { name: '始终允许', exact: true })
const region = () => page.getByRole('region', { name: '始终允许的应用', exact: true })
async function openPicker() {
  await region().getByRole('button', { name: '添加应用', exact: true }).click()
  await form().waitFor()
  await waitFor(() => search().evaluate(node => document.activeElement === node), 'Opening the picker must focus its search field')
}
function normalize(value) { return value.normalize('NFKC').toLocaleLowerCase().trim() }
const publicApplicationName = /^(?:Google Chrome|Chrome|Finder|Microsoft Edge|Notepad|记事本|TextEdit|文本编辑)(?:$|[ (])/u
async function safeScreenshot(name) {
  // Only the filtered picker is captured. Mask any surprising catalog match
  // rather than writing another installed personal application's identity.
  const rows = list().getByRole('option'), masks = []
  for (let index = 0; index < await rows.count(); index++) {
    if (!publicApplicationName.test((await rows.nth(index).locator('.qyt-application-name').textContent()).trim())) masks.push(rows.nth(index))
  }
  const path = join(output, `${name}.png`)
  await form().screenshot({ path, mask: masks, maskColor: '#879399' })
  screenshots.push({ name, path, scope: 'filtered-application-picker-only', maskedResults: masks.length })
}
async function assertNoAuthorization() {
  assert.deepEqual(await permissions(), [], 'Search, selection and cancel must never grant an application')
  assert.equal(requests.filter(request => request.op === 'allow').length, 0, 'A selection must not send an authorization RPC')
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
    await command(['--profile', 'web', '--dump-config'])
    await command(['plugin', '--profile', 'web', 'add', candidate])
    await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([{ id: 'qiuya-tools', config: { enabled: true, computerUseEnabled: true } }], null, 2) + '\n')
    assert.equal(sha256(await readFile(candidate)), candidateSha256)
    const metadata = JSON.parse(await readFile(join(profile, 'node_modules', 'dsh-qiuya-tools', 'package.json'), 'utf8'))
    assert.deepEqual(await permissions(), [])
    return { version: metadata.version, isolatedSettingsOnly: true, modelConfigured: false }
  })
  let hostLog = ''
  host = spawn(cli[0], [...cli.slice(1), '--profile', 'web', '--no-open', '--port', '0'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const append = chunk => { hostLog += chunk }; host.stdout.on('data', append); host.stderr.on('data', append)
  let hostError; host.once('error', error => { hostError = error })
  const url = await waitForHarnessHostUrl(() => ({ exited: Boolean(hostError) || host.exitCode !== null || host.signalCode !== null, error: redact(hostError?.message ?? hostLog).slice(-5000), url: hostLog.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/u)?.[0] }))
  await check('owner-cookie-bootstrap-and-installed-settings-page', async () => {
    const bootstrap = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
    assert.equal(bootstrap.status, 303)
    assert.ok(bootstrap.headers.getSetCookie().length, 'The actual Host must issue an owner cookie')
    browser = await chromium.launch({ channel, headless: true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' })
    await context.route('**/*', route => {
      const target = new URL(route.request().url())
      return ['http:', 'https:'].includes(target.protocol) && !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ? route.abort() : route.continue()
    })
    page = await context.newPage(); page.setDefaultTimeout(15000)
    page.on('pageerror', error => { pageErrors.push(redact(error.message)) })
    page.on('response', async response => {
      if (!new URL(response.url()).pathname.endsWith('/qiuya-tools.computer.control')) return
      try {
        const body = (await response.json()).result
        if (body?.ok === false) rpcErrors.push({ code: body.error?.code, message: redact(body.error?.message ?? 'RPC failed') })
        if (response.request().postDataJSON()?.payload?.op === 'applications') catalogReplies.push({ ok: body?.ok, count: Array.isArray(body?.value) ? body.value.length : null })
      } catch {}
    })
    page.on('request', request => {
      if (!new URL(request.url()).pathname.endsWith('/qiuya-tools.computer.control')) return
      let body; try { body = request.postDataJSON() } catch { return }
      const payload = body?.payload
      if (typeof payload?.op !== 'string') return
      requests.push({ op: payload.op, ...(typeof payload.allowed === 'boolean' ? { allowed: payload.allowed } : {}), ...(typeof payload.appId === 'string' ? { appIdSha256: sha256(payload.appId) } : {}) })
    })
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    const onboarding = page.getByRole('button', { name: '继续', exact: true }).first()
    await onboarding.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})
    if (await onboarding.isVisible()) await onboarding.click()
    const credentials = page.getByRole('dialog', { name: '添加一个 API Key 开始使用', exact: true }), account = page.getByRole('dialog', { name: '开始使用', exact: true })
    await credentials.or(account).waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
    if (await account.isVisible()) {
      await account.getByRole('button', { name: '关闭', exact: true }).click()
      await account.waitFor({ state: 'hidden' })
    } else if (await credentials.isVisible()) {
      await credentials.getByRole('button', { name: '稍后配置', exact: true }).click()
      await credentials.waitFor({ state: 'hidden' })
    }
    await page.getByRole('button', { name: '账号菜单', exact: true }).click()
    await page.getByRole('menuitem', { name: 'QiuYaTools', exact: true }).click()
    await page.getByRole('heading', { name: 'QiuYa 增强工具箱', exact: true }).waitFor()
    await page.getByRole('tab', { name: '电脑操控', exact: true }).click()
    const enabled = page.getByRole('switch', { name: '启用电脑操控', exact: true })
    assert.equal(await enabled.isChecked(), true)
    await openPicker()
    assert.ok(requests.some(request => request.op === 'applications'), 'The installed UI must request the real application catalog')
    return { browserChannel: channel, browserVersion: browser.version(), realInstalledHost: true, ownerCookieIssued: true }
  })
  await check('real-catalog-is-bounded-scrollable-and-has-no-native-select', async () => {
    assert.equal(await form().locator('select').count(), 0)
    const count = await list().getByRole('option').count()
    assert.ok(count > 6, 'The real installed catalog must contain enough entries to exercise scrolling')
    const dimensions = await list().evaluate(node => ({ clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, height: node.getBoundingClientRect().height, overflowY: getComputedStyle(node).overflowY }))
    assert.ok(dimensions.height > 0 && dimensions.height <= 237, 'Application results must remain within the 236 px list cap')
    assert.ok(dimensions.scrollHeight > dimensions.clientHeight, 'A long real application list must scroll internally')
    assert.ok(['auto', 'scroll'].includes(dimensions.overflowY))
    assert.ok(await list().evaluate(node => { node.scrollTop = node.scrollHeight; return node.scrollTop > 0 }))
    await list().evaluate(node => { node.scrollTop = 0 })
    const names = await list().locator('.qyt-application-name').allTextContents()
    const preferred = process.platform === 'win32' ? ['Microsoft Edge', 'Notepad', '记事本', 'Google Chrome', 'Chrome'] : ['Finder', 'Google Chrome', 'TextEdit', '文本编辑', 'Chrome']
    safeApplication = preferred.find(name => names.some(value => value.trim() === name))
    assert.ok(safeApplication, 'A known system test application is required for privacy-safe screenshots')
    await assertNoAuthorization()
    return { applicationCount: count, list: dimensions, internalScrollVerified: true, safeTestApplication: safeApplication }
  })
  await check('name-substring-search-empty-result-and-clear', async () => {
    const total = await list().getByRole('option').count()
    const term = safeApplication.length > 4 ? safeApplication.slice(1, -1).toUpperCase() : safeApplication.slice(1)
    await search().fill(term)
    const matched = await list().getByRole('option').count()
    assert.ok(matched > 0 && matched < total, 'A case-insensitive name substring must narrow the actual catalog')
    assert.ok((await list().locator('.qyt-application-name').allTextContents()).some(name => normalize(name) === normalize(safeApplication)))
    await search().fill(`QiuYa-No-Such-App-${randomUUID()}`)
    assert.equal(await list().getByRole('option').count(), 0)
    await form().getByRole('status').filter({ hasText: '未找到匹配的应用' }).waitFor()
    assert.equal(await allow().isDisabled(), true)
    await form().getByRole('button', { name: '清除搜索', exact: true }).click()
    assert.equal(await search().inputValue(), '')
    assert.equal(await list().getByRole('option').count(), total)
    assert.equal(await search().evaluate(node => document.activeElement === node), true)
    await assertNoAuthorization()
    return { substringSearch: true, caseInsensitive: true, emptyResult: true, clearRestoresCatalog: true }
  })
  await check('enter-selects-without-authorizing-and-escape-cancels', async () => {
    await search().fill(safeApplication)
    await search().press('ArrowDown')
    await search().press('Enter')
    assert.equal(await list().locator('[aria-selected="true"]').count(), 1)
    assert.equal(await allow().isEnabled(), true)
    await assertNoAuthorization()
    await search().press('Escape')
    await form().waitFor({ state: 'hidden' })
    await assertNoAuthorization()
    return { enterSelectsOnly: true, escapeCancels: true, persistentGrants: 0 }
  })
  await check('real-png-32px-application-icon-and-light-dark-filtered-screenshots', async () => {
    await openPicker(); await search().fill(safeApplication)
    await waitFor(() => list().locator('.qyt-application-icon img').evaluateAll(images => images.some(image => image.src.startsWith('data:image/png;base64,') && image.complete && image.naturalWidth === 32 && image.naturalHeight === 32)), 'The actual native application icon must decode as a 32 × 32 PNG')
    const colors = []
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme })
      await waitFor(() => page.evaluate(scheme => matchMedia(`(prefers-color-scheme: ${scheme})`).matches, colorScheme), 'The isolated renderer must apply the requested system color scheme')
      await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
      colors.push({ colorScheme, ...await form().evaluate(node => ({ background: getComputedStyle(node).backgroundColor, color: getComputedStyle(node).color })) })
      await safeScreenshot(`application-picker-${colorScheme}`)
    }
    assert.notEqual(colors[0].background, colors[1].background, 'The installed settings picker must visibly follow light and dark themes')
    await assertNoAuthorization()
    return { nativeIcon: { format: 'PNG', width: 32, height: 32, decodedInBrowser: true }, colors }
  })
  await check('narrow-installed-settings-picker-has-no-horizontal-overflow', async () => {
    await page.setViewportSize({ width: 800, height: 1000 })
    await form().scrollIntoViewIfNeeded()
    const layout = await form().evaluate(node => {
      const box = node.getBoundingClientRect(), descendants = [...node.querySelectorAll('input,button,[role="listbox"]')]
      return { left: box.left, right: box.right, width: box.width, viewport: innerWidth, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, overflowingControls: descendants.filter(item => { const rect = item.getBoundingClientRect(); return rect.left < box.left - 1 || rect.right > box.right + 1 }).length }
    })
    assert.ok(layout.left >= 0 && layout.right <= layout.viewport + 1, 'The picker must fit inside the narrow actual settings viewport')
    assert.ok(layout.scrollWidth <= layout.clientWidth + 1, 'The picker must not need horizontal scrolling')
    assert.equal(layout.overflowingControls, 0, 'Search and action controls must fit inside the picker')
    await safeScreenshot('application-picker-dark-narrow-800')
    await page.setViewportSize({ width: 1440, height: 1000 })
    return { viewport: { width: 800, height: 1000 }, layout }
  })
  await check('mouse-selection-requires-explicit-allow-and-can-be-revoked', async () => {
    await search().fill(safeApplication)
    const option = list().getByRole('option').filter({ has: page.getByText(safeApplication, { exact: true }) }).first()
    await option.click()
    assert.equal(await option.getAttribute('aria-selected'), 'true')
    await assertNoAuthorization()
    await safeScreenshot('application-picker-selected')
    await allow().click()
    await form().waitFor({ state: 'hidden' })
    const granted = await waitFor(async () => { const ids = await permissions(); return ids.length === 1 && ids }, 'Explicit Allow must persist exactly one isolated-profile grant')
    selectedAppSha256 = sha256(granted[0])
    assert.ok(requests.some(request => request.op === 'allow' && request.allowed === true && request.appIdSha256 === selectedAppSha256))
    const revoke = region().getByRole('button', { name: `撤销 ${safeApplication}`, exact: true })
    await revoke.waitFor()
    await revoke.click()
    await revoke.waitFor({ state: 'hidden' })
    await waitFor(async () => (await permissions()).length === 0, 'Revoke must remove the isolated-profile grant')
    assert.equal(requests.filter(request => request.op === 'allow').length, 2)
    assert.ok(requests.some(request => request.op === 'allow' && request.allowed === false && request.appIdSha256 === selectedAppSha256))
    return { mouseSelectionOnly: true, explicitAllow: true, revoked: true, finalPersistentGrants: 0, selectedAppSha256 }
  })
  await check('no-model-or-desktop-control-and-candidate-remains-unchanged', async () => {
    assert.deepEqual([...new Set(requests.map(request => request.op))].filter(op => !['status', 'applications', 'allow'].includes(op)), [], 'Picker acceptance may only read status/catalog and manage the isolated app grant')
    assert.deepEqual(await permissions(), [])
    assert.equal(pageErrors.length, 0, 'The actual installed renderer must have no JavaScript page errors')
    assert.deepEqual(rpcErrors, [], 'Every observed real control RPC must succeed')
    assert.equal(sha256(await readFile(candidate)), candidateSha256)
    return { desktopControlRequests: 0, applicationLaunchRequests: 0, modelConfigured: false, pageErrors: 0, unchangedCandidate: true }
  })
} catch (error) {
  failure = redact(error.message); process.exitCode = 1; console.error(failure)
  console.error(JSON.stringify({ pageErrors, rpcErrors, catalogReplies, pickerDiagnostic: await page?.locator('.qyt-computer-panel').evaluate(node => ({ forms: node.querySelectorAll('form').length, alerts: [...node.querySelectorAll('[role="alert"]')].map(item => item.textContent), buttons: [...node.querySelectorAll('button')].filter(item => item.textContent === '添加应用').map(item => ({ disabled: item.disabled })) })).catch(() => null) }))
}
finally {
  try { await browser?.close(); cleanup.browserClosed = true } catch (error) { failure ??= redact(error.message); process.exitCode = 1 }
  try { await stopOwnedHost(); cleanup.hostStopped = true } catch (error) { failure ??= redact(error.message); process.exitCode = 1 }
  if (cleanup.hostStopped) {
    try { await rm(temporary, { recursive: true, force: true }); cleanup.temporaryRemoved = true } catch (error) { failure ??= redact(error.message); process.exitCode = 1 }
  }
  await writeFile(join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', kind: 'official-Harness-installed-application-picker-disposable-profile', testedAt: new Date().toISOString(), platform: process.platform, architecture: process.arch, candidateSha256, browserChannel: channel, checks, screenshots, rpcErrors, rpcSummary: Object.fromEntries([...new Set(requests.map(request => request.op))].map(op => [op, requests.filter(request => request.op === op).length])), isolation: { disposableDSHHome: true, personalProfileTouched: false, systemPermissionsChanged: false, nativeInputSent: false, applicationLaunched: false, modelConfigured: false, externalBrowserNetworkBlocked: true, screenshotScope: 'filtered-picker-only-with-unexpected-app-identities-masked' }, cleanup, limitations: ['This focused acceptance exercises the installed Host, real application directory, browser PNG decoding and settings UI. It does not exercise desktop input or model-driven application control.'], ...(failure ? { reason: failure } : {}) }, null, 2) + '\n')
}
