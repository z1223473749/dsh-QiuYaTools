import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const root = fileURLToPath(new URL('../', import.meta.url))
const { outputFiles } = await build({ stdin: { contents: `export * from './src/features/computer-use/session.ts'; export * from './src/features/computer-use/contract.ts'; export * from './src/features/computer-use/permission-coordinator.ts'; export * from './src/features/computer-use/scheduled-driver.ts'; export * from './src/features/computer-use/presentation.tsx';`, resolveDir: root }, bundle: true, write: false, platform: 'node', format: 'esm', external: ['react'], jsx: 'automatic' })
// A file URL allows external React resolution while retaining one shared error class.
const { mkdtemp, writeFile, rm, symlink } = await import('node:fs/promises')
const dir = await mkdtemp('/tmp/qiuya-virtual-unit-')
await symlink(root + 'node_modules', dir + '/node_modules')
await writeFile(dir + '/bundle.mjs', outputFiles[0].text)
const { ComputerSessionService, ComputerPermissionCoordinator, ComputerError, ScheduledComputerDriver, ComputerInputScheduler, ComputerApprovalCard } = await import('file://' + dir + '/bundle.mjs')
test.after(() => rm(dir, { recursive: true, force: true }))
const unsupported = () => new ComputerError('VIRTUAL_INPUT_UNSUPPORTED', 'unsupported')
const action = { kind: 'drag', x: 10, y: 10, toX: 30, toY: 30 }
function fixture() {
  const target = { id: 'window:fixture', appId: 'fixture.app', pid: 42, title: 'fixture', x: 0, y: 0, width: 100, height: 100, scale: 1 }
  const calls = [], agent = { id: 'chat' }, controller = new AbortController()
  let frame = 0, generation = 0, policy = true, virtualError = unsupported()
  const driver = {
    async status() { return { available: true, capabilities: { virtualInput: true, backgroundInput: true } } },
    async targets() { return [{ ...target }] },
    async observe() { return { targetId: target.id, frameId: 'frame-' + ++frame, imageBase64: '/9j/2Q==', mediaType: 'image/jpeg', width: 100, height: 100, elements: '', geometry: { x: 0, y: 0, width: 100, height: 100, scale: 1 } } },
    async lease() {}, async release() {}, async openPreview() {}, async closePreview() {},
    async act(epoch, id, a, signal, authority) { signal?.throwIfAborted(); calls.push({ epoch, id, action: a, physical: authority?.physicalInputApproved === true }); if (!authority?.physicalInputApproved) throw virtualError; return { performed: true } },
  }
  const service = new ComputerSessionService(driver)
  const backend = {
    get: id => service.get(id), allowedApps: () => service.allowedApps(), setAppAllowed: (...args) => service.setAppAllowed(...args),
    authorizationGeneration: () => generation, authorizationStatus: (_, signal) => driver.status(signal), targetsFor: () => driver.targets(),
    approvePhysicalInput: (...args) => service.approvePhysicalInput(...args), authorizationStart: () => { throw Error('not used') },
  }
  const coordinator = new ComputerPermissionCoordinator({ backend, enabled: () => true, lookupAgent: () => agent, isRootAgent: a => a === agent, canRequest: () => policy })
  const exec = (callId = crypto.randomUUID()) => ({ callId, agent, signal: controller.signal })
  const act = async (id, value = action) => { const observation = await service.observe('chat'); return service.act('chat', { actionId: id, frameId: observation.frameId, action: value }) }
  return { service, coordinator, target, driver, calls, exec, controller, backend, act, setError: e => { virtualError = e }, policy: p => { policy = p }, invalidate: () => { generation++ },
    async start() { await service.setAppAllowed(target.appId, true); await service.start('chat', target.id) },
    async fail(id = 'virtual-failed') { await assert.rejects(act(id), { code: 'VIRTUAL_INPUT_UNSUPPORTED' }) },
    async close() { coordinator.dispose(); await service.dispose() } }
}

test('persisted application grant never grants physical input; unsupported virtual action stays ready and consumes frame', async t => {
  const f = fixture(); t.after(() => f.close()); await f.start(); await f.fail()
  assert.deepEqual(f.calls.map(c => c.physical), [false])
  assert.equal(f.service.get('chat').state, 'ready')
  assert.equal(f.service.get('chat').lastObservation, undefined)
  assert.equal(f.coordinator.pending().length, 0)
})

test('overlapping virtual targets permit fresh virtual observation but cannot request real input', async t => {
  const f = fixture(); t.after(() => f.close()); await f.start()
  f.setError(new ComputerError('VIRTUAL_TARGET_UNRESOLVED', 'adjacent control rectangles overlap'))
  await assert.rejects(f.act('overlap'), { code: 'VIRTUAL_TARGET_UNRESOLVED' })
  assert.equal(f.service.get('chat').state, 'ready')
  assert.equal(f.service.get('chat').lastObservation, undefined)
  await assert.rejects(f.coordinator.requestPhysicalInput(f.exec(), 'overlap is not unsupported'), { code: 'VIRTUAL_INPUT_REQUIRED' })
  assert.equal(f.coordinator.pending().length, 0)
  const next = await f.service.observe('chat')
  assert.ok(next.frameId)
  assert.equal(f.calls.some(c => c.physical), false)
})

test('real mouse approval is explicit, single action, canonical, and requires a fresh post-approval observation', async t => {
  const f = fixture(); t.after(() => f.close()); await f.start(); await f.fail()
  const before = await f.service.observe('chat')
  const waiting = f.coordinator.requestPhysicalInput(f.exec(), '目标控件不支持虚拟拖动')
  await new Promise(resolve => setImmediate(resolve))
  const [card] = f.coordinator.pending('chat'); assert.equal(card.scope, 'physicalInput')
  assert.deepEqual(f.calls.map(c => c.physical), [false])
  await assert.rejects(f.coordinator.decide('chat', card.requestId, 1, 'always'), { code: 'INVALID_REQUEST' })
  await f.coordinator.decide('chat', card.requestId, 1, 'once'); await waiting
  assert.throws(() => f.service.act('chat', { actionId: 'preapproval-frame', frameId: before.frameId, action }), { code: 'STALE_OBSERVATION' })
  await f.act('approved', { toY: 30, toX: 30, y: 10, x: 10, kind: 'drag' })
  await f.fail('next-virtual')
  assert.deepEqual(f.calls.map(c => c.physical), [false, true, false])
})

for (const change of ['deny', 'pause', 'stop', 'generation', 'policy', 'abort']) test(`physical request cannot dispatch after ${change}`, async t => {
  const f = fixture(); t.after(() => f.close()); await f.start(); await f.fail()
  const waiting = f.coordinator.requestPhysicalInput(f.exec(), '虚拟输入不支持'), rejected = assert.rejects(waiting)
  await new Promise(resolve => setImmediate(resolve)); const [card] = f.coordinator.pending()
  if (change === 'deny') await f.coordinator.decide('chat', card.requestId, 1, 'deny')
  if (change === 'pause') await f.service.pause('chat')
  if (change === 'stop') await f.service.stop('chat')
  if (change === 'generation') f.invalidate()
  if (change === 'policy') f.policy(false)
  if (change === 'abort') f.controller.abort()
  if (!['deny', 'abort'].includes(change)) await assert.rejects(f.coordinator.decide('chat', card.requestId, 1, 'once'))
  await rejected
  assert.deepEqual(f.calls.map(c => c.physical), [false])
})

test('a different action consumes the pending physical grant without using it', async t => {
  const f = fixture(); t.after(() => f.close()); await f.start(); await f.fail()
  const snap = f.service.get('chat'); f.service.approvePhysicalInput('chat', snap.epoch, snap.lastAction.actionId)
  await assert.rejects(f.act('different', { kind: 'click', x: 20, y: 20 }), { code: 'VIRTUAL_INPUT_UNSUPPORTED' })
  await f.fail('original-again')
  assert.deepEqual(f.calls.map(c => c.physical), [false, false, false])
})

test('pause invalidates an approved physical grant and uncertain virtual input cannot request physical replay', async t => {
  const f = fixture(); t.after(() => f.close()); await f.start(); await f.fail()
  const snap = f.service.get('chat'); f.service.approvePhysicalInput('chat', snap.epoch, snap.lastAction.actionId)
  await f.service.pause('chat'); await f.service.resume('chat'); await f.fail('after-resume')
  f.setError(new ComputerError('VIRTUAL_INPUT_UNCONFIRMED', 'unknown result'))
  await assert.rejects(f.act('uncertain'), { code: 'VIRTUAL_INPUT_UNCONFIRMED' })
  assert.equal(f.service.get('chat').state, 'paused')
  await assert.rejects(f.coordinator.requestPhysicalInput(f.exec(), 'replay'), { code: 'OWNER_RESUME_REQUIRED' })
  assert.equal(f.calls.some(c => c.physical), false)
})

test('physical request is unavailable without a proven unsupported virtual action', async t => {
  const f = fixture(); t.after(() => f.close()); await f.start()
  await assert.rejects(f.coordinator.requestPhysicalInput(f.exec(), 'skip virtual'), { code: 'VIRTUAL_INPUT_REQUIRED' })
  assert.throws(() => f.service.act('chat', { actionId: 'smuggle', frameId: 'x', action: { ...action, physicalInputApproved: true } }), { code: 'INVALID_ACTION' })
})

test('virtual scheduling never prepares foreground handoff and forwards physical authority only when supplied', async () => {
  const calls = []
  const inner = { async lease() {}, async release() {}, async act(...args) { calls.push(args[4]); return {} }, foregroundHandoff: { async context() { throw Error('must not read physical context for virtual input') } } }
  const driver = new ScheduledComputerDriver(inner, 'local-desktop', new ComputerInputScheduler())
  await driver.lease(1); await driver.act(1, 'target', { kind: 'click', x: 1, y: 1 })
  assert.equal(calls[0].physicalInputApproved, false); await driver.dispose()
})

test('physical permission card explains interference and exposes no persistent permission choice', () => {
  const html = renderToStaticMarkup(React.createElement(ComputerApprovalCard, { request: { scope: 'physicalInput', requestId: 'request', appName: 'Fixture', reason: '不支持虚拟拖动', expiresAt: Date.now() + 60_000 }, busy: false, onDecision() {} }))
  assert.match(html, /真实鼠标授权/); assert.match(html, /系统鼠标和前台焦点/); assert.match(html, /允许本次真实鼠标操作/); assert.doesNotMatch(html, /始终允许/)
})

test('native virtual adapters contain no global injection, focus change, clipboard or cursor-hiding calls', async () => {
  for (const file of ['src/native/macos/VirtualInput.swift', 'src/native/windows/VirtualInput.cs']) {
    const source = await readFile(root + file, 'utf8'), code = source.replace(/\/\/[^\n]*/g, '')
    assert.doesNotMatch(code, /SendInput\(|SetForegroundWindow\(|SetFocus\(|\.activate\(|\.post\(|postToPid\(|CGWarpMouseCursorPosition|CGDisplayHideCursor|NSPasteboard|Clipboard\./)
  }
})
