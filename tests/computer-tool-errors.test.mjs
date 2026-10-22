import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'

const source = (await build({ entryPoints: [fileURLToPath(new URL('../src/features/computer-use/tools.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external' })).outputFiles[0].text
const module = { exports: {} }
vm.runInNewContext(source, { module, exports: module.exports, Buffer, URL, require: createRequire(import.meta.url) })
const { installComputerTools } = module.exports
const privateMessage = 'driver /private/owned-profile/window?token=do-not-forward'
const failure = code => Object.assign(new Error(privateMessage), { code })
const actArgs = { frameId: 'owned-frame', action: { kind: 'move', x: 1, y: 2 } }

async function actualRuntime(service, mode = 'native') {
  const root = new Context(), plugins = [], dispatches = []
  const mount = async plugin => { const value = root.plugin(plugin); plugins.push(value); await value.await(); return value }
  await mount(child => child.provide('systemPrompt', { tools: () => () => {}, section: () => () => {}, getSectionOrder: () => 0 }))
  if (mode === 'ptc') {
    await mount(child => child.provide('workingDirectory', { ensure: async () => process.cwd() }))
    // Only the public PTC evaluation substrate is a test fixture. The real
    // SDK owns run_code, scheduling, subtool dispatch and error forwarding.
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    await mount(child => child.provide('ptcRuntime', {
      language: 'typescript', isolation: 'test-only-function', programFormat: 'function-body',
      resolve: request => request, release: async () => {},
      async run(spec) {
        try { return { logs: [], value: await new AsyncFunction('tools', spec.program)(spec.bindings[0].functions) } }
        catch (error) { return { logs: [], error: { kind: 'program', message: error.message } } }
      },
    }))
  }
  const toolPlugin = root.plugin(ToolRuntime, { mode }); plugins.push(toolPlugin); await toolPlugin.await()
  await mount(child => child.provide('attachments', { saveImage: async () => { throw new Error('No image should be saved after a failed observation') } }))
  let injection, dispose
  await mount(child => { injection = child.inject(['tools', 'attachments'], injected => { dispose = installComputerTools(injected, service) }) })
  await injection.await()
  const agent = { id: 'owned-error-chat', ctx: root, session: { id: 'owned-error-chat', append: (type, value) => dispatches.push({ type, value }) } }
  return {
    runtime: root.get('tools'), agent, dispatches,
    async close() { dispose?.(); for (const plugin of plugins.reverse()) await plugin.dispose() },
  }
}

test('actual public ToolRuntime exposes the focus code safely to the main model', async () => {
  const f = await actualRuntime({ async act() { throw failure('FOCUS_CHANGED') } })
  try {
    const result = await f.runtime.execute({ callId: 'owned-focus-failure', name: 'qiuya_computer_act', arguments: actArgs, agent: f.agent, signal: new AbortController().signal })
    assert.equal(result.isError, true)
    assert.match(result.error.message, /^\[FOCUS_CHANGED\]/u)
    assert.match(result.content[0].text, /\[FOCUS_CHANGED\]/u)
    assert.doesNotMatch(JSON.stringify(result), /private|owned-profile|do-not-forward/u)
  } finally { await f.close() }
})

test('actual public run_code/PTC dispatch preserves the human-interruption code and owner-resume instruction', async () => {
  const f = await actualRuntime({ async act() { throw failure('HUMAN_INPUT_INTERRUPTED') } }, 'ptc')
  try {
    const result = await f.runtime.execute({ callId: 'owned-ptc-failure', name: 'run_code', arguments: { code: `return await tools.qiuya_computer_act(${JSON.stringify(actArgs)})`, description: 'Only own fixture failure transport' }, agent: f.agent, signal: new AbortController().signal })
    assert.equal(result.isError, true)
    assert.match(result.error.message, /\[HUMAN_INPUT_INTERRUPTED\]/u)
    assert.match(result.error.message, /用户.*恢复/u)
    assert.ok(f.dispatches.some(row => row.type === 'tool/ptc-dispatch' && row.value.name === 'qiuya_computer_act' && row.value.isError))
    assert.doesNotMatch(JSON.stringify(result), /private|owned-profile|do-not-forward/u)
  } finally { await f.close() }
})

test('all six operational tools use the safe boundary through the actual public ToolRuntime', async t => {
  for (const [name, method, args, code] of [
    ['targets', 'permittedTargets', {}, 'TARGET_GONE'],
    ['select', 'selectTarget', { targetId: 'owned-target' }, 'OWNER_RESUME_REQUIRED'],
    ['status', 'get', {}, 'HUMAN_INPUT_INTERRUPTED'],
    ['observe', 'observe', {}, 'CAPTURE_TIMEOUT'],
    ['act', 'act', actArgs, 'FOCUS_CHANGED'],
    ['pause', 'pause', {}, 'NATIVE_CLEANUP_FAILED'],
  ]) await t.test(name, async () => {
    const f = await actualRuntime({ [method]() { throw failure(code) } })
    try {
      const result = await f.runtime.execute({ callId: 'owned-' + name, name: 'qiuya_computer_' + name, arguments: args, agent: f.agent, signal: new AbortController().signal })
      assert.equal(result.isError, true)
      assert.ok(result.error.message.startsWith('[' + code + ']'))
      assert.doesNotMatch(JSON.stringify(result), /private|owned-profile|do-not-forward/u)
    } finally { await f.close() }
  })
})

test('status safely projects a retained failure without changing its control state or code', async () => {
  const state = { sessionId: 'owned-error-chat', state: 'paused', epoch: 17, error: { code: 'FOCUS_CHANGED', message: privateMessage } }
  const f = await actualRuntime({ get: () => state })
  try {
    const result = await f.runtime.execute({ callId: 'owned-retained-error', name: 'qiuya_computer_status', arguments: {}, agent: f.agent, signal: new AbortController().signal })
    assert.equal(result.isError, false)
    assert.equal(result.value.state, 'paused')
    assert.equal(result.value.epoch, 17)
    assert.equal(result.value.error.code, 'FOCUS_CHANGED')
    assert.match(result.value.error.message, /^\[FOCUS_CHANGED\]/u)
    assert.equal(state.error.message, privateMessage, 'Public projection must not mutate the service record')
    assert.doesNotMatch(JSON.stringify(result), /private|owned-profile|do-not-forward/u)
  } finally { await f.close() }
})

test('actual SDK preserves unconfirmed cursor cleanup and forbids automatic retry', async () => {
  const f = await actualRuntime({ pause() { throw failure('CURSOR_CLEANUP_FAILED') } })
  try {
    const result = await f.runtime.execute({ callId: 'owned-cursor-cleanup', name: 'qiuya_computer_pause', arguments: {}, agent: f.agent, signal: new AbortController().signal })
    assert.equal(result.isError, true)
    assert.match(result.error.message, /^\[CURSOR_CLEANUP_FAILED\].*指针.*输入.*等待用户.*不要自动重试/u)
    assert.doesNotMatch(JSON.stringify(result), /private|owned-profile|do-not-forward/u)
  } finally { await f.close() }
})

test('unknown codes and throwing code getters cannot expose untrusted error text through the actual SDK', async () => {
  const errors = [failure('PRIVATE_CODE_WITH_TOKEN'), failure('__proto__'), Object.defineProperty(new Error(privateMessage), 'code', { get() { throw new Error(privateMessage) } })]
  for (const error of errors) {
    const f = await actualRuntime({ pause() { throw error } })
    try {
      const result = await f.runtime.execute({ callId: 'owned-unknown-error', name: 'qiuya_computer_pause', arguments: {}, agent: f.agent, signal: new AbortController().signal })
      assert.equal(result.isError, true)
      assert.match(result.error.message, /^\[COMPUTER_TOOL_FAILED\]/u)
      assert.doesNotMatch(JSON.stringify(result), /private|owned-profile|do-not-forward|PRIVATE_CODE|__proto__/u)
    } finally { await f.close() }
  }
})
