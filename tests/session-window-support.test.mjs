import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const compiled = (await build({
  stdin: {
    contents: "export * from './src/client/session-window-support.ts'; export * from './src/client/features.ts'; export * from './src/shared.ts';",
    resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts',
  },
  bundle: true, write: false, platform: 'node', target: 'node22', format: 'cjs',
  plugins: [{
    name: 'isolate-feature-installers',
    setup(builder) {
      builder.onResolve({ filter: /^\.\.\/features\/.+\/index\.tsx?$/ }, () => ({ path: 'installers', namespace: 'test-stub' }))
      builder.onLoad({ filter: /.*/, namespace: 'test-stub' }, () => ({ contents: `
        export function installPastedText() {}
        export function installBulkArchive() {}
        export function installSessionWindows() {}
        export function installPlanComments() {}
        export function installSidebarTools() {}
        export function installPromptSuggestions() {}
      ` }))
    },
  }],
})).outputFiles[0].text

const settle = () => new Promise(resolve => setImmediate(resolve))
const minimum = '0.2.1-rc.2'
function status(harnessVersion = minimum, extra = {}) {
  return { ok: true, value: { harnessVersion, minimumHarnessVersion: minimum, versionSupported: true, available: true, ...extra } }
}
function fixture() {
  const timers = new Map()
  let timerId = 0
  const module = { exports: {} }
  vm.runInNewContext(compiled, {
    module, exports: module.exports,
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id },
    clearTimeout(id) { timers.delete(id) },
  })
  const generationListeners = new Set()
  const requests = []
  let generation = { id: 1, host: { home: '/fixture' } }
  const connection = {
    generation: {
      getSnapshot: () => generation,
      subscribe(listener) { generationListeners.add(listener); return () => generationListeners.delete(listener) },
    },
    rpc: {
      call(channel, endpoint, payload) {
        assert.equal(channel, '/api')
        assert.equal(endpoint, 'qiuya-tools.session-windows.status')
        assert.deepEqual(JSON.parse(JSON.stringify(payload)), {})
        let resolve
        let reject
        const promise = new Promise((accept, refuse) => { resolve = accept; reject = refuse })
        requests.push({ resolve, reject })
        return promise
      },
    },
  }
  const store = new module.exports.SessionWindowSupportStore()
  return {
    ...module.exports, store, requests, connection, timers, generationListeners,
    connect() { return store.connect(connection) },
    setGeneration(value) { generation = value; for (const listener of generationListeners) listener() },
    retry() { const [id, callback] = timers.entries().next().value; timers.delete(id); callback() },
  }
}

test('version support uses SemVer and is independent of missing native components', async () => {
  for (const [version, expected] of [[minimum, true], ['0.2.1-rc.10', true], ['0.2.1', true], ['0.3.0', true], ['0.2.1-rc.1', false], ['0.2.0', false], ['not-a-version', false]]) {
    const f = fixture()
    const disconnect = f.connect()
    try {
      assert.equal(f.store.getSnapshot().versionSupported, false)
      await settle()
      f.requests[0].resolve(status(version, { available: false, reason: 'helper-missing' }))
      await settle()
      assert.equal(f.store.getSnapshot().versionSupported, expected, version)
      assert.equal(f.store.getSnapshot().minimumHarnessVersion, minimum)
      assert.equal(f.store.getSnapshot().status, version === 'not-a-version' ? 'unavailable' : 'ready')
    } finally { disconnect(); f.store.dispose() }
  }
})

test('unknown and legacy Hosts stay disabled, startup failures retry only four times', async () => {
  const f = fixture()
  const disconnect = f.connect()
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      await settle()
      f.requests[attempt].resolve({ ok: true, value: { available: true } })
      await settle()
      assert.equal(f.store.getSnapshot().versionSupported, false)
      if (attempt < 3) f.retry()
    }
    assert.equal(f.requests.length, 4)
    assert.equal(f.timers.size, 0)
    assert.equal(f.store.getSnapshot().status, 'unavailable')
  } finally { disconnect(); f.store.dispose() }

  const unknown = fixture()
  unknown.setGeneration(undefined)
  const stop = unknown.connect()
  await settle()
  assert.equal(unknown.requests.length, 0, 'a disconnected Host cannot be queried or authorized')
  assert.equal(unknown.store.getSnapshot().versionSupported, false)
  stop(); unknown.store.dispose()
})

test('a short endpoint registration race recovers without reconnecting', async () => {
  const f = fixture()
  const disconnect = f.connect()
  try {
    await settle()
    f.requests[0].resolve({ ok: false, error: { message: 'endpoint not registered' } })
    await settle()
    f.retry()
    await settle()
    f.requests[1].resolve(status())
    await settle()
    assert.equal(f.store.getSnapshot().versionSupported, true)
    assert.equal(f.timers.size, 0)
  } finally { disconnect(); f.store.dispose() }
})

test('disconnect and generation replacement revoke support immediately and discard late replies', async () => {
  const f = fixture()
  const disconnect = f.connect()
  try {
    await settle()
    f.setGeneration({ id: 2, host: { home: '/other' } })
    await settle()
    f.requests[0].resolve(status())
    await settle()
    assert.equal(f.store.getSnapshot().versionSupported, false, 'the earlier generation cannot authorize the new Host')
    f.requests[1].resolve(status())
    await settle()
    assert.equal(f.store.getSnapshot().versionSupported, true)
    f.setGeneration(undefined)
    assert.equal(f.store.getSnapshot().versionSupported, false)
    assert.equal(f.store.getSnapshot().harnessVersion, undefined)
    f.setGeneration({ id: 3, host: { home: '/third' } })
    await settle()
    f.requests[2].resolve(status('0.2.1-rc.1', { versionSupported: false }))
    await settle()
    assert.equal(f.store.getSnapshot().versionSupported, false)
  } finally { disconnect(); f.store.dispose() }
  assert.equal(f.generationListeners.size, 0)
  assert.equal(f.timers.size, 0)
})

test('service disposal releases subscriptions and timers and ignores an outstanding check', async () => {
  const f = fixture()
  const disconnect = f.connect()
  await settle()
  f.requests[0].reject(Error('temporarily unavailable'))
  await settle()
  assert.equal(f.timers.size, 1)
  disconnect()
  assert.equal(f.timers.size, 0)
  assert.equal(f.generationListeners.size, 0)
  const stop = f.connect()
  await settle()
  f.store.dispose()
  f.requests[1].resolve(status())
  await settle()
  assert.equal(f.store.getSnapshot().versionSupported, false)
  assert.equal(f.generationListeners.size, 0)
  stop()
})

function contextFixture(connection) {
  const effects = []
  const active = new Set()
  const starts = []
  const ctx = {
    connection,
    effect(callback) { const stop = callback(); if (typeof stop === 'function') effects.push(stop) },
    inject(_dependencies, install) { install(ctx) },
    plugin(options) {
      const field = options.name.split('/').at(-1)
      starts.push(field); active.add(field)
      return { dispose() { active.delete(field) } }
    },
    logger: { error(...args) { assert.fail(args.join(' ')) } },
  }
  return { ctx, active, starts, async dispose() { for (const stop of effects.reverse()) await stop() } }
}

test('the feature board and settings share one Context store and enforce effective flags without rewriting saved intent', async () => {
  const f = fixture()
  const c = contextFixture(f.connection)
  let snapshot = { status: 'ready', value: { ...f.DEFAULT_PREFERENCES } }
  const listeners = new Set()
  const form = {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
  }
  try {
    const shared = f.getSessionWindowSupport(c.ctx)
    assert.equal(f.getSessionWindowSupport(c.ctx), shared)
    f.installFeatures(c.ctx, form)
    await settle()
    assert.equal(f.requests.length, 1, 'settings and runtime must not create separate version checks')
    assert.equal(c.active.size, f.FEATURE_FIELDS.length - 1)
    assert.equal(c.active.has('sessionWindowsEnabled'), false)
    assert.equal(snapshot.value.sessionWindowsEnabled, true, 'saved intent stays intact while verification is pending')
    f.requests[0].resolve(status())
    await settle()
    assert.equal(c.active.has('sessionWindowsEnabled'), true)
    snapshot = { ...snapshot, value: { ...snapshot.value, sessionWindowsEnabled: false } }
    for (const listener of listeners) listener()
    await settle()
    assert.equal(c.active.has('sessionWindowsEnabled'), false, 'supported versions still honor the user setting')
    snapshot = { ...snapshot, value: { ...snapshot.value, sessionWindowsEnabled: true } }
    for (const listener of listeners) listener()
    await settle()
    assert.equal(c.active.has('sessionWindowsEnabled'), true)
    f.setGeneration(undefined)
    await settle()
    assert.equal(c.active.has('sessionWindowsEnabled'), false)
    assert.equal(c.active.size, f.FEATURE_FIELDS.length - 1, 'connection loss only withdraws the feature that requires this version')
  } finally { await c.dispose() }
  assert.equal(c.active.size, 0)
  assert.equal(listeners.size, 0)
  assert.equal(f.generationListeners.size, 0)
})
