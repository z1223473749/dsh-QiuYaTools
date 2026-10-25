import type { Context } from '@deepseek-ai/cordis'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ComputerSessionService } from './session.ts'
import { ComputerDriverRouter } from './driver-router.ts'
import { ComputerEnvironmentManager, type ComputerServiceFacade, type ComputerEnvironmentOptions, type ComputerConnectionOptions } from './environment-manager.ts'
import { ComputerError, computerError, requireIdentity, type ComputerSystemPermission, type DeviceDriver } from './contract.ts'
import { computerPreviewPage } from './preview-page.ts'
import { ComputerPermissionCoordinator, type ComputerEntryBackend } from './permission-coordinator.ts'

export const COMPUTER_ENDPOINT = 'qiuya-tools.computer.control'
export const COMPUTER_PREVIEW_PATH = '/api/qiuya-tools.computer.preview'
interface Route { path: string; methods: readonly ('POST' | 'GET')[]; requestBody?: 'buffered'; fetch(request: Request): Promise<Response> }
interface Services {
  connection: { browserPeer?: { principal: { kind: string } }; authenticatedUrl(url: string): string; fetch: { register(route: Route): () => Promise<void> } }
  webServer: { port: number }
  get?(name: string): unknown
}
export interface ComputerHost { entry: ComputerPermissionCoordinator; service: ComputerServiceFacade; manager?: ComputerEnvironmentManager; dispose(): Promise<void> }

/** App approvals are owned by the Host profile, never by model tool arguments. */
export async function installComputerHost(ctx: Context, enabled: () => boolean, options: { driver?: DeviceDriver; environments?: Pick<ComputerEnvironmentOptions, 'createRouter' | 'maxEnvironments' | 'idleMs' | 'now'> } = {}): Promise<ComputerHost> {
  const services = ctx as unknown as Services
  const profile = services.get?.('profileContext') as { dir?: string } | undefined
  const directory = profile?.dir ? join(profile.dir, 'qiuya-computer') : undefined
  let allowed: string[] = []
  if (directory) try {
    const stored: unknown = JSON.parse(await readFile(join(directory, 'permissions.json'), 'utf8'))
    if (Array.isArray(stored) && stored.every(id => typeof id === 'string' && id.length <= 512)) allowed = stored
  } catch { /* A missing/invalid approval store grants nothing. */ }
  const driver = options.driver
  let switching = false
  const permissions = {
    readAllowedApps: () => allowed,
    writeAllowedApps: async (ids: string[]) => {
      if (!directory) throw new Error('当前 Host 没有可持久化配置目录，请使用本次允许。')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const temporary = join(directory, `.permissions-${randomUUID()}.json`)
      await writeFile(temporary, JSON.stringify(ids), { mode: 0o600, flag: 'wx' })
      await rename(temporary, join(directory, 'permissions.json'))
      allowed = [...ids]
    },
  }
  // An explicitly supplied driver retains the original single-environment
  // contract used by native tests and soak tools. Production uses per-chat
  // routers and services; unscoped legacy owner calls get their own default.
  const legacyService = driver ? new ComputerSessionService(driver, { ...permissions, enabled: () => enabled() && !switching }) : undefined
  const manager = legacyService ? undefined : new ComputerEnvironmentManager({ ...options.environments, ...permissions, enabled, directory })
  const service: ComputerServiceFacade = legacyService ?? manager!
  // Public Agent identity is object identity, not a model supplied session id.
  const publicService = (name: string): unknown => { try { return services.get?.(name) } catch { return undefined } }
  const legacyGenerations = new Map<string, number>()
  const invalidate = (sessionId?: string) => {
    entry.cancelSession(sessionId)
    if (legacyService) for (const id of sessionId ? [sessionId] : new Set([...legacyGenerations.keys(), ...service.list().map(item => item.sessionId)])) legacyGenerations.set(id, (legacyGenerations.get(id) ?? 0) + 1)
  }
  const backend: ComputerEntryBackend = manager ?? {
    get: id => service.get(id), allowedApps: () => service.allowedApps(), setAppAllowed: (id, value) => service.setAppAllowed(id, value),
    ...(driver?.applications ? { applicationsFor: (_id: string, signal?: AbortSignal) => driver.applications!(signal) } : {}),
    targetsFor: (_id, signal) => legacyService!.targets(signal),
    authorizationStatus: (_id, signal) => legacyService!.status(signal),
    authorizationGeneration: id => legacyGenerations.get(id) ?? 0,
    ...(driver?.launchApplication ? { launchApplicationFor: (_id: string, appId: string, signal?: AbortSignal) => driver.launchApplication!(appId, signal) } : {}),
    authorizationStart: async (id, targetId, options) => {
      options.signal.throwIfAborted()
      if ((legacyGenerations.get(id) ?? 0) !== options.expectedGeneration) throw new ComputerError('REQUEST_STALE', '控制权已变化，请重新申请。')
      const current = service.get(id)
      if (current && ['paused', 'humanControl', 'pausing', 'handingOver', 'resuming', 'stopping'].includes(current.state)) throw new ComputerError('OWNER_RESUME_REQUIRED', '需要用户先恢复控制。')
      if (current && ['ready', 'running'].includes(current.state)) {
        if (current.target?.id === targetId) {
          if (current.target.appId !== options.expectedTarget.appId || current.target.pid !== options.expectedTarget.pid) throw new ComputerError('TARGET_CHANGED', '应用窗口身份已变化，请重新申请。')
          return current
        }
        throw new ComputerError('OWNER_SWITCH_REQUIRED', '请先停止当前电脑会话，再切换到新应用。')
      }
      return service.start(id, targetId, options)
    },
  }
  const entry = new ComputerPermissionCoordinator({ backend, enabled,
    lookupAgent: id => (publicService('agents') as { get?(id: string): unknown } | undefined)?.get?.(id),
    isRootAgent: agent => (publicService('agents') as { roots?(): unknown[] } | undefined)?.roots?.().includes(agent) === true,
    canRequest: agent => {
      const approval = publicService('approval') as { overrideOf?(session: unknown): string | undefined; config?: { policy?: string } } | undefined
      return ((agent.session ? approval?.overrideOf?.(agent.session) : undefined) ?? approval?.config?.policy) !== 'never'
    },
  })
  const removePermissionWatch = service.subscribe(() => { if (!enabled()) entry.cancelSession() })
  let disposed = false, wasEnabled = enabled()
  let cleanupError: ReturnType<typeof computerError> | undefined, shutdown: Promise<void> | undefined, lastSweep = 0
  const fileRequests = new Set<AbortController>()
  const cancelFiles = () => { for (const controller of fileRequests) controller.abort(new Error('文件交换已停止。')); manager?.cancelFiles(undefined, true) }
  const poll = setInterval(() => {
    const current = enabled()
    if (!current && (wasEnabled || cleanupError) && !shutdown) {
      invalidate(); cancelFiles()
      const stopping = manager ? manager.stopAll() : Promise.allSettled(service.list().map(item => service.stop(item.sessionId))).then(rows => {
        const failed = rows.find((row): row is PromiseRejectedResult => row.status === 'rejected'); if (failed) throw failed.reason
      })
      shutdown = stopping
      void stopping.then(() => { cleanupError = undefined; shutdown = undefined }, error => { cleanupError = computerError(error); shutdown = undefined })
    }
    if (manager && current && Date.now() - lastSweep >= 5000) {
      lastSweep = Date.now(); void manager.sweep(entry.pending().map(request => request.sessionId)).catch(error => { cleanupError = computerError(error) })
    }
    wasEnabled = current
  }, 100)
  poll.unref()
  const assertEnabled = (sessionId?: string) => { if (disposed || !enabled()) throw new Error('请先在设置中启用电脑操控。'); if (manager ? manager.isSwitching(sessionId) : switching) throw new Error('正在切换操作环境，请稍候。') }
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
        const chatSessionId = input.sessionId === undefined ? undefined : requireIdentity(input.sessionId, '会话')
        if (input.taskId !== undefined && (!manager || !chatSessionId)) throw new ComputerError('TASK_NOT_FOUND', '此电脑任务不属于当前聊天。')
        const sessionId = input.taskId === undefined ? chatSessionId : manager!.resolveTask(chatSessionId!, requireIdentity(input.taskId, '电脑任务'))
        let value: unknown
        if (input.op === 'status') {
          const changing = manager ? manager.isSwitching(sessionId) : switching
          value = { enabled: enabled(), switching: changing, sessions: service.list(), pendingRequests: await entry.pendingWithPreflight(sessionId, request.signal), allowedApps: service.allowedApps(), ...(manager ? { environments: manager.environments(), ...(chatSessionId ? { tasks: manager.listTasks(chatSessionId) } : {}) } : {}), ...(cleanupError ? { cleanupError } : {}), native: changing ? { available: false, message: '正在切换操作环境' } : enabled() ? await (manager ? sessionId === undefined ? manager.authorizationStatus(undefined, request.signal) : manager.statusIfPresentFor(sessionId, request.signal) : legacyService!.status(request.signal)).catch(computerError) : null }
        } else {
          if (!['pause', 'stop', 'cancelRequest'].includes(input.op) && !(input.op === 'allow' && input.allowed === false)) assertEnabled(sessionId)
          if (input.op === 'createTask') {
            if (!manager || !chatSessionId) throw new ComputerError('TASK_NOT_FOUND', '请从当前聊天创建电脑任务。')
            const sessions = services.get?.('sessions') as { get(id: string): unknown } | undefined
            if (!sessions?.get(chatSessionId)) throw new ComputerError('SESSION_REQUIRED', '当前聊天不可用。')
            value = { taskId: manager.createTask(chatSessionId, input.label) }
          }
          else if (input.op === 'pending') value = { pendingRequests: await entry.pendingWithPreflight(sessionId, request.signal) }
          else if (input.op === 'decide' || input.op === 'cancelRequest') {
            if (!sessionId) throw new Error('授权决定必须绑定发起请求的聊天。')
            const requestId = requireIdentity(input.requestId, '授权请求')
            value = input.op === 'decide' ? await entry.decide(sessionId, requestId, input.requestVersion, input.decision) : entry.cancelRequest(sessionId, requestId, input.requestVersion)
          }
          else if (input.op === 'openSettings') {
            if (!['screenRecording', 'accessibility', 'inputMonitoring'].includes(input.kind)) throw new Error('系统权限类型无效。')
            value = manager ? await manager.openSystemSettings(input.kind as ComputerSystemPermission, request.signal) : await driver?.openSystemSettings?.(input.kind as ComputerSystemPermission, request.signal)
            if (value === undefined) throw new Error('当前执行器不支持打开系统权限设置。')
          }
          else if (input.op === 'applications') value = manager ? await manager.applicationsFor(sessionId, request.signal) : driver?.applications ? await driver.applications(request.signal) : []
          else if (input.op === 'targets') value = await (manager ? manager.targetsFor(sessionId, request.signal) : legacyService!.targets(request.signal))
          else if (input.op === 'connect') {
            invalidate(sessionId)
            if (manager) value = await manager.connect(sessionId, input as ComputerConnectionOptions, request.signal)
            else {
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
          }
          else if (input.op === 'exchange') {
            if (manager) {
              value = await manager.exchange(sessionId, input.request, request.signal, input.expectedEnvironmentId)
              assertEnabled(sessionId); if (!owner()) throw new Error('文件交换需要本机所有者权限。')
            } else {
            if (input.expectedEnvironmentId !== undefined || sessionId !== undefined) throw new ComputerError('CONTROL_CHANGED', '请刷新当前聊天的操作环境后再使用文件交换。')
            if (!(driver instanceof ComputerDriverRouter)) throw new Error('文件交换仅适用于已配对的独立电脑。')
            const controller = new AbortController(); fileRequests.add(controller)
            try { value = await driver.exchange(input.request, AbortSignal.any([request.signal, controller.signal])); assertEnabled(); if (!owner()) throw new Error('文件交换需要本机所有者权限。') }
            finally { fileRequests.delete(controller) }
            }
          }
          else if (input.op === 'allow') { requireIdentity(input.appId, '应用'); if (input.allowed !== true) { if (legacyService) invalidate(); else entry.cancelApp(input.appId) }; await service.setAppAllowed(input.appId, input.allowed === true); value = { allowedApps: service.allowedApps() } }
          else if (!sessionId) throw new Error('请先选择要关联的聊天。')
          else if (input.op === 'start') {
            invalidate(sessionId)
            const sessions = services.get?.('sessions') as { get(id: string): unknown } | undefined
            if (!sessions?.get(chatSessionId!)) throw new Error('关联聊天不可用，请重新选择。')
            value = await service.start(sessionId, requireIdentity(input.targetId, '目标'), { allowOnce: true, signal: request.signal })
          }
          else if (input.op === 'pause') {
            if (input.expectedEpoch !== undefined) {
              if (!Number.isSafeInteger(input.expectedEpoch) || input.expectedEpoch <= 0) throw new Error('预览控制周期无效。')
              const current = service.get(sessionId)
              if (!current) throw new Error('电脑会话不存在，请重新选择。')
              // No await may separate this check from pause's synchronous
              // invalidation. An old preview error cannot stop a new session.
              if (current.epoch === input.expectedEpoch) { invalidate(sessionId); value = await service.pause(sessionId) } else value = current
            } else { invalidate(sessionId); value = await service.pause(sessionId) }
          }
          else if (input.op === 'takeover') { invalidate(sessionId); value = await service.takeover(sessionId) }
          else if (input.op === 'resume') { invalidate(sessionId); value = await service.resume(sessionId) }
          else if (input.op === 'stop') { invalidate(sessionId); value = await service.stop(sessionId) }
          else if (input.op === 'frame') value = await service.preview(sessionId, request.signal)
          else if (input.op === 'act') value = await service.humanAct(sessionId, input.request, request.signal)
          else if (input.op === 'preview') {
            const url = services.connection.authenticatedUrl(`http://127.0.0.1:${services.webServer.port}${COMPUTER_PREVIEW_PATH}?session=${encodeURIComponent(chatSessionId!)}${input.taskId === undefined ? '' : `&task=${encodeURIComponent(input.taskId)}`}`)
            value = manager ? await manager.openPreview(sessionId, url, 'QiuYaTools · 电脑操控', request.signal) : await driver!.openPreview(url, 'QiuYaTools · 电脑操控', sessionId, request.signal)
          } else if (input.op === 'redock') {
            value = manager ? await manager.redock(sessionId, request.signal) : await driver!.closePreview(request.signal, { preserveSession: true })
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
  return { entry, service, ...(manager ? { manager } : {}), async dispose() {
    if (disposed) { if (manager) await manager.dispose(); return }
    disposed = true; clearInterval(poll); entry.dispose(); removePermissionWatch(); cancelFiles()
    let failure: unknown
    try { await shutdown } catch (error) { failure = error }
    try { await (manager ?? legacyService)!.dispose() } catch (error) { failure ??= error }
    const removed = await Promise.allSettled(unregister.map(stop => Promise.resolve().then(stop)))
    if (failure) throw failure
    const failedRoute = removed.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failedRoute) throw failedRoute.reason
  } }
}
