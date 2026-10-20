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
  const service = new ComputerSessionService(driver, {
    enabled,
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
  const poll = setInterval(() => {
    const current = enabled()
    if (wasEnabled && !current) for (const item of service.list()) void service.stop(item.sessionId).catch(() => {})
    wasEnabled = current
  }, 100)
  poll.unref()
  const assertEnabled = () => { if (disposed || !enabled()) throw new Error('请先在设置中启用电脑操控。') }
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
          value = { enabled: enabled(), sessions: service.list(), allowedApps: service.allowedApps(), native: enabled() ? await service.status(request.signal).catch(computerError) : null }
        } else {
          if (!['pause', 'stop'].includes(input.op)) assertEnabled()
          if (input.op === 'targets') value = await service.targets(request.signal)
          else if (input.op === 'connect') {
            if (!(driver instanceof ComputerDriverRouter)) throw new Error('此执行器不支持切换设备')
            for (const item of service.list()) await service.stop(item.sessionId)
            if (input.mode === 'local') await driver.useLocal()
            else if (input.mode === 'remote' && typeof input.endpoint === 'string' && typeof input.token === 'string') await driver.useRemote({ endpoint: input.endpoint, token: input.token, allowInsecurePrivateNetwork: input.allowPrivateNetwork === true })
            else throw new Error('请选择本机或提供独立电脑的配对地址与密钥。')
            value = await driver.status(request.signal)
          }
          else if (input.op === 'allow') { requireIdentity(input.appId, '应用'); await service.setAppAllowed(input.appId, input.allowed === true); value = { allowedApps: service.allowedApps() } }
          else if (!sessionId) throw new Error('请先选择要关联的聊天。')
          else if (input.op === 'start') {
            const sessions = services.get?.('sessions') as { get(id: string): unknown } | undefined
            if (!sessions?.get(sessionId)) throw new Error('关联聊天不可用，请重新选择。')
            value = await service.start(sessionId, requireIdentity(input.targetId, '目标'), { allowOnce: true, signal: request.signal })
          }
          else if (input.op === 'pause') value = await service.pause(sessionId)
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
    path: COMPUTER_PREVIEW_PATH, methods: ['GET'],
    fetch: async () => owner() ? new Response(computerPreviewPage, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } }) : new Response('Forbidden', { status: 403 }),
  })]
  return { service, async dispose() { if (disposed) return; disposed = true; clearInterval(poll); await service.dispose(); await Promise.all(unregister.map(stop => stop())) } }
}
