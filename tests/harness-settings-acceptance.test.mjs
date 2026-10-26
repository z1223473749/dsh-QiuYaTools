import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep, win32 } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import * as acceptance from '../scripts/harness-settings-acceptance.mjs'

const runner = await readFile(new URL('../scripts/e2e-harness.mjs', import.meta.url), 'utf8')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const require = createRequire(import.meta.url)
const compiled = (await build({
  stdin: { contents: "export { QiuYaToolsSettings } from './src/client/index.tsx'; export { zh } from './src/client/locales.ts'", resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', loader: { '.css': 'text' },
  plugins: [{ name: 'isolate-feature-installers-only', setup(builder) {
    builder.onResolve({ filter: /^\.\/features\.ts$/ }, () => ({ path: 'features', namespace: 'no-install' }))
    builder.onLoad({ filter: /.*/, namespace: 'no-install' }, () => ({ contents: 'export function installFeatures(){}' }))
    builder.onResolve({ filter: /^\.\/q-theme\.ts$/ }, () => ({ path: 'theme', namespace: 'no-theme' }))
    builder.onLoad({ filter: /.*/, namespace: 'no-theme' }, () => ({ contents: 'export function installQTheme(){}' }))
    builder.onResolve({ filter: /^\.\/session-window-support\.ts$/ }, () => ({ path: 'support', namespace: 'ready-support' }))
    builder.onLoad({ filter: /.*/, namespace: 'ready-support' }, () => ({ contents: 'export function getSessionWindowSupport(ctx){return ctx.support}' }))
  } }],
})).outputFiles[0].text
const client = { exports: {} }
new Function('require', 'module', 'exports', compiled)(id => id === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: ({ checked, disabled, label, onChange }) => React.createElement('button', { role: 'switch', 'aria-label': label, 'aria-checked': checked, disabled, onClick: () => onChange(!checked) }) } : require(id), client, client.exports)

function isReadOnlySettingsCall(row) {
  return row.channel === '/api' && (
    (row.endpoint === 'qiuya-tools.computer.control' && ['status', 'applications'].includes(row.input?.op)) ||
    (row.endpoint === 'qiuya-tools.workbench' && row.input?.op === 'permissions')
  )
}

async function settings(t) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://127.0.0.1/' })
  const saved = new Map(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
  const writes = [], calls = [], snapshot = { status: 'ready', writable: true, value: {} }
  const support = { status: 'ready', harnessVersion: '0.2.1-rc.2', versionSupported: true }
  const ctx = { support: { subscribe: () => () => {}, getSnapshot: () => support }, get(name) {
    if (name === 'connection') return { rpc: { async call(channel, endpoint, input) { calls.push({ channel, endpoint, input }); if (endpoint === 'qiuya-tools.workbench' && input?.op === 'permissions') return { ok: true, value: { allowedOrigins: [] } }; return { ok: true, value: { sessions: [], environments: [], allowedApps: [], pendingRequests: [], native: { platform: 'win32', available: true } } } } } }
  } }
  const form = { subscribe: () => () => {}, getSnapshot: () => snapshot, async mutate(input) { writes.push(input); return true } }
  const root = createRoot(dom.window.document.querySelector('#root'))
  await act(async () => root.render(React.createElement(client.exports.QiuYaToolsSettings, { form, ctx, t: key => client.exports.zh[key] })))
  const section = dom.window.document.querySelector('.qyt-settings')
  t.after(async () => { await act(async () => root.unmount()); dom.window.close(); for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] })
  return { section, writes, calls, async select(id) {
    const expected = acceptance.SETTINGS_ACCEPTANCE_PAGES.find(row => row.id === id)
    const tab = [...section.querySelectorAll('[role="tab"]')].find(node => node.textContent === expected.label)
    assert.ok(tab)
    await act(async () => tab.click())
    return expected
  } }
}

test('the installed-Harness settings case rejects ten tab labels with empty page content', async () => {
  const labels = ['电脑操控', '长文本', '独立窗口', '批量归档', '计划批注', '会话菜单', '提示词', 'Q 主题', '关于我们', '版本更新']
  const dom = new JSDOM('<section class="qyt-settings"><button class="qyt-master-toggle"></button><span class="qyt-status" data-state="ready"></span>' + labels.map((label, index) => `<button role="tab" id="tab-${index}" aria-controls="panel-${index}" aria-selected="${index === 0}">${label}</button><div role="tabpanel" id="panel-${index}" aria-labelledby="tab-${index}" ${index === 0 ? '' : 'hidden'}></div>`).join('') + '</section>')
  const locator = nodes => ({
    async waitFor() { assert.equal(nodes.length, 1) },
    async count() { return nodes.length },
    async getAttribute(key) { return nodes[0].getAttribute(key) },
    async click() { for (const tab of dom.window.document.querySelectorAll('[role="tab"]')) { const selected = tab === nodes[0]; tab.setAttribute('aria-selected', String(selected)); dom.window.document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected } },
    async evaluate(callback, input) { return callback(nodes[0], input) },
    locator(selector) { return locator([...nodes[0].querySelectorAll(selector)]) },
    async screenshot() { throw Error('Empty pages must fail before screenshot acceptance') },
  })
  const page = { async waitForFunction() {}, locator: selector => locator([...dom.window.document.querySelectorAll(selector)]), getByRole(role, { name }) { return locator([...dom.window.document.querySelectorAll(`[role="${role}"]`)].filter(node => node.textContent === name)) } }
  const marker = "await test('account-menu-settings-and-all-feature-tabs', async () => {"
  const body = runner.slice(runner.indexOf(marker) + marker.length, runner.indexOf("\n  })\n  await test('settings-persist-thresholds-and-theme'", runner.indexOf(marker)))
  let screenshots = 0
  await assert.rejects(new AsyncFunction('page', 'openSettings', 'screenshot', 'captureSettingsTabs', body)(page, async () => {}, async () => { screenshots++ }, acceptance.captureSettingsTabs), /Settings|settings|heading|content/u)
  assert.equal(screenshots, 0)
  dom.window.close()
})

test('the runner screenshot helper uses the explicitly selected image destination', async t => {
  const base = await mkdtemp(join(tmpdir(), 'qiuya-screenshot-routing-')); t.after(() => rm(base, { recursive: true, force: true }))
  const output = join(base, 'logs'), images = join(base, 'outside-repo-images')
  const paths = [], screenshots = []
  const declaration = runner.match(/async function screenshot\(name[^]*?\n(?=async function test)/u)?.[0]
  assert.ok(declaration)
  const run = new AsyncFunction('output', 'join', 'page', 'screenshots', 'imagePath', 'imageReference', declaration + '\nreturn screenshot("settings-01-computer")')
  await run(output, join, { async screenshot({ path }) { paths.push(path) } }, screenshots, name => join(images, name), name => '../outside-repo-images/' + name)
  assert.deepEqual(paths, [join(images, 'settings-01-computer.png')])
})

test('all ten real React settings pages satisfy their own public semantics without changing preferences or checking updates', async t => {
  const f = await settings(t), pages = []
  for (const definition of acceptance.SETTINGS_ACCEPTANCE_PAGES) {
    const expected = await f.select(definition.id)
    pages.push(acceptance.inspectSettingsTab(f.section, expected))
  }
  assert.equal(pages.length, 10)
  assert.deepEqual(pages.map(row => row.id), acceptance.SETTINGS_ACCEPTANCE_PAGES.map(row => row.id))
  assert.deepEqual(pages.find(row => row.id === 'pastedTextEnabled').thresholds, { '字符数': 1000, '行数': 15 })
  assert.equal(pages.find(row => row.id === 'computer').checked, false, 'computer access is not enabled just to capture settings')
  assert.equal(pages.find(row => row.id === 'qTheme').checked, false, 'a saved false value is legitimate page state')
  assert.deepEqual(pages.find(row => row.id === 'planCommentsEnabled').features, [
    { heading: '计划批注与修改建议', checked: true, guideSteps: 3 },
    { heading: '会话批注与修改建议', checked: true, guideSteps: 3 },
  ])
  assert.equal(pages.find(row => row.id === 'planCommentsEnabled').guideSteps, 6)
  assert.deepEqual(f.writes, [])
  assert.ok(f.calls.some(row => row.endpoint === 'qiuya-tools.workbench' && row.input?.op === 'permissions'), 'computer settings must read the current site-permission list')
  assert.ok(f.calls.every(isReadOnlySettingsCall), 'the visual tour must not check/install updates or perform input')
})

test('the settings tour permits only exact readonly computer and site-permission queries', () => {
  const call = (endpoint, op, channel = '/api') => ({ channel, endpoint, input: { op } })
  for (const op of ['status', 'applications']) assert.equal(isReadOnlySettingsCall(call('qiuya-tools.computer.control', op)), true)
  assert.equal(isReadOnlySettingsCall(call('qiuya-tools.workbench', 'permissions')), true)
  for (const op of ['open', 'decide', 'revoke', 'control', 'close', 'humanAct']) assert.equal(isReadOnlySettingsCall(call('qiuya-tools.workbench', op)), false)
  for (const op of ['request', 'act', 'stop']) assert.equal(isReadOnlySettingsCall(call('qiuya-tools.computer.control', op)), false)
  assert.equal(isReadOnlySettingsCall(call('qiuya-tools.updates', 'check')), false)
  assert.equal(isReadOnlySettingsCall(call('qiuya-tools.workbench', 'permissions', 'other')), false)
})

test('a correct selected tab and heading cannot hide missing feature instructions or invalid persisted thresholds', async t => {
  const f = await settings(t)
  let expected = await f.select('bulkArchiveEnabled')
  f.section.querySelector('[role="tabpanel"]:not([hidden]) ol').replaceChildren()
  assert.throws(() => acceptance.inspectSettingsTab(f.section, expected), /usage steps/u)
  expected = await f.select('pastedTextEnabled')
  f.section.querySelector('[role="tabpanel"]:not([hidden]) input').value = '0'
  assert.throws(() => acceptance.inspectSettingsTab(f.section, expected), /invalid persisted value/u)
})

test('the shared comments page requires independent cards, switches, and matching usage guides', async t => {
  const f = await settings(t), expected = await f.select('planCommentsEnabled')
  const panel = f.section.querySelector('[role="tabpanel"]:not([hidden])')
  const cards = [...panel.querySelectorAll('.qyt-feature-panel')]
  assert.equal(cards.length, 2)
  const conversationCard = cards[1]
  const toggle = conversationCard.querySelector('[role="switch"]')
  toggle.setAttribute('aria-checked', 'false')
  assert.deepEqual(acceptance.inspectSettingsTab(f.section, expected).features.map(feature => feature.checked), [true, false], 'each card reports its own saved toggle value')
  toggle.setAttribute('aria-label', '计划批注与修改建议')
  assert.throws(() => acceptance.inspectSettingsTab(f.section, expected), /independent writable switch/u)
  toggle.setAttribute('aria-label', '会话批注与修改建议')
  const guides = cards.map(card => card.querySelector('.qyt-guide ol'))
  const conversationSteps = [...guides[1].children]
  guides[1].replaceChildren(...[...guides[0].children].map(node => node.cloneNode(true)))
  assert.throws(() => acceptance.inspectSettingsTab(f.section, expected), /usage steps.*another feature/u)
  guides[1].replaceChildren(...conversationSteps)
  assert.equal(acceptance.inspectSettingsTab(f.section, expected).guideSteps, 6)
  guides[1].lastElementChild.remove()
  assert.throws(() => acceptance.inspectSettingsTab(f.section, expected), /feature 会话批注与修改建议 usage steps/u, 'the second card must retain all three of its own steps')
  guides[1].replaceChildren(...conversationSteps)
  conversationCard.remove()
  assert.throws(() => acceptance.inspectSettingsTab(f.section, expected), /missing or extra feature cards/u)
})

test('the settings oracle rejects mixed panels and pending configuration instead of blessing tab presence', async t => {
  const f = await settings(t), expected = await f.select('about')
  const old = f.section.querySelector('[role="tabpanel"][hidden]'); old.hidden = false
  assert.throws(() => acceptance.inspectSettingsTab(f.section, expected), /multiple panels/u)
  old.hidden = true
  f.section.querySelector('.qyt-status').setAttribute('data-state', 'pending')
  assert.throws(() => acceptance.inspectSettingsTab(f.section, expected), /not loaded/u)
})

test('computer settings acceptance requires chat guidance and rejects a restored pairing form', async t => {
  const f = await settings(t), expected = await f.select('computer')
  const hint = f.section.querySelector('.qyt-computer-settings-hint')
  hint.textContent = ''
  assert.throws(() => acceptance.inspectSettingsTab(f.section, expected), /entry guidance/u)
  hint.textContent = '在聊天输入框旁选择操作环境'
  const input = f.section.ownerDocument.createElement('input'); input.type = 'password'; hint.append(input)
  assert.throws(() => acceptance.inspectSettingsTab(f.section, expected), /conversation composer/u)
})

test('external image manifests include only registered evidence, bind bytes, and keep portable relative paths', async t => {
  const base = await mkdtemp(join(tmpdir(), 'qiuya-image-manifest-')); t.after(() => rm(base, { recursive: true, force: true }))
  const output = join(base, 'logs'), directory = join(base, '外部 screenshots')
  await mkdir(directory)
  const layout = acceptance.createHarnessImageLayout(output, directory), bytes = Buffer.from('owned test pixels')
  await writeFile(layout.path('settings-01-computer.png'), bytes)
  await writeFile(join(directory, 'unrelated.png'), 'do not collect an unrelated existing file')
  layout.path('failed-capture.jpg')
  const manifest = await layout.manifest()
  assert.deepEqual(manifest.files, [{ name: 'settings-01-computer.png', path: '../外部 screenshots/settings-01-computer.png', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }])
  assert.deepEqual(manifest.missing, ['../外部 screenshots/failed-capture.jpg'])
  assert.equal(acceptance.createHarnessImageLayout(output).path('legacy.png'), join(output, 'legacy.png'))
  assert.throws(() => layout.path('../profile.json'), /match/u)
  assert.throws(() => layout.path('nested/private.png'), /match/u)
})

test('Windows screenshot routing keeps Mac host paths out of the guest argv and preserves the default evidence folder', () => {
  const guest = 'C:\\Users\\fixture\\AppData\\Local\\Temp\\QiuYaTools-harness-12345678-1234-1234-1234-123456789abc'
  const output = join(tmpdir(), 'qiuya-host-logs'), external = join(tmpdir(), 'qiuya-host-images')
  const plan = acceptance.windowsHarnessScreenshotPlan(output, external, guest)
  assert.deepEqual(plan.argv, ['--screenshots-dir', win32.join(guest, 'screenshots')])
  assert.equal(plan.hostDirectory, external)
  assert.ok(!plan.argv.includes(external))
  assert.deepEqual(acceptance.windowsHarnessScreenshotPlan(output, undefined, guest).argv, [])
  assert.equal(acceptance.windowsHarnessScreenshotPlan(output, undefined, guest).hostDirectory, join(output, 'evidence'))
  assert.equal(relative(output, plan.hostDirectory).split(sep).join('/'), '../qiuya-host-images')
})

test('Windows screenshot delivery binds actual external bytes and rejects tampering or duplicate names', async t => {
  const base = await mkdtemp(join(tmpdir(), 'qiuya-image-delivery-')); t.after(() => rm(base, { recursive: true, force: true }))
  const output = join(base, 'evidence'), directory = join(base, 'external-images'); await mkdir(directory)
  const bytes = Buffer.from('owned settings image'), image = { name: 'settings-01-computer.png', path: '../screenshots/settings-01-computer.png', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  await writeFile(join(directory, image.name), bytes)
  const manifest = { files: [image], missing: [] }
  const result = await acceptance.verifyCollectedHarnessImages(output, directory, manifest)
  assert.equal(result.status, 'passed')
  assert.equal(result.files[0].guestReference, image.path)
  assert.equal(result.files[0].path, '../external-images/settings-01-computer.png')
  await assert.rejects(acceptance.verifyCollectedHarnessImages(output, directory, { files: [image, image], missing: [] }), /repeats/u)
  await writeFile(join(directory, image.name), Buffer.alloc(bytes.length, 1))
  await assert.rejects(acceptance.verifyCollectedHarnessImages(output, directory, manifest), /changed during/u)
  await assert.rejects(acceptance.verifyCollectedHarnessImages(output, directory, { files: [{ ...image, name: '../profile.png' }], missing: [] }), /match/u)
})


test('PowerShell empty file collections normalize to an empty list without accepting malformed JSON', () => {
  for (const source of ['', ' \r\n\t', '\uFEFF  ', 'null', '[]']) assert.deepEqual(acceptance.parseWindowsHarnessFileNames(source), [])
  assert.deepEqual(acceptance.parseWindowsHarnessFileNames('"report.json"'), ['report.json'])
  assert.deepEqual(acceptance.parseWindowsHarnessFileNames('["report.json","settings-01.png"]'), ['report.json', 'settings-01.png'])
  for (const source of ['[', '{"name":', 'undefined', '{"name":"report.json"}', '0', 'false', '[null]', '[[]]', '["../profile.json"]']) {
    assert.throws(() => acceptance.parseWindowsHarnessFileNames(source), undefined, `Must reject ${source}`)
  }
})

test('Windows collection uses the strict empty-array parser and retains failed report verdicts', async () => {
  const source = await readFile(new URL('../scripts/e2e-windows-harness-pd.mjs', import.meta.url), 'utf8')
  assert.match(source, /const names = parseWindowsHarnessFileNames\(await ps\(/u)
  assert.match(source, /for \(const name of names\)/u)
  assert.match(source, /report\.status === 'passed'/u)
  assert.match(source, /install\?\.status === 'failed'/u)
})
