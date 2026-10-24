import type { Context } from '@deepseek-ai/cordis'
import { hostServiceIdentity } from '../../host-service-identity.ts'
import type { RunReadScope } from '../acceptance-runs/service.ts'
import { ComputerError } from '../computer-use/contract.ts'
import { DIAGNOSTICS_ENDPOINT, diagnosticObject, diagnosticId, diagnosticString } from './contract.ts'
import type { BrowserDiagnosticsService, DiagnosticOwnerScope } from './service.ts'
interface Route { path: string; methods: readonly ['POST']; requestBody: 'buffered'; fetch(request: Request): Promise<Response> }
interface Connection { browserPeer?: { principal: { kind: string } }; fetch: { register(route: Route): () => Promise<void> } }
export function installBrowserDiagnosticHost(ctx: Context, service: BrowserDiagnosticsService, resolveScope: (chat: string, signal: AbortSignal) => Promise<RunReadScope>): () => Promise<void> {
  const connection = ctx.get('connection') as Connection | undefined, identity = hostServiceIdentity(connection), lifetime = new AbortController(); let disposed = false
  if (!connection || !identity) throw Error('CONNECTION_UNAVAILABLE')
  const remove = connection.fetch.register({ path: '/api/' + DIAGNOSTICS_ENDPOINT, methods: ['POST'], requestBody: 'buffered', async fetch(request) {
    const peer = connection.browserPeer, principal = peer?.principal; if (disposed || principal?.kind !== 'owner') return new Response('Forbidden', { status: 403 })
    const signal = AbortSignal.any([request.signal, lifetime.signal]), grantCurrent = () => { lifetime.signal.throwIfAborted(); if (disposed || hostServiceIdentity(ctx.get('connection')) !== identity || connection.browserPeer !== peer || peer?.principal !== principal || principal.kind !== 'owner') throw new ComputerError('OWNER_CHANGED', '诊断连接已变化。') }, current = () => { signal.throwIfAborted(); grantCurrent() }
    let rpcId: string | undefined
    try {
      current(); const reader = request.body?.getReader(); if (!reader) throw Error('INVALID_REQUEST')
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(2000)]), chunks: Uint8Array[] = []; let size = 0
      const aborted = () => { void reader.cancel().catch(() => {}) }; bounded.addEventListener('abort', aborted, { once: true })
      try { for (;;) { current(); bounded.throwIfAborted(); const row = await reader.read(); current(); bounded.throwIfAborted(); if (row.done) break; size += row.value.byteLength; if (size > 32768) throw Error('REQUEST_LIMIT'); chunks.push(row.value) } } finally { bounded.removeEventListener('abort', aborted); void reader.cancel().catch(() => {}); reader.releaseLock() }
      const envelope = diagnosticObject(JSON.parse(Buffer.concat(chunks).toString('utf8')), ['type', 'rpcId', 'method', 'payload']); rpcId = diagnosticString(envelope.rpcId, 128)
      if (envelope.type !== 'client-request' || envelope.method !== DIAGNOSTICS_ENDPOINT) throw Error('INVALID_REQUEST')
      const v = diagnosticObject(envelope.payload, ['op', 'chatSessionId', 'requestId', 'allow', 'diagnosticId']), op = v.op, chat = diagnosticId(v.chatSessionId)
      if (op !== 'status' && op !== 'get' && op !== 'decide' && op !== 'stop') throw Error('INVALID_REQUEST')
      diagnosticObject(v, op === 'status' ? ['op', 'chatSessionId'] : op === 'decide' ? ['op', 'chatSessionId', 'requestId', 'allow'] : ['op', 'chatSessionId', 'diagnosticId'])
      const id = op === 'status' ? undefined : diagnosticId(op === 'decide' ? v.requestId : v.diagnosticId)
      if (op === 'decide' && typeof v.allow !== 'boolean') throw Error('INVALID_REQUEST')
      const resolved = await resolveScope(chat, lifetime.signal); current(); if (resolved.chatSessionId !== chat) throw Error('OWNER_CHANGED')
      const scope: DiagnosticOwnerScope = { chatSessionId: chat, signal: AbortSignal.any([signal, resolved.signal]), grantSignal: AbortSignal.any([lifetime.signal, resolved.signal]), assertCurrent() { current(); this.signal.throwIfAborted(); resolved.assertCurrent() }, assertGrantCurrent() { grantCurrent(); this.grantSignal.throwIfAborted(); resolved.assertCurrent() } }
      scope.assertCurrent(); const value = op === 'status' ? (() => { const status = service.status(scope); return { pending: status.pending, sessions: status.sessions.map(row => ({ ...row, entryCount: row.entries.length, entries: [] })) } })() : op === 'get' ? { pending: [], sessions: [service.ownerRead(scope, id!)] } : op === 'decide' ? await service.decide(scope, id!, v.allow as boolean) : await service.ownerStop(scope, id!); scope.assertCurrent()
      return Response.json({ type: 'server-response', rpcId, result: { ok: true, value } }, { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
    } catch (failure) { return Response.json({ type: 'server-response', rpcId, result: { ok: false, error: { code: failure instanceof ComputerError ? failure.code : 'DIAGNOSTICS_UNAVAILABLE', message: '诊断请求未能确认，请刷新查看。' } } }, { headers: { 'Cache-Control': 'no-store' } }) }
  } })
  return async () => { if (disposed) return; disposed = true; lifetime.abort(); await remove() }
}
