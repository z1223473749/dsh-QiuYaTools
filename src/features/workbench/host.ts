import { hostServiceIdentity } from '../../host-service-identity.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { ComputerError, requireIdentity, parseComputerAction } from '../computer-use/contract.ts'
import type { ComputerActionRequest, ComputerActionResult, ComputerObservation } from '../computer-use/contract.ts'
import { siteOrigin, uuid, website } from './contract.ts'
import type { SiteDecision, SiteRequest, WorkbenchTarget } from './contract.ts'
import type { SiteDecisionReceipt, SiteOwnerScope } from './site-permissions.ts'
import { WORKBENCH_ENDPOINT } from './client-api.ts'

type HostConnection = Pick<HostConnectionHandle, 'browserPeer' | 'fetch'>
export interface WorkbenchOwnerScope extends SiteOwnerScope { readonly chatSessionId: string }
export interface WorkbenchHostRegistry {
  views(chat: string): WorkbenchTarget[]
  environments(chat: string): { environmentId: string; kind: string; state: string; title: string }[]
  preview(chat: string, environmentId: string, tabId: string, owner: SiteOwnerScope): Promise<{ target: WorkbenchTarget; observation: ComputerObservation; viewOnly: boolean }>
  control(chat: string, environmentId: string, tabId: string, operation: 'pause' | 'takeover' | 'resume' | 'stop', owner: SiteOwnerScope): Promise<unknown>
  humanAct(chat: string, environmentId: string, tabId: string, request: ComputerActionRequest, owner: SiteOwnerScope): Promise<ComputerActionResult & { workbench?: WorkbenchTarget }>
  navigation(chat: string, environmentId: string, tabId: string, owner: SiteOwnerScope): Promise<{ canGoBack: boolean; canGoForward: boolean; url?: string }>
  stopEnvironment(chat: string, environmentId: string, owner: SiteOwnerScope): Promise<void>
}
export interface WorkbenchHostPermissions {
  pending(chat?: string): SiteRequest[]
  allowedOrigins(): string[]
  decide(chat: string, requestId: string, version: unknown, decision: unknown, owner: SiteOwnerScope): Promise<SiteDecisionReceipt>
  revoke(origin: unknown): Promise<{ origin: string; revoked: true }>
  openFromOwner(owner: SiteOwnerScope, chat: string, input: { actionId: unknown; url: unknown; browser: unknown; decision: unknown }): Promise<WorkbenchTarget>
}
export interface WorkbenchHostOptions {
  registry: WorkbenchHostRegistry
  permissions: WorkbenchHostPermissions
  /** Public Host session query, capturing the actual session identity across awaits. */
  resolveScope(chatSessionId: string, signal: AbortSignal): Promise<WorkbenchOwnerScope> | WorkbenchOwnerScope
}
const fail = (code = 'INVALID_REQUEST') => new ComputerError(code, '工作台操作未能确认，请刷新查看，不要重复提交。')
function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fail()
  return value as Record<string, unknown>
}
function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.length) || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)) throw fail()
  return value
}
function number(value: unknown, minimum: number, maximum: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum || integer && !Number.isSafeInteger(value)) throw fail()
  return value
}
const choice = (value: unknown, values: readonly string[]): value is string => typeof value === 'string' && values.includes(value)
function list<T>(value: readonly T[], max: number): readonly T[] { if (!Array.isArray(value) || value.length > max) throw fail(); return value }
function target(value: WorkbenchTarget, chat: string): WorkbenchTarget {
  if (value.chatSessionId !== chat || !['browser', 'desktop'].includes(value.kind)) throw fail('VIEW_CHANGED')
  return { chatSessionId: chat, environmentId: uuid(value.environmentId), workbenchTabId: uuid(value.workbenchTabId), kind: value.kind,
    targetId: requireIdentity(value.targetId), appId: requireIdentity(value.appId), epoch: number(value.epoch, 0, Number.MAX_SAFE_INTEGER, true),
    title: text(value.title, 4096, true), state: text(value.state, 64), ...(value.origin === undefined ? {} : { origin: siteOrigin(value.origin) }) }
}
function pending(value: SiteRequest, chat: string): SiteRequest {
  if (value.chatSessionId !== chat || value.requestVersion !== 1 || value.state !== 'pending' || !['chrome', 'edge'].includes(value.browser)) throw fail('REQUEST_STALE')
  return { requestId: uuid(value.requestId), requestVersion: 1, chatSessionId: chat, browser: value.browser, origin: siteOrigin(value.origin),
    reason: text(value.reason, 600), createdAt: number(value.createdAt, 0, Number.MAX_SAFE_INTEGER, true), expiresAt: number(value.expiresAt, 0, Number.MAX_SAFE_INTEGER, true), state: 'pending' }
}
function frame(value: Awaited<ReturnType<WorkbenchHostRegistry['preview']>>, chat: string, environmentId: string, tabId: string) {
  const own = target(value.target, chat), observation = value.observation, geometry = observation.geometry
  if (own.environmentId !== environmentId || own.workbenchTabId !== tabId || observation.targetId !== own.targetId || typeof value.viewOnly !== 'boolean' || observation.mediaType !== 'image/jpeg') throw fail('VIEW_CHANGED')
  const imageBase64 = text(observation.imageBase64, 32 * 1024 * 1024)
  if (imageBase64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(imageBase64) || Buffer.from(imageBase64, 'base64').toString('base64') !== imageBase64) throw fail('FRAME_UNAVAILABLE')
  const clean: ComputerObservation = { targetId: own.targetId, frameId: requireIdentity(observation.frameId), imageBase64, mediaType: 'image/jpeg',
    width: number(observation.width, 1, 16384, true), height: number(observation.height, 1, 16384, true), elements: '',
    geometry: { x: number(geometry.x, -100000, 100000), y: number(geometry.y, -100000, 100000), width: number(geometry.width, 1, 100000), height: number(geometry.height, 1, 100000), scale: number(geometry.scale, .1, 16) } }
  const cursor = observation.aiCursor
  if (cursor !== undefined) {
    if (cursor.actor !== 'ai' || typeof cursor.visible !== 'boolean') throw fail('FRAME_UNAVAILABLE')
    if (cursor.visible) clean.aiCursor = { actor: 'ai', visible: true, x: number(cursor.x, 0, clean.width), y: number(cursor.y, 0, clean.height),
      ...(cursor.epoch === undefined ? {} : { epoch: number(cursor.epoch, 1, Number.MAX_SAFE_INTEGER, true) }) }
  }
  return { target: own, observation: clean, viewOnly: value.viewOnly }
}
async function boundedRequest(request: Request, check: () => void, signal: AbortSignal): Promise<string> {
  check(); signal.throwIfAborted()
  const reader = request.body?.getReader()
  if (!reader) return ''
  let bytes = 0; const chunks: Uint8Array[] = []
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      check(); signal.throwIfAborted()
      const item = await reader.read()
      check(); signal.throwIfAborted()
      if (item.done) break
      bytes += item.value.byteLength
      if (bytes > 32768) throw fail('REQUEST_LIMIT')
      chunks.push(item.value)
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  } finally {
    signal.removeEventListener('abort', abort)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
const errorCode = (error: unknown) => error instanceof ComputerError && /^[A-Z_]{3,64}$/u.test(error.code) ? error.code : 'WORKBENCH_UNAVAILABLE'
/** Only the real owner connection can reach this route. No Agent or device authority is fabricated. */
export function installWorkbenchHost(ctx: Context, options: WorkbenchHostOptions): () => Promise<void> {
  const connection = ctx.get('connection') as HostConnection | undefined
  const connectionIdentity = hostServiceIdentity(connection)
  if (!connection || !connectionIdentity) throw fail('CONNECTION_UNAVAILABLE')
  const lifetime = new AbortController(), issued = new Set<string>()
  let disposed = false
  const unregister = connection.fetch.register({ path: '/api/' + WORKBENCH_ENDPOINT, methods: ['POST'], requestBody: 'buffered', async fetch(request) {
    const peer = connection.browserPeer, principal = peer?.principal, requestSignal = request.signal
    if (disposed || principal?.kind !== 'owner') return new Response('Forbidden', { status: 403, headers })
    const signal = AbortSignal.any([requestSignal, lifetime.signal])
    const assertOwner = () => {
      if (disposed || request.signal !== requestSignal || signal.aborted || hostServiceIdentity(ctx.get('connection')) !== connectionIdentity || connection.browserPeer !== peer || peer?.principal !== principal || principal.kind !== 'owner') throw fail('OWNER_CHANGED')
    }
    let rpcId: string | undefined
    try {
      assertOwner()
      const body = await boundedRequest(request, assertOwner, AbortSignal.any([signal, AbortSignal.timeout(2000)]))
      assertOwner()
      const envelope = object(JSON.parse(body), ['type', 'rpcId', 'method', 'payload'])
      if (envelope.type !== 'client-request' || envelope.method !== WORKBENCH_ENDPOINT) throw fail()
      rpcId = text(requireIdentity(envelope.rpcId, '请求编号'), 128)
      const input = object(envelope.payload, ['op', 'chatSessionId', 'requestId', 'requestVersion', 'decision', 'origin', 'environmentId', 'workbenchTabId', 'operation', 'actionId', 'frameId', 'action', 'url', 'browser'])
      const op = input.op
      if (op === 'permissions') {
        object(input, ['op']); assertOwner()
        const value = { allowedOrigins: list(options.permissions.allowedOrigins(), 128).map(siteOrigin) }
        assertOwner(); return Response.json({ type: 'server-response', rpcId, result: { ok: true, value } }, { headers })
      }
      if (op === 'revoke') {
        object(input, ['op', 'origin']); const origin = siteOrigin(input.origin); assertOwner()
        await options.permissions.revoke(origin)
        assertOwner(); return Response.json({ type: 'server-response', rpcId, result: { ok: true, value: { origin, revoked: true } } }, { headers })
      }
      const fields: Record<string, readonly string[]> = {
        status: [], decide: ['requestId', 'requestVersion', 'decision'], open: ['actionId', 'url', 'browser', 'decision'],
        preview: ['environmentId', 'workbenchTabId'], navigation: ['environmentId', 'workbenchTabId'],
        control: ['environmentId', 'workbenchTabId', 'operation'], humanAct: ['environmentId', 'workbenchTabId', 'actionId', 'frameId', 'action'], closeEnvironment: ['environmentId'],
      }
      if (typeof op !== 'string' || !Object.hasOwn(fields, op)) throw fail()
      object(input, ['op', 'chatSessionId', ...fields[op]!])
      const chat = requireIdentity(input.chatSessionId, '聊天')
      // Parse the complete DTO before any session query or backend operation.
      const env = 'environmentId' in input ? uuid(input.environmentId) : undefined
      const tab = 'workbenchTabId' in input ? uuid(input.workbenchTabId) : undefined
      if (['preview', 'navigation', 'control', 'humanAct'].includes(op) && (!env || !tab) || op === 'closeEnvironment' && !env) throw fail()
      const decision = input.decision
      if (op === 'decide' && (input.requestVersion !== 1 || !choice(decision, ['once', 'always', 'deny']))) throw fail()
      const requestId = op === 'decide' ? uuid(input.requestId) : undefined
      if (op === 'control' && !choice(input.operation, ['pause', 'takeover', 'resume', 'stop'])) throw fail()
      let action: ComputerActionRequest | undefined
      if (op === 'humanAct') {
        const parsed = parseComputerAction(input.action)
        if (typeof parsed.kind !== 'string' || parsed.button !== undefined && typeof parsed.button !== 'string') throw fail('INVALID_ACTION')
        action = { actionId: uuid(input.actionId), frameId: requireIdentity(input.frameId), action: parsed }
      }
      let open: { actionId: string; url: string; browser: 'chrome' | 'edge'; decision: 'once' | 'always' } | undefined
      if (op === 'open') {
        const actionId = uuid(input.actionId), url = website(input.url).url
        if (!choice(input.browser, ['chrome', 'edge']) || !choice(decision, ['once', 'always'])) throw fail()
        open = { actionId, url, browser: input.browser as 'chrome' | 'edge', decision: decision as 'once' | 'always' }
      }
      assertOwner()
      const resolved = await options.resolveScope(chat, signal)
      assertOwner()
      if (resolved.chatSessionId !== chat) throw fail('OWNER_CHANGED')
      // Device waits must receive session cancellation, not only reject a late response.
      const ownerSignal = AbortSignal.any([signal, resolved.signal])
      const owner: WorkbenchOwnerScope = { chatSessionId: chat, signal: ownerSignal, assertCurrent() {
        ownerSignal.throwIfAborted()
        assertOwner(); resolved.signal.throwIfAborted(); resolved.assertCurrent()
        if (resolved.chatSessionId !== chat) throw fail('OWNER_CHANGED')
      } }
      owner.assertCurrent()
      let value: unknown
      if (op === 'status') {
        const views = list(options.registry.views(chat), 512).map(view => target(view, chat))
        if (new Set(views.map(view => view.workbenchTabId)).size !== views.length) throw fail('VIEW_CHANGED')
        const pendingRequests = list(options.permissions.pending(chat), 32).map(request => pending(request, chat))
        const environments = list(options.registry.environments(chat), 129).map(environment => {
          if (!['browser', 'desktop'].includes(environment.kind)) throw fail('ENVIRONMENT_CHANGED')
          return { environmentId: uuid(environment.environmentId), kind: environment.kind, state: text(environment.state, 64), title: text(environment.title, 4096, true) }
        })
        value = { views, pendingRequests, environments, allowedOrigins: list(options.permissions.allowedOrigins(), 128).map(siteOrigin) }
      } else if (op === 'decide') {
        const receipt = await options.permissions.decide(chat, requestId!, 1, decision as SiteDecision, owner)
        owner.assertCurrent()
        if (receipt.requestId !== requestId || receipt.decision !== decision || !['approved', 'denied'].includes(receipt.state)) throw fail('REQUEST_STALE')
        value = { requestId, decision, state: receipt.state, ...(receipt.target === undefined ? {} : { target: target(receipt.target, chat) }) }
      } else if (op === 'open') {
        const opened = await options.permissions.openFromOwner(owner, chat, open!)
        owner.assertCurrent(); value = target(opened, chat)
      } else if (op === 'preview') {
        const observed = await options.registry.preview(chat, env!, tab!, owner)
        owner.assertCurrent(); value = frame(observed, chat, env!, tab!)
      } else if (op === 'control') {
        await options.registry.control(chat, env!, tab!, input.operation as 'pause' | 'takeover' | 'resume' | 'stop', owner)
        owner.assertCurrent(); value = { completed: true, operation: input.operation }
      } else if (op === 'humanAct') {
        const views = options.registry.views(chat).filter(view => view.environmentId === env && view.workbenchTabId === tab)
        if (views.length !== 1 || target(views[0]!, chat).state !== 'humanControl') throw fail('OWNER_TAKEOVER_REQUIRED')
        owner.assertCurrent()
        const key = chat + '\0' + action!.actionId
        if (issued.has(key)) throw fail('ACTION_REPLAY')
        if (issued.size >= 1024) throw fail('ACTION_LIMIT')
        issued.add(key)
        const ack = await options.registry.humanAct(chat, env!, tab!, action!, owner)
        owner.assertCurrent()
        if (ack.actionId !== action!.actionId) throw fail('ACTION_UNCONFIRMED')
        value = { actionId: ack.actionId, targetId: requireIdentity(ack.targetId), epoch: number(ack.epoch, 1, Number.MAX_SAFE_INTEGER, true), result: { acknowledged: true },
          ...(ack.workbench === undefined ? {} : { workbench: target(ack.workbench, chat) }) }
      } else if (op === 'navigation') {
        const navigation = await options.registry.navigation(chat, env!, tab!, owner)
        owner.assertCurrent()
        if (typeof navigation.canGoBack !== 'boolean' || typeof navigation.canGoForward !== 'boolean') throw fail('VIEW_CHANGED')
        value = { canGoBack: navigation.canGoBack, canGoForward: navigation.canGoForward, ...(navigation.url === undefined ? {} : { url: website(navigation.url).url }) }
      } else {
        await options.registry.stopEnvironment(chat, env!, owner)
        owner.assertCurrent(); value = { completed: true, environmentId: env }
      }
      owner.assertCurrent()
      return Response.json({ type: 'server-response', rpcId, result: { ok: true, value } }, { headers })
    } catch (error) {
      return Response.json({ type: 'server-response', rpcId, result: { ok: false, error: { code: errorCode(error), message: '工作台操作未能确认，请刷新查看，不要重复提交。' } } }, { headers })
    }
  } })
  return async () => { if (disposed) return; disposed = true; lifetime.abort(new Error('Workbench provider disposed')); issued.clear(); await unregister() }
}
