import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context, Service, symbols } from '@deepseek-ai/cordis'

const directory = await mkdtemp(join(tmpdir(), 'qyt-git-worktree-ui-'))
await build({ entryPoints: [fileURLToPath(new URL('../src/features/git/worktree-client.ts', import.meta.url))], bundle: true, outfile: join(directory, 'navigation.mjs'), platform: 'node', format: 'esm', plugins: [{ name: 'shared-cordis-symbols', setup(builder) { builder.onResolve({ filter: /^@deepseek-ai\/cordis$/ }, () => ({ path: fileURLToPath(import.meta.resolve('@deepseek-ai/cordis')), external: true })) } }] })
const { createGitWorktreeNavigation } = await import(pathToFileURL(join(directory, 'navigation.mjs')).href)
test.after(() => rm(directory, { recursive: true, force: true }))
const receipt = { completed: true, message: 'Prepared', worktreePath: '/synthetic/worktree', branch: 'feature/custom', snapshot: { repoName: 'Project' } }
const model = { provider: 'synthetic', model: 'model-1', reasoningEffort: 'high' }
function source(initial) { let value = initial; const listeners = new Set(); return { getSnapshot: () => value, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) }, set(next) { value = next; for (const listener of [...listeners]) listener() }, get listeners() { return listeners.size } } }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { resolve, reject, promise } }
const turn = () => new Promise(resolve => setImmediate(resolve))
function fixture(options = {}) {
  const current = source({ key: 'original' }), generation = source({ id: 1 }), bindings = new Map(), inputs = new Map(), blockStores = new Map(), drafts = new Map(), events = [], references = new Map()
  const catalog = source({ phase: 'ready', byId: { original: { cwd: '/synthetic/original', projectionValues: { agentPreset: 'create' } } } })
  const block = id => { if (!blockStores.has(id)) blockStores.set(id, source(undefined)); return blockStores.get(id) }
  function bind(id, preset = 'create') {
    const state = source({ blank: true, running: false, removed: false, subagent: null, openState: 'open', pendingSubmissions: [], awaitingFirstTurn: false })
    const projections = new Map([['modelSelection', source({ next: id === 'original' ? model : null, lastUsed: null })], ['permissions', source({ currentValue: id === 'original' ? 'workspace' : 'read-only' })]])
    const session = { ...state, projections: { faceOf(key) { if (!projections.has(key)) projections.set(key, source(undefined)); return projections.get(key) } }, async command(line) { events.push(['command', id, line]); if (options.command) return options.command(id, line, projections); projections.get('permissions').set({ currentValue: line.split(' ')[1] }); return { ok: true, value: { matched: true } } } }
    const inputState = source({ draft: id === 'original' ? 'Keep my draft\n第二行' : '', draftRev: 1, attachmentIds: id === 'original' ? [...(options.ids ?? [])] : [], phase: 'plain', occurrences: [], queue: [] })
    const input = { state: inputState, setDraft(text) { if (options.setDraft) options.setDraft(id, text); const value = inputState.getSnapshot(); inputState.set({ ...value, draft: text, draftRev: value.draftRev + 1 }) }, addAttachments(ids) { if (options.addAttachments?.(id, ids) === false) return false; inputState.set({ ...inputState.getSnapshot(), attachmentIds: [...inputState.getSnapshot().attachmentIds, ...ids] }); return true }, removeAttachment(attachmentId) { const value = inputState.getSnapshot(); if (!value.attachmentIds.includes(attachmentId)) return false; inputState.set({ ...value, attachmentIds: value.attachmentIds.filter(id => id !== attachmentId) }); return true } }
    const context = { sessionId: id }, binding = { sessionId: id, ctx: context, session }
    bindings.set(id, binding); inputs.set(id, input)
    if (id !== 'original') catalog.set({ ...catalog.getSnapshot(), byId: { ...catalog.getSnapshot().byId, [id]: { cwd: receipt.worktreePath, projectionValues: { agentPreset: preset } } } })
    return binding
  }
  bind('original')
  for (const id of options.ids ?? []) drafts.set(id, { id, kind: id.startsWith('image') ? 'image' : 'file' })
  const services = {
    sessions: { list: catalog, async create(request) { events.push(['create-session', request]); if (options.createSession) await options.createSession(); bind('target', request.agentPreset); return 'target' }, retain(id) { const binding = bindings.get(id); assert.ok(binding); references.set(id, (references.get(id) ?? 0) + 1); let released = false; return { binding, ready: Promise.resolve(binding), release() { if (!released) { released = true; references.set(id, references.get(id) - 1) } } } }, binding: id => bindings.get(id), async refreshProjections(id) { events.push(['refresh', id]); if (options.refresh) await options.refresh(id) } },
    conversation: { input: { for: context => inputs.get(context.sessionId), requestDraftInitialization(binding, request) { events.push(['initialize', binding.sessionId]); if (options.initialize) return options.initialize(binding.sessionId); inputs.get(binding.sessionId).setDraft(request.prompt); return 'applied' } }, blocks: { storeFor: block, set(id, value) { block(id).set(value) } }, resolveDraftAttachments(ids) { return ids.map(id => drafts.get(id)).filter(Boolean) }, rebindDraftFiles(id, ids) { events.push(['rebind', id, [...ids]]); if (options.rebind) options.rebind(id, ids) } },
    workspaces: { async create(request) { events.push(['create-workspace', request]); if (options.createWorkspace) await options.createWorkspace(); return { workspaceId: 'worktree-workspace', path: request.path } }, async rename(id, title) { events.push(['rename-workspace', id, title]) } },
    uiWorkspace: { openSession(id) { events.push(['open', id]); if (options.open) return options.open(id, current); current.set({ key: id }) } },
    uiSession: { adapter: { current } }, connection: { generation },
    remote: { session: { async modelCatalog() { events.push(['model-catalog']); return { ok: true, value: { default: model } } }, async selectModel(request) { events.push(['select-model', request]); if (options.selectModel) return options.selectModel(request); bindings.get(request.sessionId).session.projections.faceOf('modelSelection').set({ next: { provider: request.provider, model: request.model, reasoningEffort: request.reasoningEffort }, lastUsed: null }); return { ok: true, value: { selected: model } } } } },
    modelDirectories: { directoryFor() { return { store: source({ pending: null, status: 'ready' }) } } },
  }
  const ctx = { get: name => services[name] }
  const navigation = createGitWorktreeNavigation(ctx)
  return { ctx, services, navigation, current, generation, bindings, inputs, block, events, references, catalog, drafts }
}

test('plain draft, agent preset, selected model and reasoning effort, and permissions move to the exact new Session', async () => {
  const f = fixture()
  try {
    assert.equal(f.navigation.available, true); await f.navigation.preflight('original'); await f.navigation.openWorktree('original', receipt)
    assert.equal(f.current.getSnapshot().key, 'target'); assert.equal(f.inputs.get('target').state.getSnapshot().draft, 'Keep my draft\n第二行'); assert.equal(f.inputs.get('original').state.getSnapshot().draft, '')
    assert.deepEqual(f.events.find(row => row[0] === 'create-session')[1], { workspaceId: 'worktree-workspace', agentPreset: 'create' })
    assert.deepEqual(f.events.find(row => row[0] === 'select-model')[1], { sessionId: 'target', ...model })
    assert.deepEqual(f.events.find(row => row[0] === 'command'), ['command', 'target', '/permission workspace'])
    assert.ok(f.events.find(row => row[0] === 'rename-workspace' && row[2] === 'Project · feature/custom'))
    assert.equal(f.block('original').getSnapshot(), undefined); assert.equal(f.block('target').getSnapshot(), undefined)
    assert.equal(f.bindings.get('target').session.getSnapshot().blank, true); assert.equal(f.references.get('original'), 0); assert.equal(f.references.get('target'), 0)
  } finally { f.navigation.dispose() }
})

test('image and generic file descriptors transfer without releasing their browser-owned objects', async () => {
  const f = fixture({ ids: ['image-1', 'file-2'] })
  try {
    await f.navigation.preflight('original'); await f.navigation.openWorktree('original', receipt)
    assert.deepEqual(f.inputs.get('target').state.getSnapshot().attachmentIds, ['image-1', 'file-2']); assert.deepEqual(f.inputs.get('original').state.getSnapshot().attachmentIds, [])
    assert.equal(f.drafts.size, 2); assert.deepEqual(f.events.find(row => row[0] === 'rebind'), ['rebind', 'target', ['image-1', 'file-2']])
  } finally { f.navigation.dispose() }
})

test('a UI-owned block is adopted by object identity and left for its owner to clear', async () => {
  const f = fixture(), block = { reason: 'Git operation' }
  try {
    await f.navigation.preflight('original'); f.services.conversation.blocks.set('original', block)
    await f.navigation.openWorktree('original', receipt, { sourceBlock: block })
    assert.equal(f.block('original').getSnapshot(), block); assert.equal(f.block('target').getSnapshot(), undefined)
  } finally { f.navigation.dispose() }
})

test('detached method callbacks do not depend on a caller-provided this', async () => {
  const f = fixture()
  try { const { preflight, openWorktree } = f.navigation; await preflight('original'); await openWorktree('original', receipt); assert.equal(f.current.getSnapshot().key, 'target') } finally { f.navigation.dispose() }
})

test('fresh Cordis service wrappers with the same public original identity remain one connection', async () => {
  const f = fixture(), original = f.services.connection, previous = f.ctx.get
  f.ctx.get = name => name === 'connection' ? new Proxy(original, { get(target, key) { return key === symbols.original ? original : Reflect.get(target, key) } }) : previous(name)
  try { await f.navigation.preflight('original'); await f.navigation.openWorktree('original', receipt); assert.equal(f.current.getSnapshot().key, 'target') } finally { f.navigation.dispose() }
})

test('real Cordis namespace injection makes the public session model API available to worktree navigation', async () => {
  const f = fixture(), ctx = new Context(), navigations = []
  class RemoteRoot extends Service {
    constructor(scope) { super(scope, 'remote') }
    get session() { return this.ctx['remote.session'] }
  }
  class ModelDirectories extends Service {
    constructor(scope) { super(scope, 'modelDirectories') }
    directoryFor(id) { assert.ok(this.ctx.sessions.binding(id)); return { store: source({ pending: null, status: 'ready' }) } }
  }
  const provider = ctx.plugin(scope => {
    for (const [name, value] of Object.entries(f.services)) if (!['remote', 'modelDirectories'].includes(name)) scope.provide(name, value)
    new RemoteRoot(scope)
    new ModelDirectories(scope)
    scope.provide('remote.session', f.services.remote.session)
  })
  await provider.await()
  const dependencies = ['sessions', 'conversation', 'workspaces', 'uiWorkspace', 'uiSession', 'connection']
  const withoutNamespace = ctx.plugin({ inject: dependencies, apply(scope) { navigations.push(createGitWorktreeNavigation(scope)) } })
  await withoutNamespace.await()
  assert.equal(navigations[0].available, false, 'A root remote object alone does not grant access to its namespace')
  const withNamespace = ctx.plugin({ inject: [...dependencies, 'remote.session'], apply(scope) { navigations.push(createGitWorktreeNavigation(scope)) } })
  await withNamespace.await()
  try {
    assert.equal(navigations[1].available, true)
    await navigations[1].preflight('original'); await navigations[1].openWorktree('original', receipt)
    assert.equal(f.current.getSnapshot().key, 'target')
    assert.deepEqual(f.events.find(row => row[0] === 'select-model')[1], { sessionId: 'target', ...model })
  } finally { navigations.forEach(value => value.dispose()); f.navigation.dispose(); await withNamespace.dispose(); await withoutNamespace.dispose(); await provider.dispose() }
})

test('optional modelDirectories can be absent without disabling the public migration capability', async () => {
  const f = fixture(); delete f.services.modelDirectories
  try { assert.equal(f.navigation.available, true); await f.navigation.preflight('original'); await f.navigation.openWorktree('original', receipt); assert.equal(f.current.getSnapshot().key, 'target') } finally { f.navigation.dispose() }
})

test('missing methods fail capability detection before any worktree navigation', async () => {
  const f = fixture()
  try { delete f.services.conversation.rebindDraftFiles; assert.equal(f.navigation.available, false); await assert.rejects(f.navigation.preflight('original'), { code: 'WORKTREE_NAVIGATION_UNAVAILABLE' }); assert.equal(f.events.length, 0) } finally { f.navigation.dispose() }
})

test('rich reference or command chips and custom permission are rejected before any directory or Session creation', async () => {
  for (const mutate of [f => f.inputs.get('original').state.set({ ...f.inputs.get('original').state.getSnapshot(), occurrences: [{}] }), f => f.inputs.get('original').state.set({ ...f.inputs.get('original').state.getSnapshot(), claim: { token: '/goal' } }), f => f.bindings.get('original').session.projections.faceOf('permissions').set({ currentValue: 'custom' })]) {
    const f = fixture(); mutate(f)
    try { await assert.rejects(f.navigation.preflight('original')); assert.ok(!f.events.some(row => row[0].startsWith('create-'))); assert.equal(f.inputs.get('original').state.getSnapshot().draft, 'Keep my draft\n第二行') } finally { f.navigation.dispose() }
  }
})

test('a draft changed after preflight keeps its latest content and refuses to use a prepared worktree', async () => {
  const f = fixture()
  try { await f.navigation.preflight('original'); f.inputs.get('original').setDraft('newer draft'); await assert.rejects(f.navigation.openWorktree('original', receipt), { code: 'WORKTREE_STATE_CHANGED' }); assert.equal(f.inputs.get('original').state.getSnapshot().draft, 'newer draft'); assert.ok(!f.events.some(row => row[0].startsWith('create-'))) } finally { f.navigation.dispose() }
})

test('another feature block is not overwritten or cleared', async () => {
  const f = fixture(), foreign = { reason: 'Other operation' }
  try { await f.navigation.preflight('original'); f.block('original').set(foreign); await assert.rejects(f.navigation.openWorktree('original', receipt), { code: 'WORKTREE_BUSY' }); assert.equal(f.block('original').getSnapshot(), foreign); assert.ok(!f.events.some(row => row[0].startsWith('create-'))) } finally { f.navigation.dispose() }
})

test('model-selection refusal preserves the original draft and attachments', async () => {
  const f = fixture({ ids: ['file-1'], selectModel: async () => ({ ok: false, error: { code: 'unavailable' } }) })
  try { await f.navigation.preflight('original'); await assert.rejects(f.navigation.openWorktree('original', receipt), { code: 'WORKTREE_MODEL_UNAVAILABLE' }); assert.equal(f.current.getSnapshot().key, 'original'); assert.equal(f.inputs.get('original').state.getSnapshot().draft, 'Keep my draft\n第二行'); assert.deepEqual(f.inputs.get('original').state.getSnapshot().attachmentIds, ['file-1']); assert.ok(!f.events.some(row => row[0] === 'initialize' || row[0] === 'open' || row[0] === 'rebind')) } finally { f.navigation.dispose() }
})

test('an unmatched permission command cannot silently fall back to target defaults', async () => {
  const f = fixture({ command: async () => ({ ok: true, value: { matched: false } }) })
  try { await f.navigation.preflight('original'); await assert.rejects(f.navigation.openWorktree('original', receipt), { code: 'WORKTREE_PERMISSION_UNAVAILABLE' }); assert.equal(f.current.getSnapshot().key, 'original'); assert.ok(!f.events.some(row => row[0] === 'open')); assert.equal(f.inputs.get('original').state.getSnapshot().draft, 'Keep my draft\n第二行') } finally { f.navigation.dispose() }
})

test('failed attachment preparation removes only target references and rebinds generic files to the original Session', async () => {
  const f = fixture({ ids: ['file-1'], rebind: id => { if (id === 'target') throw Error('synthetic failure') } })
  try { await f.navigation.preflight('original'); await assert.rejects(f.navigation.openWorktree('original', receipt)); assert.equal(f.current.getSnapshot().key, 'original'); assert.deepEqual(f.inputs.get('original').state.getSnapshot().attachmentIds, ['file-1']); assert.deepEqual(f.inputs.get('target').state.getSnapshot().attachmentIds, []); assert.equal(f.inputs.get('target').state.getSnapshot().draft, ''); assert.deepEqual(f.events.filter(row => row[0] === 'rebind').map(row => row[1]), ['target', 'original']); assert.equal(f.drafts.size, 1) } finally { f.navigation.dispose() }
})

test('superseded navigation ignores a late model-selection response without opening the worktree Session', async () => {
  const held = deferred(), f = fixture({ selectModel: () => held.promise })
  try {
    await f.navigation.preflight('original'); const opening = f.navigation.openWorktree('original', receipt); await turn(); f.current.set({ key: 'other-chat' })
    await assert.rejects(opening, { code: 'WORKTREE_STATE_CHANGED' }); held.resolve({ ok: true, value: { selected: model } }); await turn()
    assert.equal(f.current.getSnapshot().key, 'other-chat'); assert.ok(!f.events.some(row => row[0] === 'open')); assert.equal(f.inputs.get('original').state.getSnapshot().draft, 'Keep my draft\n第二行')
  } finally { f.navigation.dispose() }
})

test('connection replacement and disposal cancel pending preparation without a late navigation', async () => {
  for (const cancel of [f => f.generation.set({ id: 2 }), f => f.navigation.dispose()]) {
    const held = deferred(), f = fixture({ createWorkspace: () => held.promise })
    try { await f.navigation.preflight('original'); const opening = f.navigation.openWorktree('original', receipt); await turn(); cancel(f); await assert.rejects(opening); held.resolve(); await turn(); assert.ok(!f.events.some(row => row[0] === 'create-session' || row[0] === 'open')); assert.equal(f.inputs.get('original').state.getSnapshot().draft, 'Keep my draft\n第二行'); assert.equal(f.block('original').getSnapshot(), undefined) } finally { f.navigation.dispose() }
  }
})

test('source draft and attachments are retained until target navigation is actually observed', async () => {
  const f = fixture({ ids: ['image-1'], open() {} })
  try {
    await f.navigation.preflight('original'); const opening = f.navigation.openWorktree('original', receipt); await turn()
    assert.equal(f.inputs.get('original').state.getSnapshot().draft, 'Keep my draft\n第二行'); assert.deepEqual(f.inputs.get('original').state.getSnapshot().attachmentIds, ['image-1'])
    f.current.set({ key: 'target' }); await opening
    assert.equal(f.inputs.get('original').state.getSnapshot().draft, ''); assert.deepEqual(f.inputs.get('target').state.getSnapshot().attachmentIds, ['image-1'])
  } finally { f.navigation.dispose() }
})

test('default model is resolved only when the source has no explicit saved selection', async () => {
  const f = fixture()
  try { f.bindings.get('original').session.projections.faceOf('modelSelection').set({ next: null, lastUsed: null }); await f.navigation.preflight('original'); await f.navigation.openWorktree('original', receipt); assert.equal(f.events.filter(row => row[0] === 'model-catalog').length, 1); assert.deepEqual(f.events.find(row => row[0] === 'select-model')[1], { sessionId: 'target', ...model }) } finally { f.navigation.dispose() }
})

test('source model or permission change while a worktree is prepared refuses the captured selection', async () => {
  for (const key of ['modelSelection', 'permissions']) {
    const f = fixture()
    try { await f.navigation.preflight('original'); f.bindings.get('original').session.projections.faceOf(key).set(key === 'modelSelection' ? { next: { ...model, reasoningEffort: 'low' }, lastUsed: null } : { currentValue: 'read-only' }); await assert.rejects(f.navigation.openWorktree('original', receipt), { code: 'WORKTREE_STATE_CHANGED' }); assert.ok(!f.events.some(row => row[0].startsWith('create-'))) } finally { f.navigation.dispose() }
  }
})

test('a pre-existing target draft is not cleared when preparation refuses it', async () => {
  const f = fixture(), create = f.services.sessions.create
  f.services.sessions.create = async request => { const id = await create(request); f.inputs.get(id).setDraft('Keep my draft\n第二行'); return id }
  try { await f.navigation.preflight('original'); await assert.rejects(f.navigation.openWorktree('original', receipt), { code: 'WORKTREE_STATE_CHANGED' }); assert.equal(f.inputs.get('target').state.getSnapshot().draft, 'Keep my draft\n第二行'); assert.equal(f.inputs.get('original').state.getSnapshot().draft, 'Keep my draft\n第二行'); assert.equal(f.current.getSnapshot().key, 'original') } finally { f.navigation.dispose() }
})

test('if original cleanup and restoration fail, the complete target draft and attachments stay recoverable', async () => {
  let fail = false
  const f = fixture({ ids: ['file-1'], setDraft(id) { if (fail && id === 'original') throw Error('Synthetic editor failure') } })
  try {
    await f.navigation.preflight('original'); fail = true
    await assert.rejects(f.navigation.openWorktree('original', receipt), { code: 'WORKTREE_DRAFT_RECOVERY' })
    assert.equal(f.current.getSnapshot().key, 'target'); assert.equal(f.inputs.get('target').state.getSnapshot().draft, 'Keep my draft\n第二行'); assert.deepEqual(f.inputs.get('target').state.getSnapshot().attachmentIds, ['file-1']); assert.equal(f.drafts.size, 1)
    assert.equal(f.block('original').getSnapshot(), undefined); assert.equal(f.block('target').getSnapshot(), undefined)
  } finally { f.navigation.dispose() }
})

test('late source setting changes during navigation cancel the transfer without removing original attachments', async () => {
  const f = fixture({ ids: ['file-1'], open() {} })
  try {
    await f.navigation.preflight('original'); const opening = f.navigation.openWorktree('original', receipt); await turn()
    f.bindings.get('original').session.projections.faceOf('permissions').set({ currentValue: 'read-only' })
    await assert.rejects(opening, { code: 'WORKTREE_STATE_CHANGED' })
    assert.deepEqual(f.inputs.get('original').state.getSnapshot().attachmentIds, ['file-1']); assert.deepEqual(f.inputs.get('target').state.getSnapshot().attachmentIds, []); assert.equal(f.inputs.get('original').state.getSnapshot().draft, 'Keep my draft\n第二行'); assert.ok(!f.events.some(row => row[0] === 'open' && row[1] === 'original'))
  } finally { f.navigation.dispose() }
})
