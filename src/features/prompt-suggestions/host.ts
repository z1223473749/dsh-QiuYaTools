import type { Context } from '@deepseek-ai/cordis'
import { PROMPT_SUGGESTIONS_CHANNEL, PROMPT_SUGGESTIONS_GENERATE_ENDPOINT, PROMPT_SUGGESTIONS_CANCEL_ENDPOINT, parsePromptSuggestionRequest, parsePromptSuggestionCancelRequest, validSuggestionId, type PromptSuggestionRequest, type PromptSuggestionResult, type PromptSuggestionReason } from './contract.ts'
import { normalizePromptSuggestion, suggestionContext, suggestionRoute, suggestionSystem, type SuggestionContext, type SuggestionMessage, type SuggestionRoute } from './model.ts'

interface LiveSession { id: string; deriveMessages(): readonly SuggestionMessage[]; requestHeader(): { config: SuggestionRoute } | undefined }
interface Peer { principal: { kind: string }; ctx?: { get(name: string): unknown } }
interface CallControls { maxTokens?: number; reasoningEffort?: string }
interface CallConfig extends SuggestionRoute { maxTokens: number; reasoningEffort?: string }
interface Chunk { type: string; index?: number; text?: string; block?: { type: string; text?: string }; reason?: { kind: string } }
interface Services {
  connection: { browserPeer?: Peer; fetch: { register(route: { path: string; methods: readonly ['POST']; requestBody: 'buffered'; fetch(request: Request): Promise<Response> }): () => Promise<void> } }
  sessions: { get(id: string): LiveSession | undefined }
  sessionProjections: { stateOf(session: LiveSession, key: 'modelSelection'): { pending?: SuggestionRoute | null } | undefined }
  agentDefaultModel: { currentSelection(): SuggestionRoute }
  llm: { prepareCall(config: CallConfig, signal: AbortSignal, configure: (controls: Readonly<CallControls>, info: { reasoning?: { efforts: readonly { id: string }[] } }) => CallControls): Promise<{ config: CallConfig; stream(options: object): AsyncIterable<Chunk> }> }
  get?(name: string): unknown
}
export interface PromptSuggestionsHostOptions { timeoutMs?: number; cacheTtlMs?: number; cooldownMs?: number; maxCacheEntries?: number; maxConcurrent?: number; pollMs?: number; now?: () => number }
interface Snapshot { session: LiveSession; context: SuggestionContext; route: SuggestionRoute; key: string }
interface Job { request: PromptSuggestionRequest; snapshot: Snapshot; controller: AbortController; waiters: Map<string, (result: PromptSuggestionResult) => void>; timer: ReturnType<typeof setTimeout>; settled: boolean }

const absent = (reason: PromptSuggestionReason, anchorMessageId: string | null = null): PromptSuggestionResult => ({ suggestion: null, anchorMessageId, reason })
function bounded(value: number | undefined, fallback: number, max: number): number { return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(max, Math.max(1, Math.floor(value))) : fallback }

/** One-shot assistance: no prompt(), Session creation, append(), tools, or durable model routing. */
export function installPromptSuggestionsHost(ctx: Context, readEnabled: () => boolean, options: PromptSuggestionsHostOptions = {}): () => void {
  const services = ctx as unknown as Services
  const now = options.now ?? Date.now
  const timeoutMs = bounded(options.timeoutMs, 8_000, 8_000)
  const cacheTtlMs = bounded(options.cacheTtlMs, 600_000, 600_000)
  const cooldownMs = bounded(options.cooldownMs, 15_000, 15_000)
  const maxCache = bounded(options.maxCacheEntries, 64, 64)
  const maxConcurrent = bounded(options.maxConcurrent, 2, 2)
  const jobs = new Map<string, Job>()
  const waiters = new Map<string, Job>()
  const cache = new Map<string, { result: PromptSuggestionResult; expires: number }>()
  let disposed = false
  const enabled = (): boolean => { try { return !disposed && readEnabled() } catch { return false } }
  const snapshot = (request: PromptSuggestionRequest): Snapshot | undefined => {
    const session = services.sessions.get(request.sessionId)
    if (!session || session.id !== request.sessionId) return undefined
    const agents = services.get?.('agents') as { get(id: string): { status?: string } | undefined } | undefined
    if (agents?.get(request.sessionId)?.status === 'running') return undefined
    const context = suggestionContext(session.deriveMessages())
    if (!context) return undefined
    const pending = services.sessionProjections.stateOf(session, 'modelSelection')?.pending
    const route = suggestionRoute(pending, session.requestHeader()?.config, undefined)
      ?? suggestionRoute(undefined, undefined, services.agentDefaultModel.currentSelection())
    if (!route) return undefined
    return { session, context, route, key: JSON.stringify([request.sessionId, context.anchorMessageId, route.provider, route.model, request.language, context.fingerprint]) }
  }
  const remember = (key: string, result: PromptSuggestionResult): void => {
    if (result.reason === 'cancelled' || result.reason === 'disabled' || result.reason === 'stale' || result.reason === 'busy') return
    for (const [entry, value] of cache) if (value.expires <= now()) cache.delete(entry)
    cache.delete(key)
    cache.set(key, { result, expires: now() + (result.suggestion ? cacheTtlMs : cooldownMs) })
    while (cache.size > maxCache) cache.delete(cache.keys().next().value!)
  }
  const settle = (job: Job, result: PromptSuggestionResult, save = true): void => {
    if (job.settled) return
    job.settled = true; clearTimeout(job.timer)
    if (jobs.get(job.snapshot.key) === job) jobs.delete(job.snapshot.key)
    if (save && enabled()) remember(job.snapshot.key, result)
    for (const [id, resolve] of job.waiters) { waiters.delete(id); resolve(result) }
    job.waiters.clear()
  }
  const abort = (job: Job, reason: PromptSuggestionReason): void => {
    if (job.settled) return
    job.controller.abort(reason)
    settle(job, absent(reason, job.snapshot.context.anchorMessageId), reason === 'timeout')
  }
  const cancel = (id: string): void => {
    const job = waiters.get(id)
    if (!job) return
    const resolve = job.waiters.get(id)
    job.waiters.delete(id); waiters.delete(id)
    resolve?.(absent('cancelled', job.snapshot.context.anchorMessageId))
    if (!job.waiters.size) abort(job, 'cancelled')
  }
  const untilAbort = <T,>(promise: Promise<T>, signal: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('cancelled')); return }
    const interrupted = (): void => { signal.removeEventListener('abort', interrupted); reject(new Error('cancelled')) }
    signal.addEventListener('abort', interrupted, { once: true })
    promise.then(value => { signal.removeEventListener('abort', interrupted); resolve(value) }, () => { signal.removeEventListener('abort', interrupted); reject(new Error('failed')) })
  })
  const run = async (job: Job): Promise<void> => {
    const signal = job.controller.signal
    let iterator: AsyncIterator<Chunk> | undefined
    try {
      const call = await untilAbort(services.llm.prepareCall({ ...job.snapshot.route, maxTokens: 128 }, signal, (controls, info) => {
        const efforts = info.reasoning?.efforts ?? []
        const effort = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh']
          .find(id => efforts.some(item => item.id === id))
        return { ...controls, maxTokens: 128, ...(effort ? { reasoningEffort: effort } : {}) }
      }), signal)
      if (signal.aborted || job.settled) return
      // Deliberately omit sessionId and purpose: the official session-log
      // extension otherwise uploads logs and appends delivery receipts.
      iterator = call.stream({ ...call.config, system: suggestionSystem(job.request.language), messages: [{ role: 'user', content: [{ type: 'text', text: job.snapshot.context.transcript }] }], tools: [], signal })[Symbol.asyncIterator]()
      const text = new Map<number, string>()
      let finished = false
      while (true) {
        const next = await untilAbort(Promise.resolve(iterator.next()), signal)
        if (next.done) break
        const chunk = next.value
        if (chunk.type === 'tool-call-delta' || chunk.block?.type === 'tool-call') throw new Error('tools forbidden')
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text.set(chunk.index ?? 0, (text.get(chunk.index ?? 0) ?? '') + chunk.text)
        if (chunk.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') text.set(chunk.index ?? 0, chunk.block.text)
        if ([...text.values()].reduce((length, value) => length + value.length, 0) > 4096) throw new Error('output too large')
        if (chunk.type === 'finish') { if (chunk.reason?.kind !== 'stop') throw new Error('incomplete'); finished = true; break }
      }
      if (!finished) throw new Error('missing finish')
      if (!enabled()) { abort(job, 'disabled'); return }
      const current = snapshot(job.request)
      if (!current || current.session !== job.snapshot.session || current.key !== job.snapshot.key) { settle(job, absent('stale', job.snapshot.context.anchorMessageId), false); return }
      const suggestion = normalizePromptSuggestion([...text.values()].join(''))
      settle(job, { suggestion, anchorMessageId: job.snapshot.context.anchorMessageId, ...(!suggestion ? { reason: 'empty' as const } : {}) })
    } catch {
      if (!job.settled) settle(job, absent(signal.aborted ? 'cancelled' : 'failed', job.snapshot.context.anchorMessageId))
    } finally {
      job.controller.abort('settled')
      if (iterator?.return) void Promise.resolve().then(() => iterator!.return?.()).catch(() => {})
    }
  }
  const generate = (request: PromptSuggestionRequest, signal: AbortSignal): Promise<PromptSuggestionResult> => {
    if (!enabled()) return Promise.resolve(absent('disabled'))
    if (signal.aborted) return Promise.resolve(absent('cancelled'))
    const state = snapshot(request)
    if (!state) return Promise.resolve(absent('unavailable'))
    const cached = cache.get(state.key)
    if (cached && cached.expires > now()) { cache.delete(state.key); cache.set(state.key, cached); return Promise.resolve(cached.result) }
    if (cached) cache.delete(state.key)
    if (waiters.has(request.requestId) || waiters.size >= 128) return Promise.resolve(absent('busy', state.context.anchorMessageId))
    let job = jobs.get(state.key)
    if (!job) {
      for (const old of jobs.values()) if (old.request.sessionId === request.sessionId) abort(old, 'stale')
      if (jobs.size >= maxConcurrent) return Promise.resolve(absent('busy', state.context.anchorMessageId))
      job = { request, snapshot: state, controller: new AbortController(), waiters: new Map(), timer: undefined!, settled: false }
      const created = job
      job.timer = setTimeout(() => abort(created, 'timeout'), timeoutMs)
      jobs.set(state.key, job)
    }
    const active = job
    const result = new Promise<PromptSuggestionResult>(resolve => {
      const onAbort = (): void => cancel(request.requestId)
      active.waiters.set(request.requestId, value => { signal.removeEventListener('abort', onAbort); resolve(value) })
      waiters.set(request.requestId, active)
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
    if (active.waiters.size === 1 && !active.settled && active.request.requestId === request.requestId) void run(active)
    return result
  }
  const poll = setInterval(() => {
    if (!enabled()) { cache.clear(); for (const job of jobs.values()) abort(job, 'disabled') }
  }, bounded(options.pollMs, 100, 100))
  poll.unref?.()
  const endpoints = [PROMPT_SUGGESTIONS_GENERATE_ENDPOINT, PROMPT_SUGGESTIONS_CANCEL_ENDPOINT] as const
  const unregister = endpoints.map(endpoint => services.connection.fetch.register({
    path: `${PROMPT_SUGGESTIONS_CHANNEL}/${endpoint}`, methods: ['POST'], requestBody: 'buffered',
    fetch: async request => {
      const peer = services.connection.browserPeer
      if (!peer || peer.principal.kind !== 'owner') return new Response('Forbidden', { status: 403 })
      let input: unknown
      try { const text = await request.text(); if (text.length > 8192) return new Response('Request too large', { status: 413 }); input = JSON.parse(text) } catch { return new Response('Invalid request', { status: 400 }) }
      if (!input || typeof input !== 'object' || Array.isArray(input)) return new Response('Invalid request', { status: 400 })
      const envelope = input as { type?: unknown; rpcId?: unknown; method?: unknown; payload?: unknown }
      if (envelope.type !== 'client-request' || !validSuggestionId(envelope.rpcId) || envelope.method !== endpoint) return new Response('Invalid envelope', { status: 400 })
      let result: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: object } }
      try {
        if (endpoint === PROMPT_SUGGESTIONS_CANCEL_ENDPOINT) { cancel(parsePromptSuggestionCancelRequest(envelope.payload).requestId); result = { ok: true, value: { cancelled: true } } }
        else result = { ok: true, value: await generate(parsePromptSuggestionRequest(envelope.payload), request.signal) }
      } catch { result = { ok: false, error: { code: 'qiuya-tools/suggestion-unavailable', message: '输入建议暂不可用。', details: {} } } }
      return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result })
    },
  }))
  return () => {
    if (disposed) return
    disposed = true; clearInterval(poll); cache.clear()
    for (const job of jobs.values()) abort(job, 'disabled')
    for (const stop of unregister) void stop()
  }
}
