import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import sessionRemote from '@deepseek-ai/dsh-api-session-controller/remote'
import { ownerRendererClosure } from '../scripts/vision-owner-renderer.mjs'

function fixture() {
  const calls = [], logs = [], stored = new Map()
  const context = { location: { protocol: 'dsh-app:', hostname: 'app' }, window: {},
    crypto: { randomUUID }, AbortSignal, TextDecoder, Uint8Array,
    sessionStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) },
    console: { log: value => logs.push(value) },
    async fetch(url, init) {
      const request = JSON.parse(init.body); calls.push({ url, init, request })
      const method = request.method
      let value
      if (method === 'session/modelCatalog') value = { default: { provider: 'deepseek-account', model: 'deepseek-flash' }, groups: [{ id: 'deepseek-account', models: [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', apiKey: 'private-secret', description: '/private/unrelated/path' }] }] }
      else if (method === 'pluginManager/listPlugins') value = [{ moduleName: 'dsh-qiuya-tools', fiberPhase: 'active', meta: { error: 'private-secret' } }, { moduleName: '@deepseek-ai/dsh-hmr', fiberPhase: 'active' }, { moduleName: 'unrelated-private-plugin', meta: { path: '/private/unrelated/path' } }]
      else if (method === 'pluginManager/listBundles') value = [{ name: 'dsh-qiuya-tools', version: '0.5.2', enabled: true, source: '/private/package/path', description: 'private-secret' }]
      else if (method === 'session/list') { assert.deepEqual(request.payload.args, { _request: {} }); value = { items: [{ sessionId: 'real-running-session', running: true, title: 'private-secret', cwd: '/private/unrelated/path' }, { sessionId: 'unrelated-idle-session', running: false }] } }
      else if (method === 'pluginManager/installBundle') { assert.equal(request.payload.args.options.enabled, true); value = { application: 'restart-required', restartReason: 'package-moved', changed: true, version: '0.6.0-beta.1', packageResult: { output: 'private-secret', logPath: '/private/unrelated/path' }, warnings: ['private-secret'] } }
      else if (method === 'qiuya-tools.computer.control') { assert.deepEqual(request.payload, { op: 'status' }); value = { enabled: false, sessions: [], native: null, allowedApps: ['/private/unrelated/path'] } }
      else throw new Error('Unexpected RPC: ' + method)
      return Response.json({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } })
    },
  }
  context.window.top = context.window
  return { context: vm.createContext(context), calls, logs }
}

test('owner read-only closure uses public envelopes and returns only approved metadata', async () => {
  assert.equal(sessionRemote.methods['session/list'].parameters[0].wire, '_request', 'Use the actual generated public parameter name')
  assert.equal(sessionRemote.methods['session/modelCatalog'].parameters.length, 0)
  const f = fixture()
  const result = await vm.runInContext(ownerRendererClosure('read-only'), f.context)
  assert.equal(result.catalog.default.model, 'deepseek-flash')
  assert.equal(result.catalog.models[0].inputModalities, null)
  assert.equal(result.plugins.qiuya.version, '0.5.2')
  assert.equal(result.plugins.hmrActive, true)
  assert.deepEqual(Array.from(result.background.runningSessionIds), ['real-running-session'])
  assert.equal(f.calls.length, 4)
  assert.ok(f.calls.every(call => call.url.startsWith('/api/') && call.init.credentials === 'same-origin' && !('cookie' in call.init.headers)))
  assert.doesNotMatch(JSON.stringify(result), /private-secret|\/private\/|unrelated-idle-session|unrelated-private-plugin/u)
})

test('owner install closure performs one scoped installation and suppresses replay after an unknown reply', async () => {
  const f = fixture(), source = ownerRendererClosure('install', '/fixture/exact-candidate.tgz')
  const first = await vm.runInContext(source, f.context)
  assert.equal(first.install.restartRequired, true)
  assert.equal(first.install.restartReason, 'package-moved')
  assert.equal(first.after.computerStatus.enabled, false)
  const second = await vm.runInContext(source, f.context)
  assert.equal(second.install.duplicateSuppressed, true)
  assert.equal(f.calls.filter(call => call.request.method === 'pluginManager/installBundle').length, 1)
  assert.ok(f.calls.every(call => !/prompt|selectModel|cancel|removeBundle|setPlugin|setBundle/u.test(call.request.method)))
  assert.doesNotMatch(JSON.stringify(first), /private-secret|\/private\/|exact-candidate/u)
  const lost = fixture(), fetch = lost.context.fetch
  lost.context.fetch = async (url, init) => {
    const response = await fetch(url, init)
    if (JSON.parse(init.body).method === 'pluginManager/installBundle') throw new Error('The server may have applied the install before this reply was lost')
    return response
  }
  const unknown = await vm.runInContext(source, lost.context)
  assert.equal(unknown.install.problem, 'transport-or-protocol')
  assert.equal((await vm.runInContext(source, lost.context)).install.duplicateSuppressed, true)
  assert.equal(lost.calls.filter(call => call.request.method === 'pluginManager/installBundle').length, 1)
})

test('owner probes fail closed outside the existing main Desktop renderer', async () => {
  const f = fixture(); f.context.location.hostname = 'other'
  const result = await vm.runInContext(ownerRendererClosure('install', '/fixture/exact-candidate.tgz'), f.context)
  assert.equal(result.problem, 'existing-owner-renderer-required')
  assert.equal(f.calls.length, 0)
})

test('raw remote errors and successful diagnostic objects cannot leak through probe output', async () => {
  const f = fixture()
  f.context.fetch = async (_url, init) => {
    const request = JSON.parse(init.body)
    return Response.json({ type: 'server-response', rpcId: request.rpcId, result: { ok: false, error: { code: 'private-secret', message: '/private/path', details: { token: 'private-secret' } } } })
  }
  const result = await vm.runInContext(ownerRendererClosure('read-only'), f.context)
  assert.equal(result.catalog.problem, 'remote-rejected')
  assert.doesNotMatch(f.logs.join('\n'), /private-secret|\/private\/|token/u)
})
