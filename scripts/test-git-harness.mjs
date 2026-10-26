/** Installed Harness + disposable DSH_HOME, Git repository and headless browser.
 * One deterministic local adapter turn; no external model, hosted PR write,
 * real profile or existing browser is used.
 */
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('../', import.meta.url)), at = process.argv.indexOf('--output')
const output = resolve(at < 0 ? join(tmpdir(), 'qyt-git-harness-report-' + randomUUID()) : process.argv[at + 1])
const cliAt = process.argv.indexOf('--cli'), cli = cliAt < 0 ? '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' : process.argv[cliAt + 1]
await mkdir(output, { recursive: true })
const temporary = await mkdtemp(join(tmpdir(), 'qyt-git-harness-')), home = join(temporary, 'home'), repo = join(temporary, 'git-smoke-project'), overlay = join(temporary, 'overlay.yml')
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:^|_)(?:TOKEN|API_KEY|SECRET|PASSWORD|CREDENTIAL)(?:_|$)/iu.test(key)))
Object.assign(env, { DSH_HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' })
const exec = promisify(execFile), checks = [], pageErrors = [], requestMethods = []
const redact = value => String(value).replace(/([?&]token=)[^&\s"']+/gu, '$1<redacted>').replace(/(Bearer\s+)[^\s"']+/giu, '$1<redacted>')
let host, browser, hostLog = '', page, cookie, origin, failed, localModelCalls = 0
const sleep = ms => new Promise(done => setTimeout(done, ms))
async function waitFor(read, description, timeout = 20_000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const value = await read(); if (value) return value; await sleep(100) }; throw Error(description) }
async function command(args) {
  return new Promise((done, reject) => {
    const child = spawn(cli, args, { env, cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] }); let log = ''
    child.stdout.on('data', value => { log += value }); child.stderr.on('data', value => { log += value })
    const timer = setTimeout(() => { child.kill(); reject(Error('Isolated CLI command timed out')) }, 45_000)
    child.once('error', error => { clearTimeout(timer); reject(error) }); child.once('exit', code => { clearTimeout(timer); code === 0 ? done(log) : reject(Error(redact(log).slice(-5000))) })
  })
}
async function check(name, run) { const began = Date.now(); try { const detail = await run(); checks.push({ name, status: 'passed', elapsedMs: Date.now() - began, ...detail }); console.log('PASS ' + name) } catch (error) { checks.push({ name, status: 'failed', elapsedMs: Date.now() - began, reason: redact(error.message) }); throw error } }
function publicCapabilities(ctx, scope) {
  const type = (name, ...path) => { try { let value = ctx.get(name); for (const key of path) value = value?.[key]; return typeof value } catch (error) { return 'throws:' + error.name + ':' + error.message } }
  return {
    scope,
    sessions: { self: type('sessions'), binding: type('sessions', 'binding'), refreshProjections: type('sessions', 'refreshProjections'), create: type('sessions', 'create'), retain: type('sessions', 'retain'), listSnapshot: type('sessions', 'list', 'getSnapshot'), listSubscribe: type('sessions', 'list', 'subscribe') },
    conversation: { self: type('conversation'), rebindDraftFiles: type('conversation', 'rebindDraftFiles'), resolveDraftAttachments: type('conversation', 'resolveDraftAttachments'), inputFor: type('conversation', 'input', 'for'), requestDraftInitialization: type('conversation', 'input', 'requestDraftInitialization'), blockSet: type('conversation', 'blocks', 'set'), blockStoreFor: type('conversation', 'blocks', 'storeFor') },
    workspaces: { self: type('workspaces'), create: type('workspaces', 'create') },
    uiWorkspace: { self: type('uiWorkspace'), openSession: type('uiWorkspace', 'openSession') },
    uiSession: { adapter: type('uiSession', 'adapter'), current: type('uiSession', 'adapter', 'current'), currentSnapshot: type('uiSession', 'adapter', 'current', 'getSnapshot'), currentSubscribe: type('uiSession', 'adapter', 'current', 'subscribe') },
    connection: { self: type('connection'), generation: type('connection', 'generation'), generationSnapshot: type('connection', 'generation', 'getSnapshot'), generationSubscribe: type('connection', 'generation', 'subscribe') },
    remote: { self: type('remote'), session: type('remote', 'session'), modelCatalog: type('remote', 'session', 'modelCatalog'), selectModel: type('remote', 'session', 'selectModel') },
  }
}
async function rpc(method, request, plugin = false) {
  const rpcId = randomUUID(), response = await fetch(origin + '/api/' + method, { method: 'POST', signal: AbortSignal.timeout(20_000), headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId, method, payload: plugin ? request : { args: { request } } }) })
  const result = await response.json().catch(() => undefined)
  assert.equal(response.status, 200, `Owner ${method} HTTP ${response.status}`)
  assert.equal(result?.type, 'server-response'); assert.equal(result?.rpcId, rpcId)
  assert.equal(result.result?.ok, true, `${method}: ${JSON.stringify(result.result?.error)}`)
  return result.result.value
}
async function stop() {
  await browser?.close().catch(() => {})
  if (host && host.exitCode === null && !host.signalCode) {
    host.stdin.end(); host.kill('SIGTERM')
    await Promise.race([new Promise(done => host.once('exit', done)), sleep(5000).then(() => host.kill('SIGKILL'))])
  }
}
try {
  await mkdir(repo); const git = async (...args) => (await exec('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, env })).stdout
  await git('init', '-b', 'main'); await git('config', 'user.email', 'isolated-smoke@example.invalid'); await git('config', 'user.name', 'Isolated Git Smoke')
  await writeFile(join(repo, 'example.txt'), 'before\nkeep\n'); await git('add', '.'); await git('commit', '-m', 'Isolated initial fixture')
  await check('installed-cli-isolated-profile-bootstrap', async () => { await command(['--profile', 'web', '--dump-config']); return { separateHome: true } })
  const providerPath = join(temporary, 'local-provider.mjs')
  await writeFile(providerPath, `import { appendFileSync } from 'node:fs'; import { join } from 'node:path';
export const name='qiuya-git-smoke-provider'; export const inject=['llm'];
export function apply(ctx) {
 if(process.env.DSH_HOME!==${JSON.stringify(home)}) throw Error('Isolated smoke profile required');
 const provider='qiuya-git-smoke', model='fixture';
 const metadata={provider,id:model,name:'Git 本地隔离测试模型',inputModalities:['text'],context:{contextWindow:128000},defaultMaxTokens:512,systemPromptUpdate:'in-history'};
 const adapter={providerInfo:()=>({id:provider,name:'Git 本地隔离测试',nativeAuth:{env:[],oauth:false}}),providerRetryPolicy:()=>undefined,imageRequestPricing:()=>undefined,imageRequestTarget:()=>undefined,listModels:async()=>[metadata],resolveModel:async()=>metadata,prepareCall:async()=>({model:metadata,stream:options=>adapter.stream(options)}),async *stream(options){
 options.signal?.throwIfAborted(); appendFileSync(join(process.env.DSH_HOME,'git-smoke-model.jsonl'),JSON.stringify({provider,localOnly:true})+'\\n',{mode:0o600});
 yield {type:'text-delta',index:0,text:'Git 隔离验收：本地固定回复完成。'}; yield {type:'usage',usage:{inputTokens:40,outputTokens:16}}; yield {type:'finish',reason:{kind:'stop'}};
 }};ctx.effect(()=>ctx.llm.registerAdapter([provider],adapter));
}`)
  await writeFile(overlay, JSON.stringify([
    { id: 'agent-default-model', config: { provider: 'qiuya-git-smoke', model: 'fixture' } },
    { id: 'session-title-llm', disabled: true }, { id: 'session-telemetry-otel', disabled: true },
    { insert: [{ id: 'qiuya-git-smoke-provider', name: providerPath }, { id: 'qiuya-tools', name: join(root, 'lib/index.js'), config: { enabled: true, gitEnabled: true, computerUseEnabled: false, promptSuggestionsEnabled: false, sessionWindowsEnabled: false, qThemeEnabled: false } }] },
  ], null, 2))
  host = spawn(cli, ['--profile', 'web', '--patch', overlay, '--no-open', '--port', '0'], { env, cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] })
  host.stdout.on('data', value => { hostLog += value }); host.stderr.on('data', value => { hostLog += value }); let spawnError
  host.once('error', error => { spawnError = error })
  const url = await waitFor(() => { if (spawnError || host.exitCode !== null || host.signalCode !== null) throw Error(redact(spawnError?.message ?? hostLog).slice(-5000)); return hostLog.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/u)?.[0] }, 'Installed Harness did not open its owned loopback listener', 45_000)
  origin = new URL(url).origin
  await check('real-host-owner-bootstrap', async () => { const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) }); assert.equal(response.status, 303); cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; '); assert.ok(cookie); return { localOrigin: origin } })
  const workspace = (await rpc('workspace/create', { path: repo })).workspace
  assert.equal(typeof workspace?.workspaceId, 'string')
  const sessionId = (await rpc('session/create', { workspaceId: workspace.workspaceId })).sessionId
  assert.equal(typeof sessionId, 'string')
  await check('real-cordis-git-host-registration-and-status', async () => { const status = await rpc('qiuya-tools.git.control', { op: 'status', sessionId }, true); assert.equal(status.available, true); assert.equal(status.branch, 'main'); assert.equal(status.repoName, 'git-smoke-project'); assert.equal(status.locked, false); return { repository: status.repoName, blankSession: true } })
  await check('real-git-custom-branch-owner-mutation', async () => { const value = await rpc('qiuya-tools.git.control', { op: 'createBranch', sessionId, branch: 'smoke/custom-name', requestId: randomUUID() }, true); assert.equal(value.completed, true); assert.equal((await git('branch', '--show-current')).trim(), 'smoke/custom-name'); await rpc('qiuya-tools.git.control', { op: 'selectBranch', sessionId, branch: 'main', requestId: randomUUID() }, true); assert.equal((await git('branch', '--show-current')).trim(), 'main'); return { customName: true, sourceRestored: true } })
  await writeFile(join(repo, 'example.txt'), 'after\nkeep\n'); await writeFile(join(repo, 'new.txt'), 'new\n')
  await check('real-git-working-statistics-and-file-diff', async () => { const status = await rpc('qiuya-tools.git.control', { op: 'status', sessionId }, true); assert.equal(status.fileCount, 2); assert.equal(status.added, 2); assert.equal(status.deleted, 1); const diff = await rpc('qiuya-tools.git.control', { op: 'diff', sessionId, path: 'example.txt', expectedRevision: status.revision }, true); assert.equal(diff.oldText, 'before\nkeep\n'); assert.equal(diff.newText, 'after\nkeep\n'); assert.equal(diff.hunks.length, 1); return { files: status.fileCount, added: status.added, deleted: status.deleted } })
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (!['data:', 'blob:'].includes(url.protocol) && url.origin !== origin) return route.abort()
    if (url.origin === origin && url.pathname.startsWith('/api/')) requestMethods.push(url.pathname)
    if (url.origin === origin && request.resourceType() === 'script') {
      const response = await route.fetch(); let source = await response.text()
      if (source.includes('qiuya-tools.git.control') && source.includes('return module.exports;')) {
        // Test-only observation of the exact feature Context; no service or return value is replaced.
        const marker = 'function createGitWorktreeNavigation(ctx){'
        assert.equal(source.split(marker).length - 1, 1, 'The Git feature observer must bind one exact factory')
        source = source.replace(marker, marker + 'globalThis.__qytGitSmokeFeatureCtx=ctx;')
        const point = source.lastIndexOf('return module.exports;'), observer = `const __gitSmokeExports=module.exports;const __gitSmokeApply=__gitSmokeExports.apply;return {...__gitSmokeExports,apply(...args){const rootCtx=args[0];globalThis.__qytGitSmokeCapabilities=()=>(${publicCapabilities.toString()})(globalThis.__qytGitSmokeFeatureCtx??rootCtx,globalThis.__qytGitSmokeFeatureCtx?'git-feature':'module-root');return Reflect.apply(__gitSmokeApply,this,args)}};`
        return route.fulfill({ response, body: source.slice(0, point) + observer + source.slice(point + 'return module.exports;'.length) })
      }
      return route.fulfill({ response })
    }
    return route.continue()
  })
  page = await context.newPage(); page.on('pageerror', error => pageErrors.push(redact(error.message)))
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  const continueButton = page.getByRole('button', { name: '继续', exact: true }).first(); await continueButton.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {}); if (await continueButton.isVisible()) await continueButton.click()
  const keyDialog = page.getByRole('dialog', { name: '添加一个 API Key 开始使用', exact: true }), accountDialog = page.getByRole('dialog', { name: '开始使用', exact: true })
  await keyDialog.or(accountDialog).waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
  if (await keyDialog.isVisible()) await keyDialog.getByRole('button', { name: '稍后配置', exact: true }).click()
  if (await accountDialog.isVisible()) await accountDialog.getByRole('button', { name: '关闭', exact: true }).click()
  await check('installed-renderer-loads-local-git-extension', async () => {
    const picker = page.getByRole('button', { name: '选择工作区', exact: true }); await picker.waitFor(); await picker.click(); await page.getByRole('menuitem', { name: workspace.title, exact: true }).click()
    await page.locator('[data-qyt-git-branch]:visible').waitFor({ timeout: 20_000 }); assert.equal(pageErrors.length, 0, pageErrors.join('\n')); return { realRenderer: true, heroBranch: true }
  })
  await check('one-local-only-turn-preserves-real-submit-and-locks-the-branch', async () => {
    const activeId = await page.locator('[data-qyt-git-branch]:visible').getAttribute('data-qyt-git-branch')
    assert.ok(activeId)
    const editor = page.locator('[data-composer-input][contenteditable="true"]:visible').first(); await editor.fill('Git 本地隔离验收，请返回固定回复。'); await editor.press('Enter')
    await page.getByText('Git 隔离验收：本地固定回复完成。', { exact: true }).waitFor({ timeout: 20_000 })
    await page.locator('[data-qyt-git-stats]:visible').waitFor({ timeout: 20_000 })
    const status = await rpc('qiuya-tools.git.control', { op: 'status', sessionId: activeId }, true); assert.equal(status.locked, true)
    await assert.rejects(rpc('qiuya-tools.git.control', { op: 'createBranch', sessionId: activeId, branch: 'must-stay-locked', requestId: randomUUID() }, true), /BRANCH_LOCKED/u)
    assert.equal((await git('branch', '--show-current')).trim(), 'main')
    localModelCalls = (await readFile(join(home, 'git-smoke-model.jsonl'), 'utf8')).trim().split('\n').length; assert.equal(localModelCalls, 1)
    return { localModelCalls, externalModelCalls: 0, durableBranchLock: true }
  })
  await check('hover-includes-repository-file-counts-and-click-opens-right-diff', async () => {
    const stats = page.locator('[data-qyt-git-stats]:visible').first(); await stats.hover(); const popover = page.locator('.qyt-git-stats-popover:visible'); await popover.waitFor({ timeout: 10_000 }); assert.match(await popover.innerText(), /git-smoke-project/u); assert.match(await popover.innerText(), /example\.txt/u)
    await page.screenshot({ path: join(output, 'hover-repository-files.png'), animations: 'disabled' })
    await popover.getByRole('button', { name: /example\.txt/u }).click(); const pane = page.locator('.qyt-git-pane:visible'); await pane.waitFor({ timeout: 10_000 }); const file = pane.locator('[data-git-path="example.txt"]'); await file.locator('.qyt-git-diff-table').waitFor({ timeout: 10_000 }); assert.match(await file.innerText(), /before/u); assert.match(await file.innerText(), /after/u); await page.screenshot({ path: join(output, 'right-git-comparison.png'), animations: 'disabled' }); return { hoverRepositoryName: true, rightPane: true, realDiffContent: true }
  })
  await check('real-sdk-worktree-keeps-unsent-draft-and-file-without-touching-source-changes', async () => {
    const previous = await page.locator('[data-conversation-content][data-conversation-session]:visible').getAttribute('data-conversation-session')
    await page.getByRole('button', { name: '新建会话', exact: true }).first().click({ timeout: 5000 })
    let candidate, stableAt = Date.now()
    const sourceId = await waitFor(async () => { const selector = page.locator('[data-qyt-git-branch]:visible'); if (await selector.count() !== 1) return false; const id = await selector.getAttribute('data-qyt-git-branch'); if (!id || id === previous) return false; if (candidate !== id) { candidate = id; stableAt = Date.now() }; return Date.now() - stableAt >= 750 ? id : false }, 'A fresh owned blank Session did not open', 10_000)
    console.log('INFO worktree source blank settled')
    const draft = '工作树迁移草稿：仅保留，不发送。', attachmentName = 'git-worktree-draft.txt', attachmentBytes = Buffer.from('Synthetic worktree attachment only.\n')
    const editor = () => page.locator('[data-composer-input][contenteditable="true"]:visible').first()
    await editor().fill(draft)
    const fileInput = page.locator('[data-conversation-content]:visible input[type="file"]'), attachment = await fileInput.count() > 0
    const readyAttachment = async () => {
      const card = page.locator('[data-composer-card]:visible')
      return await waitFor(async () => { if (await card.getByText('上传失败，点击重试', { exact: true }).count()) throw Error('The actual carried attachment upload failed'); return await card.getByText('上传中…', { exact: true }).count() === 0 && await card.getByRole('button', { name: '移除文件 ' + attachmentName, exact: true }).count() === 1 && await card.getByRole('button', { name: '重试上传 ' + attachmentName, exact: true }).count() === 0 }, 'The actual attachment did not become ready')
    }
    if (attachment) {
      const uploaded = page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === '/api/session/uploadFileBinary' && url.searchParams.get('sessionId') === sourceId && url.searchParams.get('name') === attachmentName }, { timeout: 15_000 }); void uploaded.catch(() => {})
      await fileInput.first().setInputFiles({ name: attachmentName, mimeType: 'text/plain', buffer: attachmentBytes })
      assert.equal((await uploaded).status(), 200); await readyAttachment(); console.log('INFO worktree synthetic TXT ready')
    }
    await page.locator('[data-qyt-git-branch]:visible button').first().click()
    const dialog = page.locator('.qyt-git-branch-popover:visible'), worktree = dialog.getByRole('switch', { name: '新建工作树', exact: true })
    await dialog.waitFor()
    assert.equal(await dialog.getAttribute('data-view'), 'environment'); assert.equal(await dialog.getByRole('searchbox').count(), 0); assert.equal(await dialog.locator('form').count(), 0)
    const capabilities = await page.evaluate(() => globalThis.__qytGitSmokeCapabilities?.() ?? { probeUnavailable: true })
    await writeFile(join(output, 'actual-sdk-capabilities.json'), JSON.stringify(capabilities, null, 2)); console.log('INFO actual SDK capabilities ' + JSON.stringify(capabilities))
    assert.equal(await worktree.isEnabled(), true, 'The actual installed SDK did not expose complete worktree migration capabilities'); console.log('INFO actual worktree switch is enabled')
    assert.equal(await worktree.getAttribute('aria-checked'), 'false'); await worktree.click(); assert.equal(await worktree.getAttribute('aria-checked'), 'true')
    await dialog.getByRole('button', { name: '选择分支', exact: true }).click(); assert.equal(await dialog.getAttribute('data-view'), 'branches'); await dialog.getByRole('searchbox', { name: '搜索分支', exact: true }).waitFor(); assert.equal(await dialog.locator('form').count(), 0)
    await dialog.getByRole('button', { name: '新建分支…', exact: true }).click(); assert.equal(await dialog.getAttribute('data-view'), 'create'); assert.equal(await dialog.getByRole('searchbox').count(), 0)
    await dialog.getByLabel('新分支名称', { exact: true }).fill('feature/worktree-draft')
    let receipt
    const onResponse = async response => { if (new URL(response.url()).pathname !== '/api/qiuya-tools.git.control') return; const payload = response.request().postDataJSON()?.payload; if (payload?.op !== 'createWorktree' || payload.sessionId !== sourceId) return; const envelope = await response.json().catch(() => undefined); receipt = envelope?.result }
    page.on('response', onResponse)
    let targetId
    try {
      await dialog.getByRole('button', { name: '创建并使用', exact: true }).click()
      targetId = await waitFor(async () => {
        const alert = dialog.locator('[role="alert"]'); if (await alert.count() && await alert.first().isVisible()) throw Error('Actual SDK worktree migration: ' + await alert.first().innerText())
        if (receipt && !receipt.ok) throw Error('Actual worktree creation: ' + JSON.stringify(receipt.error))
        const selector = page.locator('[data-qyt-git-branch]:visible'); if (await selector.count() !== 1) return false; const id = await selector.getAttribute('data-qyt-git-branch'); return id && id !== sourceId ? id : false
      }, 'The actual SDK did not finish opening the carried worktree Session', 30_000)
      await waitFor(() => receipt, 'The owned worktree receipt was not observed')
    } finally { page.off('response', onResponse) }
    assert.equal(receipt?.ok, true)
    const target = await rpc('qiuya-tools.git.control', { op: 'status', sessionId: targetId }, true), source = await rpc('qiuya-tools.git.control', { op: 'status', sessionId: sourceId }, true)
    assert.equal(target.branch, 'feature/worktree-draft'); assert.equal(target.mode, 'worktree'); assert.equal(target.locked, false); assert.equal(target.repoRoot, await realpath(receipt.value.worktreePath)); assert.notEqual(target.repoRoot, source.repoRoot)
    assert.equal(source.branch, 'main'); assert.equal(source.fileCount, 2); assert.equal(source.added, 2); assert.equal(source.deleted, 1)
    assert.equal(await readFile(join(repo, 'example.txt'), 'utf8'), 'after\nkeep\n'); assert.equal(await readFile(join(repo, 'new.txt'), 'utf8'), 'new\n')
    assert.equal(await readFile(join(target.repoRoot, 'example.txt'), 'utf8'), 'before\nkeep\n')
    assert.equal((await editor().innerText()).trim(), draft)
    if (attachment) await readyAttachment()
    assert.equal((await readFile(join(home, 'git-smoke-model.jsonl'), 'utf8')).trim().split('\n').length, 1)
    await page.screenshot({ path: join(output, 'worktree-unsent-draft-and-attachment.png'), animations: 'disabled' })
    return { movedUnsentDraft: true, attachmentExposed: attachment, ...(attachment ? { syntheticAttachmentReady: true, attachmentBytes: attachmentBytes.length } : {}), sourceChangesPreserved: true, separateWorktreeSession: true, extraModelCalls: 0 }
  })
  assert.equal(requestMethods.some(method => /qiuya-tools\.computer/u.test(method)), false, 'No computer operation may be sent')
  assert.equal(requestMethods.filter(method => method === '/api/session/prompt').length, 1, 'Only one explicitly local stub prompt may be sent')
  assert.equal(pageErrors.length, 0, pageErrors.join('\n'))
} catch (error) { failed = redact(error.message); console.error(failed) }
finally {
  await writeFile(join(output, 'host-startup.log'), redact(hostLog))
  localModelCalls = await readFile(join(home, 'git-smoke-model.jsonl'), 'utf8').then(value => value.trim().split('\n').filter(Boolean).length).catch(() => 0)
  if (failed && page) { await page.evaluate(() => ({ text: document.body.innerText, slots: [...document.querySelectorAll('[data-slot]')].map(node => node.getAttribute('data-slot')) })).then(value => writeFile(join(output, 'isolated-failure-dom.json'), JSON.stringify(value, null, 2))).catch(() => {}); await page.screenshot({ path: join(output, 'isolated-failure.png'), animations: 'disabled', timeout: 5000 }).catch(() => {}) }
  await stop(); await rm(temporary, { recursive: true, force: true })
  const report = { status: failed ? 'failed' : 'passed', kind: 'actual-installed-Harness-isolated-Git-smoke', checks, ...(failed ? { reason: failed } : {}), pageErrors, localOwnerOnly: true, localStubModelCalls: localModelCalls, realModelRequests: 0, hostedGitWrites: 0, isolatedBrowser: true, temporaryProfileRemoved: true, testedAt: new Date().toISOString() }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log('Report: ' + output); if (failed) process.exitCode = 1
}
