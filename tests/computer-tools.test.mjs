import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import * as sdk from '@deepseek-ai/dsh-tools'
import { Context } from '@deepseek-ai/cordis'

const source = (await build({ entryPoints: [fileURLToPath(new URL('../src/features/computer-use/tools.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external' })).outputFiles[0].text
const module = { exports: {} }, require = createRequire(import.meta.url)
vm.runInNewContext(source, { module, exports: module.exports, Buffer, URL, require: id => id === '@deepseek-ai/dsh-tools' ? sdk : require(id) })
const { installComputerTools } = module.exports
const sessionSource = (await build({ entryPoints: [fileURLToPath(new URL('../src/features/computer-use/session.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })).outputFiles[0].text
const { ComputerSessionService } = await import(`data:text/javascript;base64,${Buffer.from(sessionSource).toString('base64')}`)
function fixture(actualService) {
  const definitions = new Map(), calls = [], saved = []
  const attachment = { attachmentId: 'fixture-image', mediaType: 'image/jpeg', bytes: 4, width: 10, height: 10 }
  const ctx = { tools: { register(definition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) } }, attachments: { async saveImage(input) { saved.push(input); return attachment } } }
  const service = actualService ?? {
    get(id) { calls.push(['get', id]); return { sessionId: id, state: 'ready' } },
    async observe(id, signal) { calls.push(['observe', id, signal]); signal.throwIfAborted(); return { targetId: 'target', frameId: 'f1', imageBase64: '/9j/2Q==', mediaType: 'image/jpeg', width: 10, height: 10, elements: 'button' } },
    async act(id, request, signal) { calls.push(['act', id, request, signal]); return { actionId: request.actionId, applied: true } },
    async pause(id) { calls.push(['pause', id]); return { sessionId: id, state: 'paused' } },
    start() { throw new Error('Agent must not start or authorize') }, setAppAllowed() { throw new Error('Agent must not grant itself access') },
  }
  const dispose = installComputerTools(ctx, service)
  const exec = { callId: 'tool-call-1', agent: { id: 'chat-one' }, signal: new AbortController().signal }
  return { definitions, calls, saved, attachment, dispose, exec, ctx, service }
}

async function actualRuntime(f) {
  const root = new Context()
  const system = root.plugin(child => child.provide('systemPrompt', { tools() { return () => {} } }))
  await system.await()
  const toolPlugin = root.plugin(sdk.ToolRuntime)
  await toolPlugin.await()
  const attachments = root.plugin(child => child.provide('attachments', f.ctx.attachments))
  await attachments.await()
  let disposeTools, injection
  const plugin = root.plugin(child => { injection = child.inject(['tools', 'attachments'], injected => { disposeTools = installComputerTools(injected, f.service) }) })
  await plugin.await(); await injection.await()
  return {
    runtime: root.get('tools'), disposeTools: () => disposeTools(),
    async close() { disposeTools(); await plugin.dispose(); await attachments.dispose(); await toolPlugin.dispose(); await system.dispose() },
  }
}

test('public SDK tools bind the calling Agent, never expose start/selfgrant and unregister cleanly', async () => {
  const f = fixture()
  assert.equal(f.definitions.size, 6)
  assert.equal([...f.definitions.keys()].some(name => /start|allow|resume/.test(name)), false)
  await f.definitions.get('qiuya_computer_status').execute({}, f.exec)
  assert.equal(f.calls[0][1], 'chat-one')
  await assert.rejects(f.definitions.get('qiuya_computer_status').execute({}, { ...f.exec, agent: undefined }), { code: 'SESSION_REQUIRED' })
  f.dispose(); assert.equal(f.definitions.size, 0)
})

test('observation stores actual screenshot bytes then canonical output renders a durable image block', async () => {
  const f = fixture(), definition = f.definitions.get('qiuya_computer_observe')
  const value = await definition.execute({}, f.exec)
  assert.equal(f.saved.length, 1)
  assert.deepEqual([...f.saved[0].data], [255, 216, 255, 217])
  assert.equal(value.image.attachmentId, 'fixture-image')
  assert.equal('imageBase64' in value, false)
  const content = definition.output.render({}, value)
  assert.equal(content[1].type, 'image')
  assert.equal(content[1].attachment.attachmentId, 'fixture-image')
  assert.match(content[0].text, /"frameId":"f1"/)
  assert.equal(f.calls[0][2], f.exec.signal)
  f.dispose()
})

test('action validates input, forwards cancellation and uses call identity as default action id', async () => {
  const f = fixture(), definition = f.definitions.get('qiuya_computer_act')
  await definition.execute({ frameId: 'f1', action: { kind: 'key', key: 'Enter' } }, f.exec)
  assert.equal(f.calls[0][2].actionId, f.exec.callId)
  assert.equal(f.calls[0][3], f.exec.signal)
  await assert.rejects(definition.execute({ frameId: 'f1', action: { kind: 'shell', text: 'anything' } }, f.exec))
  assert.equal(f.calls.length, 1)
  f.dispose()
})

test('actual public ToolRuntime registers schemas and validates/render canonical screenshot output', async () => {
  const f = fixture(), actual = await actualRuntime(f)
  try {
    const { runtime } = actual
    assert.ok(runtime.schemas().some(value => value.name === 'qiuya_computer_observe'))
    const result = await runtime.execute({ callId: 'actual-observe', name: 'qiuya_computer_observe', arguments: {}, agent: { id: 'chat-sdk' }, signal: f.exec.signal })
    assert.equal(result.isError, false)
    assert.equal(result.value.frameId, 'f1')
    assert.equal(result.content.find(value => value.type === 'image').attachment.attachmentId, f.attachment.attachmentId)
    assert.equal(f.calls[0][1], 'chat-sdk')
    actual.disposeTools()
    assert.equal(runtime.schemas().some(value => value.name.startsWith('qiuya_computer_')), false)
  } finally { f.dispose(); await actual.close() }
})

test('actual public tools and session consume the click frame and recover type after observing without replaying click', async () => {
  const target = { id: 'window:frame-lifecycle', appId: 'fixture.app', pid: 123, title: 'Fixture', x: 0, y: 0, width: 10, height: 10, scale: 1 }
  const inputs = []; let frame = 0, lease = 0
  const driver = {
    async status() { return { available: true } }, async targets() { return [{ ...target }] },
    async lease(epoch) { lease = epoch }, async release(epoch) { if (epoch === lease) lease = 0 },
    async observe(targetId) { return { targetId, frameId: `frame-${++frame}`, imageBase64: '/9j/2Q==', mediaType: 'image/jpeg', width: 10, height: 10, elements: 'editable fixture', geometry: target } },
    async act(epoch, targetId, action, signal) { signal.throwIfAborted(); assert.equal(epoch, lease); assert.equal(targetId, target.id); inputs.push(action); return { applied: true } },
  }
  const service = new ComputerSessionService(driver), f = fixture(service), actual = await actualRuntime(f)
  const call = (name, args, callId) => actual.runtime.execute({ callId, name: 'qiuya_computer_' + name, arguments: args, agent: { id: 'frame-chat' }, signal: f.exec.signal })
  try {
    await service.start('frame-chat', target.id, { allowOnce: true })
    const schemas = actual.runtime.schemas(), observe = schemas.find(value => value.name === 'qiuya_computer_observe'), act = schemas.find(value => value.name === 'qiuya_computer_act')
    assert.match(observe.description, /every successful act.*click\/type\/key\/move.*consumes/iu)
    assert.match(act.description, /observe → click → observe → type → observe → key/u)
    assert.match(act.parameters.properties.frameId.description, /one successful act.*observe again/iu)
    const first = await call('observe', {}, 'observe-before-click')
    assert.equal(first.isError, false)
    const clicked = await call('act', { frameId: first.value.frameId, action: { kind: 'click', x: 1, y: 2 } }, 'click-once')
    assert.equal(clicked.isError, false); assert.equal(clicked.value.result.applied, true)
    const staleType = await call('act', { frameId: first.value.frameId, action: { kind: 'type', text: 'single input' } }, 'type-old-frame')
    assert.equal(staleType.isError, true)
    assert.match(staleType.error.message, /^\[STALE_OBSERVATION\].*observe.*frameId/u)
    assert.equal(inputs.filter(action => action.kind === 'type').length, 0, 'Rejected stale type must never reach the driver')
    assert.equal(inputs.filter(action => action.kind === 'click').length, 1)
    const fresh = await call('observe', {}, 'observe-before-type')
    assert.equal(fresh.isError, false); assert.notEqual(fresh.value.frameId, first.value.frameId)
    const typed = await call('act', { frameId: fresh.value.frameId, action: { kind: 'type', text: 'single input' } }, 'type-fresh-frame')
    assert.equal(typed.isError, false); assert.equal(typed.value.result.applied, true)
    assert.deepEqual(inputs.map(action => action.kind), ['click', 'type'], 'Refreshing the observation must not replay the successful click')
    assert.equal(inputs[1].text, 'single input')
  } finally { f.dispose(); await actual.close(); await service.dispose() }
})

test('cancelled observation does not create an attachment', async () => {
  const f = fixture(), abort = new AbortController(); abort.abort(new Error('cancelled'))
  await assert.rejects(f.definitions.get('qiuya_computer_observe').execute({}, { ...f.exec, signal: abort.signal }))
  assert.equal(f.saved.length, 0)
  f.dispose()
})

test('registered Agent action exposes structured browser navigation and selectors without eval or file paths', async () => {
  const f = fixture(), tool = f.definitions.get('qiuya_computer_act')
  assert.ok(tool.parameters.properties.action.properties.kind.enum.includes('navigate'))
  assert.equal('expression' in tool.parameters.properties.action.properties, false)
  assert.equal('filePath' in tool.parameters.properties.action.properties, false)
  await tool.execute({ frameId: 'f1', action: { kind: 'navigate', url: 'https://approved.example/path' } }, f.exec)
  assert.equal(f.calls.at(-1)[2].action.url, 'https://approved.example/path')
  await tool.execute({ frameId: 'f2', action: { kind: 'selectorType', selector: '#name', text: '中文🙂' } }, f.exec)
  assert.equal(f.calls.at(-1)[2].action.kind, 'selectorType')
  for (const action of [{ kind: 'navigate', url: 'javascript:alert(1)' }, { kind: 'openTab', url: 'file:///tmp/private' }, { kind: 'selectorClick', selector: '\0bad' }]) await assert.rejects(tool.execute({ frameId: 'f1', action }, f.exec))
  f.dispose()
})
