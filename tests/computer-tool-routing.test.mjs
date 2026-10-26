import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt, renderContextSnapshot, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { build } from 'esbuild'

const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/features/computer-use/tool-routing.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', metafile: true,
})
const compiledModule = { exports: {} }
vm.runInNewContext(compiled.outputFiles[0].text, { module: compiledModule, exports: compiledModule.exports, require: createRequire(import.meta.url) })
const { installComputerToolRouting } = compiledModule.exports

/** Shell bodies are inert SDK fixtures. No test reads a real app, screen, or profile. */
async function fixture(t) {
  const ctx = new Context(), plugins = [], calls = []
  const agent = { id: 'routing-chat' }, other = { id: 'other-chat' }, child = { id: 'routing-child' }
  const state = { enabled: true, rows: [], current: agent, roots: [agent, other], reads: 0 }
  const agents = {
    get(id) { return id === agent.id ? state.current : id === other.id ? other : id === child.id ? child : undefined },
    roots() { return [...state.roots] },
  }
  const environments = {
    environments() { state.reads++; return state.rows.map(row => ({ ...row })) },
    statusFor() { throw Error('Routing must not create a driver or query the OS') },
    authorizationStatus() { throw Error('Routing must not query system permissions') },
    applicationsFor() { throw Error('Routing must not discover applications eagerly') },
  }
  const mount = async (plugin, config) => { const value = ctx.plugin(plugin, config); plugins.push(value); await value.await(); return value }
  await mount(SystemPrompt, { includeHarnessIdentity: false })
  await mount(ToolRuntime)
  await mount(scope => scope.provide('agents', agents))
  let injected, injection, remove
  await mount(scope => {
    injection = scope.inject(['systemPrompt', 'tools', 'agents'], active => {
      injected = active
      remove = installComputerToolRouting(active, environments, () => state.enabled)
    })
  })
  await injection.await()
  const runtime = ctx.get('tools'), systemPrompt = ctx.get('systemPrompt')
  const register = name => injected.tools.register({
    name, description: 'Inert routing regression fixture',
    parameters: { type: 'object', additionalProperties: true },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) { calls.push({ name, args, agent: exec.agent }); return { executed: true } },
  })
  for (const name of ['bash', 'pwsh', 'skill', 'bsk_tabs', 'qiuya_computer_discover', 'qiuya_computer_observe', 'qiuya_browser_open']) register(name)
  const call = (name, args = {}, subject = agent) => runtime.execute({ callId: randomUUID(), name, arguments: args, agent: subject, signal: new AbortController().signal })
  const assemble = (subject = agent) => systemPrompt.assemble(subject ? { agent: subject, scope: subject } : {})
  const mode = (value, extra = {}) => { state.rows = [{ sessionId: agent.id, mode: value, switching: false, retiring: false, ...extra }] }
  t.after(async () => { remove?.(); for (const plugin of plugins.reverse()) await plugin.dispose() })
  return { ctx, state, agent, other, child, calls, register, runtime, systemPrompt, call, assemble, mode, remove: () => remove() }
}

const routingSection = assembly => assembly.sections.find(section => section.name === 'qiuya-tools:computer-routing')?.text ?? ''
const environmentText = assembly => assembly.contexts.find(context => context.name === 'qiuya-tools:computer-environment')?.text ?? ''
const feedback = result => result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')

test('actual SystemPrompt publishes local-first tool guidance and a literal default environment without OS imports', async t => {
  const f = await fixture(t), assembly = await f.assemble()
  assert.match(routingSection(assembly), /qiuya_computer_discover/u)
  assert.match(routingSection(assembly), /qiuya_computer_request_control/u)
  assert.match(routingSection(assembly), /bsk/u)
  assert.match(environmentText(assembly), /local|这台电脑/u)
  assert.match(renderPrompt(assembly), /qiuya_computer_discover/u)
  assert.match(renderContextSnapshot(assembly), /local|这台电脑/u)
  assert.ok(f.state.reads > 0)
  assert.equal(Object.keys(compiled.metafile.inputs).some(path => /native|driver|browser\.ts/u.test(path)), false, 'Prompt/guard installation must not import a device driver')
  assert.equal(Object.keys(compiled.metafile.outputs).flatMap(path => compiled.metafile.outputs[path].imports).some(value => /child_process|playwright/u.test(value.path)), false)
})

test('actual ToolRuntime denies local browser fallbacks before their body while retaining QiuYa tools', async t => {
  const f = await fixture(t)
  const blocked = [
    ['bsk_tabs', {}],
    ['skill', { name: 'browser-skill' }],
    ['bash', { command: 'bsk tabs' }],
    ['bash', { command: '/usr/local/bin/bsk tabs' }],
    ['bash', { command: '"/Applications/Tools/bin/bsk" tabs' }],
    ['bash', { command: 'osascript -e \'tell application "Google Chrome" to get URL of active tab of front window\'' }],
    ['bash', { command: '/usr/bin/osascript -e \'tell application "Google Chrome" to get name\'' }],
    ['bash', { command: 'git status --short; command -v bsk' }],
    ['bash', { command: 'printf ready | /usr/bin/osascript -' }],
    ['pwsh', { command: '& "C:\\Tools\\bsk.exe" tabs' }],
  ]
  for (const [name, args] of blocked) {
    const result = await f.call(name, args)
    assert.equal(result.isError, true, `${name} ${JSON.stringify(args)} must not execute in this chat's local mode`)
    assert.match(feedback(result), /qiuya_computer_discover|QiuYa|电脑/u)
  }
  assert.equal(f.calls.length, 0, 'Denied fallbacks must never invoke their tool body')
  for (const name of ['qiuya_computer_discover', 'qiuya_computer_observe', 'qiuya_browser_open']) assert.equal((await f.call(name)).isError, false)
  assert.deepEqual(f.calls.map(call => call.name), ['qiuya_computer_discover', 'qiuya_computer_observe', 'qiuya_browser_open'])
})

test('ordinary coding shell and unrelated skills remain callable through the real SDK', async t => {
  const f = await fixture(t)
  const commands = [
    ['bash', { command: 'git status --short' }],
    ['bash', { command: 'npm run typecheck' }],
    ['bash', { command: 'rg -n "browser|bsk" src' }],
    ['bash', { command: 'printf "%s\\n" "documentation mentions osascript"' }],
    ['bash', { command: 'rg -n osascript src' }],
    ['bash', { command: 'pnpm test -- --grep bsk' }],
    ['bash', { command: "printf '%s\\n' 'bsk --version' > example.sh" }],
    ['bash', { command: 'cat docs/osascript' }],
    ['bash', { command: 'echo bsk' }],
    ['bash', { command: '# bsk is mentioned in a comment\ngit status --short' }],
    ['bash', { command: "cat <<'EOF'\nbsk --version\nosascript --help\nEOF\nnode --version" }],
    ['pwsh', { command: 'Get-Content package.json' }],
    ['skill', { name: 'code-review' }],
  ]
  for (const [name, args] of commands) assert.equal((await f.call(name, args)).isError, false, `${name} ${JSON.stringify(args)} is ordinary coding work`)
  assert.equal(f.calls.length, commands.length)
})

test('guard covers lazy bsk registration without requiring a known-name restriction at installation', async t => {
  const f = await fixture(t)
  f.register('bsk_late_registered')
  assert.equal((await f.call('bsk_late_registered')).isError, true)
  assert.equal(f.calls.length, 0)
  f.state.enabled = false
  assert.equal((await f.call('bsk_late_registered')).isError, false)
})

test('environment changes are read dynamically and remain isolated to the calling root chat', async t => {
  const f = await fixture(t)
  f.state.rows = [{ sessionId: f.other.id, mode: 'remote', switching: false, retiring: false }]
  assert.equal((await f.call('bsk_tabs')).isError, true, 'Another chat remote environment must not switch this chat')
  for (const mode of ['browser', 'remote']) {
    f.mode(mode)
    assert.equal((await f.call('bsk_tabs')).isError, false)
    assert.equal((await f.call('bash', { command: 'bsk tabs' })).isError, false)
    assert.match(environmentText(await f.assemble()), new RegExp(`${mode}|${mode === 'browser' ? '独立浏览器' : '远端电脑'}`, 'u'))
  }
  f.mode('local')
  assert.equal((await f.call('bsk_tabs')).isError, true)
  assert.match(environmentText(await f.assemble()), /local|这台电脑/u)
})

test('required environment context refreshes mode and transition facts at SDK admission', async t => {
  const f = await fixture(t), accepted = await f.assemble()
  f.mode('remote', { switching: true })
  let refreshed = f.systemPrompt.refreshContext(accepted, { agent: f.agent, scope: f.agent })
  assert.match(environmentText(refreshed), /remote|远端电脑/u)
  assert.match(environmentText(refreshed), /switch|切换/u)
  f.mode('local', { retiring: true })
  refreshed = f.systemPrompt.refreshContext(accepted, { agent: f.agent, scope: f.agent })
  assert.match(environmentText(refreshed), /retir|清理/u)
  assert.equal((await f.call('bsk_tabs')).isError, true, 'A local environment being cleaned up must not grant another route')
  f.state.enabled = false
  refreshed = f.systemPrompt.refreshContext(accepted, { agent: f.agent, scope: f.agent })
  assert.equal(environmentText(refreshed), '')
})

test('optional runtime-context suppression retains the registered operational environment fact', async t => {
  const f = await fixture(t)
  let removeSuppression
  const plugin = f.ctx.plugin(scope => { scope.inject(['systemPrompt'], active => { removeSuppression = active.systemPrompt.suppressRuntimeContext() }) })
  await plugin.await()
  try { assert.match(environmentText(await f.assemble()), /local|这台电脑/u) }
  finally { removeSuppression?.(); await plugin.dispose() }
})

test('stale same-id instances, children, and agentless calls receive no new root authority or routing policy', async t => {
  const f = await fixture(t), stale = { id: f.agent.id }
  for (const subject of [stale, f.child, undefined]) {
    const actual = subject === undefined ? await f.systemPrompt.assemble({}) : await f.assemble(subject)
    assert.equal(routingSection(actual), '')
    assert.equal(environmentText(actual), '')
    const result = await f.runtime.execute({ callId: randomUUID(), name: 'bsk_tabs', arguments: {}, agent: subject, signal: new AbortController().signal })
    assert.equal(result.isError, false)
  }
  const replacement = { id: f.agent.id }
  f.state.current = replacement; f.state.roots = [replacement, f.other]
  assert.equal((await f.call('bsk_tabs')).isError, false, 'The old root instance must lose the new policy after replacement')
  assert.equal((await f.call('bsk_tabs', {}, replacement)).isError, true)
})

test('disabling and disposing routing removes guidance and guards without mutating tool registrations', async t => {
  const f = await fixture(t), names = f.runtime.schemas().map(tool => tool.name).sort()
  f.state.enabled = false
  let assembly = await f.assemble()
  assert.equal(routingSection(assembly), '')
  assert.equal(environmentText(assembly), '')
  assert.equal((await f.call('bsk_tabs')).isError, false)
  f.state.enabled = true
  assert.equal((await f.call('bsk_tabs')).isError, true)
  f.remove()
  assembly = await f.assemble()
  assert.equal(routingSection(assembly), '')
  assert.equal(environmentText(assembly), '')
  assert.equal((await f.call('bsk_tabs')).isError, false)
  assert.deepEqual(f.runtime.schemas().map(tool => tool.name).sort(), names)
})
