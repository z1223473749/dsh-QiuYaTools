import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const built = await build({ entryPoints: [fileURLToPath(new URL('../src/features/conversation-comments/new-question.ts', import.meta.url))], write: false, bundle: true, platform: 'node', format: 'cjs', target: 'node22' })
const module = { exports: {} }
vm.runInNewContext(built.outputFiles[0].text, { module, exports: module.exports, crypto: { randomUUID } })
const { createNewConversationQuestion } = module.exports
const json = value => JSON.parse(JSON.stringify(value))
function defer() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

function fixture(options = {}) {
  const sourceState = { openState: 'open', removed: false, subagent: null }
  const targetState = { openState: 'open', removed: false, subagent: null, running: false, pendingSubmissions: [], awaitingFirstTurn: false, blank: true }
  const sourceDraft = { draft: 'Keep my original draft', attachmentIds: ['file-a'], occurrences: [{ source: 'files', ref: 'file-a' }] }
  const targetDraft = { draft: options.existingDraft ?? '', attachmentIds: [], occurrences: [], phase: 'plain' }
  const source = { sessionId: 'source', ctx: { id: 'source' }, session: { getSnapshot: () => sourceState, projections: { faceOf: key => ({ getSnapshot: () => key === 'agentPreset' ? 'plan' : key === 'modelSelection' ? { next: { provider: 'deepseek', model: 'flash', reasoningEffort: 'high' } } : undefined }) } } }
  const target = { sessionId: 'target', ctx: { id: 'target' }, session: { getSnapshot: () => targetState } }
  let current = { key: 'source' }
  let sourceBinding = source
  const calls = { create: [], retain: [], release: 0, initialize: [], model: [], navigate: [], prompt: 0 }
  const ctx = {
    sessions: {
      list: { getSnapshot: () => ({ phase: 'ready', byId: { source: { cwd: '/original/source' } } }) },
      binding: id => id === 'source' ? sourceBinding : id === 'target' ? target : undefined,
      async create(value) { calls.create.push(value); await options.create?.(value); return 'target' },
      retain(id, retainOptions) { calls.retain.push([id, retainOptions]); return { ready: typeof options.ready === 'function' ? options.ready() : options.ready ?? Promise.resolve(target), release() { calls.release++ } } },
    },
    workspaces: { list: { getSnapshot: () => ({ phase: 'ready', items: options.ungrouped ? [] : [{ workspaceId: 'workspace-a', sessionIds: ['source'] }] }) } },
    uiSession: { adapter: { current: { getSnapshot: () => current } } },
    conversation: { input: {
      for(scope) { return scope === source.ctx ? { state: { getSnapshot: () => sourceDraft }, setDraft() { assert.fail('Do not alter the source draft') } } : { state: { getSnapshot: () => targetDraft } } },
      requestDraftInitialization(binding, init) {
        calls.initialize.push([binding.sessionId, init])
        if (options.initialization) return options.initialization(binding, init)
        if (targetDraft.draft) return 'preserved'
        targetDraft.draft = init.prompt
        return 'applied'
      },
    }, send() { calls.prompt++; assert.fail('New-question action must not send') } },
    uiWorkspace: { openSession(id) { calls.navigate.push(id); if (options.navigate) options.navigate(id); current = { key: id } } },
    get(name) { assert.equal(name, 'remote'); return options.noModelAPI ? undefined : { session: { async selectModel(value) { calls.model.push(value); return options.model ? options.model(value) : { ok: true } } } } },
  }
  const helper = createNewConversationQuestion(ctx, source, 'en')
  return { helper, calls, source, target, sourceDraft, targetDraft, targetState, sourceState, ctx,
    select: key => { current = { key } }, replaceSource: () => { sourceBinding = { ...source } },
  }
}

test('creates in the same workspace and preset, carries the selected model and quote into an unsent draft', async () => {
  const f = fixture()
  const original = json(f.sourceDraft)
  await f.helper.open('Quoted first line\nQuoted second line')
  assert.equal(f.calls.create.length, 1)
  assert.equal(f.calls.create[0].workspaceId, 'workspace-a')
  assert.equal(f.calls.create[0].agentPreset, 'plan')
  assert.match(f.calls.create[0].sessionId, /^[a-f0-9-]{36}$/u)
  assert.deepEqual(json(f.calls.model), [{ sessionId: 'target', provider: 'deepseek', model: 'flash', reasoningEffort: 'high' }])
  assert.equal(f.calls.initialize[0][1].clearPreviousDraft, false)
  assert.match(f.targetDraft.draft, /> Quoted first line\n> Quoted second line\n\nMy question: /u)
  assert.deepEqual(f.calls.navigate, ['target'])
  assert.equal(f.calls.prompt, 0)
  assert.equal(f.calls.release, 1)
  assert.deepEqual(json(f.sourceDraft), original)
  f.helper.dispose()
  assert.equal(f.calls.release, 1)
})

test('ungrouped source keeps its directory and an unavailable optional model API does not block an unsent question', async () => {
  const f = fixture({ ungrouped: true, noModelAPI: true })
  await f.helper.open('A quoted passage')
  assert.equal(f.calls.create[0].cwd, '/original/source')
  assert.equal('workspaceId' in f.calls.create[0], false)
  assert.equal(f.calls.model.length, 0)
  assert.deepEqual(f.calls.navigate, ['target'])
})

test('concurrent clicks share one attempt and successful later explicit questions create a fresh target', async () => {
  const waiting = defer()
  const f = fixture({ create: async () => waiting.promise })
  const first = f.helper.open('The same quote')
  const repeated = f.helper.open('The same quote')
  assert.equal(first, repeated)
  await assert.rejects(f.helper.open('A different quote'), /already opening/u)
  assert.equal(f.calls.create.length, 1)
  waiting.resolve()
  await first
  const requested = f.calls.create[0].sessionId
  f.select('source')
  f.targetDraft.draft = ''
  await f.helper.open('The same quote')
  assert.equal(f.calls.create.length, 2)
  assert.notEqual(f.calls.create[1].sessionId, requested)
})

test('navigation failure retries the prepared target without creating or initializing another session', async () => {
  let attempts = 0
  const f = fixture({ navigate() { if (++attempts === 1) throw Error('Navigation failed') } })
  await assert.rejects(f.helper.open('Preserve this quote'), /Navigation failed/u)
  assert.equal(f.calls.release, 0)
  const prepared = f.targetDraft.draft
  await f.helper.open('Preserve this quote')
  assert.equal(f.calls.create.length, 1)
  assert.equal(f.calls.initialize.length, 1)
  assert.equal(f.targetDraft.draft, prepared)
  assert.equal(f.calls.release, 1)
})

test('unconfirmed create retries use the same preallocated identity rather than creating a duplicate', async () => {
  let attempts = 0
  const f = fixture({ create() { if (++attempts === 1) throw Error('Response lost') } })
  await assert.rejects(f.helper.open('Quote'), /Response lost/u)
  await f.helper.open('Quote')
  assert.equal(f.calls.create.length, 2)
  assert.equal(f.calls.create[0].sessionId, f.calls.create[1].sessionId)
})

test('failed initial target acquisition reacquires that target without creating another conversation', async () => {
  let attempts = 0
  const f = fixture({ ready: () => ++attempts === 1 ? Promise.reject(Error('Initial opening failed')) : Promise.resolve(f.target) })
  await assert.rejects(f.helper.open('Quote'), /Initial opening failed/u)
  assert.equal(f.calls.release, 1)
  await f.helper.open('Quote')
  assert.equal(f.calls.create.length, 1)
  assert.equal(f.calls.retain.length, 2)
  assert.equal(f.calls.release, 2)
  assert.deepEqual(f.calls.navigate, ['target'])
})

test('source navigation or replacement during creation never hijacks the later selection', async () => {
  for (const change of ['select', 'replaceSource']) {
    const waiting = defer()
    const f = fixture({ create: async () => waiting.promise })
    const request = f.helper.open('Old source quote')
    if (change === 'select') f.select('another-session')
    else f.replaceSource()
    waiting.resolve()
    await assert.rejects(request, /source conversation changed/u)
    assert.equal(f.calls.retain.length, 0)
    assert.equal(f.calls.initialize.length, 0)
    assert.equal(f.calls.navigate.length, 0)
  }
})

test('target draft refusal preserves existing target and source content without navigating or sending', async () => {
  const f = fixture({ existingDraft: 'Someone is editing this new session' })
  await assert.rejects(f.helper.open('Quote'), /already has a draft/u)
  assert.equal(f.targetDraft.draft, 'Someone is editing this new session')
  assert.equal(f.sourceDraft.draft, 'Keep my original draft')
  assert.equal(f.calls.initialize.length, 0)
  assert.equal(f.calls.navigate.length, 0)
  f.helper.dispose()
  assert.equal(f.calls.release, 1)
})

test('disposal during acquisition releases its reference and refuses late initialization', async () => {
  const ready = defer()
  const f = fixture({ ready: ready.promise })
  const request = f.helper.open('Quote')
  await setImmediate()
  assert.equal(f.calls.retain.length, 1)
  f.helper.dispose()
  ready.resolve(f.target)
  await assert.rejects(request, /source conversation changed/u)
  assert.equal(f.calls.release, 1)
  assert.equal(f.calls.initialize.length, 0)
  assert.equal(f.calls.navigate.length, 0)
})
