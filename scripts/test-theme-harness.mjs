/** Theme-only checks against the installed official Harness in an isolated profile.
 * No real account, external model, desktop input or user workspace is used. */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import { build } from 'esbuild'
import { waitForHarnessHostUrl } from './harness-host-readiness.mjs'
import { registerHarnessWorkspace, captureHarnessWorkspaceDom, selectedHarnessWorkspaceSession } from '../tests/fixtures/harness-workspace-prerequisite.mjs'

const cli = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const candidate = resolve(process.argv[2] ?? 'artifacts/candidates/dsh-qiuya-tools-darwin-universal.tgz')
const output = resolve('artifacts/theme-harness')
await mkdir(output, { recursive: true })
const temporary = await mkdtemp(join(tmpdir(), 'qiuya-harness-theme-'))
const env = { ...process.env, DSH_HOME: join(temporary, 'home'), DSH_TELEMETRY_DISABLED: '1', QIUYA_HARNESS_E2E: '1' }
for (const key of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|PASSWORD/u.test(key)) delete env[key]
const command = promisify(execFile)
let host, browser, page, log = '', failure
const checks = [], screenshots = []
const snapshot = async name => { const filename = name + '.png'; await page.screenshot({ path: join(output, filename) }); screenshots.push(filename) }
const backdrop = async locator => locator.evaluate(element => {
  const style = getComputedStyle(element)
  return { art: style.backgroundImage.includes('data:image/'), attachment: style.backgroundAttachment, color: style.backgroundColor }
})
try {
  await command(cli, ['--profile', 'web', '--dump-config'], { env, maxBuffer: 2 ** 20 })
  await command(cli, ['plugin', '--profile', 'web', 'add', candidate], { env, maxBuffer: 2 ** 20 })
  const provider = join(temporary, 'provider'); await mkdir(provider)
  const model = await build({ entryPoints: ['tests/fixtures/harness-e2e-provider.mjs'], bundle: true, write: false, platform: 'node', format: 'esm' })
  await writeFile(join(provider, 'index.mjs'), model.outputFiles[0].contents)
  const overlay = join(temporary, 'theme.yml')
  await writeFile(overlay, JSON.stringify([
    { id: 'qiuya-tools', config: { qThemeEnabled: true, qThemeId: 'moonfrost', qThemeSettings: { moonfrost: { motion: 'static' } }, computerUseEnabled: false, promptSuggestionsEnabled: false, autoCheckUpdates: false } },
    { id: 'session-title-llm', disabled: true }, { id: 'session-telemetry-otel', disabled: true },
    { id: 'agent-default-model', config: { provider: 'qiuya-e2e', model: 'fixture' } },
    { insert: [{ id: 'qiuya-harness-e2e-provider', name: join(provider, 'index.mjs') }] },
  ]))
  host = spawn(cli, ['--profile', 'web', '--patch', overlay, '--no-open', '--port', '0'], { env, stdio: ['pipe','pipe','pipe'] })
  host.stdout.on('data', chunk => { log = (log + chunk).slice(-64000) })
  host.stderr.on('data', chunk => { log = (log + chunk).slice(-64000) })
  const url = await waitForHarnessHostUrl(() => ({ exited: host.exitCode !== null, error: 'Isolated Host exited', url: log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/u)?.[0] }))
  browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } })
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    return ['http:','https:'].includes(url.protocol) && !['127.0.0.1','localhost'].includes(url.hostname) ? route.abort() : route.continue()
  })
  page = await context.newPage(); page.setDefaultTimeout(15000)
  await page.goto(url)
  const onboarding = page.getByRole('button', { name: /我已阅读并同意|I have read/u })
  // No onboarding agreement is accepted by this test.
  if (await onboarding.isVisible()) throw Error('Isolated Harness requires onboarding; no agreement accepted')
  const previewNotice = page.getByRole('button', { name: '继续', exact: true })
  await previewNotice.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})
  if (await previewNotice.isVisible()) await previewNotice.click()
  await page.getByRole('button', { name: '账号菜单', exact: true }).waitFor()
  assert.equal(await page.locator('body').getAttribute('data-qyt-q-theme'), 'moonfrost')
  await page.getByRole('button', { name: '插件', exact: true }).click()
  const plugins = page.locator('[data-plugin-panel]')
  await page.locator('[data-plugin-panel][aria-busy="false"]').waitFor(); assert.equal((await backdrop(plugins)).art, true)
  await snapshot('plugins-light'); checks.push('actual-plugin-page')
  await page.getByRole('button', { name: '自动化任务', exact: true }).click()
  const schedules = page.locator('[data-testid="task-manager-page"]')
  await schedules.waitFor(); assert.equal((await backdrop(schedules)).art, true)
  await snapshot('schedules-light'); checks.push('actual-automation-page')
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
  const workspacePath = join(temporary, 'theme-workspace'); await mkdir(workspacePath)
  const workspace = await realpath(workspacePath)
  await writeFile(join(workspace, 'preview.bin'), Buffer.from([0,1,2,3]))
  await writeFile(join(workspace, 'notes.md'), '# 月阙清霜\n\n文件预览与阅读纸面。\n')
  const registered = await registerHarnessWorkspace(page, workspace)
  await page.getByRole('button', { name: '选择工作区', exact: true }).click()
  await page.getByRole('menuitem', { name: registered.title, exact: true }).click()
  let sessionId
  const deadline = Date.now() + 15000
  while (!sessionId && Date.now() < deadline) {
    sessionId = selectedHarnessWorkspaceSession(await page.evaluate(captureHarnessWorkspaceDom), registered)
    if (!sessionId) await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(sessionId, 'Selected own workspace must expose its ready blank session before input')
  const input = page.locator(`[data-conversation-session="${sessionId}"] [data-composer-input][contenteditable="true"]:visible`)
  await input.fill('E2E:Theme')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await page.getByText('已完成本地测试回复：E2E:Theme', { exact: true }).waitFor()
  await snapshot('conversation-light'); checks.push('actual-local-fixture-conversation')
  await writeFile(join(output,'header-dom.html'),await page.locator('[data-conversation-tabs]').evaluate(node=>node.parentElement.parentElement.outerHTML))
  for (const [name, file] of [['轨迹','trace'],['上下文','context'],['编队','formation']]) {
    const tab = page.locator('[data-conversation-tabs]').getByRole('tab', { name, exact: true })
    if (await tab.count() === 0) continue
    await tab.click(); await snapshot(file+'-light'); checks.push('actual-'+file+'-view')
  }
  await page.locator('[data-conversation-tabs]').getByRole('tab', { name: '对话', exact: true }).click()
  await page.getByRole('button', { name: '打开右侧边栏', exact: true }).click()
  await page.getByText('工作区文件', { exact: true }).first().click()
  await page.locator('[data-files-entry="file"]').filter({ hasText: 'preview.bin' }).click()
  const unsupported = page.locator('[data-textpreview-state="unsupported"]')
  await unsupported.waitFor()
  assert.equal((await backdrop(unsupported.locator('xpath=ancestor::*[@data-dockkit-content][1]'))).art, true)
  await snapshot('file-unsupported-light'); checks.push('actual-unsupported-file-pane')
  await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
  await snapshot('file-unsupported-dark')
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--qyt-q-paper').trim()), 'rgba(21, 29, 45, .78)')
  checks.push('actual-dark-surfaces')
} catch (error) {
  failure = error.message
  if (page) {
    await snapshot('failure').catch(() => {})
    await writeFile(join(output, 'failure-dom.txt'), await page.locator('body').innerText().catch(() => 'unavailable'))
  }
} finally {
  await browser?.close()
  if (host && host.exitCode === null) {
    host.stdin.end(); host.kill('SIGTERM')
    await new Promise(resolve => { const timer = setTimeout(resolve, 5000); host.once('exit', () => { clearTimeout(timer); resolve() }) })
  }
  const hostRetired = !host || host.exitCode !== null || host.signalCode !== null
  if (!hostRetired) failure ??= 'Isolated Host did not retire'
  const result = { passed: !failure, checks, screenshots, failure: failure ?? null, hostRetired, isolated: true }
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2)+'\n')
  await writeFile(join(output, 'host.log'), log.replace(/token=[^\s]+/gu, 'token=<redacted>'))
  if (hostRetired) await rm(temporary, { recursive: true, force: true })
  console.log(JSON.stringify(result, null, 2)); if (failure) process.exitCode = 1
}
