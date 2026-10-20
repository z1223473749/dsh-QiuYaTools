import type { Context } from '@deepseek-ai/cordis'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ComputerSessionService } from './session.ts'
import { ComputerDriverRouter } from './driver-router.ts'
import { computerError, requireIdentity, type DeviceDriver } from './contract.ts'
import { computerPreviewPage } from './preview-page.ts'

export const COMPUTER_ENDPOINT = 'qiuya-tools.computer.control'
export const COMPUTER_PREVIEW_PATH = '/api/qiuya-tools.computer.preview'
interface Route { path: string; methods: readonly ('POST' | 'GET')[]; requestBody?: 'buffered'; fetch(request: Request): Promise<Response> }
interface Services {
  connection: { browserPeer?: { principal: { kind: string } }; authenticatedUrl(url: string): string; fetch: { register(route: Route): () => Promise<void> } }
  webServer: { port: number }
  get?(name: string): unknown
}
export interface ComputerHost { service: ComputerSessionService; dispose(): Promise<void> }

/** App approvals are owned by the Host profile, never by model tool arguments. */
export async function installComputerHost(ctx: Context, enabled: () => boolean, options: { driver?: DeviceDriver } = {}): Promise<ComputerHost> {
  const services = ctx as unknown as Services
  const profile = services.get?.('profileContext') as { dir?: string } | undefined
  const directory = profile?.dir ? join(profile.dir, 'qiuya-computer') : undefined
  let allowed: string[] = []
  if (directory) try {
    const stored: unknown = JSON.parse(await readFile(join(directory, 'permissions.json'), 'utf8'))
    if (Array.isArray(stored) && stored.every(id => typeof id === 'string' && id.length <= 512)) allowed = stored
  } catch { /* A missing/invalid approval store grants nothing. */ }
  const driver = options.driver ?? new ComputerDriverRouter()
  let switching = false
  const service = new ComputerSessionService(driver, {
    enabled: () => enabled() && !switching,
    readAllowedApps: () => allowed,
    writeAllowedApps: async ids => {
      if (!directory) throw new Error('当前 Host 没有可持久化配置目录，请使用本次允许。')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const temporary = join(directory, `.permissions-${randomUUID()}.json`)
      await writeFile(temporary, JSON.stringify(ids), { mode: 0o600, flag: 'wx' })
      await rename(temporary, join(directory, 'permissions.json'))
      allowed = [...ids]
    },
  })
  let disposed = false, wasEnabled = enabled()
  const fileRequests = new Set<AbortController>()
  const cancelFiles = () => { for (const controller of fileRequests) controller.abort(new Error('文件交换已停止。')) }
  const poll = setInterval(() => {
    const current = enabled()
    if (wasEnabled && !current) { cancelFiles(); for (const item of service.list()) void service.stop(item.sessionId).catch(() => {}) }
    wasEnabled = current
  }, 100)
  poll.unref()
  const assertEnabled = () => { if (disposed || !enabled()) throw new Error('请先在设置中启用电脑操控。'); if (switching) throw new Error('正在切换操作环境，请稍候。') }
  const owner = () => services.connection.browserPeer?.principal.kind === 'owner'
  const unregister = [services.connection.fetch.register({
    path: `/api/${COMPUTER_ENDPOINT}`, methods: ['POST'], requestBody: 'buffered',
    fetch: async request => {
      if (!owner()) return new Response('Forbidden', { status: 403 })
      let rpcId: string | undefined
      try {
        const text = await request.text()
        if (text.length > 256_000) return new Response('Request too large', { status: 413 })
        const envelope = JSON.parse(text)
        if (envelope.type !== 'client-request' || envelope.method !== COMPUTER_ENDPOINT || typeof envelope.rpcId !== 'string') throw new Error('无效请求')
        rpcId = envelope.rpcId
        const input = envelope.payload
        if (!input || typeof input !== 'object') throw new Error('无效参数')
        const sessionId = input.sessionId === undefined ? undefined : requireIdentity(input.sessionId, '会话')
        let value: unknown
        if (input.op === 'status') {
          value = { enabled: enabled(), switching, sessions: service.list(), allowedApps: service.allowedApps(), native: switching ? { available: false, message: '正在切换操作环境' } : enabled() ? await service.status(request.signal).catch(computerError) : null }
        } else {
          if (!['pause', 'stop'].includes(input.op)) assertEnabled()
          if (input.op === 'targets') value = await service.targets(request.signal)
          else if (input.op === 'connect') {
            if (!(driver instanceof ComputerDriverRouter)) throw new Error('此执行器不支持切换设备')
            switching = true; cancelFiles()
            try {
              for (const item of service.list()) await service.stop(item.sessionId)
              if (input.mode === 'local') await driver.useLocal()
              else if (input.mode === 'remote' && typeof input.endpoint === 'string' && typeof input.token === 'string') await driver.useRemote({ endpoint: input.endpoint, token: input.token, allowInsecurePrivateNetwork: input.allowPrivateNetwork === true })
              else if (input.mode === 'browser') {
                if (!directory) throw new Error('浏览器连接需要独立的 Host 配置目录。')
                if (!['chrome', 'edge'].includes(input.browser) || !Array.isArray(input.allowedOrigins) || input.allowedOrigins.length < 1 || input.allowedOrigins.length > 128 || input.allowedOrigins.some((origin: unknown) => typeof origin !== 'string' || origin.length > 2048)) throw new Error('请选择浏览器并填写允许的网站来源。')
                if (input.initialUrl !== undefined && (typeof input.initialUrl !== 'string' || input.initialUrl.length > 8192)) throw new Error('起始页面地址无效。')
                if (input.cdpEndpoint !== undefined && (typeof input.cdpEndpoint !== 'string' || input.cdpEndpoint.length > 2048)) throw new Error('现有浏览器连接地址无效。')
                await mkdir(directory, { recursive: true, mode: 0o700 })
                await driver.useBrowser({ browser: input.browser, profileDir: join(directory, 'browser-profiles', input.browser), allowedOrigins: input.allowedOrigins, ...(input.cdpEndpoint ? { cdpEndpoint: input.cdpEndpoint } : {}) }, input.initialUrl, request.signal)
              } else throw new Error('请选择本机或提供独立电脑的配对地址与密钥。')
              value = await driver.status(request.signal)
            } finally { switching = false }
          }
          else if (input.op === 'exchange') {
            if (!(driver instanceof ComputerDriverRouter)) throw new Error('文件交换仅适用于已配对的独立电脑。')
            const controller = new AbortController(); fileRequests.add(controller)
            try { value = await driver.exchange(input.request, AbortSignal.any([request.signal, controller.signal])); assertEnabled(); if (!owner()) throw new Error('文件交换需要本机所有者权限。') }
            finally { fileRequests.delete(controller) }
          }
          else if (input.op === 'allow') { requireIdentity(input.appId, '应用'); await service.setAppAllowed(input.appId, input.allowed === true); value = { allowedApps: service.allowedApps() } }
          else if (!sessionId) throw new Error('请先选择要关联的聊天。')
          else if (input.op === 'start') {
            const sessions = services.get?.('sessions') as { get(id: string): unknown } | undefined
            if (!sessions?.get(sessionId)) throw new Error('关联聊天不可用，请重新选择。')
            value = await service.start(sessionId, requireIdentity(input.targetId, '目标'), { allowOnce: true, signal: request.signal })
          }
          else if (input.op === 'pause') {
            if (input.expectedEpoch !== undefined) {
              if (!Number.isSafeInteger(input.expectedEpoch) || input.expectedEpoch <= 0) throw new Error('预览控制周期无效。')
              const current = service.get(sessionId)
              if (!current) throw new Error('电脑会话不存在，请重新选择。')
              // No await may separate this check from pause's synchronous
              // invalidation. An old preview error cannot stop a new session.
              value = current.epoch === input.expectedEpoch ? await service.pause(sessionId) : current
            } else value = await service.pause(sessionId)
          }
          else if (input.op === 'takeover') value = await service.takeover(sessionId)
          else if (input.op === 'resume') value = await service.resume(sessionId)
          else if (input.op === 'stop') value = await service.stop(sessionId)
          else if (input.op === 'frame') value = await service.preview(sessionId, request.signal)
          else if (input.op === 'act') value = await service.humanAct(sessionId, input.request, request.signal)
          else if (input.op === 'preview') {
            const url = services.connection.authenticatedUrl(`http://127.0.0.1:${services.webServer.port}${COMPUTER_PREVIEW_PATH}?session=${encodeURIComponent(sessionId)}`)
            value = await driver.openPreview(url, 'QiuYaTools · 电脑操控', sessionId, request.signal)
          } else throw new Error('不支持的操作')
        }
        return Response.json({ type: 'server-response', rpcId, result: { ok: true, value } }, { headers: { 'Cache-Control': 'no-store' } })
      } catch (error) { return Response.json({ type: 'server-response', rpcId, result: { ok: false, error: { ...computerError(error), details: {} } } }, { headers: { 'Cache-Control': 'no-store' } }) }
    },
  }), services.connection.fetch.register({
    // The formal Connection bridge defaults an omitted body mode to streaming.
    // GET cannot carry that stream in WHATWG Request; explicitly buffer its
    // empty body so the authenticated HTML route reaches this handler.
    path: COMPUTER_PREVIEW_PATH, methods: ['GET'], requestBody: 'buffered',
    fetch: async () => owner() ? new Response(computerPreviewPage, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } }) : new Response('Forbidden', { status: 403 }),
  })]
  return { service, async dispose() {
    if (disposed) return
    disposed = true; clearInterval(poll); cancelFiles()
    let failure: unknown
    try { await service.dispose() } catch (error) { failure = error }
    const removed = await Promise.allSettled(unregister.map(stop => Promise.resolve().then(stop)))
    if (failure) throw failure
    const failedRoute = removed.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failedRoute) throw failedRoute.reason
  } }
}
