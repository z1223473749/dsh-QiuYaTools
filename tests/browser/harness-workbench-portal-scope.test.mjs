/** Explicit integration test: real isolated headless Chromium, never the personal Harness. */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { locateHarnessWorkbenchChat, captureHarnessWorkbenchScope } from '../../scripts/harness-workbench-ui-evidence.mjs'

const sessionId = 'own-chat', foreignId = 'foreign-chat'
let browser, context
before(async () => {
  const executablePath = [
    process.env.QIUYA_TEST_CHROMIUM,
    process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined,
    process.platform === 'win32' ? join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe') : undefined,
    chromium.executablePath(),
  ].find(value => value && existsSync(value))
  assert(executablePath, 'The explicit real-browser suite requires an installed Chromium executable')
  browser = await chromium.launch({ executablePath, headless: true })
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await context.route('**/*', route => route.abort())
})
after(async () => { await context?.close(); await browser?.close() })

const markup = ({ phase = 'active', chat = sessionId } = {}) => `<!doctype html><html><head><style>
body { margin: 0 } [data-phase] { width: 900px; height: 700px; position: relative }
[data-conversation-content] { width: 800px; height: 500px }
.qyt-workbench-small-anchor,.qyt-workbench-small-portal { width: 0; height: 0; position: relative }
.qyt-workbench-approvals,.qyt-workbench-small { position: fixed; top: 40px; right: 40px; width: 300px; height: 180px; background: white }
</style></head><body><main data-phase="${phase}"><div data-conversation-content data-conversation-session="${chat}"></div><div class="qyt-workbench-small-anchor" data-qyt-workbench-anchor="${chat}"></div></main><div class="qyt-workbench-small-portal" data-qyt-workbench-chat="${chat}"><div class="qyt-workbench-approvals"><section aria-label="电脑操作授权"><button>允许一次</button></section></div></div></body></html>`
async function setup(t, options) { const page = await context.newPage(); t.after(() => page.close()); await page.setContent(markup(options)); return page }
async function rawScope(page) { return page.locator(`[data-qyt-workbench-chat="${sessionId}"]`).first().evaluate(captureHarnessWorkbenchScope, { sessionId }) }
async function deny(page, pattern) {
  const selected = locateHarnessWorkbenchChat(page, sessionId)
  assert.equal(await selected.anchor.count(), 0, 'The locator must not expose a card outside the unique current-chat ownership contract')
  if (await page.locator(`[data-qyt-workbench-chat="${sessionId}"]`).count()) await assert.rejects(rawScope(page), pattern)
}

test('formal body portal binds the unique visible official chat and its zero-area input-overlay marker', async t => {
  const page = await setup(t), selected = locateHarnessWorkbenchChat(page, sessionId)
  assert.equal(await selected.owner.count(), 1)
  assert.equal(await selected.anchor.count(), 1)
  assert.equal(await selected.anchor.getByRole('region', { name: '电脑操作授权', exact: true }).count(), 1)
  const scope = await selected.anchor.evaluate(captureHarnessWorkbenchScope, { sessionId })
  assert.equal(scope.ownership, 'input-overlay-body-portal')
  for (const key of ['uniqueOwnPanel', 'uniqueOwnContent', 'uniqueOwnAnchor', 'uniqueOwnPortal', 'markerConnected', 'portalConnected', 'markerNearestPhaseMatchesOwner']) assert.equal(scope[key], true, key)
  assert.equal(scope.contentChatSessionId, sessionId); assert.equal(scope.markerChatSessionId, sessionId); assert.equal(scope.portalChatSessionId, sessionId)
  assert.deepEqual(scope.markerBox, { width: 0, height: 0 }); assert.deepEqual(scope.anchorBox, { width: 0, height: 0 })
  assert.equal(scope.anchorAreaRequired, false); assert.equal(scope.portalAreaRequired, false)
  assert.equal(scope.portalParent, 'body'); assert.equal(scope.cardBox.width, 300); assert.equal(scope.cardBox.height, 180)
})
for (const phase of ['settling', 'hero']) test(`official ${phase} phase is supported with real visible card`, async t => {
  const page = await setup(t, { phase }), selected = locateHarnessWorkbenchChat(page, sessionId)
  assert.equal(await selected.anchor.count(), 1)
  assert.equal((await rawScope(page)).phase, phase)
})
test('preview card and authorization card use the same portal ownership', async t => {
  const page = await setup(t); await page.locator('.qyt-workbench-approvals').evaluate(node => { node.className = 'qyt-workbench-small'; node.setAttribute('aria-label', '电脑实时预览') })
  assert.equal(await locateHarnessWorkbenchChat(page, sessionId).anchor.getByLabel('电脑实时预览', { exact: true }).count(), 1)
  assert.equal((await rawScope(page)).cardKind, 'preview')
})
test('a foreign inactive chat and its separate portal do not become the current owner', async t => {
  const page = await setup(t)
  await page.evaluate(foreignId => { const panel = document.querySelector('main').cloneNode(true); panel.dataset.phase = 'inactive'; panel.querySelector('[data-conversation-session]').dataset.conversationSession = foreignId; panel.querySelector('[data-qyt-workbench-anchor]').dataset.qytWorkbenchAnchor = foreignId; document.body.append(panel); const portal = document.querySelector('[data-qyt-workbench-chat]').cloneNode(true); portal.dataset.qytWorkbenchChat = foreignId; document.body.append(portal) }, foreignId)
  assert.equal(await locateHarnessWorkbenchChat(page, sessionId).anchor.count(), 1); assert.equal((await rawScope(page)).chatSessionId, sessionId)
})
for (const phase of ['inactive', 'hidden', 'gone']) test(`rejects ${phase} current panel`, async t => {
  const page = await setup(t, { phase }); await deny(page, /VISIBLE_CONVERSATION_OWNER/)
})
for (const target of ['main', '[data-conversation-content]', '.qyt-workbench-approvals']) test(`rejects hidden ${target}`, async t => {
  const page = await setup(t); await page.locator(target).evaluate(node => { node.style.display = 'none' }); await deny(page, /VISIBLE_CONVERSATION_OWNER|VISIBLE_WORKBENCH_CARD/)
})
for (const nodeName of ['marker', 'portal', 'content']) test(`rejects duplicate same-chat ${nodeName}`, async t => {
  const page = await setup(t), selector = { marker: '[data-qyt-workbench-anchor]', portal: '[data-qyt-workbench-chat]', content: '[data-conversation-content]' }[nodeName]
  await page.locator(selector).evaluate(node => node.parentElement.append(node.cloneNode(true)))
  await deny(page, /AMBIGUOUS_WORKBENCH_MARKER|AMBIGUOUS_WORKBENCH_PORTAL|WRONG_VISIBLE_CONVERSATION_OWNER/)
})
test('rejects duplicate hidden same-chat marker', async t => {
  const page = await setup(t); await page.locator('[data-qyt-workbench-anchor]').evaluate(node => { const duplicate = node.cloneNode(true); duplicate.style.display = 'none'; node.parentElement.append(duplicate) }); await deny(page, /AMBIGUOUS_WORKBENCH_MARKER/)
})
for (const attribute of ['data-qyt-workbench-anchor', 'data-qyt-workbench-chat', 'data-conversation-session']) test(`rejects foreign ${attribute}`, async t => {
  const page = await setup(t); await page.locator(`[${attribute}]`).evaluate((node, { attribute, foreignId }) => node.setAttribute(attribute, foreignId), { attribute, foreignId }); await deny(page, /WORKBENCH_MARKER|WRONG_VISIBLE_CONVERSATION_OWNER/)
})
for (const selector of ['[data-qyt-workbench-anchor]', '[data-qyt-workbench-chat]', '[data-conversation-content]']) test(`rejects missing ${selector}`, async t => {
  const page = await setup(t); await page.locator(selector).evaluate(node => node.remove()); await deny(page, /WORKBENCH_MARKER|WRONG_VISIBLE_CONVERSATION_OWNER/)
})
test('a marker in a nested inactive phase cannot stand in for the visible parent', async t => {
  const page = await setup(t); await page.locator('[data-qyt-workbench-anchor]').evaluate(node => { const nested = document.createElement('div'); nested.dataset.phase = 'inactive'; node.before(nested); nested.append(node) }); await deny(page, /WRONG_WORKBENCH_MARKER_OWNER/)
})
test('a portal nested inside an official panel cannot masquerade as the formal body portal', async t => {
  const page = await setup(t); await page.locator('[data-qyt-workbench-chat]').evaluate(node => document.querySelector('main').append(node)); await deny(page, /WRONG_WORKBENCH_PORTAL_OWNER/)
})
test('visible foreign content inside the same official phase invalidates ownership', async t => {
  const page = await setup(t); await page.locator('[data-conversation-content]').evaluate((node, foreignId) => { const duplicate = node.cloneNode(true); duplicate.dataset.conversationSession = foreignId; node.parentElement.append(duplicate) }, foreignId); await deny(page, /WRONG_VISIBLE_CONVERSATION_OWNER/)
})
test('a foreign marker inside the same official phase invalidates ownership', async t => {
  const page = await setup(t); await page.locator('[data-qyt-workbench-anchor]').evaluate((node, foreignId) => { const duplicate = node.cloneNode(true); duplicate.dataset.qytWorkbenchAnchor = foreignId; node.parentElement.append(duplicate) }, foreignId); await deny(page, /AMBIGUOUS_WORKBENCH_MARKER/)
})
test('two actual visible cards inside one portal are ambiguous', async t => {
  const page = await setup(t); await page.locator('.qyt-workbench-approvals').evaluate(node => node.parentElement.append(node.cloneNode(true))); await deny(page, /VISIBLE_WORKBENCH_CARD/)
})
test('a disconnected portal node cannot produce scope evidence', async t => {
  const page = await setup(t), handle = await page.locator('[data-qyt-workbench-chat]').elementHandle(); await handle.evaluate(node => node.remove()); await assert.rejects(handle.evaluate(captureHarnessWorkbenchScope, { sessionId }), /WRONG_WORKBENCH_CHAT/)
})
test('a disconnected marker cannot produce scope evidence for a surviving portal', async t => {
  const page = await setup(t); await page.locator('[data-qyt-workbench-anchor]').evaluate(node => node.remove()); await deny(page, /WORKBENCH_MARKER/)
})
