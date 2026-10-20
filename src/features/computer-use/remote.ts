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
  private readonly ownedEpochs = new Set<number>()
  private issuedEpoch = 0
  private disposed = false
  private disposing?: Promise<void>
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
  private async rpc<T>(op: string, payload: object = {}, signal?: AbortSignal, cleanup = false): Promise<T> {
    if (this.disposed && !cleanup) throw new ComputerError('DISPOSED', '独立电脑连接已关闭')
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
      const epoch = this.activeEpoch
      void this.rpc('heartbeat', { epoch }).catch(error => {
        if (this.activeEpoch !== epoch || this.disposed) return
        if (this.timer) clearInterval(this.timer); this.timer = undefined; this.activeEpoch = undefined
        this.emit({ event: error instanceof ComputerError && error.code === 'HUMAN_INPUT' ? 'humanInput' : 'disconnected' })
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
    if (this.disposed) throw new ComputerError('DISPOSED', '独立电脑连接已关闭')
    epochNumber(epoch)
    if (epoch <= this.issuedEpoch) throw new ComputerError('STALE_EPOCH', '远端控制周期必须递增')
    this.issuedEpoch = epoch
    // A timeout does not prove that the remote native lease was never acquired.
    this.ownedEpochs.add(epoch)
    const result = await this.rpc('lease', { epoch }, signal)
    if (this.disposed || this.issuedEpoch !== epoch) { if (!this.disposed) await this.release(epoch).catch(() => {}); throw new ComputerError('CONTROL_CHANGED', '远端租约已被更新的控制周期替代') }
    // The server confirms cleanup of this client's older leases before granting this one.
    for (const previous of this.ownedEpochs) if (previous < epoch) this.ownedEpochs.delete(previous)
    this.activeEpoch = epoch; this.startHeartbeat(); return result
  }
  async release(epoch: number, signal?: AbortSignal): Promise<unknown> {
    epochNumber(epoch)
    if (this.activeEpoch === epoch) { if (this.timer) clearInterval(this.timer); this.timer = undefined }
    const result = await this.rpc('release', { epoch }, signal)
    this.ownedEpochs.delete(epoch)
    if (this.activeEpoch === epoch) this.activeEpoch = undefined
    return result
  }
  act(epoch: number, targetId: string, action: ComputerAction, signal?: AbortSignal) { return this.rpc('act', { epoch: epochNumber(epoch), targetId, action: parseComputerAction(action) }, signal) }
  async openPreview(_url: string, _title: string, _sessionId: string): Promise<unknown> { throw new ComputerError('LOCAL_PREVIEW_REQUIRED', '独立电脑预览应在本机窗口显示') }
  async closePreview(): Promise<unknown> { return undefined }
  dispose(): Promise<void> {
    if (this.disposing) return this.disposing
    this.disposed = true
    if (this.timer) clearInterval(this.timer); this.timer = undefined
    this.activeEpoch = undefined
    // Every uncertain acquisition is retained until cleanup is acknowledged,
    // including acquisitions whose HTTP response was lost or cancelled.
    for (const controller of this.pending) controller.abort(new ComputerError('DISPOSED', '独立电脑连接已关闭'))
    this.disposing = (async () => {
      const results = await Promise.allSettled([...this.ownedEpochs].map(async epoch => {
        await this.rpc('release', { epoch }, AbortSignal.timeout(2000), true)
        this.ownedEpochs.delete(epoch)
      }))
      this.listeners.clear()
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failure) { this.disposing = undefined; throw failure.reason }
    })()
    return this.disposing
  }
}

export interface ComputerAgentOptions {
  token: string; host?: string; port?: number; leaseTimeoutMs?: number
  maxRequestBytes?: number; maxResponseBytes?: number
}
export interface ComputerAgentServer { server: Server; endpoint: string; revoke(newToken?: string): Promise<void>; close(): Promise<void> }
interface ActiveLease { clientId: string; epoch: number; nativeEpoch: number; lastSeen: number; controller?: AbortController; acquisition?: Promise<unknown> }
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
  const pendingReleases = new Map<number, ActiveLease>(), releasing = new Map<number, Promise<void>>()
  let leaseTail: Promise<unknown> = Promise.resolve()
  const interruptions = new Map<string, { epoch: number; code: string }>()
  const leaseTimeout = options.leaseTimeoutMs ?? 5000
  if (!Number.isFinite(leaseTimeout) || leaseTimeout < 100 || leaseTimeout > 60_000) throw new ComputerError('INVALID_TIMEOUT', '租约超时必须介于 100 和 60000 毫秒')
  const releaseLease = (lease: ActiveLease): Promise<void> => {
    const previous = releasing.get(lease.nativeEpoch); if (previous) return previous
    lease.controller?.abort(new ComputerError('CONTROL_CHANGED', '远端租约已撤销'))
    const acquisition = lease.acquisition
    const cleanup = (async () => {
      await driver.release(lease.nativeEpoch)
      if (acquisition) { await Promise.allSettled([acquisition]); await driver.release(lease.nativeEpoch) }
      pendingReleases.delete(lease.nativeEpoch)
    })()
    releasing.set(lease.nativeEpoch, cleanup)
    void cleanup.then(() => releasing.delete(lease.nativeEpoch), () => releasing.delete(lease.nativeEpoch))
    return cleanup
  }
  const drainReleases = async (): Promise<void> => { for (const lease of pendingReleases.values()) await releaseLease(lease) }
  const revokeLease = async (): Promise<void> => {
    const lease = active; active = undefined
    if (lease) pendingReleases.set(lease.nativeEpoch, lease)
    await drainReleases()
  }
  const unsubscribe = driver.subscribe?.(event => {
    const lease = active
    if (!lease || !['humanInput', 'previewClosed', 'disconnected'].includes(event.event)) return
    interruptions.set(lease.clientId, { epoch: lease.epoch, code: event.event === 'disconnected' ? 'DISCONNECTED' : 'HUMAN_INPUT' })
    // Input is fenced by the companion immediately. Mirror that revocation to
    // the paired owner instead of letting its healthy heartbeat retain a lease.
    void revokeLease().catch(() => {})
  })
  const leaseFor = (clientId: string, epoch: number): ActiveLease => {
    const interruption = interruptions.get(clientId)
    if (interruption?.epoch === epoch) throw new ComputerError(interruption.code, interruption.code === 'HUMAN_INPUT' ? '独立电脑已由本地用户暂停' : '独立电脑执行器已断开')
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
      if (op === 'status') result = { ...await driver.status(controller.signal), protocolVersion: COMPUTER_AGENT_VERSION, leaseTimeoutMs: leaseTimeout, cleanupPending: pendingReleases.size > 0 }
      else if (op === 'targets') result = await driver.targets(controller.signal)
      else if (op === 'observe') result = payload.preview === true && driver.preview ? await driver.preview(requireIdentity(payload.targetId, '目标'), controller.signal) : await driver.observe(requireIdentity(payload.targetId, '目标'), controller.signal)
      else {
        const epoch = epochNumber(payload.epoch)
        if (op === 'lease') {
          const operationController = controller
          const acquiring = leaseTail.catch(() => {}).then(async () => {
            operationController.signal.throwIfAborted()
            if (closing || generation !== pairingGeneration) throw new ComputerError('PAIR_UNAUTHORIZED', '配对已撤销')
            if (active && active.clientId !== clientId) throw new ComputerError('DEVICE_BUSY', '独立电脑已被另一个客户端控制')
            if ((clients.get(clientId) ?? 0) >= epoch) throw new ComputerError('STALE_EPOCH', '控制周期必须递增')
            if (!clients.has(clientId) && clients.size >= 128) throw new ComputerError('CLIENT_LIMIT', '配对客户端数量已达上限，请重新配对')
            if (active) await revokeLease(); else await drainReleases()
            operationController.signal.throwIfAborted()
            if (closing || generation !== pairingGeneration) throw new ComputerError('PAIR_UNAUTHORIZED', '配对已撤销')
            clients.set(clientId, epoch); interruptions.delete(clientId)
            const candidate: ActiveLease = { clientId, epoch, nativeEpoch: ++nextNativeEpoch, lastSeen: Date.now(), controller: operationController }
            active = candidate
            candidate.acquisition = Promise.resolve().then(() => driver.lease(candidate.nativeEpoch, operationController.signal))
            try {
              await candidate.acquisition
              candidate.acquisition = undefined; candidate.controller = undefined
              if (active !== candidate || generation !== pairingGeneration || operationController.signal.aborted) throw new ComputerError('CONTROL_CHANGED', '建立租约时控制权已变化')
              return { epoch, leaseTimeoutMs: leaseTimeout }
            } catch (error) {
              if (active === candidate) active = undefined
              pendingReleases.set(candidate.nativeEpoch, candidate)
              await releaseLease(candidate).catch(() => {})
              throw error
            }
          })
          leaseTail = acquiring.catch(() => {})
          result = await acquiring
        } else if (op === 'release') {
          if (active?.clientId === clientId && active.epoch === epoch) await revokeLease()
          else for (const lease of pendingReleases.values()) if (lease.clientId === clientId && lease.epoch === epoch) await releaseLease(lease)
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
  const watchdog = setInterval(() => { if (active && Date.now() - active.lastSeen > leaseTimeout) void revokeLease().catch(() => {}); else if (pendingReleases.size) void drainReleases().catch(() => {}) }, Math.min(1000, Math.max(25, leaseTimeout / 4)))
  watchdog.unref()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => { server.off('error', reject); resolve() }) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new ComputerError('LISTEN_FAILED', '无法取得代理监听地址')
  const host = address.address.includes(':') ? `[${address.address}]` : address.address
  return {
    server, endpoint: `http://${host}:${address.port}${COMPUTER_AGENT_PATH}`,
    async revoke(newToken) { token = newToken === undefined ? undefined : pairToken(newToken); pairingGeneration++; clients.clear(); interruptions.clear(); for (const controller of pending) controller.abort(new ComputerError('PAIR_UNAUTHORIZED', '配对已撤销')); await revokeLease() },
    async close() {
      if (closing) { await drainReleases(); return }
      closing = true; unsubscribe?.(); clearInterval(watchdog); token = undefined; pairingGeneration++
      for (const controller of pending) controller.abort()
      let failure: unknown
      try { await revokeLease() }
      catch (error) {
        failure = error
        // An independent process retirement may be the only remaining way to
        // confirm cleanup. Never clear uncertain epochs merely on RPC failure.
        if (driver.dispose) try { await driver.dispose(); pendingReleases.clear(); failure = undefined } catch (retirementError) { failure = retirementError }
      } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
      if (failure) throw failure
    },
  }
}
