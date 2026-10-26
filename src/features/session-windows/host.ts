/// <reference types="node" />
import type { Context } from '@deepseek-ai/cordis'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { access, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { SESSION_WINDOW_CHANNEL, SESSION_WINDOW_STATUS_ENDPOINT, SESSION_WINDOW_OPEN_ENDPOINT, SESSION_WINDOW_QUERY, parseWindowRequest, type SessionWindowStatus } from './contract.ts'
import { MINIMUM_SESSION_WINDOW_HARNESS_VERSION, sessionWindowVersionCompatibility } from './compatibility.ts'
import { bundledNativePath, resolveNativeExecutable } from '../../native/runtime.ts'

/** Resolve the running installation's API; bundling app-boot would report the build machine's version. */
export async function getOfficialHarnessVersion(installAnchor: unknown): Promise<unknown> {
  // ProfileContext.installAnchor is the launcher's own package.json, outside
  // the plugin/profile dependency tree. Never authorize from linked dev deps.
  if (typeof installAnchor !== 'string' || installAnchor.length === 0) return undefined
  const entry = createRequire(installAnchor).resolve('@deepseek-ai/dsh-app-boot')
  const runtime = await import(pathToFileURL(entry).href) as { getDshRuntimeVersion?: () => unknown }
  return runtime.getDshRuntimeVersion?.()
}

export function sessionWindowExecutable(base: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  return bundledNativePath('session-window', platform, arch, new URL('./', base))
}

interface SessionControllerReader { list(request: object, signal: AbortSignal): Promise<{ items: readonly { sessionId: string; title?: string; blank?: boolean }[] }> }
interface SessionHeaderView { id: string; cwd?: string; title?: string }
interface LiveSessionView { id: string; header: SessionHeaderView; seq: number }
interface SessionStoreReader { get(id: string): LiveSessionView | undefined }
interface SessionPersistenceReader { stat(id: string, options?: { signal?: AbortSignal }): Promise<{ header: SessionHeaderView; eventCount?: number } | undefined> }
interface SessionProjectionsReader { stateOf(session: LiveSessionView, key: 'sessionListMetadata'): { blank?: boolean } | undefined }
interface SessionProjectionCacheReader { cachedSnapshot(header: SessionHeaderView, keys?: readonly string[]): { asOfSeq?: number | null; values: { sessionListMetadata?: { blank?: boolean } } } | undefined }
interface SessionQueryReader { listSessions(signal?: AbortSignal): Promise<readonly { header: { id: string; title?: string } }[]>; readTitle?(id: string, signal?: AbortSignal): Promise<{ title?: string } | undefined> }
interface CallingPeer { principal: { kind: string }; ctx: { get(name: string): unknown } }
type Result = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: object } }
interface SessionReaders {
  sessionController?: SessionControllerReader
  sessionQuery?: SessionQueryReader
  sessions?: SessionStoreReader
  sessionPersistence?: SessionPersistenceReader
  sessionProjections?: SessionProjectionsReader
  sessionProjectionCache?: SessionProjectionCacheReader
}
interface HostServices extends SessionReaders {
  connection: {
    authenticatedUrl(base: string): string
    browserPeer?: CallingPeer
    fetch: { register(route: { path: string; methods: readonly ['POST']; requestBody: 'buffered'; fetch(request: Request): Promise<Response> }): () => Promise<void> }
  }
  webServer: { port: number }
  get?(name: string): unknown
}

/** A stable UUID v5 namespaces browser data by canonical Host profile and exact Session. */
export async function sessionWindowStoreIdentifier(sessionId: string, profileDirectory?: string): Promise<string> {
  const absolute = profileDirectory ? resolve(profileDirectory) : undefined
  const canonical = absolute === undefined ? null : await realpath(absolute).catch(() => absolute)
  // The namespace is plugin-owned and fixed; paths enter only the hash and are
  // never sent to the helper or written to logs. JSON keeps tuple boundaries exact.
  const namespace = Buffer.from('b2e7c58f62ad4ee28afd1bda3c36599b', 'hex')
  const bytes = createHash('sha1').update(namespace).update(JSON.stringify([canonical, sessionId])).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** A single native companion owns one window per Session and receives credentials only over stdin. */
export class SessionWindowCompanion {
  private child: ChildProcessWithoutNullStreams | undefined
  private sequence = 0
  private disposed = false
  private retirement: Promise<void> | undefined
  private readonly draining = new Set<Promise<void>>()
  private cleanupFailure: Error | undefined
  private readonly pending = new Map<number, { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  constructor(private readonly executable: string, private readonly args: readonly string[] = []) {}

  async open(value: object): Promise<void> {
    return this.send('open', value)
  }

  /** Receipt acknowledges a hidden target window, independently of its eventual ready message. */
  async prepare(value: object): Promise<void> {
    return this.send('prepare', value)
  }

  /** Cancellation is cleanup: it never starts a helper that has not been needed yet. */
  async cancel(sessionId: string): Promise<void> {
    if (!this.child || this.child.exitCode !== null || this.child.killed) return
    return this.send('cancel', { sessionId, url: '', title: '', source: 'drag' })
  }

  private async send(op: 'open' | 'prepare' | 'cancel', value: object): Promise<void> {
    if (this.disposed) throw new Error('Session windows are unavailable')
    const child = this.start()
    const requestId = ++this.sequence
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('会话窗口加载超时，请重试。'))
      }, 35_000)
      timer.unref()
      this.pending.set(requestId, { resolve, reject, timer })
      child.stdin.write(JSON.stringify({ ...value, requestId, op }) + '\n', error => {
        if (error) this.failRequest(requestId, new Error('无法连接会话窗口。'))
      })
    })
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child
    const child = spawn(this.executable, [...this.args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, QIUYA_TOOLS_PARENT_PID: String(process.pid) } })
    this.child = child
    const lines = createInterface({ input: child.stdout })
    lines.on('line', line => {
      // No subprocess output or authenticated URL is ever forwarded to logs/UI.
      if (line.length > 4096) return
      try {
        const answer = JSON.parse(line) as { requestId?: number; ok?: boolean }
        if (!Number.isSafeInteger(answer.requestId)) return
        const requestId = answer.requestId!
        if (answer.ok === true) {
          const pending = this.pending.get(requestId)
          if (pending) { clearTimeout(pending.timer); this.pending.delete(requestId); pending.resolve() }
        } else this.failRequest(requestId, new Error('会话窗口加载失败，请重试。'))
      } catch { /* Ignore non-protocol output without exposing it. */ }
    })
    // Drain WebKit diagnostics without printing token-bearing URLs.
    child.stderr.resume()
    const failed = (): void => {
      if (this.child !== child) return
      this.child = undefined
      for (const requestId of this.pending.keys()) this.failRequest(requestId, new Error('会话窗口已退出，请重试。'))
    }
    child.stdin.on('error', failed)
    child.once('error', failed)
    child.once('exit', failed)
    // Exit may precede the final stdout data. Keep draining until stdio closes.
    let finishDrain!: () => void
    const draining = new Promise<void>(resolve => { finishDrain = resolve })
    this.draining.add(draining)
    child.once('close', (code, signal) => {
      if (child.pid && (code !== 0 || signal !== null)) this.cleanupFailure ??= new Error('会话窗口组件未正常退出。')
      lines.close(); this.draining.delete(draining); finishDrain()
    })
    return child
  }

  private failRequest(id: number, error: Error): void {
    const pending = this.pending.get(id)
    if (!pending) return
    clearTimeout(pending.timer); this.pending.delete(id); pending.reject(error)
  }

  dispose(): Promise<void> {
    if (this.retirement) return this.retirement
    this.disposed = true
    for (const id of this.pending.keys()) this.failRequest(id, new Error('Session windows are unavailable'))
    const child = this.child
    this.child = undefined
    const draining = [...this.draining]
    if (!child && draining.length === 0) return this.retirement = this.cleanupFailure ? Promise.reject(this.cleanupFailure) : Promise.resolve()
    // Keep the Host and its output pipe alive while the native helper drains
    // WebView. Ending stdin alone does not complete an asynchronous teardown.
    this.retirement = new Promise<void>((resolve, reject) => {
      let finished = false
      const finish = (error?: Error): void => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      }
      const timer = setTimeout(() => {
        this.cleanupFailure ??= new Error('会话窗口组件未确认退出。')
        if (child?.exitCode === null) child.kill('SIGTERM')
        finish(this.cleanupFailure)
      }, process.platform === 'win32' ? 6000 : 1500)
      timer.unref()
      void Promise.all(draining).then(() => finish(this.cleanupFailure))
      child?.stdin.end()
    })
    return this.retirement
  }
}

/** Root waits only for connection and webServer. Session readers are resolved on the authenticated call. */
export function installSessionWindowsHost(ctx: Context, enabled: () => boolean, companionOptions?: { executable: string; args?: readonly string[]; getHarnessVersion?: () => unknown | Promise<unknown> }): () => Promise<void> {
  const services = ctx as unknown as HostServices
  // A normal .app bundle gives AppKit, LaunchServices and accessibility tools
  // one stable identity while stdin still carries the private launch facts.
  // Resolve lazily so a missing optional dependency cannot prevent the plugin
  // settings from loading, and an installation repair can be checked again.
  let companion: SessionWindowCompanion | undefined
  let executable: string | undefined
  const native = () => {
    const resolved = companionOptions?.executable ?? resolveNativeExecutable('session-window')
    if (companion && executable !== resolved) throw new Error('窗口组件已经变化，请重新启用插件。')
    executable = resolved
    return companion ??= new SessionWindowCompanion(resolved, companionOptions?.args)
  }
  const getHarnessVersion = companionOptions?.getHarnessVersion ?? (() => {
    const profile = services.get?.('profileContext') as Pick<ProfileContext, 'installAnchor'> | undefined
    return getOfficialHarnessVersion(profile?.installAnchor)
  })
  // A cancel can arrive while exact target validation is awaiting persistence.
  // Keep its intent here so that late validation cannot resurrect a hidden view.
  let preparation: { id: string; generation: number } | undefined
  let preparationGeneration = 0
  const reader = <T,>(name: keyof SessionReaders, peer?: CallingPeer): T | undefined => {
    const scoped = peer?.ctx.get(name)
    if (scoped !== undefined) return scoped as T
    // Respect an optional Context lookup returning undefined; a strict property
    // read after that would incorrectly require another injected dependency.
    return (typeof services.get === 'function' ? services.get(name) : services[name]) as T | undefined
  }
  const status = async (peer?: CallingPeer): Promise<SessionWindowStatus> => {
    let version: unknown
    try { version = await getHarnessVersion() } catch { /* Unknown runtime versions cannot authorize native windows. */ }
    const compatibility = sessionWindowVersionCompatibility(version)
    if (!compatibility.versionSupported) return { ...compatibility, available: false, reason: compatibility.harnessVersion === undefined ? 'harness-version-unknown' : 'harness-version' }
    if (!['darwin', 'win32'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch)) return { ...compatibility, available: false, reason: 'platform' }
    try { const resolved = companionOptions?.executable ?? resolveNativeExecutable('session-window'); await access(resolved, constants.X_OK) }
    catch { return { ...compatibility, available: false, reason: 'helper-missing' } }
    if (!reader<SessionStoreReader>('sessions', peer) && !reader<SessionPersistenceReader>('sessionPersistence', peer) && !reader<SessionControllerReader>('sessionController', peer) && !reader<SessionQueryReader>('sessionQuery', peer)) return { ...compatibility, available: false, reason: 'reader-missing' }
    return { ...compatibility, available: true }
  }
  const validateTarget = async (id: string, signal: AbortSignal, peer?: CallingPeer): Promise<string | undefined> => {
    const checkAbort = (): void => { if (signal.aborted) throw new Error('已取消打开窗口。') }
    const missing = (): never => { throw new Error('会话不存在或尚未创建。') }
    checkAbort()
    const store = reader<SessionStoreReader>('sessions', peer)
    const projections = reader<SessionProjectionsReader>('sessionProjections', peer)
    const persistence = reader<SessionPersistenceReader>('sessionPersistence', peer)
    const cache = reader<SessionProjectionCacheReader>('sessionProjectionCache', peer)
    const live = store?.get(id)
    if (live) {
      if (live.id !== id || live.header.id !== id) return missing()
      const metadata = projections?.stateOf(live, 'sessionListMetadata')
      // This is the same current unit/fallback used by ApiSessionList.summaryFor;
      // a positive log length alone never overrides an explicit blank unit.
      if (metadata?.blank ?? live.seq === 0) return missing()
      return live.header.title
    }
    if (persistence) {
      const stored = await persistence.stat(id, { signal })
      checkAbort()
      if (!stored || stored.header.id !== id || stored.eventCount === 0) return missing()
      const metadata = cache?.cachedSnapshot(stored.header, ['sessionListMetadata'])?.values.sessionListMetadata
      if (metadata?.blank === true) return missing()
      if (metadata?.blank === false) return stored.header.title
      // Missing cold metadata is uncommon. Keep the maintained controller as
      // the compatibility fallback instead of guessing that a cold row is used.
      const controller = reader<SessionControllerReader>('sessionController', peer)
      if (controller) {
        const list = await controller.list({}, signal)
        checkAbort()
        const summary = list.items.find(item => item.sessionId === id)
        if (!summary || summary.blank) return missing()
        return summary.title
      }
      // ApiSessionList's documented cold fallback also treats unknown blank
      // metadata as visible; stat still proved exact durable existence.
      return stored.header.title
    }
    const controller = reader<SessionControllerReader>('sessionController', peer)
    if (controller) {
      const list = await controller.list({}, signal)
      checkAbort()
      const summary = list.items.find(item => item.sessionId === id)
      if (!summary || summary.blank) return missing()
      return summary.title
    }
    const query = reader<SessionQueryReader>('sessionQuery', peer)
    if (query) {
      const records = await query.listSessions(signal)
      checkAbort()
      const record = records.find(item => item.header.id === id)
      if (!record) return missing()
      return record.header.title
    }
    throw new Error('会话读取服务尚未就绪。')
  }
  const handle = async (endpoint: 'status' | 'open', payload: unknown, signal: AbortSignal, peer = services.connection.browserPeer): Promise<Result> => {
    try {
      if (peer && peer.principal.kind !== 'owner') throw new Error('只有本机所有者可以打开会话窗口。')
      if (endpoint === 'status') return { ok: true, value: await status(peer) }
      if (endpoint !== 'open') throw new Error('Unknown session window operation')
      const request = parseWindowRequest(payload)
      if (request.action === 'cancel') {
        if (preparation?.id === request.sessionId) preparation = undefined
        await companion?.cancel(request.sessionId)
        return { ok: true, value: { canceled: true } }
      }
      if (!enabled()) throw new Error('会话独立窗口功能已关闭。')
      let currentPreparation: typeof preparation
      let previousPreparation: typeof preparation
      if (request.action === 'prepare') {
        previousPreparation = preparation
        preparation = currentPreparation = { id: request.sessionId, generation: ++preparationGeneration }
      } else if (preparation?.id === request.sessionId) preparation = undefined
      const availability = await status(peer)
      if (!availability.versionSupported) throw new Error(`会话独立窗口最低支持官方 HARNESS ${MINIMUM_SESSION_WINDOW_HARNESS_VERSION}，请先升级 HARNESS。`)
      if (!availability.available) throw new Error('当前系统没有可用的会话窗口组件。')
      if (request.action === 'prepare' && currentPreparation !== preparation) return { ok: true, value: { prepared: false } }
      if (previousPreparation && previousPreparation.id !== request.sessionId) await companion?.cancel(previousPreparation.id)
      const title = await validateTarget(request.sessionId, signal, peer)
      if (signal.aborted) throw new Error('已取消打开窗口。')
      if (request.action === 'prepare' && currentPreparation !== preparation) return { ok: true, value: { prepared: false } }
      // profileContext is an optional formal launcher service. Respect get()
      // returning undefined; a strict property fallback would require injection.
      const profile = services.get?.('profileContext') as { dir?: unknown } | undefined
      const storeIdentifier = await sessionWindowStoreIdentifier(request.sessionId, typeof profile?.dir === 'string' ? profile.dir : undefined)
      if (signal.aborted) throw new Error('已取消打开窗口。')
      if (request.action === 'prepare' && currentPreparation !== preparation) return { ok: true, value: { prepared: false } }
      const url = new URL(services.connection.authenticatedUrl(`http://127.0.0.1:${services.webServer.port}/`))
      url.searchParams.set(SESSION_WINDOW_QUERY, request.sessionId)
      const nativeRequest = { sessionId: request.sessionId, storeIdentifier, url: url.href, title: title || 'DeepSeek Harness', source: request.source, position: request.position }
      if (request.action === 'prepare') {
        await native().prepare(nativeRequest)
        return { ok: true, value: { prepared: true } }
      }
      await native().open(nativeRequest)
      return { ok: true, value: { opened: true } }
    } catch (error) {
      return { ok: false, error: { code: 'qiuya-tools/session-window', message: error instanceof Error ? error.message : '无法打开会话窗口。', details: {} } }
    }
  }
  // Exact Fetch contributions compose inside the existing authenticated /api
  // bridge. Harness admits only owner Peers to exact routes and therefore
  // keeps native launch unavailable to delegated/API principals. This also
  // avoids rpc.handle's Cordis shadow-owner webServer dependency.
  const unregister = ([['status', SESSION_WINDOW_STATUS_ENDPOINT], ['open', SESSION_WINDOW_OPEN_ENDPOINT]] as const).map(([operation, endpoint]) =>
    services.connection.fetch.register({
      path: `${SESSION_WINDOW_CHANNEL}/${endpoint}`, methods: ['POST'], requestBody: 'buffered',
      fetch: async request => {
        let input: unknown
        try { input = await request.json() } catch { return new Response('Invalid session window request', { status: 400 }) }
        if (input === null || typeof input !== 'object') return new Response('Invalid session window request', { status: 400 })
        const message = input as { type?: unknown; rpcId?: unknown; method?: unknown; payload?: unknown }
        if (message.type !== 'client-request' || typeof message.rpcId !== 'string' || message.rpcId.length === 0 || message.rpcId.length > 256
          || /[\x00-\x1f\x7f]/u.test(message.rpcId) || message.method !== endpoint) return new Response('Invalid session window envelope', { status: 400 })
        const result = await handle(operation, message.payload, request.signal)
        return Response.json({ type: 'server-response', rpcId: message.rpcId, result })
      },
    }))
  return async () => {
    const retirement = companion?.dispose()
    try { await Promise.all(unregister.map(dispose => dispose())) }
    finally { await retirement }
  }
}
