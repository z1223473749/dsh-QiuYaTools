/** Real installed Harness + isolated profile + deterministic local model + Chrome. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const arg = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1] }
const output = resolve(arg('--output', 'artifacts/harness-e2e'))
const candidate = arg('--package')
const cli = JSON.parse(arg('--cli-json', JSON.stringify(['/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'])))
if (!Array.isArray(cli) || !cli.length || !cli.every(value => typeof value === 'string')) throw new Error('--cli-json must be a nonempty JSON array')
if (!candidate && !arg('--url')) throw new Error('Pass --package <candidate.tgz> or --url <isolated-fixture-URL>')
await mkdir(output, { recursive: true })
const candidateSHA256 = candidate ? createHash('sha256').update(await readFile(resolve(candidate))).digest('hex') : null
const temporary = await mkdtemp(join(tmpdir(), 'qiuya-harness-e2e-'))
const profileHome = join(temporary, 'qiuya-harness-home')
const env = { ...process.env, DSH_HOME: profileHome, QIUYA_HARNESS_E2E: '1' }
const tests = [], errors = [], screenshots = []
let host, browser, page, driver
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const execute = (args, timeoutMs = 120000) => new Promise((resolve, reject) => {
  const child = spawn(cli[0], [...cli.slice(1), ...args], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
  const timer = setTimeout(() => { child.kill(); reject(new Error('Isolated Harness command timed out')) }, timeoutMs)
  child.once('error', error => { clearTimeout(timer); reject(error) }); child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(output.replace(/([?&]token=)[^&\s]+/gu, '$1<redacted>').slice(-12000))) })
})
const nativeCommand = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''; child.stdout.on('data', chunk => { out += chunk }); child.stderr.on('data', chunk => { err += chunk })
  const timeout = setTimeout(() => { child.kill(); reject(new Error('Native evidence command timed out')) }, 30000)
  child.once('error', error => { clearTimeout(timeout); reject(error) })
  child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve(out) : reject(new Error(err || `${command} exited ${code}`)) })
})
async function screenshot(name) { const path = join(output, `${name}.png`); await page.screenshot({ path }); screenshots.push(path) }
async function test(name, operation) {
  const start = Date.now()
  try { const details = await operation(); tests.push({ name, status: 'passed', elapsedMs: Date.now() - start, ...(details ? { details } : {}) }); console.log(`PASS ${name}`); return true }
  catch (error) {
    tests.push({ name, status: 'failed', elapsedMs: Date.now() - start, error: error.message })
    await screenshot(`failed-${tests.length}`).catch(() => {})
    // A failure inside Settings must not leave its modal covering later cases.
    const close = page?.getByRole('button', { name: '关闭', exact: true })
    if (await close?.isVisible().catch(() => false)) await close.click().catch(() => {})
    await page?.keyboard.press('Escape').catch(() => {})
    console.log(`FAIL ${name}: ${error.message}`); return false
  }
}
async function waitFor(predicate, message, milliseconds = 15000) {
  const until = Date.now() + milliseconds
  while (Date.now() < until) { const result = await predicate(); if (result) return result; await sleep(100) }
  throw new Error(message)
}
const editor = () => page.locator('[data-composer-input][contenteditable="true"]').first()
const row = label => page.locator('[data-row-key^="session:"]').filter({ hasText: label }).first()
async function openSettings() {
  await page.getByRole('button', { name: '账号菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: 'QiuYaTools', exact: true }).click()
  await page.getByRole('heading', { name: 'QiuYa 增强工具箱', exact: true }).waitFor()
}
async function newSession(label) {
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
  // The public action asynchronously opens its blank Session and restores its
  // editor. Wait for that transition before simulating the human's first text.
  await sleep(450)
  await editor().fill(label); await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await page.getByText(`已完成本地测试回复：${label}`, { exact: true }).waitFor({ timeout: 15000 })
  await row(label).waitFor()
  return (await row(label).getAttribute('data-row-key')).slice('session:'.length)
}
async function menu(label) { await row(label).click({ button: 'right' }); await page.getByRole('menuitem', { name: '复制会话标题', exact: true }).waitFor() }
try {
  let url = arg('--url')
  if (!url) {
    await execute(['--profile', 'web', '--dump-config'])
    await execute(['plugin', '--profile', 'web', 'add', resolve(candidate)])
    assert.equal(createHash('sha256').update(await readFile(resolve(candidate))).digest('hex'), candidateSHA256, 'The candidate changed while Harness was installing it')
    const fixture = join(temporary, 'provider'); await mkdir(fixture)
    await copyFile(join(root, 'tests/fixtures/harness-e2e-provider.mjs'), join(fixture, 'index.mjs'))
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
    url = await waitFor(() => { if (exited) throw new Error(log.replace(/([?&]token=)[^&\s]+/gu, '$1<redacted>')); return log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/u)?.[0] }, 'Isolated Harness did not start', 45000)
    await writeFile(join(output, 'host-startup.log'), log.replace(/([?&]token=)[^&\s]+/gu, '$1<redacted>'))
  }
  browser = await chromium.launch({ channel: arg('--browser', 'chrome'), headless: !process.argv.includes('--headed') })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  // The isolated browser owns this API spy; the user's system clipboard is never read or changed.
  await context.addInitScript(() => { window.__e2eClipboard = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText(text) { window.__e2eClipboard = text } } }) })
  await context.route('**/*', route => { const requestURL = new URL(route.request().url()); return ['http:', 'https:'].includes(requestURL.protocol) && !['127.0.0.1', 'localhost'].includes(requestURL.hostname) ? route.abort() : route.continue() })
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(15000)
  await page.goto(url)
  const onboarding = page.getByRole('button', { name: '继续', exact: true })
  await onboarding.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})
  if (await onboarding.isVisible()) await onboarding.click()
  await page.getByRole('button', { name: '账号菜单', exact: true }).waitFor()
  const suffix = Date.now().toString(36), alpha = `E2E:Alpha-${suffix}`, beta = `E2E:Beta-${suffix}`, gamma = `E2E:Gamma-${suffix}`
  await test('account-menu-settings-and-all-feature-tabs', async () => {
    await openSettings()
    for (const label of ['长文本', '独立窗口', '批量归档', '计划批注', '会话菜单', '提示词', 'Q 主题', '关于我们', '版本更新', '电脑操控']) await page.getByRole('tab', { name: label, exact: true }).waitFor()
    await screenshot('settings')
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
    const payload = 'E2E attachment line 1\nline 2\nline 3\nline 4\n' + '保留原始文本。'.repeat(15)
    await editor().evaluate((element, text) => { const data = new DataTransfer(); data.setData('text/plain', text); element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })) }, payload)
    await page.getByText(/粘贴文本-.*\.txt/u).first().waitFor()
    assert.equal((await editor().innerText()).trim(), '')
    await screenshot('pasted-txt')
    const remove = page.getByRole('button', { name: /移除|删除附件/u }).first()
    if (await remove.isVisible()) await remove.click(); else await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
    return { input: 'browser ClipboardEvent', path: 'actual Harness attachment intake and upload UI' }
  })
  await newSession(beta); await newSession(gamma)
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
    const executable = arg('--native', process.platform === 'darwin' ? join(root, 'lib/QiuYaTools Computer.app/Contents/MacOS/qiuya-computer') : join(root, `lib/native/win32-${process.arch}/qiuya-windows.exe`))
    driver = new NativeCompanionDriver({ executable, args: process.platform === 'win32' ? ['--computer'] : [] })
    await menu(alpha); await page.getByRole('menuitem', { name: '新窗口打开', exact: true }).click()
    const target = await waitFor(async () => (await driver.targets()).find(target => target.title.includes(alpha)), 'Native session window did not appear', 35000)
    independentTarget = target
    const observation = await driver.observe(target.id)
    await writeFile(join(output, 'independent-window.jpg'), Buffer.from(observation.imageBase64, 'base64'))
    assert.ok(observation.elements.includes(alpha), 'The independent WebKit/Windows window should expose the exact target session')
    await menu(alpha); await page.getByRole('menuitem', { name: '新窗口打开', exact: true }).click(); await sleep(500)
    const second = (await driver.targets()).filter(target => target.title.includes(alpha))
    assert.equal(second.length, 1); assert.equal(second[0].id, target.id)
    return { targetId: target.id, pid: target.pid, screenshotWidth: observation.width }
  })
  await test('computer-main-agent-tools-and-image-adapter-pipeline', async () => {
    assert.ok(independentTarget && alphaId, 'The fixture session window must exist before computer control')
    await row(alpha).click(); await sleep(300); await openSettings()
    await page.getByRole('tab', { name: '电脑操控', exact: true }).click()
    const enable = page.getByRole('checkbox', { name: '启用', exact: true })
    if (!await enable.isChecked()) await enable.click()
    await waitFor(() => enable.isChecked(), 'Computer-use setting did not persist')
    await page.getByRole('button', { name: '刷新窗口', exact: true }).click()
    await page.getByRole('combobox', { name: /^关联聊天/u }).selectOption(alphaId)
    await page.getByRole('combobox', { name: /^应用窗口/u }).selectOption(independentTarget.id)
    await page.getByRole('button', { name: '允许本次并开始', exact: true }).click()
    await waitFor(async () => (await page.locator('.qyt-feature-panel [role="status"]').innerText()).includes('ready'), 'Computer session did not become ready')
    await screenshot('computer-authorized')
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await editor().fill('E2E:computer-move'); await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await page.getByText(/E2E_ADAPTER_IMAGE_CONFIRMED:/u).waitFor({ timeout: 25000 })
    const requests = (await readFile(join(profileHome, 'e2e-adapter-requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    const images = requests.filter(request => request.sessionId === alphaId && request.marker === 'E2E:computer-move' && request.imageBlocks.length > 0)
    assert.ok(images.length, 'The main Agent adapter must actually receive image blocks after the computer tool')
    assert.ok(images.flatMap(request => request.imageBlocks).every(image => image.attachmentId && image.width > 0 && image.height > 0))
    assert.ok(images.flatMap(request => request.actionResults).some(result => result?.performed), 'The main Agent must receive a successful native move-action receipt')
    await writeFile(join(output, 'agent-image-adapter-evidence.json'), JSON.stringify(images, null, 2))
    await screenshot('agent-computer-image')
    await openSettings(); await page.getByRole('tab', { name: '电脑操控', exact: true }).click()
    await page.getByRole('button', { name: '悬浮实时预览', exact: true }).click()
    await sleep(1000)
    const nativeStatus = await page.evaluate(async sessionId => {
      const response = await fetch('/api/qiuya-tools.computer.control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'qiuya-tools.computer.control', payload: { op: 'status', sessionId } }) })
      return (await response.json()).result.value.native
    }, alphaId)
    await writeFile(join(output, 'preview-native-status.json'), JSON.stringify(nativeStatus, null, 2))
    const previewPath = join(output, 'floating-computer-preview.jpg')
    let preview, observer, windowsPreview
    if (process.platform === 'darwin') {
      observer = join(temporary, 'harness-window-evidence')
      await nativeCommand('/usr/bin/swiftc', ['-parse-as-library', '-framework', 'AppKit', '-framework', 'ScreenCaptureKit', '-framework', 'Vision', join(root, 'src/native/macos/fixtures/HarnessWindowEvidence.swift'), '-o', observer])
      await sleep(1500)
      preview = JSON.parse(await nativeCommand(observer, ['QiuYaTools · 电脑操控', previewPath]))
      await writeFile(join(output, 'floating-preview-evidence.json'), JSON.stringify(preview, null, 2))
      const text = [...preview.accessibility, ...preview.recognizedText].join('\n')
      for (const label of ['暂停', '接管', '继续', '停止']) assert.ok(text.includes(label), `The actual floating preview must expose ${label}`)
      assert.ok(!text.includes('unauthorized'), 'The floating preview must complete the real Harness owner-cookie bootstrap')
      assert.match(text, /\d+\s*ms/u, 'The live preview must display a successful frame latency, not just an empty image element')
      assert.equal(nativeStatus.preview.httpStatus, 200)
    } else {
      preview = await waitFor(async () => (await driver.targets()).find(target => target.title.startsWith('QiuYaTools · 电脑操控')), 'Native floating preview did not appear')
      const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
      windowsPreview = button => nativeCommand(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'tests/fixtures/harness-preview-windows.ps1'), '-WindowId', preview.id, ...(button ? ['-Button', button] : [])])
      const controls = JSON.parse(await windowsPreview())
      await writeFile(join(output, 'floating-preview-evidence.json'), JSON.stringify(controls, null, 2))
      const previewImage = await driver.observe(preview.id)
      await writeFile(previewPath, Buffer.from(previewImage.imageBase64, 'base64'))
      const text = controls.labels.join('\n')
      for (const label of ['暂停', '接管', '继续', '停止', '实时电脑画面']) assert.ok(text.includes(label), `The actual floating preview must expose ${label}`)
      assert.ok(!text.includes('unauthorized'), 'The floating preview must complete the real Harness owner-cookie bootstrap')
      assert.match(text, /\d+\s*ms/u, 'The live preview must display a successful frame latency')
    }
    for (const [button, state] of [['暂停', 'paused'], ['继续', 'ready'], ['接管', 'humanControl'], ['停止', 'stopped']]) {
      if (observer) {
        const receipt = JSON.parse(await nativeCommand(observer, ['QiuYaTools · 电脑操控', join(output, `preview-control-${state}.jpg`), button]))
        await writeFile(join(output, `preview-control-${state}.json`), JSON.stringify(receipt, null, 2))
      }
      else await windowsPreview(button)
      await waitFor(async () => (await page.locator('.qyt-feature-panel [role="status"]').innerText()).includes(state), `Computer ${button} did not enter ${state}`)
    }
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    return { preview, adapterRequestsWithImages: images.length, imageBlocks: images.flatMap(request => request.imageBlocks).length,
      model: 'Local deterministic adapter verifies actual main-Agent image transport, not external vision reasoning' }
  })
  await test('batch-archive-real-sessions', async () => {
    await row(beta).click(); await row(gamma).click({ modifiers: ['Shift'] })
    await row(beta).click({ button: 'right' })
    await page.getByRole('menuitem', { name: /归档所选|归档.*2|批量归档/u }).first().click()
    await waitFor(async () => (await row(beta).count()) === 0 && (await row(gamma).count()) === 0, 'Selected real sessions were not archived')
    await screenshot('archived')
  })
  await test('plan-review-comment-and-draft-preservation', async () => {
    await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
    await sleep(450)
    await editor().fill('/plan on'); await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await waitFor(async () => (await page.locator('body').innerText()).includes('计划模式已开启') || (await page.getByRole('button', { name: /计划模式已开启/u }).count()) > 0, 'Plan mode did not activate')
    await editor().fill('E2E:plan'); await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await sleep(100)
    await editor().fill('E2E original draft must survive')
    await page.locator('[data-plan-review-surface]').waitFor({ timeout: 15000 })
    const paragraph = page.getByText('检查真实会话和插件菜单。', { exact: true }).last()
    await paragraph.waitFor(); await paragraph.evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })) })
    await page.getByPlaceholder('输入评论…').fill('E2E 请增加真实回归测试')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await page.getByRole('button', { name: '修正计划', exact: true }).click()
    await waitFor(async () => (await page.locator('body').innerText()).includes('E2E 请增加真实回归测试'), 'The revision did not enter the actual session')
    assert.equal(await editor().innerText(), 'E2E original draft must survive')
    await screenshot('plan-comments')
  })
  assert.equal(errors.length, 0, `Frontend errors: ${errors.join('; ')}`)
} catch (error) { tests.push({ name: 'runner', status: 'failed', error: error.message }); console.log(`FAIL runner: ${error.message}`) }
finally {
  await driver?.dispose(); await browser?.close(); host?.stdin.end(); host?.kill('SIGTERM')
  if (host) await Promise.race([new Promise(resolve => host.once('exit', resolve)), sleep(3000).then(() => host.kill('SIGKILL'))])
  const report = { status: tests.length && tests.every(test => test.status === 'passed') && !errors.length ? 'passed' : 'failed', kind: 'official-Harness-isolated-profile-real-browser', platform: process.platform, architecture: process.arch, browserChannel: arg('--browser', 'chrome'), candidate: candidate ? resolve(candidate) : null, candidateSHA256, testedAt: new Date().toISOString(), tests, frontendErrors: errors, screenshots, profileIsolation: true, model: 'deterministic local fixture, no real account credentials', limitations: ['Paste input is a browser ClipboardEvent; system clipboard API is spied inside the disposable browser to avoid altering the user clipboard.', 'This runner validates plugin UI and Host integration; it does not measure 30-minute preview endurance or claim Windows execution when run on macOS.', 'The local adapter proves actual main-Agent tool/image transport. External vision-model reasoning and physical IME composition require separate evidence.'] }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  if (!process.argv.includes('--keep-profile')) await rm(temporary, { recursive: true, force: true })
  console.log(JSON.stringify({ status: report.status, tests: tests.map(({ name, status }) => ({ name, status })), report: join(output, 'report.json') }, null, 2))
  if (report.status !== 'passed') process.exitCode = 1
}
