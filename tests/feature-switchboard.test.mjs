import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'
import { Context } from '@deepseek-ai/cordis'

const compiled = await build({
  stdin: {
    contents: "export * from './src/client/feature-switchboard.ts'; export * from './src/shared.ts';",
    resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts',
  },
  bundle: true, write: false, platform: 'node', target: 'node22', format: 'cjs',
})
const module = { exports: {} }
vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, Promise, Map })
const { FeatureSwitchboard, FEATURE_FIELDS, DEFAULT_PREFERENCES } = module.exports

function deferred() {
  let resolve
  let reject
  const promise = new Promise((accept, refuse) => { resolve = accept; reject = refuse })
  return { promise, resolve, reject }
}
const nextTurn = () => new Promise(resolve => setImmediate(resolve))
const enabledOnly = (...fields) => Object.fromEntries(FEATURE_FIELDS.map(field => [field, fields.includes(field)]))

function registrations(stop = async () => {}) {
  const active = new Map()
  const starts = new Map()
  const events = []
  const board = new FeatureSwitchboard(field => {
    active.set(field, (active.get(field) ?? 0) + 1)
    starts.set(field, (starts.get(field) ?? 0) + 1)
    assert.equal(active.get(field), 1, `${field} must never have two registrations`)
    events.push(['start', field])
    return async () => {
      events.push(['stop-start', field])
      await stop(field)
      active.set(field, active.get(field) - 1)
      events.push(['stop-done', field])
    }
  })
  return { board, active, starts, events, count: () => [...active.values()].reduce((sum, value) => sum + value, 0) }
}

test('feature switchboard waits for configuration, inherits new flags, and honors the legacy pause', async () => {
  const f = registrations()
  try {
    await f.board.update(undefined)
    assert.equal(f.count(), 0)
    await f.board.update({})
    assert.equal(f.count(), FEATURE_FIELDS.length, 'new and upgraded profiles inherit every feature as enabled')
    assert.equal(f.active.get('promptSuggestionsEnabled'), 1, 'upgrades enable prompt suggestions by default')
    await f.board.update({ enabled: false })
    assert.equal(f.count(), 0)
    await f.board.update({ enabled: true, bulkArchiveEnabled: false })
    assert.equal(f.count(), FEATURE_FIELDS.length - 1)
    assert.equal(f.active.get('bulkArchiveEnabled'), 0)
    await f.board.update(undefined)
    assert.equal(f.count(), 0, 'unavailable settings withdraw all features')
  } finally { await f.board.dispose() }
})

test('threshold-only changes preserve each feature fiber without reinstalling listeners', async () => {
  const f = registrations()
  try {
    await f.board.update({ ...DEFAULT_PREFERENCES })
    await f.board.update({ ...DEFAULT_PREFERENCES, pasteCharacterThreshold: 2000, pasteLineThreshold: 30 })
    assert.equal(f.count(), FEATURE_FIELDS.length)
    assert.equal([...f.starts.values()].every(count => count === 1), true)
    assert.equal(f.events.some(([event]) => event === 'stop-start'), false)
  } finally { await f.board.dispose() }
})

test('rapid feature toggles wait for asynchronous cleanup before registering a replacement', async () => {
  const closing = deferred()
  const entered = deferred()
  let firstStop = true
  const field = 'pastedTextEnabled'
  const f = registrations(async stopped => {
    if (stopped === field && firstStop) { firstStop = false; entered.resolve(); await closing.promise }
  })
  try {
    await f.board.update(enabledOnly(field))
    const off = f.board.update(enabledOnly())
    await entered.promise
    const on = f.board.update(enabledOnly(field))
    await nextTurn()
    assert.equal(f.starts.get(field), 1)
    assert.equal(f.active.get(field), 1, 'the old cleanup still owns its registration')
    closing.resolve()
    await Promise.all([off, on])
    assert.equal(f.active.get(field), 1)
    assert.equal(f.starts.get(field), 2)
    const toggles = []
    for (let index = 0; index < 40; index++) toggles.push(f.board.update(enabledOnly(...(index % 2 ? [field] : []))))
    await Promise.all(toggles)
    assert.equal(f.active.get(field), 1)
  } finally { closing.resolve(); await f.board.dispose() }
  assert.equal(f.count(), 0)
})

test('all concurrent dispose callers wait for the same complete asynchronous teardown', async () => {
  const closing = deferred()
  const entered = deferred()
  const f = registrations(async () => { entered.resolve(); await closing.promise })
  await f.board.update(enabledOnly('pastedTextEnabled'))
  let firstDone = false
  let secondDone = false
  const first = f.board.dispose().then(() => { firstDone = true })
  await entered.promise
  const second = f.board.dispose().then(() => { secondDone = true })
  try {
    await nextTurn()
    assert.equal(firstDone, false)
    assert.equal(secondDone, false, 'a repeated dispose must not resolve before the active cleanup')
    closing.resolve()
    await Promise.all([first, second])
    assert.equal(f.count(), 0)
    await f.board.update(DEFAULT_PREFERENCES)
    assert.equal(f.count(), 0, 'closed switchboards never reactivate')
  } finally { closing.resolve(); await Promise.allSettled([first, second]) }
})

test('disposal during an update suppresses registrations still queued after a slow teardown', async () => {
  const closing = deferred()
  const entered = deferred()
  const f = registrations(async field => {
    if (field === 'pastedTextEnabled') { entered.resolve(); await closing.promise }
  })
  await f.board.update(enabledOnly('pastedTextEnabled'))
  const updating = f.board.update(enabledOnly('sessionWindowsEnabled'))
  await entered.promise
  const disposing = f.board.dispose()
  closing.resolve()
  await Promise.all([updating, disposing])
  assert.equal(f.count(), 0)
  assert.equal(f.starts.has('sessionWindowsEnabled'), false, 'requested disposal must prevent a pending activation')
})

test('a startup failure leaves earlier registrations owned and a later update can recover', async () => {
  const active = new Set()
  let fail = true
  const board = new FeatureSwitchboard(field => {
    if (field === 'sessionWindowsEnabled' && fail) throw Error('provider unavailable')
    assert.equal(active.has(field), false)
    active.add(field)
    return () => active.delete(field)
  })
  try {
    await assert.rejects(board.update(DEFAULT_PREFERENCES), /provider unavailable/)
    assert.equal(active.size, 1)
    fail = false
    await board.update(DEFAULT_PREFERENCES)
    assert.equal(active.size, FEATURE_FIELDS.length)
  } finally { await board.dispose() }
  assert.equal(active.size, 0)
})

test('actual Cordis child fibers finish their cleanup before a feature is reinstalled', async () => {
  const ctx = new Context()
  const field = 'pastedTextEnabled'
  const closed = deferred()
  const entered = deferred()
  const fibers = []
  let active = 0
  let firstCleanup = true
  const board = new FeatureSwitchboard(() => {
    const fiber = ctx.plugin({
      name: 'qiuya-tools/switchboard-fixture',
      apply(child) {
        child.effect(() => {
          active++
          assert.equal(active, 1)
          return async () => {
            if (firstCleanup) { firstCleanup = false; entered.resolve(); await closed.promise }
            active--
          }
        })
      },
    })
    fibers.push(fiber)
    return () => fiber.dispose()
  })
  try {
    await board.update(enabledOnly(field))
    await fibers[0].await()
    assert.equal(active, 1)
    const off = board.update(enabledOnly())
    await entered.promise
    const on = board.update(enabledOnly(field))
    await nextTurn()
    assert.equal(fibers.length, 1)
    closed.resolve()
    await Promise.all([off, on])
    await fibers[1].await()
    assert.equal(active, 1)
  } finally { closed.resolve(); await board.dispose() }
  assert.equal(active, 0)
})

test('a failed teardown retains ownership so a later enable cannot duplicate its registration', async () => {
  let fail = true
  const field = 'pastedTextEnabled'
  const f = registrations(async () => { if (fail) throw Error('cleanup failed') })
  try {
    await f.board.update(enabledOnly(field))
    await assert.rejects(f.board.update(enabledOnly()), /cleanup failed/)
    await f.board.update(enabledOnly(field))
    assert.equal(f.count(), 1)
    assert.equal(f.starts.get(field), 1, 'an unsettled owner must not be replaced')
    fail = false
    await f.board.update(enabledOnly())
    assert.equal(f.count(), 0)
  } finally { fail = false; await f.board.dispose() }
})
