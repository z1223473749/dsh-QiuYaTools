import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, readFile, writeFile, chmod, rm, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { JSDOM } from 'jsdom'
import { SESSION_WINDOW_APP_NAME, SESSION_WINDOW_BUNDLE_ID, sessionWindowAppInfoPlist } from '../src/features/session-windows/build-helper.mjs'

const root = new URL('../', import.meta.url)
const temporary = await mkdtemp(join(tmpdir(), 'qiuya-session-window-test-'))
const source = (await build({ entryPoints: [fileURLToPath(new URL('src/features/session-windows/contract.ts', root))], bundle: true, write: false, platform: 'node', format: 'cjs' })).outputFiles[0].text
const contractModule = { exports: {} }
vm.runInNewContext(source, { module: contractModule, exports: contractModule.exports })
const contract = contractModule.exports
await build({ entryPoints: [fileURLToPath(new URL('src/features/session-windows/host.ts', root))], bundle: true, outfile: join(temporary, 'host.mjs'), platform: 'node', format: 'esm', packages: 'external' })
const { SessionWindowCompanion, installSessionWindowsHost: installHost, sessionWindowStoreIdentifier } = await import(pathToFileURL(join(temporary, 'host.mjs')).href)
const fixtureDirectory = join(temporary, SESSION_WINDOW_APP_NAME, 'Contents', 'MacOS')
await mkdir(fixtureDirectory, { recursive: true })
const fixture = join(fixtureDirectory, 'qiuya-session-window')
const records = join(temporary, 'records.jsonl')
await writeFile(fixture, `#!${process.execPath}\nconst fs = require('node:fs'); const rl = require('node:readline').createInterface({ input: process.stdin }); rl.on('line', line => { const value = JSON.parse(line); fs.appendFileSync(${JSON.stringify(records)}, JSON.stringify({ ...value, pid: process.pid, argv: process.argv.slice(2) })+'\\n'); process.stdout.write(JSON.stringify({requestId:value.requestId,ok:true})+'\\n'); }); rl.on('close',()=>process.exit(0));\n`)
await chmod(fixture, 0o755)
const versionCompatibility = { harnessVersion: '0.2.1-rc.2', minimumHarnessVersion: '0.2.1-rc.2', versionSupported: true }
const installSessionWindowsHost = (ctx, enabled) => installHost(ctx, enabled, { executable: process.execPath, args: [fixture], getHarnessVersion: () => versionCompatibility.harnessVersion })

test.after(async () => { await rm(temporary, { recursive: true, force: true }) })

test('window requests accept only opaque session ids, known triggers, and finite screen positions', () => {
  assert.equal(contract.validSessionId('session-abc'), true)
  for (const id of ['', 'a\nb', 'x'.repeat(257), 'a b', null]) assert.equal(contract.validSessionId(id), false)
  const request = contract.parseWindowRequest({ sessionId: 'existing', source: 'drag', position: { x: -100, y: 30 }, url: 'https://evil.example/' })
  assert.equal(request.sessionId, 'existing')
  assert.equal(request.action, 'open')
  assert.equal('url' in request, false, 'the renderer cannot choose a destination')
  for (const value of [null, {}, { sessionId: 'id', source: 'arbitrary' }, { sessionId: 'id', source: 'drag', position: { x: NaN, y: 0 } }]) assert.throws(() => contract.parseWindowRequest(value))
  for (const action of ['prepare', 'cancel']) {
    assert.equal(contract.parseWindowRequest({ sessionId: 'existing', source: 'drag', action }).action, action)
    assert.throws(() => contract.parseWindowRequest({ sessionId: 'existing', source: 'menu', action }))
  }
  assert.throws(() => contract.parseWindowRequest({ sessionId: 'existing', source: 'drag', action: 'unknown' }))
})

test('tear-out excludes accepted drops, Escape, and Chromium empty cancellation coordinates', () => {
  const outside = { screenX: 1400, screenY: 500, clientX: 1400, clientY: 500, dataTransfer: { dropEffect: 'none' } }
  assert.equal(contract.isExternalSessionDrop(outside, { cancelled: false, dropped: false }, { width: 1280, height: 820 }), true)
  for (const state of [{ cancelled: true, dropped: false }, { cancelled: false, dropped: true }]) assert.equal(contract.isExternalSessionDrop(outside, state, { width: 1280, height: 820 }), false)
  assert.equal(contract.isExternalSessionDrop({ ...outside, screenX: 0, screenY: 0 }, { cancelled: false, dropped: false }, { width: 1280, height: 820 }), false)
  assert.equal(contract.isExternalSessionDrop({ ...outside, dataTransfer: { dropEffect: 'move' } }, { cancelled: false, dropped: false }, { width: 1280, height: 820 }), false)
})

test('companion shares one process and carries authenticated URL only through stdin', async () => {
  const companion = new SessionWindowCompanion(process.execPath, [fixture])
  try {
    await companion.open({ sessionId: 'one', url: 'http://127.0.0.1:19387/?token=fixture-only' })
    await companion.open({ sessionId: 'two', url: 'http://127.0.0.1:19387/?token=fixture-only' })
    const lines = (await readFile(records, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(lines[0].pid, lines[1].pid)
    assert.deepEqual(lines[0].argv, [])
    assert.equal(lines[0].url.includes('fixture-only'), true)
  } finally { companion.dispose() }
  await assert.rejects(() => companion.open({}), /unavailable/)
})

test('companion startup failure rejects without an unhandled Host stream error', async () => {
  const companion = new SessionWindowCompanion(join(temporary, 'missing-executable'))
  try { await assert.rejects(() => companion.open({ sessionId: 'one' }), /窗口/) }
  finally { companion.dispose() }
})

test('drag preparation and cancellation share the helper without cancellation starting a new process', async () => {
  const before = (await readFile(records, 'utf8')).trim().split('\n').length
  const dormant = new SessionWindowCompanion(process.execPath, [fixture])
  try { await dormant.cancel('not-created') }
  finally { dormant.dispose() }
  assert.equal((await readFile(records, 'utf8')).trim().split('\n').length, before)
  const companion = new SessionWindowCompanion(process.execPath, [fixture])
  try {
    const target = { sessionId: 'prepared-target', url: 'http://127.0.0.1:19444/?token=fixture-only', title: 'Fixture', source: 'drag' }
    await companion.prepare(target)
    await companion.open(target)
    await companion.cancel(target.sessionId)
    const sent = (await readFile(records, 'utf8')).trim().split('\n').slice(before).map(JSON.parse)
    assert.deepEqual(sent.map(command => command.op), ['prepare', 'open', 'cancel'])
    assert.equal(new Set(sent.map(command => command.pid)).size, 1)
    assert.deepEqual(sent.map(command => command.sessionId), [target.sessionId, target.sessionId, target.sessionId])
    assert.equal(sent[2].url, '', 'cleanup does not need another authenticated URL')
  } finally { companion.dispose() }
})

function windowFetchFixture(extra = {}) {
  const routes = new Map()
  const host = {
    connection: {
      authenticatedUrl: base => `${base}?token=fixture-only`,
      browserPeer: { principal: { kind: 'owner' }, ctx: { get: () => undefined } },
      fetch: { register(route) { routes.set(route.path, route); return async () => { routes.delete(route.path) } } },
    },
    webServer: { port: 19444 },
    ...extra,
  }
  const call = async (operation, payload = {}, signal = new AbortController().signal) => {
    const endpoint = operation === 'status' ? contract.SESSION_WINDOW_STATUS_ENDPOINT : contract.SESSION_WINDOW_OPEN_ENDPOINT
    const route = routes.get(`${contract.SESSION_WINDOW_CHANNEL}/${endpoint}`)
    const response = await route.fetch(new Request(`http://127.0.0.1:19444${route.path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'fixture', method: endpoint, payload }), signal }))
    assert.equal(response.status, 200)
    return (await response.json()).result
  }
  return { host, routes, call }
}

test('Host authority validates feature setting and existing Session before building same-Host URL', async () => {
  let enabled = false
  const fixture = windowFetchFixture({ sessionController: { async list() { return { items: [{ sessionId: 'real-session', title: 'Fixture' }] } } } })
  const dispose = installSessionWindowsHost(fixture.host, () => enabled)
  try {
    assert.deepEqual(await fixture.call('status'), { ok: true, value: { ...versionCompatibility, available: true } })
    assert.equal((await fixture.call('open', { sessionId: 'real-session', source: 'menu' })).ok, false)
    enabled = true
    assert.equal((await fixture.call('open', { sessionId: 'missing', source: 'menu' })).ok, false)
    assert.equal((await fixture.call('open', { sessionId: 'real-session', source: 'menu' })).ok, true)
    const last = JSON.parse((await readFile(records, 'utf8')).trim().split('\n').at(-1))
    const url = new URL(last.url)
    assert.equal(url.origin, 'http://127.0.0.1:19444')
    assert.equal(url.searchParams.get('qiuya-session'), 'real-session')
    assert.equal(url.searchParams.get('token'), 'fixture-only')
  } finally { dispose() }
  assert.equal(fixture.routes.size, 0)
})

test('Host prepare validates exact targets while cancel remains cleanup after settings or catalog changes', async () => {
  let enabled = true
  let readCount = 0
  const fixture = windowFetchFixture({
    sessionPersistence: { async stat(id) { readCount++; return id === 'prepared-existing' ? { header: { id }, eventCount: 4 } : undefined } },
    sessionProjectionCache: { cachedSnapshot: () => ({ values: { sessionListMetadata: { blank: false } } }) },
  })
  const dispose = installSessionWindowsHost(fixture.host, () => enabled)
  const before = (await readFile(records, 'utf8')).trim().split('\n').length
  try {
    assert.equal((await fixture.call('open', { sessionId: 'missing-preparation', source: 'drag', action: 'prepare' })).ok, false)
    assert.deepEqual(await fixture.call('open', { sessionId: 'prepared-existing', source: 'drag', action: 'prepare' }), { ok: true, value: { prepared: true } })
    enabled = false
    fixture.host.sessionPersistence = undefined
    assert.deepEqual(await fixture.call('open', { sessionId: 'prepared-existing', source: 'drag', action: 'cancel' }), { ok: true, value: { canceled: true } })
    const sent = (await readFile(records, 'utf8')).trim().split('\n').slice(before).map(JSON.parse)
    assert.deepEqual(sent.map(command => command.op), ['prepare', 'cancel'])
    assert.equal(readCount, 2, 'cancel does not consult the catalog or exact reader')
  } finally { dispose() }
})

test('a cancel arriving during preparation validation prevents a late hidden window from being created', async () => {
  let entered
  const reading = new Promise(resolve => { entered = resolve })
  let complete
  const fixture = windowFetchFixture({
    sessionPersistence: { stat() { entered(); return new Promise(resolve => { complete = resolve }) } },
    sessionProjectionCache: { cachedSnapshot: () => ({ values: { sessionListMetadata: { blank: false } } }) },
  })
  const dispose = installSessionWindowsHost(fixture.host, () => true)
  const before = (await readFile(records, 'utf8')).trim().split('\n').length
  try {
    const preparing = fixture.call('open', { sessionId: 'late-preparation', source: 'drag', action: 'prepare' })
    await reading
    assert.equal((await fixture.call('open', { sessionId: 'late-preparation', source: 'drag', action: 'cancel' })).ok, true)
    complete({ header: { id: 'late-preparation' }, eventCount: 4 })
    assert.deepEqual(await preparing, { ok: true, value: { prepared: false } })
    assert.equal((await readFile(records, 'utf8')).trim().split('\n').length, before, 'cancel did not spawn a helper and late validation stayed canceled')
  } finally { dispose() }
})

const clientSource = (await build({ entryPoints: [fileURLToPath(new URL('src/features/session-windows/index.tsx', root))], bundle: true, write: false, platform: 'browser', format: 'cjs', packages: 'external' })).outputFiles[0].text
const require = createRequire(import.meta.url)
function dragHarness() {
  const dom = new JSDOM('<body><div role="tree"><div data-row-key="session:A" draggable="true"></div><div data-row-key="session:B"></div></div><main id="conversation"></main></body>', { url: 'https://local.invalid/' })
  class FakeDragEvent extends dom.window.Event {
    constructor(type, options = {}) { super(type, options); for (const [key, value] of Object.entries(options)) if (!['bubbles', 'cancelable'].includes(key)) Object.defineProperty(this, key, { value }) }
  }
  dom.window.DragEvent = FakeDragEvent
  const module = { exports: {} }
  vm.runInNewContext(clientSource, { module, exports: module.exports, window: dom.window, document: dom.window.document, setTimeout, clearTimeout, require: id => id === 'react-dom' ? { flushSync: callback => callback() } : id === '@deepseek-ai/dsh-client-ui-primitives' ? {} : require(id) })
  const opened = []
  const off = module.exports.installSessionWindowDrag(dom.window, { canOpen: id => id === 'A', open: (...args) => opened.push(args) })
  const row = dom.window.document.querySelector('[data-row-key="session:A"]')
  const conversation = dom.window.document.querySelector('main')
  const dataTransfer = { dropEffect: 'none' }
  const event = (type, overrides = {}) => new FakeDragEvent(type, { bubbles: true, cancelable: true, screenX: 100, screenY: 100, clientX: 10, clientY: 10, dataTransfer, ...overrides })
  return { dom, row, conversation, event, opened, off }
}

test('dragging a single session to conversation opens it and clears upstream hover back to source', () => {
  const h = dragHarness()
  try {
    let resets = 0
    h.row.addEventListener('dragstart', () => resets++)
    h.row.dispatchEvent(h.event('dragstart'))
    h.conversation.dispatchEvent(h.event('drop'))
    h.row.dispatchEvent(h.event('dragend'))
    assert.equal(h.opened.length, 1)
    assert.equal(h.opened[0][0], 'A')
    assert.equal(resets, 2)
    h.off()
    h.row.dispatchEvent(h.event('dragstart'))
    h.conversation.dispatchEvent(h.event('drop'))
    assert.equal(h.opened.length, 1)
  } finally { h.off(); h.dom.window.close() }
})

test('Escape, accepted row drops, and bulk selection do not detach sessions', () => {
  for (const scenario of ['escape', 'row-drop', 'multi']) {
    const h = dragHarness()
    try {
      if (scenario === 'multi') for (const row of h.dom.window.document.querySelectorAll('[data-row-key]')) row.setAttribute('data-qyt-bulk-selected', 'true')
      h.row.dispatchEvent(h.event('dragstart'))
      if (scenario === 'escape') h.dom.window.document.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      if (scenario === 'row-drop') h.row.dispatchEvent(h.event('drop'))
      h.row.dispatchEvent(h.event('dragend', { screenX: 2000, clientX: 2000 }))
      assert.equal(h.opened.length, 0, scenario)
    } finally { h.off(); h.dom.window.close() }
  }
})

test('real React row dragend clears its last-hover target after an outside tear-out, preserving order', async () => {
  const h = dragHarness()
  h.off()
  const React = require('react')
  const ReactDOM = require('react-dom')
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  globalThis.window = h.dom.window
  globalThis.document = h.dom.window.document
  const { createRoot } = require('react-dom/client')
  const module = { exports: {} }
  vm.runInNewContext(clientSource, { module, exports: module.exports, window: h.dom.window, document: h.dom.window.document, setTimeout, clearTimeout, require: id => id === '@deepseek-ai/dsh-client-ui-primitives' ? {} : require(id) })
  const commits = []
  const mount = h.dom.window.document.createElement('section')
  h.dom.window.document.body.append(mount)
  const root = createRoot(mount)
  function Rows() {
    const [over, setOver] = React.useState(null)
    return React.createElement('div', { role: 'tree' },
      React.createElement('div', { 'data-row-key': 'session:A', 'data-hover': over, draggable: true, onDragStart: () => setOver(null), onDragOver: event => { event.preventDefault(); setOver('A') }, onDragEnd: () => commits.push(over) }),
      React.createElement('div', { 'data-row-key': 'session:B', onDragOver: event => { event.preventDefault(); setOver('B') } }))
  }
  ReactDOM.flushSync(() => root.render(React.createElement(Rows)))
  const row = mount.querySelector('[data-row-key="session:A"]')
  const other = mount.querySelector('[data-row-key="session:B"]')
  const opened = []
  const off = module.exports.installSessionWindowDrag(h.dom.window, { canOpen: () => true, open: id => opened.push(id) })
  try {
    ReactDOM.flushSync(() => row.dispatchEvent(h.event('dragstart')))
    ReactDOM.flushSync(() => other.dispatchEvent(h.event('dragover')))
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(row.getAttribute('data-hover'), 'B', 'the previous hover target reached a real React render')
    row.dispatchEvent(h.event('dragend', { screenX: 2000, clientX: 2000 }))
    assert.deepEqual(opened, ['A'])
    assert.deepEqual(commits, [null], 'React sees no hover target and only cleans up instead of reordering')
  } finally {
    off(); ReactDOM.flushSync(() => root.unmount()); h.dom.window.close()
    globalThis.window = previousWindow; globalThis.document = previousDocument
  }
})


test('persistent store identities are stable and isolate exact Sessions and canonical Host profiles', async () => {
  const profile = join(temporary, 'profile-one')
  const otherProfile = join(temporary, 'profile-two')
  const alias = join(temporary, 'profile-alias')
  await mkdir(profile); await mkdir(otherProfile)
  await symlink(profile, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const identifier = await sessionWindowStoreIdentifier('session-one', profile)
  assert.match(identifier, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
  assert.equal(await sessionWindowStoreIdentifier('session-one', profile), identifier)
  assert.equal(await sessionWindowStoreIdentifier('session-one', alias), identifier, 'symlinked launch paths belong to the same profile')
  assert.notEqual(await sessionWindowStoreIdentifier('session-two', profile), identifier)
  assert.notEqual(await sessionWindowStoreIdentifier('session-one', otherProfile), identifier)
  const fallback = await sessionWindowStoreIdentifier('session-one')
  assert.equal(await sessionWindowStoreIdentifier('session-one'), fallback)
  assert.notEqual(fallback, identifier)
  assert.notEqual(await sessionWindowStoreIdentifier('session-two'), fallback)
  assert.notEqual(await sessionWindowStoreIdentifier('c', join(profile, 'ab')), await sessionWindowStoreIdentifier('bc', join(profile, 'a')), 'tuple boundaries cannot alias')
})

test('native helper isolates network sessions while retaining existing data and validating stdin store UUIDs', { skip: process.platform !== 'darwin' }, async () => {
  const swift = await readFile(new URL('src/features/session-windows/SessionWindow.swift', root), 'utf8')
  assert.match(swift, /if #available\(macOS 14\.0, \*\) \{\s+config\.websiteDataStore = WKWebsiteDataStore\(forIdentifier: storeIdentifier\)\s+\} else \{[\s\S]*?config\.websiteDataStore = WKWebsiteDataStore\.nonPersistent\(\)/)
  assert.match(swift, /legacySharedStoreIdentifier = UUID\(uuidString: "982880DD-DB84-4AE4-970A-414EE7997DE3"\)/)
  assert.doesNotMatch(swift, /removeData|removeDataStore|QIUYA_DIAGNOSTIC_ISOLATED_WEBKIT|__QYT_LIST_FETCH_DIAG__/)
  assert.match(swift, /guard sessionWindowStoreUUID\(command\.storeIdentifier\) != nil else/)
  const validator = /func sessionWindowStoreUUID\(_ raw: String\?\) -> UUID\? \{[\s\S]*?\n\}/u.exec(swift)?.[0]
  assert.ok(validator)
  const script = join(temporary, 'store-identity.swift')
  const valid = await sessionWindowStoreIdentifier('uuid-test')
  await writeFile(script, `import Foundation\n${validator}\nassert(sessionWindowStoreUUID(${JSON.stringify(valid)}) != nil)\nassert(sessionWindowStoreUUID(${JSON.stringify(valid.toUpperCase())}) != nil)\nassert(sessionWindowStoreUUID(nil) == nil)\nassert(sessionWindowStoreUUID("not-a-store") == nil)\nassert(sessionWindowStoreUUID("00000000-0000-0000-0000-000000000000") == nil)\nassert(sessionWindowStoreUUID("${valid}x") == nil)\nprint("native-store-identity-ok")\n`)
  const output = execFileSync('/usr/bin/swift', ['-module-cache-path', join(temporary, 'swift-module-cache'), script], { encoding: 'utf8', timeout: 30_000 })
  assert.equal(output.trim(), 'native-store-identity-ok')
})

test('native preparation ownership releases only the matching hidden target and survives reveal or replacement', { skip: process.platform !== 'darwin' }, async () => {
  const swift = await readFile(new URL('src/features/session-windows/SessionWindow.swift', root), 'utf8')
  const policy = /struct PreparedSessionWindow \{[\s\S]*?\n\}/u.exec(swift)?.[0]
  assert.ok(policy, 'exercise the native helper\'s real ownership policy')
  const script = join(temporary, 'preparation-policy.swift')
  await writeFile(script, `${policy}\nvar state = PreparedSessionWindow()\nassert(!state.cancel("visible"))\nassert(state.replace(with: "A") == nil)\nassert(state.replace(with: "A") == nil)\nassert(!state.cancel("other"))\nassert(state.replace(with: "B") == "A")\nassert(!state.cancel("A"))\nstate.reveal("B")\nassert(!state.cancel("B"))\nassert(state.replace(with: "A") == nil)\nassert(state.cancel("A"))\nassert(!state.cancel("A"))\nprint("native-preparation-policy-ok")\n`)
  const output = execFileSync('/usr/bin/swift', ['-module-cache-path', join(temporary, 'swift-module-cache'), script], { encoding: 'utf8', timeout: 30_000 })
  assert.equal(output.trim(), 'native-preparation-policy-ok')
  assert.match(swift, /waiting = prepare \? \[\] : \[command\.requestId\]/)
  assert.match(swift, /if !prepare \{\s+window\.makeKeyAndOrderFront/)
  assert.match(swift, /if command\.op == "prepare" \{ answer\(command\.requestId, true\); return \}/)
  assert.match(swift, /if prepare \{ answer\(command\.requestId, true\) \}/)
  assert.match(swift, /if isPrepared \{ window\.close\(\) \}/)
})

test('native hidden views stay schedulable and revealing a preparation restarts its entire loading deadline', { skip: process.platform !== 'darwin' }, async () => {
  const swift = await readFile(new URL('src/features/session-windows/SessionWindow.swift', root), 'utf8')
  assert.match(swift, /if #available\(macOS 14\.0, \*\) \{[\s\S]*?config\.preferences\.inactiveSchedulingPolicy = \.none/)
  const focus = swift.slice(swift.indexOf('    func focus('), swift.indexOf('    func finish('))
  assert.match(focus, /window\.makeKeyAndOrderFront\(nil\)[\s\S]*?if !ready \{ armTimeout\(\) \}/)
  const timeout = /    func armTimeout\(\) \{[\s\S]*?\n    \}/u.exec(swift)?.[0]
  assert.ok(timeout)
  assert.match(timeout, /self\.timeoutGeneration == generation/)
  assert.match(timeout, /deadline: \.now\(\) \+ 30/)
  const script = join(temporary, 'visible-deadline.swift')
  // Keep the native function and its full 30-second budget intact. A manual
  // queue makes cancellation races reproducible without assuming that a loaded
  // CI runner can resume a RunLoop before a short wall-clock deadline.
  await writeFile(script, `
struct DeadlineInstant {
    let seconds: Int
    static func now() -> DeadlineInstant { DeadlineInstant(seconds: DispatchQueue.main.clock) }
    static func + (left: DeadlineInstant, right: Int) -> DeadlineInstant {
        DeadlineInstant(seconds: left.seconds + right)
    }
}
final class DispatchWorkItem {
    let block: () -> Void
    private(set) var isCancelled = false
    init(block: @escaping () -> Void) { self.block = block }
    func cancel() { isCancelled = true }
    // A callback already handed to a scheduler can race cancellation. Run it
    // anyway, so only the actual native generation guard can reject it.
    func performEvenIfCancelled() { block() }
}
final class DispatchQueue {
    struct Scheduled { let deadline: Int; let task: DispatchWorkItem }
    static let main = DispatchQueue()
    private(set) var clock = 0
    private(set) var scheduled: [Scheduled] = []
    func asyncAfter(deadline: DeadlineInstant, execute task: DispatchWorkItem) {
        scheduled.append(Scheduled(deadline: deadline.seconds, task: task))
    }
    func advance(to instant: Int) {
        assert(instant >= clock)
        clock = instant
        let due = scheduled.filter { $0.deadline <= instant }
        scheduled.removeAll { $0.deadline <= instant }
        for entry in due { entry.task.performEvenIfCancelled() }
    }
}
final class DeadlineHarness {
    var ready = false
    var failed = false
    var timeout: DispatchWorkItem?
    var timeoutGeneration = 0
    var failures = 0
    func fail(_ message: String) { failures += 1; failed = true }
${timeout}
}
let queue = DispatchQueue.main
let view = DeadlineHarness()
view.armTimeout()
let hiddenTask = queue.scheduled[0].task
assert(queue.scheduled[0].deadline == 30)
queue.advance(to: 10)
view.armTimeout()
assert(hiddenTask.isCancelled, "revealing the view cancels its hidden task")
assert(view.timeoutGeneration == 2)
assert(queue.scheduled.map { $0.deadline } == [30, 40], "the visible task gets a complete new 30-second budget")
queue.advance(to: 30)
assert(view.failures == 0, "even an executed old hidden callback cannot fail the visible window")
queue.advance(to: 39)
assert(view.failures == 0, "the replacement task cannot fire before its full budget")
queue.advance(to: 40)
assert(view.failures == 1, "the replacement visible deadline still reports a real timeout")
queue.advance(to: 100)
assert(view.failures == 1)
let readyView = DeadlineHarness()
readyView.armTimeout()
readyView.ready = true
let failedView = DeadlineHarness()
failedView.armTimeout()
failedView.failed = true
queue.advance(to: 130)
assert(readyView.failures == 0, "a ready view ignores its pending timeout")
assert(failedView.failures == 0, "a failed view cannot report a duplicate failure")
print("visible-deadline-ok")
`)
  const output = execFileSync('/usr/bin/swift', ['-module-cache-path', join(temporary, 'swift-module-cache'), script], { encoding: 'utf8', timeout: 30_000 })
  assert.equal(output.trim(), 'visible-deadline-ok')
})

test('native startup keeps the Harness boot page visible while concealing unverified conversation content', async () => {
  const swift = await readFile(new URL('src/features/session-windows/SessionWindow.swift', root), 'utf8')
  assert.doesNotMatch(swift, /NSProgressIndicator|正在打开会话/)
  assert.match(swift, /failureOverlay\.isHidden = true/)
  assert.match(swift, /failureLabel\.stringValue = message\s+failureOverlay\.isHidden = false/)
  const boot = /let boot = """\n([\s\S]*?)\n\s*"""/u.exec(swift)?.[1]
  assert.ok(boot, 'the document-start guard is part of the real native UserScript')
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"><div data-dsh-boot>HARNESS</div><main>Old main panel</main><div class="_centerCol_fixture"><div data-conversation-session="previous">Old conversation</div></div></div></body></html>', { runScripts: 'outside-only' })
  try {
    dom.window.eval(boot.replace('\\(encodedSessionId)', JSON.stringify('target-session')))
    const doc = dom.window.document
    assert.equal(dom.window.__QIUYA_SESSION_WINDOW__, 'target-session')
    assert.equal(dom.window.getComputedStyle(doc.querySelector('[data-dsh-boot]')).visibility, 'visible')
    for (const selector of ['main', '[class*="_centerCol"]', '[data-conversation-session]']) assert.equal(dom.window.getComputedStyle(doc.querySelector(selector)).visibility, 'hidden', selector)
    doc.body.dataset.qytSessionWindowState = 'ready'
    for (const selector of ['main', '[class*="_centerCol"]', '[data-conversation-session]']) assert.equal(dom.window.getComputedStyle(doc.querySelector(selector)).visibility, 'visible', selector)
  } finally { dom.window.close() }
})


test('exact window endpoints work with a sibling WebServer plugin under real Cordis shadow contexts', async () => {
  const ctx = new Context()
  const routes = []
  // A root.provide would conceal Cordis's dependency check and caused the
  // previous custom-channel regression to pass its original fixture.
  const server = ctx.plugin(child => child.provide('webServer', { port: 19444, register(route) { routes.push(route); return () => routes.splice(routes.indexOf(route), 1) } }))
  const readers = ctx.plugin(child => child.provide('sessionController', { list: async () => ({ items: [] }) }))
  await server.await(); await readers.await()
  const connection = ctx.plugin(child => { new HostConnectionService(child, [], { isAuthenticated: () => true }) })
  await connection.await()
  let installer
  const plugin = ctx.plugin(child => {
    installer = child.inject(['connection', 'webServer'], injected => {
      // This is the real failure observed inside the official desktop Host.
      assert.throws(() => injected.connection.rpc.handle('/qiuya-old-test', async () => ({ ok: true, value: {} })), /webServer.*without inject/)
      injected.effect(() => installSessionWindowsHost(injected, () => true))
    })
  })
  await plugin.await(); await installer.await()
  try {
    assert.equal(routes.length, 0, 'the plugin contributes exact handlers to the existing /api bridge instead of a new WebServer route')
    const service = ctx.get('connection')
    const shared = service.createSharedFetchHandler('/api')
    const endpoint = contract.SESSION_WINDOW_STATUS_ENDPOINT
    const createRequest = override => new Request(`http://127.0.0.1:19444/api/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'fixture-status', method: endpoint, payload: {}, ...override }) })
    const response = await shared.fetch(createRequest(), service.browserPeer)
    assert.equal(response.status, 200)
    const decoded = await response.json()
    assert.equal(decoded.rpcId, 'fixture-status')
    assert.equal(decoded.result.ok, true)
    assert.equal(typeof decoded.result.value.available, 'boolean')
    const foreign = { ...service.browserPeer, principal: { kind: 'api' } }
    assert.equal((await shared.fetch(createRequest(), foreign)).status, 403, 'the official exact-route fence denies non-owner native launches')
    for (const invalid of [{ type: 'other' }, { rpcId: '' }, { method: contract.SESSION_WINDOW_OPEN_ENDPOINT }]) assert.equal((await shared.fetch(createRequest(invalid), service.browserPeer)).status, 400)
    await plugin.dispose()
    assert.equal((await shared.fetch(createRequest(), service.browserPeer)).status, 404)
  } finally { await plugin.dispose(); await connection.dispose(); await readers.dispose(); await server.dispose() }
})

test('Client retries a startup status failure and updates a mounted menu instead of staying loading', async () => {
  const dom = new JSDOM('<body></body>', { url: 'https://local.invalid/' })
  const module = { exports: {} }
  const scheduled = new Map()
  let timerSequence = 0
  vm.runInNewContext(clientSource, {
    module, exports: module.exports, window: dom.window, document: dom.window.document, URL,
    setTimeout(callback) { const timer = ++timerSequence; scheduled.set(timer, callback); return timer },
    clearTimeout(timer) { scheduled.delete(timer) },
    require: id => id === '@deepseek-ai/dsh-client-ui-primitives' ? {} : require(id),
  })
  const cleanups = []
  let actions
  let attempts = 0
  const services = {
    sessions: { list: { getSnapshot: () => ({ phase: 'ready', byId: { A: { id: 'A', displayTitle: 'Fixture', blank: false } } }) } },
    workspaces: { list: { getSnapshot: () => ({ phase: 'ready', archivedSessionIds: [] }) } },
    uiWorkspace: { openSession() {} },
    locale: { getSnapshot: () => ({ active: 'zh' }) },
    slots: {
      inject(_name, callback) { const off = callback(); return () => off() },
      register(options) { actions = options.inject().actions; return () => {} },
    },
    connection: { rpc: { async call(channel, endpoint) {
      assert.equal(channel, contract.SESSION_WINDOW_CHANNEL)
      assert.equal(endpoint, contract.SESSION_WINDOW_STATUS_ENDPOINT)
      if (++attempts === 1) throw new Error('Host contribution is still activating')
      return { ok: true, value: { available: true } }
    } } },
    effect(callback) { cleanups.push(callback()) },
  }
  const dispose = module.exports.installSessionWindows({ inject(_names, callback) { callback(services); return { async dispose() { for (const cleanup of cleanups.reverse()) cleanup() } } } })
  try {
    await new Promise(setImmediate)
    assert.equal(actions.status.getSnapshot().reason, 'host-transport')
    assert.equal(scheduled.size, 1)
    const [timer, retry] = scheduled.entries().next().value
    scheduled.delete(timer); retry()
    await new Promise(setImmediate)
    assert.equal(attempts, 2)
    assert.equal(actions.status.getSnapshot().available, true)
    assert.equal(actions.canOpen('A'), true)
  } finally { dispose(); dom.window.close() }
  assert.equal(scheduled.size, 0)
})

test('exact Host route uses the browser owner reader without a root SessionController', async () => {
  let listed = 0
  const controller = { async list() { listed++; return { items: [{ sessionId: 'peer-session', title: 'Peer fixture' }] } } }
  const fixture = windowFetchFixture({ get: () => undefined })
  fixture.host.connection.browserPeer.ctx.get = name => name === 'sessionController' ? controller : undefined
  const dispose = installSessionWindowsHost(fixture.host, () => true)
  try {
    assert.deepEqual(await fixture.call('status'), { ok: true, value: { ...versionCompatibility, available: true } })
    assert.equal((await fixture.call('open', { sessionId: 'peer-session', source: 'menu' })).ok, true)
    assert.equal(listed, 1)
    fixture.host.connection.browserPeer.ctx.get = () => undefined
    assert.deepEqual(await fixture.call('status'), { ok: true, value: { ...versionCompatibility, available: false, reason: 'reader-missing' } })
  } finally { dispose() }
})

test('Host resolves optional profileContext through get and sends only a hashed profile identity over stdin', async () => {
  const profile = join(temporary, 'profile-one')
  let providedProfile = { dir: profile }
  const live = { id: 'profile-scoped', header: { id: 'profile-scoped' }, seq: 2 }
  const readers = { sessions: { get: () => live }, sessionProjections: { stateOf: () => ({ blank: false }) } }
  const requested = []
  const fixture = windowFetchFixture({ get(name) { requested.push(name); return name === 'profileContext' ? providedProfile : readers[name] } })
  Object.defineProperty(fixture.host, 'profileContext', { get() { throw new Error('cannot get property "profileContext" without inject') } })
  const dispose = installSessionWindowsHost(fixture.host, () => true)
  const before = (await readFile(records, 'utf8')).trim().split('\n').length
  try {
    assert.equal((await fixture.call('open', { sessionId: live.id, source: 'menu' })).ok, true)
    providedProfile = undefined
    assert.equal((await fixture.call('open', { sessionId: live.id, source: 'menu' })).ok, true, 'an absent optional service must not fall back to a strict property read')
    const commands = (await readFile(records, 'utf8')).trim().split('\n').slice(before).map(JSON.parse)
    assert.deepEqual(commands.map(value => value.storeIdentifier), [await sessionWindowStoreIdentifier(live.id, profile), await sessionWindowStoreIdentifier(live.id)])
    assert.equal(JSON.stringify(commands).includes(profile), false, 'the native protocol does not disclose profile paths')
    assert.equal(requested.filter(name => name === 'profileContext').length, 2)
    assert.deepEqual(commands.map(value => value.argv), [[], []], 'profile identity and credentials never enter process arguments')
  } finally { dispose() }
})


test('native helper is a normal app bundle with a stable identity and Dock/window participation', () => {
  const plist = sessionWindowAppInfoPlist('0.2.1')
  assert.equal(SESSION_WINDOW_APP_NAME, 'QiuYaTools Sessions.app')
  assert.equal(SESSION_WINDOW_BUNDLE_ID, 'com.qiuya.tools.session-window')
  assert.match(plist, /<key>CFBundleIdentifier<\/key><string>com\.qiuya\.tools\.session-window<\/string>/)
  assert.match(plist, /<key>CFBundleExecutable<\/key><string>qiuya-session-window<\/string>/)
  assert.match(plist, /<key>CFBundlePackageType<\/key><string>APPL<\/string>/)
  assert.match(plist, /<key>LSUIElement<\/key><false\/>/)
  assert.match(plist, /<key>LSMinimumSystemVersion<\/key><string>13\.0<\/string>/)
  assert.throws(() => sessionWindowAppInfoPlist('<invalid>'))
})

test('built native helper supports its promised Mac architectures and macOS 13', { skip: process.platform !== 'darwin' }, () => {
  const executable = fileURLToPath(new URL('lib/QiuYaTools Sessions.app/Contents/MacOS/qiuya-session-window', root))
  const architectures = execFileSync('/usr/bin/lipo', ['-archs', executable], { encoding: 'utf8' }).trim().split(/\s+/)
  assert.ok(architectures.includes(process.arch === 'arm64' ? 'arm64' : 'x86_64'))
  if (process.env.QIUYA_TOOLS_UNIVERSAL === '1') assert.deepEqual(new Set(architectures), new Set(['arm64', 'x86_64']))
  const loadCommands = execFileSync('/usr/bin/otool', ['-arch', 'all', '-l', executable], { encoding: 'utf8' })
  const minimums = [...loadCommands.matchAll(/\bminos (\d+\.\d+(?:\.\d+)?)/g)].map(match => match[1])
  assert.equal(minimums.length, architectures.length)
  assert.ok(minimums.every(minimum => minimum === '13.0' || minimum === '13.0.0'))
})

test('live target validation uses the exact Session and current blank unit without scanning the catalog', async () => {
  let lists = 0
  let stats = 0
  const live = { id: 'live-session', header: { id: 'live-session', cwd: '/fixture' }, seq: 9 }
  const fixture = windowFetchFixture({
    sessions: { get: id => id === live.id ? live : undefined },
    sessionProjections: { stateOf: (session, key) => { assert.equal(session, live); assert.equal(key, 'sessionListMetadata'); return { blank: false } } },
    sessionPersistence: { async stat() { stats++; return undefined } },
    sessionController: { async list() { lists++; return { items: [] } } },
  })
  const dispose = installSessionWindowsHost(fixture.host, () => true)
  try {
    assert.equal((await fixture.call('open', { sessionId: live.id, source: 'menu' })).ok, true)
    assert.equal(lists, 0)
    assert.equal(stats, 0)
    fixture.host.sessionProjections.stateOf = () => ({ blank: true })
    assert.equal((await fixture.call('open', { sessionId: live.id, source: 'menu' })).ok, false, 'an explicit blank projection overrides a positive event count')
  } finally { dispose() }
})

test('cold target validation stats only the requested identity and rejects missing, blank, or mismatched headers', async () => {
  const requested = []
  let lists = 0
  let current = { header: { id: 'cold-session', cwd: '/fixture' }, eventCount: 12 }
  let blank = false
  const fixture = windowFetchFixture({
    sessionPersistence: { async stat(id, options) { requested.push(id); assert.equal(options.signal.aborted, false); return current } },
    sessionProjectionCache: { cachedSnapshot: () => ({ values: { sessionListMetadata: { blank } } }) },
    sessionController: { async list() { lists++; return { items: [] } } },
  })
  const dispose = installSessionWindowsHost(fixture.host, () => true)
  try {
    assert.equal((await fixture.call('open', { sessionId: 'cold-session', source: 'menu' })).ok, true)
    assert.deepEqual(requested, ['cold-session'])
    assert.equal(lists, 0)
    blank = true
    assert.equal((await fixture.call('open', { sessionId: 'cold-session', source: 'menu' })).ok, false)
    blank = false; current = { header: { id: 'cold-session', cwd: '/fixture' }, eventCount: 0 }
    assert.equal((await fixture.call('open', { sessionId: 'cold-session', source: 'menu' })).ok, false)
    current = undefined
    assert.equal((await fixture.call('open', { sessionId: 'missing-session', source: 'menu' })).ok, false)
    current = { header: { id: 'different-session', cwd: '/fixture' }, eventCount: 12 }
    assert.equal((await fixture.call('open', { sessionId: 'cold-session', source: 'menu' })).ok, false)
    assert.equal(lists, 0, 'authoritative exact misses never trigger a full-list fallback')
  } finally { dispose() }
})

test('cancellation before or during exact target metadata reads never launches a native window', async () => {
  let reads = 0
  const aborted = new AbortController()
  aborted.abort()
  let inFlight
  const fixture = windowFetchFixture({
    sessionPersistence: { async stat(id) { reads++; inFlight.abort(); return { header: { id, cwd: '/fixture' }, eventCount: 1 } } },
    sessionProjectionCache: { cachedSnapshot: () => ({ values: { sessionListMetadata: { blank: false } } }) },
  })
  const dispose = installSessionWindowsHost(fixture.host, () => true)
  const before = (await readFile(records, 'utf8')).trim().split('\n').length
  try {
    assert.equal((await fixture.call('open', { sessionId: 'cancelled', source: 'menu' }, aborted.signal)).ok, false)
    assert.equal(reads, 0)
    inFlight = new AbortController()
    assert.equal((await fixture.call('open', { sessionId: 'cancelled', source: 'menu' }, inFlight.signal)).ok, false)
    assert.equal(reads, 1)
    assert.equal((await readFile(records, 'utf8')).trim().split('\n').length, before)
  } finally { dispose() }
})
