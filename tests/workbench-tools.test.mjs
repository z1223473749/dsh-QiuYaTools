import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'

const root = fileURLToPath(new URL('../', import.meta.url))
const built = await build({ stdin: { resolveDir: root, contents: "export * from './src/features/workbench/tools.ts'; export * from './src/features/workbench/browser-registry.ts'; export * from './src/features/workbench/site-permissions.ts'; export { BrowserDeviceDriver } from './src/features/computer-use/browser.ts'; export { ComputerError } from './src/features/computer-use/contract.ts'" }, bundle: true, write: false, platform: 'node', format: 'esm' })
const { installBrowserWorkbenchTools, BrowserWorkbenchRegistry, BrowserPermissionCoordinator, BrowserDeviceDriver, ComputerError } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))
const turn = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

/** Actual production registry/coordinator/session with a deterministic, non-OS device only. */
function fixture({ recorder, onSelected, initial = [], saveImage } = {}) {
  const agents = new Map(), roots = [], instances = [], saved = [], selected = []
  let permissions
  const registry = new BrowserWorkbenchRegistry({ directory: '/synthetic-no-filesystem', enabled: () => true,
    isAllowed: (...args) => permissions.isAllowed(...args), isCallerCurrent: exec => agents.get(exec.agent?.id) === exec.agent && roots.includes(exec.agent),
    create(options) {
      const state = { rows: [], origins: [...options.allowedOrigins], actions: [], frame: 0, closed: [], launches: 0, beforeObserve: null, beforeAct: null, beforeTargets: null, owned: false }
      const browser = { deviceId: 'browser:tools-' + instances.length, profileDir: options.profileDir,
        async launch() { state.launches++; state.owned = true }, hasOwnedRuntime() { return state.owned }, subscribe() { return () => {} },
        allowedOrigins() { return [...state.origins] }, setAllowedOrigins(value) { state.origins = [...value] },
        async list() { await state.beforeTargets?.(); return state.rows.map(row => ({ ...row, allowed: state.origins.includes(new URL(row.url).origin) })) },
        async open(url, signal, guard) { signal?.throwIfAborted(); guard?.(); const row = { id: 'target-' + (state.rows.length + 1), url, title: 'isolated fixture page', allowed: true }; state.rows.push(row); return { ...row } },
        async metrics() { return { x: 0, y: 0, width: 20, height: 20, scale: 1 } },
        async observe(targetId) { await state.beforeObserve?.(); return { targetId, frameId: 'frame-' + (++state.frame), imageBase64: '/9j/2Q==', mediaType: 'image/jpeg', width: 20, height: 20, elements: 'isolated fixture content', geometry: { x: 0, y: 0, width: 20, height: 20, scale: 1 } } },
        async preview(targetId) { return this.observe(targetId) },
        async act(targetId, action, signal, guard) { await state.beforeAct?.(); signal?.throwIfAborted(); guard?.(); state.actions.push({ targetId, action: { ...action } }); return { applied: true } },
        async navigate(targetId, url, signal, guard) { signal?.throwIfAborted(); guard?.(); if (!state.origins.includes(new URL(url).origin)) throw new ComputerError('SITE_NOT_ALLOWED', 'fixture denied'); state.actions.push({ targetId, action: { kind: 'navigate', url } }); state.rows.find(row => row.id === targetId).url = url },
        async history(targetId, kind, signal, guard) { signal?.throwIfAborted(); guard?.(); state.actions.push({ targetId, action: { kind } }) },
        async closeTab(targetId, signal, guard) { signal?.throwIfAborted(); guard?.(); state.actions.push({ targetId, action: { kind: 'closeTab' } }); await this.closeOwnedTab(targetId) },
        async closeOwnedTab(targetId) { assert.ok(state.rows.some(row => row.id === targetId)); state.closed.push(targetId); state.rows = state.rows.filter(row => row.id !== targetId) },
        async navigationState() { return { canGoBack: false, canGoForward: false } }, invalidateObservations() {}, async releaseInputs() {}, async close() { state.owned = false },
      }
      instances.push({ state, browser }); return { browser, driver: new BrowserDeviceDriver(browser) }
    },
  })
  permissions = new BrowserPermissionCoordinator({ backend: registry, enabled: () => true, lookupAgent: id => agents.get(id), isRootAgent: agent => roots.includes(agent), readAllowedOrigins: () => initial, writeAllowedOrigins: async () => {} })
  const image = { attachmentId: AttachmentId('isolated-workbench-image'), mediaType: 'image/jpeg', bytes: 4, width: 20, height: 20 }
  const attachmentService = { async saveImage(input) { saved.push(input); await saveImage?.(input); return image } }
  const agent = (id = 'chat-tools') => { if (!agents.has(id)) { const value = { id }; agents.set(id, value); roots.push(value) } return agents.get(id) }
  const owner = () => ({ signal: new AbortController().signal, assertCurrent() {} })
  const options = { recorder: recorder ? { async observed() {}, async issuing() {}, ...recorder } : undefined, onSelected(exec, context) { selected.push({ exec, context }); onSelected?.(exec, context) } }
  return { registry, permissions, agents, roots, instances, saved, selected, image, attachmentService, options, agent, owner,
    async directOpen(id = 'chat-tools', url = 'https://allowed.test/page') {
      const exec = { callId: randomUUID(), agent: agent(id), signal: new AbortController().signal }, waiting = permissions.request(exec, { url, reason: 'isolated tool fixture', browser: 'chrome' }); void waiting.catch(() => {})
      const card = permissions.pending(id)[0]; if (card) await permissions.decide(id, card.requestId, 1, 'once', owner())
      return { exec, target: await waiting }
    },
    async dispose() { await permissions.dispose(); await registry.dispose() },
  }
}

async function runtime(t, f) {
  const ctx = new Context(), system = ctx.plugin(child => child.provide('systemPrompt', { tools() { return () => {} } })); await system.await()
  const actual = ctx.plugin(ToolRuntime); await actual.await()
  const attachments = ctx.plugin(child => child.provide('attachments', f.attachmentService)); await attachments.await()
  let unregister, injection
  const plugin = ctx.plugin(child => { injection = child.inject(['tools', 'attachments'], active => { unregister = installBrowserWorkbenchTools(active, f.registry, f.permissions, f.options) }) })
  await plugin.await(); await injection.await()
  const tools = ctx.get('tools'), abort = new AbortController()
  t.after(async () => { unregister(); await plugin.dispose(); await attachments.dispose(); await actual.dispose(); await system.dispose(); await f.dispose() })
  return { tools, unregister, abort, call(name, args = {}, { id = 'chat-tools', agent = f.agent(id), signal = abort.signal } = {}) { return tools.execute({ callId: randomUUID(), name: 'qiuya_browser_' + name, arguments: args, agent, signal }) } }
}
const params = target => ({ environmentId: target.environmentId, workbenchTabId: target.workbenchTabId })
async function observed(r, target, options) { const value = await r.call('observe', params(target), options); assert.equal(value.isError, false); return value.value }
const actArgs = (target, frame, action = { kind: 'click', x: 2, y: 3 }) => ({ ...params(target), frameId: frame.frameId, action })
async function waitPending(f, id = 'chat-tools') { for (let i = 0; i < 30; i++) { const p = f.permissions.pending(id)[0]; if (p) return p; await turn() } throw Error('actual runtime did not reach approval') }

test('real public ToolRuntime admits all six schemas and exact unregister removes them', async t => {
  const f = fixture(), r = await runtime(t, f)
  assert.deepEqual(r.tools.schemas().map(value => value.name).sort(), ['act', 'observe', 'open', 'pause', 'select', 'tabs'].map(name => 'qiuya_browser_' + name).sort())
  r.unregister(); assert.equal(r.tools.schemas().length, 0)
})
test('actual runtime open waits for exact-origin owner approval before creating a device, then emits a real captured selection', async t => {
  const f = fixture(), r = await runtime(t, f), opening = r.call('open', { url: 'https://allowed.test/page', reason: 'read fixture', browser: 'chrome' })
  const card = await waitPending(f); assert.equal(f.instances.length, 0); assert.equal(card.origin, 'https://allowed.test')
  await f.permissions.decide('chat-tools', card.requestId, 1, 'once', f.owner()); const result = await opening
  assert.equal(result.isError, false); assert.equal(result.value.kind, 'browser'); assert.equal(f.instances.length, 1); assert.equal(f.selected.length, 1)
  assert.equal(f.selected[0].context.environmentId, result.value.environmentId); f.selected[0].context.assertCurrent()
})
test('denial does not launch, save an image or select a model target', async t => {
  const f = fixture(), r = await runtime(t, f), opening = r.call('open', { url: 'https://denied.test', reason: 'denied fixture' }), card = await waitPending(f)
  await f.permissions.decide('chat-tools', card.requestId, 1, 'deny', f.owner()); const result = await opening
  assert.equal(result.isError, true); assert.match(result.error.message, /SITE_DENIED/u); assert.equal(f.instances.length, 0); assert.equal(f.saved.length, 0); assert.equal(f.selected.length, 0)
})
test('canonical screenshot output uses actual saved public image reference and never publishes raw base64', async t => {
  const seen = [], f = fixture({ recorder: { async observed(exec, context, observation, image) { seen.push({ exec, context, observation, image }); return { runId: 'fixture-run' } } } }), opened = await f.directOpen(), r = await runtime(t, f)
  const result = await r.call('observe', params(opened.target))
  assert.equal(result.isError, false); assert.equal(f.saved.length, 1); assert.deepEqual([...f.saved[0].data], [255, 216, 255, 217])
  assert.equal(result.content.find(block => block.type === 'image').attachment.attachmentId, f.image.attachmentId)
  assert.equal(result.value.image.attachmentId, f.image.attachmentId); assert.equal('imageBase64' in result.value, false); assert.equal(JSON.stringify(result.content).includes('/9j/2Q=='), false)
  assert.equal(seen.length, 1); assert.equal(seen[0].image, f.image); assert.equal(seen[0].context.environmentId, opened.target.environmentId); assert.equal(result.value.acceptance.runId, 'fixture-run')
})
test('tabs and owner view-only preview never notify the trusted model-target selector', async t => {
  const f = fixture(), a = await f.directOpen(), b = await f.directOpen('chat-other'), r = await runtime(t, f)
  assert.equal((await r.call('tabs')).value.tabs.length, 1)
  await f.registry.preview('chat-other', b.target.environmentId, b.target.workbenchTabId, f.owner()); assert.equal(f.selected.length, 0)
  assert.equal((await r.call('observe', params(a.target))).isError, false); assert.equal(f.selected.length, 1)
})
test('explicit model select changes only an already-authorized same-chat view, then requires a fresh frame', async t => {
  const f = fixture(), a = await f.directOpen(), b = await f.directOpen(), r = await runtime(t, f), freshB = await observed(r, b.target)
  const selected = await r.call('select', params(a.target)); assert.equal(selected.isError, false); assert.equal(selected.value.targetId, a.target.targetId)
  assert.equal(f.selected.at(-1).context.targetId, a.target.targetId)
  assert.equal((await r.call('act', actArgs(a.target, freshB))).isError, true); assert.equal(f.instances[0].state.actions.length, 0)
  const freshA = await observed(r, selected.value); assert.equal((await r.call('act', actArgs(selected.value, freshA))).isError, false)
})
test('paused control cannot be resumed or switched by the model select tool', async t => {
  const f = fixture(), a = await f.directOpen(), b = await f.directOpen(), r = await runtime(t, f)
  assert.equal((await r.call('pause', params(b.target))).isError, false)
  const selected = await r.call('select', params(a.target)); assert.equal(selected.isError, true); assert.match(selected.error.message, /OWNER_RESUME_REQUIRED/u); assert.equal(f.instances[0].state.actions.length, 0)
})
for (const addition of [{ chatSessionId: 'another-chat' }, { context: {} }, { service: {} }, { principal: 'owner' }, { environmentId: 'forged' }]) test('actual schema rejects forged authority field ' + Object.keys(addition)[0], async t => {
  const f = fixture(), r = await runtime(t, f), result = await r.call('open', { url: 'https://allowed.test', reason: 'fixture', ...addition })
  assert.equal(result.isError, true); assert.equal(f.instances.length, 0); assert.equal(f.permissions.pending().length, 0)
})
test('another live chat and forged same-id Agent cannot observe or select a known environment', async t => {
  const f = fixture(), a = await f.directOpen(), r = await runtime(t, f)
  for (const name of ['observe', 'select']) { assert.equal((await r.call(name, params(a.target), { id: 'chat-other' })).isError, true); assert.equal((await r.call(name, params(a.target), { agent: { ...f.agent() } })).isError, true) }
  assert.equal(f.saved.length, 0); assert.equal(f.selected.length, 0)
})
test('same-frame act is single-use through actual ToolRuntime, registry and session; no click replay refreshes it', async t => {
  const completions = [], f = fixture({ recorder: { async issuing() { return async value => { completions.push(value); return { phase: value ? 'acknowledged' : 'unknown' } } } } }), a = await f.directOpen(), r = await runtime(t, f), image = await observed(r, a.target)
  assert.equal((await r.call('act', actArgs(a.target, image))).isError, false)
  const stale = await r.call('act', actArgs(a.target, image, { kind: 'type', text: 'fixture text' })); assert.equal(stale.isError, true)
  assert.deepEqual(f.instances[0].state.actions.map(value => value.action.kind), ['click']); assert.equal(completions.length, 2); assert.equal(completions[1], undefined)
  const fresh = await observed(r, a.target); assert.equal((await r.call('act', actArgs(a.target, fresh, { kind: 'type', text: 'fixture text' }))).isError, false)
  assert.deepEqual(f.instances[0].state.actions.map(value => value.action.kind), ['click', 'type'])
})
test('permission revoked while issued recorder waits triggers exactly one unknown completion and zero dispatch', async t => {
  const barrier = deferred(), entered = deferred(), completions = [], f = fixture({ recorder: { async issuing() { entered.resolve(); await barrier.promise; return async value => { completions.push(value) } } } }), a = await f.directOpen(), r = await runtime(t, f), image = await observed(r, a.target)
  const acting = r.call('act', actArgs(a.target, image)); await entered.promise; await f.permissions.revoke('https://allowed.test'); barrier.resolve(); const result = await acting
  assert.equal(result.isError, true); assert.deepEqual(completions, [undefined]); assert.equal(f.instances[0].state.actions.length, 0)
})
test('root Agent replacement while issued recorder waits cannot dispatch; completion still receives unknown once', async t => {
  const barrier = deferred(), entered = deferred(), completions = [], f = fixture({ recorder: { async issuing() { entered.resolve(); await barrier.promise; return async value => { completions.push(value) } } } }), a = await f.directOpen(), r = await runtime(t, f), image = await observed(r, a.target)
  const acting = r.call('act', actArgs(a.target, image)); await entered.promise; f.agents.set('chat-tools', { id: 'chat-tools' }); barrier.resolve(); const result = await acting
  assert.equal(result.isError, true); assert.deepEqual(completions, [undefined]); assert.equal(f.instances[0].state.actions.length, 0)
})
test('driver failure after issued retains exactly one unknown completion without leaking private diagnostics', async t => {
  const completions = [], f = fixture({ recorder: { async issuing() { return async value => { completions.push(value) } } } }), a = await f.directOpen(), r = await runtime(t, f), image = await observed(r, a.target)
  f.instances[0].state.beforeAct = () => { throw new Error('/private/secret fixture content') }
  const result = await r.call('act', actArgs(a.target, image)); assert.equal(result.isError, true); assert.deepEqual(completions, [undefined]); assert.equal(f.instances[0].state.actions.length, 0); assert.doesNotMatch(JSON.stringify(result), /\/private\/secret/u)
})
test('cancellation after issued causes unknown completion, zero dispatch and no new execution identity', async t => {
  const barrier = deferred(), entered = deferred(), calls = [], controller = new AbortController(), f = fixture({ recorder: { async issuing(exec) { entered.resolve(); await barrier.promise; return async value => { calls.push({ value, exec }) } } } }), a = await f.directOpen(), r = await runtime(t, f), image = await observed(r, a.target)
  const acting = r.call('act', actArgs(a.target, image), { signal: controller.signal }); await entered.promise; controller.abort(); barrier.resolve(); const result = await acting
  assert.equal(result.isError, true); assert.equal(calls.length, 1); assert.equal(calls[0].value, undefined); assert.equal(calls[0].exec.signal.aborted, true); assert.equal(f.instances[0].state.actions.length, 0)
})
test('post-navigation recorder wait cannot publish success after site revocation, and an ACK completion is never replayed', async t => {
  const barrier = deferred(), entered = deferred(), completions = [], f = fixture({ initial: ['https://other.test'], recorder: { async issuing() { return async value => { completions.push(value); entered.resolve(); await barrier.promise; return { phase: 'acknowledged' } } } } }), a = await f.directOpen(), r = await runtime(t, f), image = await observed(r, a.target)
  const acting = r.call('act', actArgs(a.target, image, { kind: 'navigate', url: 'https://other.test/page' })); await entered.promise; await f.permissions.revoke('https://other.test'); barrier.resolve(); const result = await acting
  assert.equal(result.isError, true); assert.equal(completions.length, 1); assert.ok(completions[0]); assert.equal(f.instances[0].state.actions.length, 1)
})
test('confirmed navigation legitimately updates selected Host context without reusing the old target appId or frame', async t => {
  const f = fixture({ initial: ['https://other.test'], recorder: { async issuing() { return async () => ({ phase: 'acknowledged' }) } } }), a = await f.directOpen(), r = await runtime(t, f), image = await observed(r, a.target)
  const result = await r.call('act', actArgs(a.target, image, { kind: 'navigate', url: 'https://other.test/page' }))
  assert.equal(result.isError, false); assert.equal(result.value.workbench.origin, 'https://other.test'); assert.equal(f.selected.at(-1).context.service.get('chat-tools').target.appId.endsWith(':https://other.test'), true); f.selected.at(-1).context.assertCurrent()
  assert.equal((await r.call('act', actArgs(result.value.workbench, image))).isError, true); assert.equal(f.instances[0].state.actions.length, 1)
})
test('completion storage failure is surfaced once without retrying the already completed input or completion callback', async t => {
  const completions = [], f = fixture({ recorder: { async issuing() { return async value => { completions.push(value); throw Error('fixture store acknowledgement unknown') } } } }), a = await f.directOpen(), r = await runtime(t, f), image = await observed(r, a.target)
  const result = await r.call('act', actArgs(a.target, image)); assert.equal(result.isError, true); assert.equal(completions.length, 1); assert.ok(completions[0]); assert.equal(f.instances[0].state.actions.length, 1)
})
test('revocation while saveImage waits prevents recorder evidence publication and rendered image output', async t => {
  const barrier = deferred(), entered = deferred(), recorded = [], f = fixture({ saveImage: async () => { entered.resolve(); await barrier.promise }, recorder: { async observed(...args) { recorded.push(args) } } }), a = await f.directOpen(), r = await runtime(t, f)
  const observing = r.call('observe', params(a.target)); await entered.promise; await f.permissions.revoke('https://allowed.test'); barrier.resolve(); const result = await observing
  assert.equal(result.isError, true); assert.equal(recorded.length, 0); assert.equal(result.content.some(value => value.type === 'image'), false)
})
test('Agent replacement during completion await blocks the final result after exactly one real completed action', async t => {
  const barrier = deferred(), entered = deferred(), completed = [], f = fixture({ recorder: { async issuing() { return async value => { completed.push(value); entered.resolve(); await barrier.promise } } } }), a = await f.directOpen(), r = await runtime(t, f), image = await observed(r, a.target)
  const acting = r.call('act', actArgs(a.target, image)); await entered.promise; f.agents.set('chat-tools', { id: 'chat-tools' }); barrier.resolve(); const result = await acting
  assert.equal(result.isError, true); assert.equal(completed.length, 1); assert.ok(completed[0]); assert.equal(f.instances[0].state.actions.length, 1)
})
test('closing the last target confirms the stopped service without inventing a replacement selection or retry', async t => {
  const completed = [], f = fixture({ recorder: { async issuing() { return async value => { completed.push(value); return { phase: 'acknowledged' } } } } }), a = await f.directOpen(), r = await runtime(t, f), image = await observed(r, a.target), selections = f.selected.length
  const result = await r.call('act', actArgs(a.target, image, { kind: 'closeTab' }))
  assert.equal(result.isError, false); assert.equal(result.value.workbench, undefined); assert.equal(completed.length, 1); assert.equal(f.selected.length, selections)
  assert.deepEqual(f.instances[0].state.actions.map(value => value.action.kind), ['closeTab']); assert.deepEqual(f.registry.views('chat-tools'), [])
})
test('last-tab close completion cannot bypass exact Agent post-fence merely because no new workbench target exists', async t => {
  const barrier = deferred(), entered = deferred(), completed = [], f = fixture({ recorder: { async issuing() { return async value => { completed.push(value); entered.resolve(); await barrier.promise } } } }), a = await f.directOpen(), r = await runtime(t, f), image = await observed(r, a.target)
  const acting = r.call('act', actArgs(a.target, image, { kind: 'closeTab' })); await entered.promise; f.agents.set('chat-tools', { id: 'chat-tools' }); barrier.resolve(); const result = await acting
  assert.equal(result.isError, true); assert.equal(completed.length, 1); assert.ok(completed[0]); assert.equal(f.instances[0].state.actions.length, 1); assert.equal(f.instances[0].state.rows.length, 0)
})
test('unconfirmed issued-store failure prevents all device input and never fabricates a completion closure', async t => {
  let issued = 0; const f = fixture({ recorder: { async issuing() { issued++; throw Error('STORE_COMMIT_UNCONFIRMED private fixture path') } } }), a = await f.directOpen(), r = await runtime(t, f), image = await observed(r, a.target)
  const result = await r.call('act', actArgs(a.target, image)); assert.equal(result.isError, true); assert.equal(issued, 1); assert.equal(f.instances[0].state.actions.length, 0); assert.doesNotMatch(JSON.stringify(result), /private fixture path/u)
})
test('failed trusted target notification blocks observe before any screenshot or attachment work', async t => {
  const f = fixture({ onSelected() { throw Error('trusted selector rejected stale binding') } }), a = await f.directOpen(), r = await runtime(t, f)
  const before = f.instances[0].state.frame, result = await r.call('observe', params(a.target))
  assert.equal(result.isError, true); assert.equal(f.instances[0].state.frame, before); assert.equal(f.saved.length, 0)
})
test('canonical projection preserves all real public image-reference fields including normalized original dimensions', async t => {
  const f = fixture(), a = await f.directOpen(), r = await runtime(t, f); f.image.name = 'fixture-image.jpg'; f.image.originalDimensions = { width: 40, height: 40 }
  const result = await r.call('observe', params(a.target)); assert.equal(result.isError, false)
  const attachment = result.content.find(value => value.type === 'image').attachment
  assert.equal(attachment.name, f.image.name); assert.deepEqual(attachment.originalDimensions, f.image.originalDimensions); assert.equal(attachment.mediaType, f.image.mediaType); assert.equal(attachment.attachmentId, f.image.attachmentId)
})
test('real SDK action schema rejects an unsupported operation before recorder or device dispatch', async t => {
  let issued = 0; const f = fixture({ recorder: { async issuing() { issued++ } } }), a = await f.directOpen(), r = await runtime(t, f), image = await observed(r, a.target)
  const result = await r.call('act', actArgs(a.target, image, { kind: 'shell', text: 'unsupported fixture' }))
  assert.equal(result.isError, true); assert.equal(issued, 0); assert.equal(f.instances[0].state.actions.length, 0)
})
