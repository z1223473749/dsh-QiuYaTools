/** Theme-only checks against the installed official Harness in an isolated profile.
 * No real account, external model, desktop input or user workspace is used. */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, realpath, writeFile, rm, cp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import { build } from 'esbuild'
import { waitForHarnessHostUrl } from './harness-host-readiness.mjs'
import { registerHarnessWorkspace, captureHarnessWorkspaceDom, selectedHarnessWorkspaceSession } from '../tests/fixtures/harness-workspace-prerequisite.mjs'

const cli = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const candidate = resolve(process.argv[2] ?? 'artifacts/candidates/dsh-qiuya-tools-darwin-universal.tgz')
const themeId = process.argv[3] ?? 'moonfrost'
assert.ok(['moonfrost', 'buliangren', 'fox', 'garo'].includes(themeId))
const videoTheme = themeId === 'fox' || themeId === 'garo'
const output = resolve(themeId === 'moonfrost' ? 'artifacts/theme-harness' : `artifacts/theme-harness-${themeId}`)
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
  // Reuse the verified public-video fixture cache for layout checks. Download
  // integrity and first-use loading have their own Host/browser coverage.
  if(themeId==='fox') await cp(resolve('artifacts/video-theme/profile/qiuya-theme-videos'),join(env.DSH_HOME,'profiles/web/qiuya-theme-videos'),{recursive:true}).catch(()=>{})
  await command(cli, ['plugin', '--profile', 'web', 'add', candidate], { env, maxBuffer: 2 ** 20 })
  const provider = join(temporary, 'provider'); await mkdir(provider)
  const model = await build({ entryPoints: ['tests/fixtures/harness-e2e-provider.mjs'], bundle: true, write: false, platform: 'node', format: 'esm' })
  await writeFile(join(provider, 'index.mjs'), model.outputFiles[0].contents)
  const overlay = join(temporary, 'theme.yml')
  await writeFile(overlay, JSON.stringify([
    { id: 'qiuya-tools', config: { qThemeEnabled: true, qThemeId: themeId, qThemeSettings: { [themeId]: { motion: themeId !== 'moonfrost' ? 'dynamic' : 'static' } }, computerUseEnabled: false, promptSuggestionsEnabled: false, autoCheckUpdates: false } },
    { id: 'session-title-llm', disabled: true }, { id: 'session-telemetry-otel', disabled: true },
    { id: 'agent-default-model', config: { provider: 'qiuya-e2e', model: 'fixture' } },
    { insert: [{ id: 'qiuya-harness-e2e-provider', name: join(provider, 'index.mjs') }] },
  ]))
  host = spawn(cli, ['--profile', 'web', '--patch', overlay, '--no-open', '--port', '0'], { env, stdio: ['pipe','pipe','pipe'] })
  host.stdout.on('data', chunk => { log = (log + chunk).slice(-64000) })
  host.stderr.on('data', chunk => { log = (log + chunk).slice(-64000) })
  const url = await waitForHarnessHostUrl(() => ({ exited: host.exitCode !== null, error: 'Isolated Host exited', url: log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/u)?.[0] }))
  browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
  const context = await browser.newContext({ viewport: themeId === 'buliangren' ? { width: 1280, height: 820 } : { width: 1440, height: 950 } })
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
  assert.equal(await page.locator('body').getAttribute('data-qyt-q-theme'), themeId)
  await page.getByRole('button', { name: '插件', exact: true }).click()
  const plugins = page.locator('[data-plugin-panel]')
  await page.locator('[data-plugin-panel][aria-busy="false"]').waitFor()
  if (videoTheme) {
    await page.locator('video[data-qyt-video-scene][data-ready="true"]').waitFor({ timeout: 30000 })
    await page.waitForFunction(() => { const video=document.querySelector('video[data-qyt-video-scene]'); return video && !video.paused && video.currentTime>.1 })
    assert.equal(await page.locator('video[data-qyt-video-scene]').evaluate(v=>v.muted),true)
    assert.equal((await backdrop(plugins)).art,false)
    await page.evaluate(()=>{window.__themeMainVideo=document.querySelector('video[data-qyt-video-scene]')})
    await page.emulateMedia({reducedMotion:'reduce'})
    await page.locator('video[data-qyt-video-scene]').waitFor({state:'detached'})
    await snapshot('plugins-static-light')
    await page.emulateMedia({reducedMotion:'no-preference'})
    await page.locator('video[data-qyt-video-scene][data-ready="true"]').waitFor()
    await page.evaluate(()=>{window.__themeMainVideo=document.querySelector('video[data-qyt-video-scene]')})
    assert.equal(await page.locator('[data-slot="sidebar"] > :first-child').evaluate(node=>getComputedStyle(node).backgroundImage.includes('data:image/')),false)
    checks.push('actual-plugin-and-sidebar-share-video')
  } else assert.equal((await backdrop(plugins)).art,true)
  if (videoTheme) await writeFile(join(output,'video-layout.json'),JSON.stringify(await page.evaluate(()=>[...document.querySelectorAll('[data-slot="sidebar"],video[data-qyt-video-scene],[data-rightbar-col]')].map(node=>({tag:node.tagName,rect:node.getBoundingClientRect().toJSON(),attrs:[...node.attributes].filter(a=>!['poster','src'].includes(a.name)).map(a=>[a.name,a.value]),ancestors:[...function*(n){for(let p=n.parentElement;p&&p!==document.body;p=p.parentElement){const s=getComputedStyle(p);yield {tag:p.tagName,attrs:[...p.attributes].map(a=>[a.name,a.value]),background:s.backgroundColor,image:s.backgroundImage.startsWith('url(')?'image':s.backgroundImage.slice(0,120),rect:p.getBoundingClientRect().toJSON()}}}(node)]}))),null,2))
  await snapshot('plugins-light'); checks.push('actual-plugin-page')
  await page.getByRole('button', { name: '自动化任务', exact: true }).click()
  const schedules = page.locator('[data-testid="task-manager-page"]')
  await schedules.waitFor(); assert.equal((await backdrop(schedules)).art, !videoTheme)
  if (videoTheme) {
    assert.equal(await page.evaluate(()=>document.querySelector('video[data-qyt-video-scene]')===window.__themeMainVideo),true)
    assert.equal(await page.locator('video[data-qyt-video-scene]').evaluate(v=>!v.paused&&v.muted),true)
    checks.push('actual-automation-video-keeps-decoder')
  }
  await snapshot('schedules-light'); checks.push('actual-automation-page')
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
  const workspacePath = join(temporary, 'theme-workspace'); await mkdir(workspacePath)
  const workspace = await realpath(workspacePath)
  if (themeId === 'buliangren') {
    await command('git', ['init', '--initial-branch=main', workspace])
    await command('git', ['-C', workspace, '-c', 'user.name=Theme Preview', '-c', 'user.email=theme-preview@example.invalid', 'commit', '--allow-empty', '-m', 'Theme preview fixture'])
  }
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
  if (themeId === 'buliangren') {
    const hero = page.locator('[data-slot="main.conversation"] > [data-phase="hero"]')
    await hero.waitFor()
    const headline = hero.getByText('探索未至之境', { exact: true })
    const workspaceChip = hero.getByRole('button', { name: '选择工作区', exact: true })
    await headline.waitFor()
    const gold = 'rgb(230, 197, 139)'
    assert.equal(await headline.evaluate(node => getComputedStyle(node).color), gold)
    assert.equal(await workspaceChip.evaluate(node => getComputedStyle(node).color), gold)
    const mode = hero.locator('[data-slot="conversation.hero.agentPreset"] button').first()
    if (await mode.count()) assert.equal(await mode.evaluate(node => getComputedStyle(node).color), gold)
    const branch = hero.locator('.qyt-git-branch-trigger')
    await branch.filter({ hasText: 'main' }).waitFor()
    assert.equal(await branch.evaluate(node => getComputedStyle(node).color), gold)
    const editor = hero.locator('[data-composer-card] [data-composer-input]')
    assert.notEqual(await editor.evaluate(node => getComputedStyle(node).color), gold, 'Input retains reading ink')
    await writeFile(join(output, 'hero-dom.html'), await hero.evaluate(node => node.outerHTML))
    await snapshot('hero-gold-light')
    await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
    assert.equal(await headline.evaluate(node => getComputedStyle(node).color), gold)
    assert.equal(await workspaceChip.evaluate(node => getComputedStyle(node).color), gold)
    await snapshot('hero-gold-dark')
    await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))
    checks.push('actual-hero-title-and-workspace-gold')
  }
  // Workspace selection can replace its initial provisional blank session.
  // Read the currently selected session again after the hero checks settle.
  sessionId = selectedHarnessWorkspaceSession(await page.evaluate(captureHarnessWorkspaceDom), registered)
  assert.ok(sessionId, 'Current own workspace session remains selected')
  const input = page.locator(`[data-conversation-session="${sessionId}"] [data-composer-input][contenteditable="true"]:visible`)
  await input.fill('E2E:Theme')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  // The native Host may finish replacing a provisional blank session after
  // submission. Reopen this fixture's titled row before checking its response.
  if (videoTheme) await page.locator('[data-slot="sidebar"]').getByText('E2E:Theme',{exact:true}).click()
  await page.getByText('已完成本地测试回复：E2E:Theme', { exact: true }).waitFor()
  if (videoTheme) {
    const seat=page.locator('[data-slot="main.conversation"] > [data-phase="active"] > [data-conversation-content] > [data-conversation-scroll] > [data-composer-seat]')
    assert.equal(await seat.evaluate(node=>getComputedStyle(node,'::before').content),'none')
    assert.equal(await page.evaluate(()=>document.querySelector('video[data-qyt-video-scene]')===window.__themeMainVideo),true)
    checks.push('actual-composer-reveals-video-without-static-image')
  }
  await snapshot('conversation-light'); checks.push('actual-local-fixture-conversation')
  if (themeId === 'buliangren') {
    const art = page.locator('canvas[data-qyt-buliangren-art][data-ready="true"]')
    await art.waitFor()
    assert.equal(await page.locator('[data-qyt-leaf="maple"]').count(), 36)
    const before = await art.evaluate(canvas => canvas.toDataURL())
    await page.waitForFunction(before => document.querySelector('canvas[data-qyt-buliangren-art]')?.toDataURL() !== before, before)
    await page.waitForTimeout(1000)
    await snapshot('conversation-light-moving')
    await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
    await snapshot('conversation-dark')
    await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))
    checks.push('actual-active-conversation-motion')
  }
  await writeFile(join(output,'header-dom.html'),await page.locator('[data-conversation-tabs]').evaluate(node=>node.parentElement.parentElement.outerHTML))
  for (const [name, file] of [['轨迹','trace'],['上下文','context'],['编队','formation']]) {
    const tab = page.locator('[data-conversation-tabs]').getByRole('tab', { name, exact: true })
    if (await tab.count() === 0) continue
    await tab.click(); await snapshot(file+'-light'); checks.push('actual-'+file+'-view')
  }
  await page.locator('[data-conversation-tabs]').getByRole('tab', { name: '对话', exact: true }).click()
  await page.getByRole('button', { name: '打开右侧边栏', exact: true }).click()
  if (videoTheme) {
    await page.waitForFunction(()=>{const v=document.querySelector('video[data-qyt-video-scene]'),right=document.querySelector('[data-rightbar-col]');return v?.parentElement?.contains(right)&&right.getBoundingClientRect().width>100})
    assert.equal(await page.locator('video[data-qyt-video-scene]').count(),1)
    assert.equal(await page.evaluate(()=>document.querySelector('video[data-qyt-video-scene]')===window.__themeMainVideo),true)
    assert.equal(await page.locator('[data-rightbar-col]').evaluate(node=>getComputedStyle(node).backgroundImage.includes('data:image/')),false)
    await snapshot('right-start-video-light')
    const before=await page.locator('video[data-qyt-video-scene]').evaluate(v=>v.currentTime)
    await page.waitForFunction(before=>document.querySelector('video[data-qyt-video-scene]').currentTime>before+.25,before)
    checks.push('actual-sidebar-main-and-right-dock-share-one-frame')
  }
  await page.getByText('工作区文件', { exact: true }).first().click()
  await page.locator('[data-files-entry="file"]').filter({ hasText: 'preview.bin' }).click()
  const unsupported = page.locator('[data-textpreview-state="unsupported"]')
  await unsupported.waitFor()
  assert.equal((await backdrop(unsupported.locator('xpath=ancestor::*[@data-dockkit-content][1]'))).art, !videoTheme)
  await snapshot('file-unsupported-light'); checks.push('actual-unsupported-file-pane')
  await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
  await snapshot('file-unsupported-dark')
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--qyt-q-paper').trim()), themeId === 'buliangren' ? 'rgba(20, 24, 28, .70)' : themeId === 'fox' ? 'rgba(41, 29, 42, .72)' : 'rgba(21, 29, 45, .78)')
  checks.push('actual-dark-surfaces')
} catch (error) {
  failure = error.message
  if (page) {
    await snapshot('failure').catch(() => {})
    await writeFile(join(output,'failure-layout.json'),JSON.stringify(await page.evaluate(()=>[...document.querySelectorAll('[data-slot="main"],[data-plugin-panel],[data-testid="task-manager-page"],video[data-qyt-video-scene],[data-slot="root"]')].map(node=>({tag:node.tagName,attrs:[...node.attributes].map(a=>[a.name,a.name==='src'?'media':a.value]),rect:node.getBoundingClientRect().toJSON(),ancestors:[...function*(n){for(let p=n.parentElement;p&&p!==document.body;p=p.parentElement)yield {tag:p.tagName,attrs:[...p.attributes].map(a=>[a.name,a.value])}}(node)]}))),null,2))
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
