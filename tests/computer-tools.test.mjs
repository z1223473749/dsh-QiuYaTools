import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import * as sdk from '@deepseek-ai/dsh-tools'
import { Context } from '@deepseek-ai/cordis'

const source = (await build({ entryPoints: [new URL('../src/features/computer-use/tools.ts', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external' })).outputFiles[0].text
const module = { exports: {} }, require = createRequire(import.meta.url)
vm.runInNewContext(source, { module, exports: module.exports, Buffer, require: id => id === '@deepseek-ai/dsh-tools' ? sdk : require(id) })
const { installComputerTools } = module.exports
function fixture() {
  const definitions = new Map(), calls = [], saved = []
  const attachment = { attachmentId: 'fixture-image', mediaType: 'image/jpeg', bytes: 4, width: 10, height: 10 }
  const ctx = { tools: { register(definition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) } }, attachments: { async saveImage(input) { saved.push(input); return attachment } } }
  const service = {
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
  const f = fixture(), root = new Context()
  const system = root.plugin(child => child.provide('systemPrompt', { tools() { return () => {} } }))
  await system.await()
  const toolPlugin = root.plugin(sdk.ToolRuntime)
  await toolPlugin.await()
  const attachments = root.plugin(child => child.provide('attachments', f.ctx.attachments))
  await attachments.await()
  let disposeTools
  let injection
  const plugin = root.plugin(child => { injection = child.inject(['tools', 'attachments'], injected => { disposeTools = installComputerTools(injected, f.service) }) })
  await plugin.await()
  await injection.await()
  try {
    const runtime = root.get('tools')
    assert.ok(runtime.schemas().some(value => value.name === 'qiuya_computer_observe'))
    const result = await runtime.execute({ callId: 'actual-observe', name: 'qiuya_computer_observe', arguments: {}, agent: { id: 'chat-sdk' }, signal: f.exec.signal })
    assert.equal(result.isError, false)
    assert.equal(result.value.frameId, 'f1')
    assert.equal(result.content.find(value => value.type === 'image').attachment.attachmentId, f.attachment.attachmentId)
    assert.equal(f.calls[0][1], 'chat-sdk')
    disposeTools()
    assert.equal(runtime.schemas().some(value => value.name.startsWith('qiuya_computer_')), false)
  } finally { f.dispose(); await plugin.dispose(); await attachments.dispose(); await toolPlugin.dispose(); await system.dispose() }
})

test('cancelled observation does not create an attachment', async () => {
  const f = fixture(), abort = new AbortController(); abort.abort(new Error('cancelled'))
  await assert.rejects(f.definitions.get('qiuya_computer_observe').execute({}, { ...f.exec, signal: abort.signal }))
  assert.equal(f.saved.length, 0)
  f.dispose()
})
