import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

// Optional offline review dependency anchor; the normal project run resolves its own public packages.
const anchor = process.env.QIUYA_H2_REVIEW_DEPENDENCY_ANCHOR ?? fileURLToPath(new URL('../../package.json', import.meta.url))
const require = createRequire(anchor), { build } = require('esbuild')
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
const { ToolRuntime } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')).href)
const root = fileURLToPath(new URL('../../', import.meta.url))
const built = await build({ stdin: { resolveDir: root, contents: "export * from './src/features/workbench/model-target.ts';export * from './src/features/workbench/desktop-registry.ts';export * from './src/features/workbench/browser-registry.ts';export * from './src/features/workbench/site-permissions.ts';export * from './src/features/workbench/integration.ts';export {ComputerEnvironmentManager} from './src/features/computer-use/environment-manager.ts';export {ComputerDriverRouter} from './src/features/computer-use/driver-router.ts';export {BrowserDeviceDriver} from './src/features/computer-use/browser.ts';export {createComputerRunBridge} from './src/features/acceptance-runs/integration.ts';export {WORKBENCH_ENDPOINT} from './src/features/workbench/client-api.ts';" }, bundle: true, write: false, platform: 'node', format: 'esm', nodePaths: [join(dirname(anchor), 'node_modules')] })
const api = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))
const turn = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

/** Production manager/router/session and browser registry, with only deterministic non-OS devices. */
async function fixture(t) {
  const agents = new Map(), roots = [], desktops = new Map(), browserStates = [], profile = await realpath(await mkdtemp(join(tmpdir(), 'qiuya-h2-target-pure-')))
  const geometry = { x: 0, y: 0, width: 20, height: 20, scale: 1 }
  const manager = new api.ComputerEnvironmentManager({ directory: profile, enabled: () => true, createRouter(chat) {
    const state = { captures: 0, actions: [], beforeObserve: null, beforeAct: null, lease: 0 }
    const target = { ...geometry, id: 'shared-target', appId: 'fixture.app', pid: 12, title: 'same window title' }
    const driver = { async status() { return { available: true, capabilities: { capture: true, input: true, backgroundInput: true } } }, async targets() { return [{ ...target }] },
      async lease(epoch) { state.lease = epoch }, async release(epoch) { if (state.lease === epoch) state.lease = 0 },
      async observe(targetId, signal) { await state.beforeObserve?.(); signal?.throwIfAborted(); return { targetId, frameId: 'native-frame-' + (++state.captures), imageBase64: '/9j/2Q==', mediaType: 'image/jpeg', width: 20, height: 20, elements: 'isolated native ' + chat, geometry: { ...geometry } } },
      async act(epoch, targetId, action, signal) { await state.beforeAct?.(); signal?.throwIfAborted(); assert.equal(state.lease, epoch); state.actions.push({ targetId, action }); return { applied: true } }, async dispose() {},
    }
    desktops.set(chat, state); return new api.ComputerDriverRouter({ local: driver })
  } })
  const agent = (id = 'chat-one') => { if (!agents.has(id)) { const value = { id }; agents.set(id, value); roots.push(value) } return agents.get(id) }
  const current = value => agents.get(value.id) === value && roots.includes(value)
  const execution = (id = 'chat-one') => ({ callId: randomUUID(), agent: agent(id), signal: new AbortController().signal })
  let permissions
  const browsers = new api.BrowserWorkbenchRegistry({ directory: profile, enabled: () => true, isAllowed: (...args) => permissions.isAllowed(...args), isCallerCurrent: exec => !!exec.agent && current(exec.agent) && !exec.signal.aborted, create(options) {
    const state = { rows: [], allowed: [...options.allowedOrigins], frames: 0, actions: [], previews: 0, elements: 'isolated browser' }, deviceId = 'browser:review-' + browserStates.length
    const browser = { deviceId, profileDir: options.profileDir, async launch() {}, hasOwnedRuntime() { return false }, subscribe() { return () => {} },
      allowedOrigins() { return [...state.allowed] }, setAllowedOrigins(value) { state.allowed = [...value] },
      async open(url, signal, guard) { signal?.throwIfAborted(); guard?.(); const tab = { id: state.rows.length ? 'another-target-' + state.rows.length : 'shared-target', url, title: 'same window title', allowed: true }; state.rows.push(tab); return { ...tab } },
      async list() { return state.rows.map(row => ({ ...row, allowed: state.allowed.includes(new URL(row.url).origin) })) }, async metrics() { return { ...geometry } },
      async observe(targetId) { return { targetId, frameId: 'browser-frame-' + (++state.frames), imageBase64: '/9j/2Q==', mediaType: 'image/jpeg', width: 20, height: 20, elements: state.elements, geometry: { ...geometry } } }, async preview(targetId) { state.previews++; return this.observe(targetId) },
      async act(targetId, action, signal, guard) { signal?.throwIfAborted(); guard?.(); state.actions.push({ targetId, action }); return { applied: true } }, invalidateObservations() {}, async releaseInputs() {},
      async closeOwnedTab(id) { state.rows = state.rows.filter(row => row.id !== id) }, async closeTab(id) { return this.closeOwnedTab(id) }, async navigationState() { return { canGoBack: false, canGoForward: false } }, async close() {},
    }
    browserStates.push(state); return { browser, driver: new api.BrowserDeviceDriver(browser) }
  } })
  permissions = new api.BrowserPermissionCoordinator({ backend: browsers, enabled: () => true, lookupAgent: id => agents.get(id), isRootAgent: current, readAllowedOrigins: () => ['https://allowed.test'], writeAllowedOrigins: async () => {} })
  const target = new api.ModelTargetRegistry(manager, browsers, current), desktop = new api.DesktopWorkbenchRegistry(manager)
  const owner = () => { const controller = new AbortController(); let live = true; return { signal: controller.signal, controller, invalidate() { live = false }, assertCurrent() { controller.signal.throwIfAborted(); if (!live) throw Error('OWNER_CHANGED') } } }
  const native = async (id = 'chat-one') => { const exec = execution(id); await manager.start(id, 'shared-target', { allowOnce: true }); return { exec, view: desktop.views(id)[0] } }
  const browser = async (id = 'chat-one') => { const exec = execution(id), view = await permissions.request(exec, { url: 'https://allowed.test/page', browser: 'chrome', reason: 'isolated authority review' }); return { exec, view, context: browsers.capture(exec, view.environmentId, view.workbenchTabId) } }
  t.after(async () => { await permissions.dispose(); await browsers.dispose(); await manager.dispose(); await rm(profile, { recursive: true, force: true }) })
  return { manager, desktops, browsers, browserStates, permissions, target, desktop, agents, roots, agent, execution, current, owner, native, browser, profile }
}
const identity = value => value && { environmentId: value.environmentId, epoch: value.epoch, targetId: value.target.id, appId: value.target.appId }


export {fixture,api,turn,deferred,identity}
