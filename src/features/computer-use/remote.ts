import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import { ComputerError, computerError, parseComputerAction, requireIdentity } from './contract.ts'
import type { ComputerAction, ComputerObservation, ComputerStatus, DeviceDriver, NativeComputerEvent, NativeTarget } from './contract.ts'
export { NativeCompanionDriver } from './native.ts'

export const COMPUTER_AGENT_VERSION = 1
export const COMPUTER_AGENT_PATH = '/v1/computer'
const REQUEST_LIMIT = 512 * 1024
const RESPONSE_LIMIT = 48 * 1024 * 1024
const operations = new Set(['status', 'targets', 'observe', 'lease', 'release', 'act', 'heartbeat'])
function pairToken(value: string): string {
  if (typeof value !== 'string' || value.length < 32 || value.length > 512 || /\s|[\x00-\x1f\x7f]/u.test(value)) throw new ComputerError('INVALID_PAIR_TOKEN', '配对令牌必须至少 32 字符且不包含空白')
  return value
}
function epochNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new ComputerError('INVALID_EPOCH', '控制周期无效')
  return value
}
function privateAddress(host: string): boolean {
  if (isIP(host) !== 4) return false
  const [a, b] = host.split('.').map(Number)
  return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168)
}
export function computerAgentEndpoint(value: string, allowInsecurePrivateNetwork = false): string {
  let url: URL
  try { url = new URL(value) } catch { throw new ComputerError('INVALID_ENDPOINT', '电脑代理地址无效') }
  const host = url.hostname.replace(/^\[|\]$/gu, '')
  const loopback = host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'))
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol) || (url.protocol === 'http:' && !loopback && !(allowInsecurePrivateNetwork && privateAddress(host)))) throw new ComputerError('UNSAFE_ENDPOINT', '请使用 HTTPS、回环隧道或明确允许的私有网络配对地址')
  if (url.pathname === '/') url.pathname = COMPUTER_AGENT_PATH
  return url.href
}
async function readResponse(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'))
  if (declared > maxBytes) { await response.body?.cancel(); throw new ComputerError('REMOTE_RESPONSE_LIMIT', '远端响应超过限制') }
  const reader = response.body?.getReader()
  if (!reader) throw new ComputerError('REMOTE_PROTOCOL', '远端响应为空')
  const chunks: Uint8Array[] = []; let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break
      length += value.byteLength
      if (length > maxBytes) { await reader.cancel(); throw new ComputerError('REMOTE_RESPONSE_LIMIT', '远端响应超过限制') }
      chunks.push(value)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new ComputerError('REMOTE_PROTOCOL', '远端没有返回有效 JSON') }
  } finally { reader.releaseLock() }
}
export interface RemoteComputerOptions {
  endpoint: string; token: string; clientId?: string; fetch?: typeof fetch
  allowInsecurePrivateNetwork?: boolean; heartbeatMs?: number; timeoutMs?: number; maxResponseBytes?: number
}
/** A preconfigured paired target. Models never choose its endpoint or token. */
export class RemoteComputerDriver implements DeviceDriver {
  readonly endpoint: string
  readonly clientId: string
  readonly deviceId: string
  private readonly token: string
  private readonly fetcher: typeof fetch
  private readonly listeners = new Set<(event: NativeComputerEvent) => void>()
  private readonly pending = new Set<AbortController>()
  private timer?: ReturnType<typeof setInterval>
  private activeEpoch?: number
  private disposed = false
  private requestId = 0
  private heartbeating = false
  constructor(private readonly options: RemoteComputerOptions) {
    this.endpoint = computerAgentEndpoint(options.endpoint, options.allowInsecurePrivateNetwork)
    this.token = pairToken(options.token)
    // Pair rotation must not inherit an old device's application approvals.
    this.deviceId = `remote:${createHash('sha256').update(this.endpoint).update('\0').update(this.token).digest('hex').slice(0, 24)}`
    this.clientId = requireIdentity(options.clientId ?? randomUUID(), '配对客户端')
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
  }
  subscribe(listener: (event: NativeComputerEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit(event: NativeComputerEvent): void { for (const listener of this.listeners) { try { listener(event) } catch {} } }
  private async rpc<T>(op: string, payload: object = {}, signal?: AbortSignal): Promise<T> {
    if (this.disposed) throw new ComputerError('DISPOSED', '独立电脑连接已关闭')
    signal?.throwIfAborted()
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(new ComputerError('REMOTE_TIMEOUT', '远端操作超时')), this.options.timeoutMs ?? 20_000)
    const abort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true }); this.pending.add(controller)
    const requestId = ++this.requestId
    try {
      if (signal?.aborted) abort()
      const response = await this.fetcher(this.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` }, body: JSON.stringify({ version: COMPUTER_AGENT_VERSION, clientId: this.clientId, requestId, op, payload }), signal: controller.signal, redirect: 'error' })
      const value = await readResponse(response, this.options.maxResponseBytes ?? RESPONSE_LIMIT) as { version?: unknown; requestId?: unknown; ok?: unknown; result?: T; error?: { code?: unknown; message?: unknown } }
      if (value?.version !== COMPUTER_AGENT_VERSION) throw new ComputerError('VERSION_MISMATCH', '远端电脑代理协议版本不兼容')
      if (!response.ok || value.ok !== true) throw new ComputerError(typeof value.error?.code === 'string' ? value.error.code : 'REMOTE_FAILED', typeof value.error?.message === 'string' ? value.error.message : '远端操作失败')
      if (value.requestId !== requestId) throw new ComputerError('REMOTE_PROTOCOL', '远端响应身份不匹配')
      return value.result as T
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); this.pending.delete(controller) }
  }
  private startHeartbeat(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => {
      if (this.heartbeating || this.activeEpoch === undefined || this.disposed) return
      this.heartbeating = true
      void this.rpc('heartbeat', { epoch: this.activeEpoch }).catch(() => {
        if (this.timer) clearInterval(this.timer); this.timer = undefined; this.activeEpoch = undefined
        this.emit({ event: 'disconnected' })
      }).finally(() => { this.heartbeating = false })
    }, this.options.heartbeatMs ?? 1000)
    this.timer.unref?.()
  }
  status(signal?: AbortSignal) { return this.rpc<ComputerStatus>('status', {}, signal) }
  async targets(signal?: AbortSignal): Promise<NativeTarget[]> {
    const targets = await this.rpc<NativeTarget[]>('targets', {}, signal)
    if (!Array.isArray(targets)) throw new ComputerError('REMOTE_PROTOCOL', '远端目标列表无效')
    return targets.map(target => ({ ...target, appId: `${this.deviceId}:${target.appId}` }))
  }
  observe(targetId: string, signal?: AbortSignal) { return this.rpc<ComputerObservation>('observe', { targetId }, signal) }
  preview(targetId: string, signal?: AbortSignal) { return this.rpc<ComputerObservation>('observe', { targetId, preview: true }, signal) }
  async lease(epoch: number, signal?: AbortSignal): Promise<unknown> {
    const result = await this.rpc('lease', { epoch: epochNumber(epoch) }, signal)
    this.activeEpoch = epoch; this.startHeartbeat(); return result
  }
  async release(epoch: number, signal?: AbortSignal): Promise<unknown> {
    if (this.activeEpoch === epoch) { this.activeEpoch = undefined; if (this.timer) clearInterval(this.timer); this.timer = undefined }
    return this.rpc('release', { epoch: epochNumber(epoch) }, signal)
  }
  act(epoch: number, targetId: string, action: ComputerAction, signal?: AbortSignal) { return this.rpc('act', { epoch: epochNumber(epoch), targetId, action: parseComputerAction(action) }, signal) }
  async openPreview(_url: string, _title: string, _sessionId: string): Promise<unknown> { throw new ComputerError('LOCAL_PREVIEW_REQUIRED', '独立电脑预览应在本机窗口显示') }
  async closePreview(): Promise<unknown> { return undefined }
  async dispose(): Promise<void> {
    if (this.disposed) return
    if (this.timer) clearInterval(this.timer); this.timer = undefined
    const epoch = this.activeEpoch; this.activeEpoch = undefined
    // Cancel owned requests first, then allow only the already-started cleanup
    // RPC to finish. Concurrent callers cannot begin new work during disposal.
    for (const controller of this.pending) controller.abort(new ComputerError('DISPOSED', '独立电脑连接已关闭'))
    const release = epoch === undefined ? Promise.resolve() : this.rpc('release', { epoch }, AbortSignal.timeout(2000)).catch(() => {})
    this.disposed = true
    await release
    this.listeners.clear()
  }
}

export interface ComputerAgentOptions {
  token: string; host?: string; port?: number; leaseTimeoutMs?: number
  maxRequestBytes?: number; maxResponseBytes?: number
}
export interface ComputerAgentServer { server: Server; endpoint: string; revoke(newToken?: string): Promise<void>; close(): Promise<void> }
interface ActiveLease { clientId: string; epoch: number; nativeEpoch: number; lastSeen: number }
function authorized(header: string | undefined, token: string | undefined): boolean {
  if (!token || !header?.startsWith('Bearer ')) return false
  const actual = Buffer.from(header.slice(7)), expected = Buffer.from(token)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
async function readRequest(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  if (Number(request.headers['content-length']) > maxBytes) throw new ComputerError('REQUEST_LIMIT', '请求超过限制')
  const chunks: Buffer[] = []; let length = 0
  for await (const chunk of request) {
    length += Buffer.byteLength(chunk)
    if (length > maxBytes) throw new ComputerError('REQUEST_LIMIT', '请求超过限制')
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new ComputerError('INVALID_REQUEST', '请求必须是 JSON') }
}
/** Loopback by default. Public network exposure is an explicit operator decision. */
export async function createComputerAgentServer(driver: DeviceDriver, options: ComputerAgentOptions): Promise<ComputerAgentServer> {
  let token: string | undefined = pairToken(options.token), active: ActiveLease | undefined, nextNativeEpoch = 0, closing = false
  let pairingGeneration = 0
  const clients = new Map<string, number>(), pending = new Set<AbortController>()
  const leaseTimeout = options.leaseTimeoutMs ?? 5000
  if (!Number.isFinite(leaseTimeout) || leaseTimeout < 100 || leaseTimeout > 60_000) throw new ComputerError('INVALID_TIMEOUT', '租约超时必须介于 100 和 60000 毫秒')
  const revokeLease = async (): Promise<void> => {
    const lease = active; active = undefined
    if (lease) await driver.release(lease.nativeEpoch)
  }
  const leaseFor = (clientId: string, epoch: number): ActiveLease => {
    if (!active || active.clientId !== clientId || active.epoch !== epoch || Date.now() - active.lastSeen > leaseTimeout) throw new ComputerError('CONTROL_CHANGED', '远端输入租约无效或已过期')
    return active
  }
  const reply = (response: ServerResponse, status: number, requestId: unknown, body: object): void => {
    let bytes = Buffer.from(JSON.stringify({ version: COMPUTER_AGENT_VERSION, requestId: typeof requestId === 'number' ? requestId : null, ...body }))
    if (bytes.length > (options.maxResponseBytes ?? RESPONSE_LIMIT)) { status = 413; bytes = Buffer.from(JSON.stringify({ version: COMPUTER_AGENT_VERSION, requestId, ok: false, error: { code: 'RESPONSE_LIMIT', message: '响应超过限制' } })) }
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Length': bytes.length }); response.end(bytes)
  }
  const server = createServer(async (request, response) => {
    let requestId: unknown, controller: AbortController | undefined
    try {
      if (closing || request.method !== 'POST' || request.url !== COMPUTER_AGENT_PATH) { reply(response, 404, null, { ok: false, error: { code: 'NOT_FOUND', message: '无此入口' } }); return }
      if (!authorized(request.headers.authorization, token)) { reply(response, 401, null, { ok: false, error: { code: 'PAIR_UNAUTHORIZED', message: '配对无效或已撤销' } }); return }
      // No browser-origin requests: the owner Host is the only network client.
      if (request.headers.origin) throw new ComputerError('ORIGIN_DENIED', '不接受网页来源请求')
      const generation = pairingGeneration
      const input = await readRequest(request, options.maxRequestBytes ?? REQUEST_LIMIT) as Record<string, unknown>
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ComputerError('INVALID_REQUEST', '请求无效')
      requestId = input.requestId
      if (input.version !== COMPUTER_AGENT_VERSION) throw new ComputerError('VERSION_MISMATCH', '电脑代理协议版本不兼容')
      if (typeof requestId !== 'number' || !Number.isSafeInteger(requestId) || requestId < 1) throw new ComputerError('INVALID_REQUEST', '请求标识无效')
      const clientId = requireIdentity(input.clientId, '客户端'), op = String(input.op)
      if (!operations.has(op)) throw new ComputerError('OP_NOT_ALLOWED', '不允许的代理操作')
      const payload = input.payload as Record<string, unknown>
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ComputerError('INVALID_REQUEST', '操作参数无效')
      if (generation !== pairingGeneration || !authorized(request.headers.authorization, token)) throw new ComputerError('PAIR_UNAUTHORIZED', '配对已撤销')
      controller = new AbortController(); pending.add(controller)
      if (pending.size > 128) throw new ComputerError('QUEUE_FULL', '代理请求过多')
      const cancel = () => { if (!response.writableEnded) controller?.abort(new ComputerError('ABORTED', '连接已中断')) }
      response.once('close', cancel)
      let result: unknown
      if (op === 'status') result = { ...await driver.status(controller.signal), protocolVersion: COMPUTER_AGENT_VERSION, leaseTimeoutMs: leaseTimeout }
      else if (op === 'targets') result = await driver.targets(controller.signal)
      else if (op === 'observe') result = payload.preview === true && driver.preview ? await driver.preview(requireIdentity(payload.targetId, '目标'), controller.signal) : await driver.observe(requireIdentity(payload.targetId, '目标'), controller.signal)
      else {
        const epoch = epochNumber(payload.epoch)
        if (op === 'lease') {
          if (active && active.clientId !== clientId) throw new ComputerError('DEVICE_BUSY', '独立电脑已被另一个客户端控制')
          if ((clients.get(clientId) ?? 0) >= epoch) throw new ComputerError('STALE_EPOCH', '控制周期必须递增')
          if (!clients.has(clientId) && clients.size >= 128) throw new ComputerError('CLIENT_LIMIT', '配对客户端数量已达上限，请重新配对')
          clients.set(clientId, epoch)
          const previous = active, candidate: ActiveLease = { clientId, epoch, nativeEpoch: ++nextNativeEpoch, lastSeen: Date.now() }
          active = candidate
          if (previous) await driver.release(previous.nativeEpoch)
          try {
            await driver.lease(candidate.nativeEpoch, controller.signal)
            if (active !== candidate || generation !== pairingGeneration || controller.signal.aborted) { await driver.release(candidate.nativeEpoch); throw new ComputerError('CONTROL_CHANGED', '建立租约时控制权已变化') }
            result = { epoch, leaseTimeoutMs: leaseTimeout }
          } catch (error) { if (active === candidate) active = undefined; await driver.release(candidate.nativeEpoch).catch(() => {}); throw error }
        } else if (op === 'release') {
          if (active?.clientId === clientId && active.epoch === epoch) await revokeLease()
          result = { released: true }
        } else {
          const lease = leaseFor(clientId, epoch)
          if (op === 'heartbeat') { lease.lastSeen = Date.now(); result = { epoch } }
          else {
            const targetId = requireIdentity(payload.targetId, '目标'), action = parseComputerAction(payload.action)
            const aborted = () => { if (active === lease) void revokeLease().catch(() => {}) }
            controller.signal.addEventListener('abort', aborted, { once: true })
            try { result = await driver.act(lease.nativeEpoch, targetId, action, controller.signal); if (active !== lease) throw new ComputerError('CONTROL_CHANGED', '执行期间控制权已变化') }
            finally { controller.signal.removeEventListener('abort', aborted) }
          }
        }
      }
      controller.signal.throwIfAborted()
      if (generation !== pairingGeneration) throw new ComputerError('PAIR_UNAUTHORIZED', '配对已撤销')
      reply(response, 200, requestId, { ok: true, result })
    } catch (error) {
      if (!response.destroyed && !response.writableEnded) reply(response, error instanceof ComputerError && error.code === 'REQUEST_LIMIT' ? 413 : 400, requestId, { ok: false, error: computerError(error) })
    } finally { if (controller) pending.delete(controller) }
  })
  server.headersTimeout = 10_000; server.requestTimeout = 25_000; server.maxHeadersCount = 32
  const watchdog = setInterval(() => { if (active && Date.now() - active.lastSeen > leaseTimeout) void revokeLease().catch(() => {}) }, Math.min(1000, Math.max(25, leaseTimeout / 4)))
  watchdog.unref()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => { server.off('error', reject); resolve() }) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new ComputerError('LISTEN_FAILED', '无法取得代理监听地址')
  const host = address.address.includes(':') ? `[${address.address}]` : address.address
  return {
    server, endpoint: `http://${host}:${address.port}${COMPUTER_AGENT_PATH}`,
    async revoke(newToken) { token = newToken === undefined ? undefined : pairToken(newToken); pairingGeneration++; for (const controller of pending) controller.abort(new ComputerError('PAIR_UNAUTHORIZED', '配对已撤销')); await revokeLease(); clients.clear() },
    async close() { if (closing) return; closing = true; clearInterval(watchdog); token = undefined; pairingGeneration++; for (const controller of pending) controller.abort(); await revokeLease().catch(() => {}); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) },
  }
}
