import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setImmediate } from 'node:timers/promises'

const directory = await mkdtemp(join(tmpdir(), 'qiuya-suggestions-test-'))
await build({ entryPoints: ['src/features/prompt-suggestions/host.ts', 'src/features/prompt-suggestions/model.ts', 'src/features/prompt-suggestions/contract.ts'], outdir: directory, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
const { installPromptSuggestionsHost } = await import(pathToFileURL(join(directory, 'host.js')))
const contract = await import(pathToFileURL(join(directory, 'contract.js')))
const { suggestionContext, normalizePromptSuggestion, suggestionRoute } = await import(pathToFileURL(join(directory, 'model.js')))
test.after(() => rm(directory, { recursive: true, force: true }))
const { PROMPT_SUGGESTIONS_CHANNEL: channel, PROMPT_SUGGESTIONS_GENERATE_ENDPOINT: generate, PROMPT_SUGGESTIONS_CANCEL_ENDPOINT: cancel } = contract
const textMessage = (id, role, text, kind = role === 'user' ? 'user' : 'model') => ({ id, role, source: { kind }, content: [{ type: 'text', text }] })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

function fixture(t, options = {}) {
  let enabled = true
  let clock = 100
  let sequence = 0
  const routes = new Map(), sessions = new Map(), prepared = [], streams = []
  const state = { pending: undefined, running: false, defaultReads: 0, output: '请帮我实现下一步并验证结果。', generator: undefined, prepare: undefined, reasoningEfforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }], defaultReasoningEffort: undefined }
  const addSession = id => {
    const session = { id, messages: [textMessage('human-1', 'user', '请分析这个问题。'), textMessage('answer-1', 'assistant', '已经给出分析和下一步方案。')], header: { config: { provider: 'selected-provider', model: 'selected-model', reasoningEffort: 'high' } }, deriveMessages() { return this.messages }, requestHeader() { return this.header }, append() { throw new Error('MUST NOT WRITE SESSION') } }
    sessions.set(id, session)
    return session
  }
  addSession('one')
  const ctx = {
    connection: { browserPeer: { principal: { kind: 'owner' } }, fetch: { register(route) { assert.ok(route.path.startsWith('/api/')); routes.set(route.path, route); return async () => routes.delete(route.path) } } },
    sessions: { get: id => sessions.get(id), create() { throw new Error('MUST NOT CREATE SESSION') } },
    sessionProjections: { stateOf(session, key) { assert.equal(key, 'modelSelection'); return { pending: state.pending } } },
    agentDefaultModel: { currentSelection() { state.defaultReads++; return { provider: 'default-provider', model: 'default-model' } } },
    get(name) { return name === 'agents' ? { get: () => ({ status: state.running ? 'running' : 'idle' }) } : undefined },
    llm: { async prepareCall(config, signal, configure) {
      prepared.push({ config, signal })
      if (state.prepare) await state.prepare(signal)
      // The owning prepareCall callback receives controls only; the route
      // stays bound outside that callback in the actual LlmRuntime.
      const next = configure({ maxTokens: config.maxTokens }, { reasoning: { efforts: state.reasoningEfforts } })
      return { config: { ...config, ...(state.defaultReasoningEffort ? { reasoningEffort: state.defaultReasoningEffort } : {}), ...next }, stream(options) {
        streams.push(options)
        if (state.generator) return state.generator(options)
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: state.output }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: state.output } }
          yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 8 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      } }
    } },
  }
  const dispose = installPromptSuggestionsHost(ctx, () => enabled, { timeoutMs: 1000, now: () => clock, ...options })
  t.after(dispose)
  const raw = async (endpoint, payload, signal = new AbortController().signal) => {
    const route = routes.get(`${channel}/${endpoint}`)
    assert.ok(route)
    return route.fetch(new Request(`http://harness.test${channel}/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: `rpc-${++sequence}`, method: endpoint, payload }), signal }))
  }
  const request = async (payload = {}, signal) => {
    const response = await raw(generate, { sessionId: 'one', requestId: `request-${++sequence}`, language: 'zh', ...payload }, signal)
    assert.equal(response.status, 200)
    const result = (await response.json()).result
    assert.equal(result.ok, true)
    return result.value
  }
  return { ctx, routes, sessions, prepared, streams, state, raw, request, dispose, addSession, setEnabled(value) { enabled = value }, advance(ms) { clock += ms } }
}

test('request contract validates required identities/language and uses a valid native RPC channel', () => {
  assert.match(channel, /^\/[A-Za-z0-9._~-]+$/)
  assert.equal(contract.parsePromptSuggestionRequest({ sessionId: 'one', requestId: 'req', language: 'zh', provider: 'evil' }).provider, undefined)
  for (const payload of [null, [], {}, { sessionId: 'one', requestId: 'req', language: 'fr' }, { sessionId: 'bad id', requestId: 'req', language: 'zh' }, { sessionId: 'one', requestId: '\n', language: 'en' }]) assert.throws(() => contract.parsePromptSuggestionRequest(payload))
  assert.deepEqual(contract.parsePromptSuggestionCancelRequest({ requestId: 'req' }), { requestId: 'req' })
})

test('context includes only bounded visible human/assistant text and requires a final assistant answer', () => {
  const messages = [textMessage('sys', 'system', 'PRIVATE SYSTEM'), textMessage('inject', 'user', 'PRIVATE AGENTS', 'context'), textMessage('human', 'user', '普通请求'), textMessage('tool', 'tool', 'PRIVATE TOOL'), { ...textMessage('answer', 'assistant', '普通回答'), content: [{ type: 'reasoning', text: 'PRIVATE REASONING' }, { type: 'text', text: '普通回答' }, { type: 'file', text: 'PRIVATE FILE' }] }]
  const result = suggestionContext(messages)
  assert.equal(result.anchorMessageId, 'answer')
  assert.equal(result.transcript.includes('PRIVATE'), false)
  assert.equal(suggestionContext([textMessage('last', 'user', '还在等待')]), undefined)
  assert.equal(suggestionContext([{ ...messages.at(-1), content: [{ type: 'tool-call' }, { type: 'text', text: '调用中' }] }]), undefined)
  assert.equal(suggestionContext([]), undefined)
  const huge = suggestionContext([textMessage('huge', 'assistant', '中'.repeat(40_000))])
  assert.ok(Buffer.byteLength(huge.transcript, 'utf8') <= 12_000)
})

test('one-shot uses the current selected route, disables reasoning/tools, and never carries Session identity or durable-purpose metadata', async t => {
  const f = fixture(t)
  const result = await f.request({ provider: 'renderer-provider', model: 'renderer-model' })
  assert.equal(result.suggestion, f.state.output)
  assert.equal(result.anchorMessageId, 'answer-1')
  assert.equal(f.streams.length, 1)
  const options = f.streams[0]
  assert.equal(options.provider, 'selected-provider')
  assert.equal(options.model, 'selected-model')
  assert.equal(options.reasoningEffort, 'off')
  assert.equal(options.maxTokens, 128)
  assert.deepEqual(options.tools, [])
  assert.equal('sessionId' in options, false)
  assert.equal('purpose' in options, false)
  assert.equal(options.messages.length, 1)
  assert.equal('id' in options.messages[0], false)
  assert.equal('source' in options.messages[0], false)
  assert.equal(f.state.defaultReads, 0)
  assert.equal(f.sessions.size, 1)
  assert.equal(f.sessions.get('one').messages.length, 2)
})

test('pending model intent wins the last request; default is read only when neither exists', async t => {
  const f = fixture(t)
  f.state.pending = { provider: 'pending', model: 'pending' }
  await f.request()
  assert.equal(f.streams[0].provider, 'pending')
  f.state.pending = undefined; f.sessions.get('one').header = undefined
  await f.request()
  assert.equal(f.streams[1].provider, 'default-provider')
  assert.equal(f.state.defaultReads, 2, 'default is read at capture and final freshness check')
  assert.deepEqual(suggestionRoute({}, { provider: 'p', model: 'm' }, {}), { provider: 'p', model: 'm' })
})

test('reasoning uses the lightest known effort independently of provider metadata order', async t => {
  const f = fixture(t)
  for (const [efforts, expected] of [
    [['high', 'medium', 'low', 'minimal'], 'minimal'],
    [['xhigh', 'high', 'none', 'minimal'], 'none'],
    [['high', 'low', 'off', 'none'], 'off'],
  ]) {
    f.state.reasoningEfforts = efforts.map(id => ({ id }))
    f.sessions.get('one').messages[1] = textMessage(`answer-${expected}`, 'assistant', '下一步计划')
    assert.ok((await f.request()).suggestion)
    assert.equal(f.streams.at(-1).reasoningEffort, expected)
  }
})

test('unknown reasoning metadata preserves the adapter default instead of selecting its first option', async t => {
  const f = fixture(t)
  f.state.reasoningEfforts = [{ id: 'custom-expensive' }, { id: 'custom-default' }]
  f.state.defaultReasoningEffort = 'custom-default'
  assert.ok((await f.request()).suggestion)
  assert.equal('reasoningEffort' in f.prepared[0].config, false)
  assert.equal(f.streams[0].reasoningEffort, 'custom-default')
})

test('synchronously throwing iterator cleanup cannot reject a completed or cancelled job', async t => {
  const f = fixture(t)
  let returned = 0
  f.state.generator = () => {
    const chunks = [{ type: 'text-delta', text: '继续实现并验证。' }, { type: 'finish', reason: { kind: 'stop' } }]
    return { [Symbol.asyncIterator]() { return this }, next() { return Promise.resolve({ value: chunks.shift(), done: false }) }, return() { returned++; throw new Error('synchronous cleanup failure') } }
  }
  assert.equal((await f.request()).suggestion, '继续实现并验证。')
  await setImmediate()
  assert.equal(returned, 1)
  // A second path enters finally because cancellation wins a next() that
  // ignores AbortSignal; a sync return() failure must stay contained there too.
  f.sessions.get('one').messages[1] = textMessage('cancellable', 'assistant', '另一个最终回答')
  f.state.generator = () => ({ [Symbol.asyncIterator]() { return this }, next() { return new Promise(() => {}) }, return() { returned++; throw new Error('cancel cleanup failure') } })
  const controller = new AbortController()
  const pending = f.request({}, controller.signal)
  await setImmediate(); controller.abort()
  assert.equal((await pending).reason, 'cancelled')
  await setImmediate()
  assert.equal(returned, 2)
})

test('same anchor and language reuse cache, model/language changes do not, and expired entries regenerate', async t => {
  const f = fixture(t, { cacheTtlMs: 100 })
  await f.request(); await f.request()
  assert.equal(f.streams.length, 1)
  await f.request({ language: 'en' })
  assert.match(f.streams[1].system, /English/)
  f.state.pending = { provider: 'another', model: 'another' }; await f.request()
  assert.equal(f.streams.length, 3)
  f.advance(101); await f.request()
  assert.equal(f.streams.length, 4)
})

test('LRU cache is bounded and failures use a short cooldown without retrying the model', async t => {
  const f = fixture(t, { maxCacheEntries: 1, cooldownMs: 20 })
  await f.request(); await f.request({ language: 'en' }); await f.request()
  assert.equal(f.streams.length, 3)
  f.state.generator = async function* () { throw new Error('SECRET provider body') }
  f.sessions.get('one').messages[1] = textMessage('new-answer', 'assistant', '新内容')
  const failed = await f.request()
  assert.equal(failed.reason, 'failed')
  assert.equal(JSON.stringify(failed).includes('SECRET'), false)
  await f.request(); assert.equal(f.streams.length, 4)
  f.advance(21); await f.request(); assert.equal(f.streams.length, 5)
})

test('coalesced windows share one job; cancelling one waiter preserves the other request', async t => {
  const f = fixture(t)
  const gate = deferred()
  f.state.generator = async function* () { await gate.promise; yield { type: 'text-delta', text: '继续实现并验证。' }; yield { type: 'finish', reason: { kind: 'stop' } } }
  const first = f.request({ requestId: 'first' })
  const second = f.request({ requestId: 'second' })
  await setImmediate()
  assert.equal(f.streams.length, 1)
  const response = await f.raw(cancel, { requestId: 'first' })
  assert.deepEqual((await response.json()).result.value, { cancelled: true })
  assert.equal((await first).reason, 'cancelled')
  assert.equal(f.streams[0].signal.aborted, false)
  gate.resolve()
  assert.equal((await second).suggestion, '继续实现并验证。')
})

test('incoming abort and explicit last-waiter cancellation abort generation without caching partial output', async t => {
  const f = fixture(t)
  const gate = deferred()
  f.state.generator = async function* () { yield { type: 'text-delta', text: '部分' }; await gate.promise; yield { type: 'finish', reason: { kind: 'stop' } } }
  const controller = new AbortController()
  const pending = f.request({ requestId: 'abortable' }, controller.signal)
  await setImmediate(); controller.abort()
  assert.equal((await pending).reason, 'cancelled')
  assert.equal(f.streams[0].signal.aborted, true)
  const next = f.request({ requestId: 'explicit' }); await setImmediate()
  await f.raw(cancel, { requestId: 'explicit' })
  assert.equal((await next).reason, 'cancelled')
  assert.equal(f.streams.length, 2)
  gate.resolve()
})

test('hard deadline releases slots even if an adapter ignores abort during preparation', async t => {
  const f = fixture(t, { timeoutMs: 20 })
  const gate = deferred()
  f.state.prepare = () => gate.promise
  assert.equal((await f.request()).reason, 'timeout')
  assert.equal(f.prepared[0].signal.aborted, true)
  assert.equal(f.streams.length, 0)
  gate.resolve()
})

test('global concurrency and per-session supersession are bounded', async t => {
  const f = fixture(t)
  f.addSession('two'); f.addSession('three')
  const gate = deferred()
  f.state.generator = async function* () { await gate.promise; yield { type: 'text-delta', text: '继续。' }; yield { type: 'finish', reason: { kind: 'stop' } } }
  const one = f.request({ requestId: 'one-running' })
  const two = f.request({ sessionId: 'two', requestId: 'two-running' })
  await setImmediate()
  assert.equal((await f.request({ sessionId: 'three' })).reason, 'busy')
  f.sessions.get('one').messages[1] = textMessage('superseding', 'assistant', '新的最终回复')
  const newer = f.request({ requestId: 'newer' })
  assert.equal((await one).reason, 'stale')
  gate.resolve()
  assert.equal((await newer).anchorMessageId, 'superseding')
  await two
})

test('changed context or route before completion discards the stale answer', async t => {
  const f = fixture(t)
  const gate = deferred()
  f.state.generator = async function* () { await gate.promise; yield { type: 'text-delta', text: '不能显示的旧建议' }; yield { type: 'finish', reason: { kind: 'stop' } } }
  const pending = f.request(); await setImmediate()
  f.state.pending = { provider: 'new-route', model: 'new-route' }
  gate.resolve()
  const result = await pending
  assert.equal(result.reason, 'stale')
  assert.equal(result.suggestion, null)
})

test('disable and unload abort in-flight work, clear cache and withdraw routes', async t => {
  const f = fixture(t, { pollMs: 5 })
  const gate = deferred()
  f.state.generator = async function* () { await gate.promise; yield { type: 'finish', reason: { kind: 'stop' } } }
  const pending = f.request(); await setImmediate()
  f.setEnabled(false)
  assert.equal((await pending).reason, 'disabled')
  assert.equal(f.streams[0].signal.aborted, true)
  f.setEnabled(true)
  const another = f.request(); await setImmediate(); f.dispose()
  assert.equal((await another).reason, 'disabled')
  assert.equal(f.routes.size, 0)
  gate.resolve()
})

test('non-owner, missing owner, malformed envelopes and invalid requests never reach model I/O', async t => {
  const f = fixture(t)
  f.ctx.connection.browserPeer.principal.kind = 'delegated'
  assert.equal((await f.raw(generate, {})).status, 403)
  f.ctx.connection.browserPeer = undefined
  assert.equal((await f.raw(generate, {})).status, 403)
  f.ctx.connection.browserPeer = { principal: { kind: 'owner' } }
  const invalid = await f.raw(generate, { sessionId: 'one', requestId: 'ok', language: 'xx' })
  assert.equal((await invalid.json()).result.ok, false)
  const route = f.routes.get(`${channel}/${generate}`)
  assert.equal((await route.fetch(new Request('http://fixture/', { method: 'POST', body: '{}' }))).status, 400)
  assert.equal((await route.fetch(new Request('http://fixture/', { method: 'POST', body: 'x'.repeat(8193) }))).status, 413)
  assert.equal(f.prepared.length, 0)
})

test('missing/cold sessions, running agents and unfinished replies abstain without restoring or prompting', async t => {
  const f = fixture(t)
  assert.equal((await f.request({ sessionId: 'cold' })).reason, 'unavailable')
  f.state.running = true
  assert.equal((await f.request()).reason, 'unavailable')
  f.state.running = false
  f.sessions.get('one').messages.push(textMessage('human-new', 'user', '刚发送的问题'))
  assert.equal((await f.request()).reason, 'unavailable')
  assert.equal(f.prepared.length, 0)
  assert.equal(f.sessions.size, 1)
})

test('tool requests, failed/truncated finishes and non-plain suggestions cannot become ghost text', async t => {
  for (const chunks of [
    [{ type: 'tool-call-delta', id: 'no-tools', argumentsDelta: '{}' }],
    [{ type: 'text-delta', text: '部分' }, { type: 'finish', reason: { kind: 'max-tokens' } }],
    [{ type: 'finish', reason: { kind: 'error', failure: { message: 'SECRET' } } }],
  ]) {
    const f = fixture(t)
    f.state.generator = async function* () { yield* chunks }
    assert.equal((await f.request()).suggestion, null)
  }
  for (const value of ['```code```', '- 运行命令', '第一行\n第二行', '坏\u202e文本', '中'.repeat(121)]) assert.equal(normalizePromptSuggestion(value), null)
  assert.equal(normalizePromptSuggestion('“请继续。”'), '请继续。')
})
