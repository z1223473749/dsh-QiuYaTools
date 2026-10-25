import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url)), directory = await mkdtemp('/private/tmp/qyt-desktop-lifecycle-')
const bundle = await build({ stdin: { resolveDir: root, contents: "export { DesktopWorkbenchRegistry } from './src/features/workbench/desktop-registry.ts'" }, bundle: true, write: false, platform: 'node', format: 'esm' })
await writeFile(join(directory, 'registry.mjs'), bundle.outputFiles[0].text)
const { DesktopWorkbenchRegistry } = await import(pathToFileURL(join(directory, 'registry.mjs')).href)
after(() => rm(directory, { recursive: true, force: true }))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

function fixture() {
  const entered = deferred(), released = deferred(), environmentId = randomUUID()
  const state = { epoch: 3, state: 'ready', target: { id: 'own-window', appId: 'own.application', title: '自有测试窗口' }, reads: 0, ownerCurrent: true, returnedTarget: 'own-window' }
  const registry = new DesktopWorkbenchRegistry({
    workbenchEnvironment() { return { environmentId, snapshot: { epoch: state.epoch, state: state.state, target: state.target } } },
    async preview() { state.reads++; entered.resolve(); await released.promise; return { targetId: state.returnedTarget, frameId: 'held-frame', imageBase64: '/9j/2Q==', mediaType: 'image/jpeg', width: 1, height: 1, elements: '', geometry: { x: 0, y: 0, width: 1, height: 1, scale: 1 } } },
  })
  const owner = { signal: new AbortController().signal, assertCurrent() { if (!state.ownerCurrent) throw Object.assign(new Error('owner changed'), { code: 'OWNER_CHANGED' }) } }
  const view = registry.views('own-chat')[0]
  const read = () => registry.preview('own-chat', environmentId, view.workbenchTabId, owner)
  return { registry, state, entered, released, environmentId, owner, view, read }
}

for (const [name, change] of [
  ['pause advances the control epoch', s => { s.epoch++; s.state = 'paused' }],
  ['stop removes the selected target', s => { s.epoch++; s.target = undefined; s.state = 'stopped' }],
  ['the selected window is replaced', s => { s.target = { ...s.target, id: 'replacement-window' } }],
]) test(`a previously verified preview reports CONTROL_CHANGED when ${name} during its actual wait`, async () => {
  const f = fixture(), pending = f.read()
  const rejected = assert.rejects(pending, { code: 'CONTROL_CHANGED' })
  await f.entered.promise; change(f.state); f.released.resolve(); await rejected
  assert.equal(f.state.reads, 1, 'The old frame must be refused without retrying the device')
})

test('an invalid initial view remains VIEW_CHANGED and never reaches the device', async () => {
  const f = fixture()
  await assert.rejects(f.registry.preview('own-chat', f.environmentId, randomUUID(), f.owner), { code: 'VIEW_CHANGED' })
  assert.equal(f.state.reads, 0)
})

test('a foreign frame target remains VIEW_CHANGED without a control lifecycle change', async () => {
  const f = fixture(), pending = f.read(), rejected = assert.rejects(pending, { code: 'VIEW_CHANGED' })
  await f.entered.promise; f.state.returnedTarget = 'foreign-window'; f.released.resolve(); await rejected
  assert.equal(f.state.reads, 1)
})

test('an actual owner change is preserved rather than normalized as a preview lifecycle change', async () => {
  const f = fixture(), pending = f.read(), rejected = assert.rejects(pending, { code: 'OWNER_CHANGED' })
  await f.entered.promise; f.state.ownerCurrent = false; f.released.resolve(); await rejected
  assert.equal(f.state.reads, 1)
})
