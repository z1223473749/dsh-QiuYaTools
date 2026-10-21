import test from 'node:test'
import assert from 'node:assert/strict'
import { VisionPolicy, VISION_TOOLS, sameVisionTarget, projectVisionRequest, projectVisionTool, assertVisionAnswerHidden, projectVisionFailure, projectVisionNativeStatus } from '../scripts/live-vision-guard-core.mjs'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { visionBundleManifest, visionBundlePatch, visionBundleConsole, VISION_TEST_BUNDLE } from '../scripts/prepare-live-vision.mjs'
import { bundlePatchPaths, loadOverlayPatches, composeEntries } from '@deepseek-ai/dsh-app-boot'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import vm from 'node:vm'
import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'

const id = 'qiuya-vision-12345678-1234-1234-1234-123456789abc'
const target = { id: 'mac-window:123', pid: 1234, appId: 'com.qiuya.tools.vision-own' }
const selection = { provider: 'account-route', model: 'visual-model' }
function fixture(task = 1) {
  let now = 1000
  const policy = new VisionPolicy({ sessionId: id, target, task, selection, now: () => now })
  return { policy, advance: delta => { now += delta } }
}
const request = (extra = {}) => ({ sessionId: id, ...selection, messages: [], tools: VISION_TOOLS.map(name => ({ name })), ...extra })

test('vision guard never acts on an unrelated session and rejects shell/read_image/select on its own scope', () => {
  const { policy } = fixture(); policy.arm()
  assert.equal(policy.toolGuard({ agent: { id: 'someone-else' }, name: 'bash' }), undefined)
  for (const name of ['bash', 'read_image', 'qiuya_computer_select', 'qiuya_computer_targets', 'run_code']) assert.equal(policy.toolGuard({ agent: { id }, name }), 'VISION_TOOL_NOT_ALLOWED')
  assert.equal(policy.toolGuard({ agent: { id }, name: 'qiuya_computer_observe' }), undefined)
})

test('thirteenth model stream is denied before dispatch even if a step retries', () => {
  const { policy } = fixture(); policy.arm(); policy.enterStep()
  for (let i = 0; i < 12; i++) policy.admitRequest(request())
  assert.throws(() => policy.admitRequest(request()), /VISION_REQUEST_LIMIT/)
  assert.equal(policy.requests.length, 12); assert.equal(policy.steps, 1)
})

test('180-second deadline blocks both model requests and tool dispatch', () => {
  const { policy, advance } = fixture(); policy.arm(); advance(180000)
  assert.throws(() => policy.enterStep(), /VISION_DEADLINE/)
  assert.throws(() => policy.admitRequest(request()), /VISION_DEADLINE/)
  assert.equal(policy.toolGuard({ agent: { id }, name: 'qiuya_computer_act', arguments: { action: { kind: 'click' } } }), 'VISION_DEADLINE')
})

test('fixture identity is exact and task action policy rejects browser navigation or OS shortcuts', () => {
  assert.equal(sameVisionTarget({ ...target }, target), true)
  for (const other of [{ pid: 9999 }, { id: 'mac-window:other' }, { appId: 'other.app' }]) assert.equal(sameVisionTarget({ ...target, ...other }, target), false)
  const { policy } = fixture(2); policy.arm()
  for (const action of [{ kind: 'navigate', url: 'https://example.com' }, { kind: 'key', key: 'CMD+Q' }, { kind: 'type', text: 'x'.repeat(257) }]) assert.ok(policy.toolGuard({ agent: { id }, name: 'qiuya_computer_act', arguments: { action } }))
})

test('a business pass alone cannot establish visual reasoning without retained images and a read nonce', () => {
  const { policy } = fixture(); policy.arm(); policy.enterStep(); policy.admitRequest(request())
  assert.equal(policy.summary({ businessPassed: true, nonceRead: true, syntheticNonce: 'A1B2C3' }).passed, false)
  policy.admitRequest(request({ messages: [{ role: 'tool', content: [{ type: 'image', attachment: { attachmentId: 'synthetic', width: 1280, height: 960, bytes: 100, mediaType: 'image/jpeg' } }] }] }))
  assert.equal(policy.summary({ businessPassed: true, nonceRead: false, syntheticNonce: 'A1B2C3' }).passed, false)
  assert.equal(policy.summary({ businessPassed: true, nonceRead: true, syntheticNonce: 'A1B2C3' }).passed, false)
  policy.recordObservation({ elements: 'Opaque image canvas', image: { attachmentId: 'unrelated-image' } }, 'A1B2C3')
  assert.equal(policy.summary({ businessPassed: true, nonceRead: true, syntheticNonce: 'A1B2C3' }).passed, false)
  policy.recordObservation({ elements: 'Opaque image canvas', image: { attachmentId: 'synthetic' } }, 'A1B2C3')
  assert.equal(policy.summary({ businessPassed: true, nonceRead: true, syntheticNonce: 'A1B2C3' }).passed, true)
})

test('initial accessibility text must not reveal the random answer before the model sees a result', () => {
  assert.equal(assertVisionAnswerHidden('Disposable visual business canvas. Inspect the screenshot.', 'A1B2C3'), true)
  for (const value of ['AXValue=A1B2C3', 'help: a1b2c3', undefined]) assert.throws(() => assertVisionAnswerHidden(value, 'A1B2C3'), /VISION_ACCESSIBILITY_ANSWER_LEAK/)
})

test('metadata projection omits prompt text, action plaintext, replay state, auth and endpoint fields', () => {
  const projected = projectVisionRequest(request({ apiKey: 'fixture-not-a-real-key', endpoint: 'private-url', messages: [{ content: [{ type: 'text', text: 'PRIVATE_TEXT' }, { type: 'image', attachment: { attachmentId: 'image-1', width: 2, height: 3, bytes: 4, mediaType: 'image/jpeg', auth: 'PRIVATE_AUTH' } }] }] }))
  const tool = projectVisionTool('qiuya_computer_act', { action: { kind: 'type', text: 'PRIVATE_TEXT' } })
  assert.doesNotMatch(JSON.stringify({ projected, tool }), /PRIVATE_|fixture-not|private-url/)
  assert.equal(tool.action.textLength, 12); assert.equal(tool.action.textSha256.length, 64)
})

test('actual public ToolRuntime scope hides shell and applies final guards without changing another agent', async () => {
  const root = new Context(), calls = [], agent = { id }, other = { id: 'unrelated-existing-session' }
  const system = root.plugin(child => child.provide('systemPrompt', { tools() { return () => {} } }))
  await system.await()
  const plugin = root.plugin(ToolRuntime); await plugin.await()
  let scoped, runtime
  const installation = root.plugin(child => {
    child.inject(['tools'], injected => {
      runtime = injected.tools
      for (const name of [...VISION_TOOLS, 'bash', 'read_image', 'qiuya_computer_select', 'qiuya_computer_targets']) runtime.register({ name, description: name,
        parameters: { type: 'object', additionalProperties: true }, output: { schema: { type: 'object', additionalProperties: true }, render: () => [] },
        async execute(args, exec) { calls.push({ name, id: exec.agent.id }); return { executed: true } } })
      scoped = createScope(injected, agent)
      const tools = scoped.ctx.tools, { policy } = fixture(1); policy.arm()
      tools.presentAs('native'); tools.restrict({ allow: VISION_TOOLS }); tools.guard(exec => policy.toolGuard(exec))
      const definition = runtime.get('qiuya_computer_observe')
      tools.register({ ...definition, async execute(args, exec) { calls.push({ name: 'scoped-observe', id: exec.agent.id }); return definition.execute(args, exec) } })
    })
  })
  await installation.await()
  try {
    assert.ok(runtime, 'public service injection must be ready')
    assert.deepEqual(runtime.schemas(agent).map(tool => tool.name).sort(), [...VISION_TOOLS].sort())
    assert.ok(runtime.schemas(other).some(tool => tool.name === 'bash'))
    const invoke = (subject, name, args = {}) => runtime.execute({ callId: name + '-' + subject.id, agent: subject, name, arguments: args, signal: new AbortController().signal })
    assert.equal((await invoke(agent, 'qiuya_computer_observe')).isError, false)
    assert.equal((await invoke(agent, 'bash')).isError, true)
    assert.equal((await invoke(agent, 'qiuya_computer_act', { action: { kind: 'key', key: 'CMD+Q' } })).isError, true)
    assert.equal((await invoke(other, 'bash')).isError, false)
    assert.deepEqual(calls.map(row => row.name), ['scoped-observe', 'qiuya_computer_observe', 'bash'])
    await scoped.dispose()
    assert.ok(runtime.schemas(agent).some(tool => tool.name === 'bash'), 'disposal removes only this test scope restrictions')
  } finally { await scoped?.dispose(); await installation.dispose(); await plugin.dispose(); await system.dispose() }
})

test('temporary private bundle composes through the official patch parser without profile mutation or runtime dependencies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qiuya-vision-bundle-unit-'))
  try {
    const manifest = visionBundleManifest(), config = { native: join(directory, 'frozen-helper'), directory }
    assert.equal(manifest.name, VISION_TEST_BUNDLE); assert.equal(manifest.version, '0.0.0'); assert.equal(manifest.private, true)
    assert.equal(manifest.dependencies, undefined); assert.equal(manifest.scripts, undefined)
    const patch = visionBundlePatch(config, '12345678-1234-1234-1234-123456789abc')
    await writeFile(join(directory, 'cordis.patch.yml'), JSON.stringify(patch))
    const rows = composeEntries([bundlePatchPaths(directory, manifest.dsh.bundle).flatMap(file => loadOverlayPatches('dsh', file))])
    assert.equal(rows.length, 1); assert.equal(rows[0].name, VISION_TEST_BUNDLE)
    assert.deepEqual(rows[0].config, config)
    assert.throws(() => visionBundlePatch({ ...config, native: 'floating/helper' }), /absolute test paths/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

function consoleHarness() {
  const values = new Map(), calls = [], output = [], state = { installed: false }
  const window = {}; window.top = window
  const execute = source => new Promise((done, reject) => {
    const timer = setTimeout(() => reject(Error('Synthetic Console closure did not finish')), 1000)
    const context = { window, location: { protocol: 'dsh-app:', hostname: 'app' }, crypto: { randomUUID: () => 'synthetic-request-' + calls.length }, AbortSignal,
      sessionStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
      console: { log(value) { output.push(value); clearTimeout(timer); done(JSON.parse(value.slice(value.indexOf(' ') + 1))) }, error(value) { output.push(value); clearTimeout(timer); done({ failed: true }) } },
      async fetch(_url, options) {
        const envelope = JSON.parse(options.body); calls.push(envelope)
        let value
        if (envelope.method === 'pluginManager/listBundles') value = state.installed ? [{ name: VISION_TEST_BUNDLE, version: '0.0.0', enabled: true, private: 'SYNTHETIC_PRIVATE_METADATA' }] : []
        else if (envelope.method === 'pluginManager/listPlugins') value = [{ moduleName: '@deepseek-ai/dsh-hmr', fiberPhase: 'active' }, ...(state.installed ? [{ moduleName: VISION_TEST_BUNDLE, fiberPhase: 'active' }] : [])]
        else if (envelope.method === 'pluginManager/installBundle') { state.installed = true; value = { application: 'applied', changed: true, packageResult: { output: 'SYNTHETIC_PRIVATE_DIAGNOSTIC' } } }
        else if (envelope.method === 'pluginManager/removeBundle') { state.installed = false; value = { application: 'applied', changed: true, error: null } }
        else throw Error('Unknown public test method')
        return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value } })
      },
    }
    vm.runInNewContext(source, context)
  })
  return { execute, calls, output, state, values }
}
const closureConfig = { archive: join(tmpdir(), 'synthetic-vision-test.tgz'), sha256: 'a'.repeat(64) }

test('owner Console install uses official args, stays below 2k and never replays an uncertain prior attempt', async () => {
  const f = consoleHarness(), command = await visionBundleConsole('install', closureConfig)
  assert.ok(command.length < 2000); assert.equal(command.includes('\n'), false)
  assert.equal((await f.execute(command)).application, 'applied')
  const install = f.calls.find(row => row.method === 'pluginManager/installBundle')
  assert.equal(install.payload.args.spec, closureConfig.archive); assert.equal(install.payload.args.options.enabled, true)
  assert.equal(install.payload.args.options.saveExact, true)
  f.state.installed = false // unknown server response/observation cannot authorize replay.
  assert.equal((await f.execute(command)).duplicateSuppressed, true)
  assert.equal(f.calls.filter(row => row.method === 'pluginManager/installBundle').length, 1)
  assert.doesNotMatch(f.output.join(''), /SYNTHETIC_PRIVATE_/u)
})

test('owner Console read-only and removal touch only this test bundle and removal requires this install attempt', async () => {
  const f = consoleHarness(), read = await visionBundleConsole('read-only', closureConfig), remove = await visionBundleConsole('uninstall', closureConfig)
  for (const command of [read, remove]) { assert.ok(command.length < 2000); assert.equal(command.includes('\n'), false) }
  assert.equal((await f.execute(read)).installed, false)
  assert.equal((await f.execute(remove)).failed, true)
  assert.equal(f.calls.some(row => row.method === 'pluginManager/removeBundle'), false)
  await f.execute(await visionBundleConsole('install', closureConfig))
  assert.equal((await f.execute(read)).active, true)
  const result = await f.execute(remove); assert.equal(result.application, 'applied'); assert.equal(result.absent, true); assert.equal(result.inactive, true)
  assert.equal(f.calls.find(row => row.method === 'pluginManager/removeBundle').payload.args.name, VISION_TEST_BUNDLE)
  assert.doesNotMatch(f.output.join(''), /SYNTHETIC_PRIVATE_/u)
})

test('diagnostics admit only finite phases/public codes and boolean native permission readback', () => {
  const error = Object.assign(new TypeError('PRIVATE_MESSAGE token=PRIVATE_TOKEN'), { code: 'VISION_PRIVATE_TOKEN', stack: 'PRIVATE_STACK', cause: { credentials: 'PRIVATE_AUTH' } })
  assert.deepEqual(projectVisionFailure(error, 'PRIVATE_PHASE'), { phase: 'unknown', code: 'VISION_TEST_FAILED', category: 'type-error' })
  assert.deepEqual(projectVisionFailure({ code: 'ENOENT', message: 'PRIVATE_PATH' }, 'fixture-copy'), { phase: 'fixture-copy', code: 'ENOENT', category: 'filesystem' })
  const native = projectVisionNativeStatus({ available: true, platform: 'darwin', protocolVersion: 1, message: 'PRIVATE_NATIVE_MESSAGE', auth: 'PRIVATE_AUTH', permissions: { screenRecording: false, accessibility: true, postEvents: 'PRIVATE_VALUE', inputMonitoring: false, unknown: 'PRIVATE_PERMISSION' } })
  assert.deepEqual(native, { available: true, platform: 'darwin', protocolVersion: 1, permissions: { screenRecording: false, accessibility: true, postEvents: null, inputMonitoring: false } })
  assert.doesNotMatch(JSON.stringify({ error: projectVisionFailure(error), native }), /PRIVATE_/u)
})

async function bundledVisionPlugin(directory) {
  const file = join(directory, 'guard.mjs')
  await build({ entryPoints: [fileURLToPath(new URL('../scripts/live-vision-guard-plugin.mjs', import.meta.url))], outfile: file, bundle: true, platform: 'node', target: 'node22', format: 'esm' })
  return import(pathToFileURL(file).href)
}

test('real preparation copy failure records its exact phase, drains owned setup and cannot become green after restoration', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qiuya-vision-preparation-diagnostic-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const plugin = await bundledVisionPlugin(directory), routes = new Map(), disposers = []
  const ctx = {
    tools: { get: name => ({ name, execute() { throw Error('Tools must not run during failed preparation') } }) },
    connection: { browserPeer: { principal: { kind: 'owner' } }, fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } },
    effect(fn) { disposers.push(fn()) }, on() { return () => {} },
  }
  const config = { fixtureTemplate: join(directory, 'missing-template.app'), native: join(directory, 'must-not-spawn'), directory: join(directory, 'own-output') }
  if (process.platform !== 'darwin') { assert.throws(() => plugin.apply(ctx, config), /VISION_MAC_REQUIRED/); assert.equal(routes.size, 0); return }
  plugin.apply(ctx, config); t.after(async () => { for (const dispose of disposers) await dispose() })
  const call = async input => (await routes.get('/api/qiuya-tools.vision-test').fetch(new Request('http://127.0.0.1/api/qiuya-tools.vision-test', { method: 'POST', body: JSON.stringify(input) }))).json()
  const result = await call({ op: 'prepare', task: 1 })
  assert.equal(result.ok, false); assert.equal(result.error, 'ENOENT'); assert.equal(result.diagnostic.phase, 'fixture-copy')
  const failure = JSON.parse(await readFile(join(config.directory, 'evidence/preparation-failure.json'), 'utf8'))
  assert.equal(failure.diagnostic.phase, 'fixture-copy'); assert.equal(failure.diagnostic.category, 'filesystem')
  assert.equal(failure.cleanup.passed, true); assert.deepEqual(failure.nativeStatus, { status: 'not-read' })
  assert.equal(failure.ownedStreamAttemptsObserved, 0); assert.equal(failure.networkDispatchCount, 'not-proven')
  assert.equal((await call({ op: 'delivery', restore: { localMode: true, featureFlags: true } })).value.passed, true)
  const report = JSON.parse(await readFile(join(config.directory, 'evidence/report.json'), 'utf8'))
  assert.equal(report.status, 'failed'); assert.equal(report.tasks.length, 0); assert.equal(report.preparationFailures.length, 1)
  assert.doesNotMatch(JSON.stringify({ result, failure, report }), /missing-template|must-not-spawn|\.app|stack|nonce|pairToken/u)
})

test('served owner client preserves remote preparation phase/public code without leaking the rejected payload or prompting a model', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qiuya-vision-owner-diagnostic-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const plugin = await bundledVisionPlugin(directory), calls = [], output = [], flags = {}, originalEffective = { enabled: true, computerUseEnabled: false }
  const run = vm.runInNewContext(plugin.visionOwnerClientSource().replace('export const run=', 'const run=') + ';run', {
    crypto: { randomUUID: () => 'synthetic-request' }, AbortSignal, Object, TypeError, SyntaxError,
    console: { log(value) { output.push(value) } },
    async fetch(url, options) {
      const input = JSON.parse(options.body); calls.push({ url, input })
      if (url === '/api/qiuya-tools.vision-test') {
        if (input.op === 'prepare') return Response.json({ ok: false, error: 'ENOENT', diagnostic: { phase: 'fixture-copy', message: 'PRIVATE_SERVER_PATH', stack: 'PRIVATE_STACK', token: 'PRIVATE_TOKEN' } })
        if (input.op === 'failure') return Response.json({ ok: true, value: { recorded: true } })
        if (input.op === 'delivery') return Response.json({ ok: true, value: { passed: input.restore.localMode && input.restore.featureFlags } })
        throw Error('Unexpected test operation')
      }
      let value
      if (input.method === 'settings/describe') value = { writable: true, namespaces: [{ ns: 'qiuya-tools', revision: 1, user: { ...flags }, value: { ...originalEffective, ...flags } }] }
      else if (input.method === 'settings/mutate') { for (const op of input.payload.args.ops) { if (op.op === 'set') flags[op.path[0]] = op.value; else delete flags[op.path[0]] }; value = {} }
      else if (input.method === 'qiuya-tools.computer.control') value = input.payload.op === 'status' ? { native: { mode: 'local' }, sessions: [] } : {}
      else throw Error('Model request or unrelated public RPC is forbidden')
      return Response.json({ rpcId: input.rpcId, result: { ok: true, value } })
    },
  })
  const result = await run()
  assert.equal(result.passed, false); assert.equal(result.error, 'ENOENT'); assert.equal(result.diagnostic.phase, 'fixture-copy')
  assert.equal(result.restoration.localMode, true); assert.equal(result.restoration.featureFlags, true)
  assert.equal(calls.filter(row => row.input.method === 'session/prompt').length, 0)
  const failure = calls.find(row => row.input.op === 'failure').input
  assert.deepEqual(failure, { op: 'failure', phase: 'fixture-copy', code: 'ENOENT' })
  assert.doesNotMatch(output.join(''), /PRIVATE_|message|stack|token/u)
})
