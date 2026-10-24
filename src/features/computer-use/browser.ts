import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { access, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { ComputerError, parseComputerAction, requireIdentity } from './contract.ts'
import type { ComputerAction, ComputerGeometry, ComputerObservation, ComputerStatus, DeviceDriver, NativeComputerEvent, NativeTarget } from './contract.ts'

export interface BrowserOptions {
  browser?: 'chrome' | 'edge'; executable?: string; profileDir?: string; headless?: boolean
  allowedOrigins: readonly string[]; cdpEndpoint?: string; timeoutMs?: number
}
export interface BrowserTab { id: string; title: string; url: string; allowed: boolean }
export type BrowserSelectorAction = { kind: 'click' | 'type' | 'scroll'; selector: string; text?: string; deltaX?: number; deltaY?: number }
interface Pending { resolve(value: unknown): void; reject(error: unknown): void; clean(): void }
interface OwnedBrowserInput { sessionId: string; tabId: string; method: string; params: Record<string, unknown> }
interface OwnedBrowserLaunch { child: ChildProcess; activePort: string; endpoint?: string; ambiguous: boolean; stop(): void }
/** Only this exact spawned child's complete stderr line can identify a late endpoint. */
function trackOwnedBrowserLaunch(child: ChildProcess, activePort: string): OwnedBrowserLaunch {
  let tail = ''
  const launch: OwnedBrowserLaunch = { child, activePort, ambiguous: false, stop: () => { child.stderr?.off('data', onData); tail = '' } }
  const onData = (chunk: Buffer | string) => {
    tail = (tail + chunk.toString()).slice(-16_384)
    let newline: number
    while ((newline = tail.indexOf('\n')) >= 0) {
      const line = tail.slice(0, newline).replace(/\r$/u, ''); tail = tail.slice(newline + 1)
      const match = /^DevTools listening on (ws:\/\/127\.0\.0\.1:([0-9]{1,5})\/devtools\/browser\/[a-zA-Z0-9-]+)$/u.exec(line)
      if (!match) continue
      if (Number(match[2]) < 1 || Number(match[2]) > 65535 || launch.endpoint && launch.endpoint !== match[1]) launch.ambiguous = true
      else launch.endpoint = match[1]
    }
  }
  child.stderr?.on('data', onData)
  return launch
}
type CdpEvent = { method: string; sessionId?: string; params?: Record<string, unknown> }
/** Minimal public CDP transport. No arbitrary model-provided evaluate endpoint. */
class CdpConnection {
  private sequence = 0
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Set<(event: CdpEvent) => void>()
  private disposed = false
  constructor(private readonly socket: WebSocket, private readonly timeoutMs: number) {
    socket.addEventListener('message', event => {
      if (typeof event.data !== 'string' || event.data.length > 48 * 1024 * 1024) { this.fail(new ComputerError('BROWSER_PROTOCOL', '浏览器响应无效或超过限制')); socket.close(); return }
      let value: { id?: number; result?: unknown; error?: { message?: string }; method?: string; sessionId?: string; params?: Record<string, unknown> }
      try { value = JSON.parse(event.data) } catch { this.fail(new ComputerError('BROWSER_PROTOCOL', '浏览器返回无效 JSON')); socket.close(); return }
      if (typeof value.id === 'number') {
        const entry = this.pending.get(value.id); if (!entry) return
        this.pending.delete(value.id); entry.clean()
        if (value.error) entry.reject(new ComputerError('BROWSER_CDP_FAILED', value.error.message ?? '浏览器操作失败')); else entry.resolve(value.result)
      } else if (value.method) for (const listener of this.listeners) { try { listener(value as CdpEvent) } catch {} }
    })
    socket.addEventListener('close', () => this.fail(new ComputerError('BROWSER_DISCONNECTED', '浏览器连接已关闭')))
    socket.addEventListener('error', () => this.fail(new ComputerError('BROWSER_DISCONNECTED', '浏览器连接失败')))
  }
  static async open(endpoint: string, timeoutMs: number, signal?: AbortSignal): Promise<CdpConnection> {
    signal?.throwIfAborted()
    const socket = new WebSocket(endpoint)
    await new Promise<void>((resolve, reject) => {
      const clean = () => { clearTimeout(timer); socket.removeEventListener('open', opened); socket.removeEventListener('error', failed); signal?.removeEventListener('abort', aborted) }
      const opened = () => { clean(); resolve() }, failed = () => { clean(); socket.close(); reject(new ComputerError('BROWSER_CONNECT_FAILED', '无法连接浏览器调试接口')) }, aborted = () => { clean(); socket.close(); reject(signal?.reason) }
      const timer = setTimeout(failed, timeoutMs)
      socket.addEventListener('open', opened, { once: true }); socket.addEventListener('error', failed, { once: true }); signal?.addEventListener('abort', aborted, { once: true })
      if (signal?.aborted) aborted()
    })
    return new CdpConnection(socket, timeoutMs)
  }
  subscribe(listener: (event: CdpEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private fail(error: unknown): void { this.disposed = true; for (const entry of this.pending.values()) { entry.clean(); entry.reject(error) }; this.pending.clear(); for (const listener of this.listeners) { try { listener({ method: 'QiuYa.disconnected' }) } catch {} } }
  send<T = Record<string, unknown>>(method: string, params: object = {}, sessionId?: string, signal?: AbortSignal): Promise<T> {
    if (this.disposed || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new ComputerError('BROWSER_DISCONNECTED', '浏览器尚未连接'))
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (this.pending.size >= 128) return Promise.reject(new ComputerError('BROWSER_QUEUE_FULL', '浏览器请求过多'))
    return new Promise<T>((resolve, reject) => {
      const id = ++this.sequence
      const abort = () => { const entry = this.pending.get(id); if (entry) { this.pending.delete(id); entry.clean(); reject(signal?.reason) } }
      const timer = setTimeout(() => { this.pending.delete(id); clean(); reject(new ComputerError('BROWSER_TIMEOUT', '浏览器操作超时')) }, this.timeoutMs)
      const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
      this.pending.set(id, { resolve: value => resolve(value as T), reject, clean }); signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) { abort(); return }
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })) } catch (error) { this.pending.delete(id); clean(); reject(error) }
    })
  }
  close(): void { this.fail(new ComputerError('BROWSER_DISCONNECTED', '浏览器会话已结束')); this.socket.close(); this.listeners.clear() }
}
function originOf(value: string): string | undefined { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.origin : undefined } catch { return undefined } }
function debugEndpoint(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new ComputerError('INVALID_CDP_ENDPOINT', '浏览器调试地址无效') }
  const host = url.hostname.replace(/^\[|\]$/gu, '')
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || !['localhost', '127.0.0.1', '::1'].includes(host) || url.username || url.password || url.search || url.hash) throw new ComputerError('UNSAFE_CDP_ENDPOINT', '浏览器调试接口必须通过本机回环地址或可信隧道连接')
  return url
}
export function browserExecutableCandidates(browser: 'chrome' | 'edge', platform = process.platform): string[] {
  if (platform === 'darwin') return browser === 'chrome' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] : ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
  if (platform === 'win32') {
    const suffix = browser === 'chrome' ? ['Google', 'Chrome', 'Application', 'chrome.exe'] : ['Microsoft', 'Edge', 'Application', 'msedge.exe']
    return [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter((root): root is string => !!root).map(root => join(root, ...suffix))
  }
  return browser === 'chrome' ? ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'] : ['/usr/bin/microsoft-edge']
}
function jpegSize(base64: string): { width: number; height: number } {
  const bytes = Buffer.from(base64, 'base64')
  if (bytes[0] !== 255 || bytes[1] !== 216) throw new ComputerError('BROWSER_IMAGE_INVALID', '浏览器截图不是 JPEG')
  let offset = 2
  while (offset + 4 < bytes.length) {
    if (bytes[offset++] !== 255) continue
    let marker = bytes[offset++]!; while (marker === 255 && offset < bytes.length) marker = bytes[offset++]!
    if (marker === 217 || marker === 218) break
    if (marker === 1 || marker >= 208 && marker <= 215) continue
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length) break
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 7) return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) }
    offset += length
  }
  throw new ComputerError('BROWSER_IMAGE_INVALID', '无法读取浏览器截图尺寸')
}
export class BrowserSession {
  readonly profileDir: string
  readonly deviceId: string
  private readonly origins: Set<string>
  private connection?: CdpConnection
  private child?: ChildProcess
  private ownedLaunch?: OwnedBrowserLaunch
  private readonly sessions = new Map<string, string>()
  private readonly ownedTabs = new Set<string>()
  private readonly observations = new Map<string, ComputerObservation>()
  private readonly previewObservations = new Map<string, ComputerObservation>()
  private readonly listeners = new Set<(event: NativeComputerEvent) => void>()
  private readonly ownedInput = new Map<number, OwnedBrowserInput>()
  private readonly inputReleases = new Map<number, Promise<void>>()
  private inputSequence = 0
  private frameId = 0
  private closing = false
  constructor(readonly options: BrowserOptions) {
    this.profileDir = options.profileDir ?? join(homedir(), '.qiuya-tools', 'computer-use', 'profiles', options.browser ?? 'chrome')
    this.origins = new Set(options.allowedOrigins.map(value => { const origin = originOf(value); if (!origin) throw new ComputerError('INVALID_ORIGIN', '网站许可必须是 HTTP 或 HTTPS 来源'); return origin }))
    if (options.cdpEndpoint) debugEndpoint(options.cdpEndpoint)
    this.deviceId = `browser:${createHash('sha256').update(options.cdpEndpoint ?? this.profileDir).digest('hex').slice(0, 20)}`
  }
  hasOwnedRuntime(): boolean { return this.child !== undefined || this.connection !== undefined }
  allowedOrigins(): string[] { return [...this.origins].sort() }
  setAllowedOrigins(origins: readonly string[]): void {
    const next = origins.map(value => { const origin = originOf(value); if (!origin) throw new ComputerError('INVALID_ORIGIN', '网站来源无效'); return origin })
    this.origins.clear(); next.forEach(origin => this.origins.add(origin)); this.invalidateObservations()
  }
  invalidateObservations(): void { this.observations.clear(); this.previewObservations.clear() }
  subscribe(listener: (event: NativeComputerEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit(event: NativeComputerEvent): void { for (const listener of this.listeners) { try { listener(event) } catch {} } }
  private cdp(): CdpConnection { if (!this.connection) throw new ComputerError('BROWSER_NOT_CONNECTED', '请先连接浏览器'); return this.connection }
  async launch(signal?: AbortSignal): Promise<void> {
    if (this.connection) return
    if (this.child) throw new ComputerError('BROWSER_CLEANUP_FAILED', '上一次浏览器启动的退出尚未确认，请先结束该浏览器环境。')
    if (this.options.cdpEndpoint) { await this.connect(signal); return }
    signal?.throwIfAborted(); this.closing = false
    const candidates = this.options.executable ? [this.options.executable] : browserExecutableCandidates(this.options.browser ?? 'chrome')
    let executable: string | undefined
    for (const candidate of candidates) { try { await access(candidate); executable = candidate; break } catch {} }
    if (!executable) throw new ComputerError('BROWSER_NOT_INSTALLED', `请安装 ${this.options.browser === 'edge' ? 'Microsoft Edge' : 'Google Chrome'}`)
    await mkdir(this.profileDir, { recursive: true })
    const activePort = join(this.profileDir, 'DevToolsActivePort'); await rm(activePort, { force: true })
    const args = ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${this.profileDir}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', ...(this.options.headless ? ['--headless=new', '--disable-gpu'] : []), 'about:blank']
    const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: false }); this.child = child
    const ownedLaunch = trackOwnedBrowserLaunch(child, activePort); this.ownedLaunch = ownedLaunch
    let startupError: unknown
    child.once('error', error => { startupError = error }); child.stderr?.resume()
    child.once('exit', () => { ownedLaunch.stop(); if (this.ownedLaunch === ownedLaunch) this.ownedLaunch = undefined; if (this.child === child) { this.child = undefined; if (!this.closing) this.emit({ event: 'disconnected' }) } })
    const deadline = Date.now() + (this.options.timeoutMs ?? 15_000)
    try {
      while (Date.now() < deadline) {
        signal?.throwIfAborted()
        if (startupError || child.exitCode !== null) throw new ComputerError('BROWSER_LAUNCH_FAILED', '浏览器启动失败，请检查独立配置目录是否已被其他进程使用')
        try {
          const [port, path] = (await readFile(activePort, 'utf8')).trim().split('\n')
          if (/^\d+$/u.test(port ?? '') && path?.startsWith('/devtools/browser/')) { await this.attach(`ws://127.0.0.1:${port}${path}`, signal); return }
        } catch (error) { if (error instanceof ComputerError) throw error }
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      throw new ComputerError('BROWSER_LAUNCH_TIMEOUT', '等待浏览器调试接口超时')
    } catch (error) {
      // Keep an unconfirmed own child pinned. A failed/aborted launch never authorizes
      // terminating it or spawning a replacement while its retirement is unknown.
      if (this.child === child && (child.exitCode !== null || child.signalCode !== null || startupError && child.pid === undefined)) { this.child = undefined; ownedLaunch.stop(); if (this.ownedLaunch === ownedLaunch) this.ownedLaunch = undefined }
      throw error
    }
  }
  async connect(signal?: AbortSignal): Promise<void> {
    if (this.connection) return
    if (!this.options.cdpEndpoint) throw new ComputerError('CDP_ENDPOINT_REQUIRED', '请由用户配置已有浏览器的调试地址')
    const endpoint = debugEndpoint(this.options.cdpEndpoint)
    let websocket = endpoint.href
    if (['http:', 'https:'].includes(endpoint.protocol)) {
      endpoint.pathname = '/json/version'
      const response = await fetch(endpoint, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs ?? 15_000)]) : AbortSignal.timeout(this.options.timeoutMs ?? 15_000), redirect: 'error' })
      if (!response.ok) throw new ComputerError('BROWSER_CONNECT_FAILED', '浏览器调试接口不可用')
      const text = await response.text()
      if (text.length > 64 * 1024) throw new ComputerError('BROWSER_PROTOCOL', '调试接口响应超出限制')
      const info = JSON.parse(text) as { webSocketDebuggerUrl?: string }
      if (!info.webSocketDebuggerUrl) throw new ComputerError('BROWSER_PROTOCOL', '浏览器未提供 CDP WebSocket')
      const ws = debugEndpoint(info.webSocketDebuggerUrl)
      if (ws.hostname !== endpoint.hostname || ws.port !== endpoint.port) throw new ComputerError('BROWSER_PROTOCOL', '浏览器调试地址身份不匹配')
      websocket = ws.href
    }
    await this.attach(websocket, signal)
  }
  private async attach(endpoint: string, signal?: AbortSignal): Promise<void> {
    this.connection = await CdpConnection.open(debugEndpoint(endpoint).href, this.options.timeoutMs ?? 15_000, signal)
    this.connection.subscribe(event => { if (event.method === 'QiuYa.disconnected') { this.sessions.clear(); this.invalidateObservations(); this.emit({ event: 'disconnected' }) } })
  }
  async list(signal?: AbortSignal): Promise<BrowserTab[]> {
    const result = await this.cdp().send<{ targetInfos: { type: string; targetId: string; title: string; url: string }[] }>('Target.getTargets', {}, undefined, signal)
    return result.targetInfos.filter(target => target.type === 'page').map(target => ({ id: target.targetId, title: target.title, url: target.url, allowed: this.origins.has(originOf(target.url) ?? '') }))
  }
  private async permission(tabId: string, signal?: AbortSignal): Promise<BrowserTab> {
    requireIdentity(tabId, '标签页')
    const result = await this.cdp().send<{ targetInfo: { targetId: string; title: string; url: string; type: string } }>('Target.getTargetInfo', { targetId: tabId }, undefined, signal)
    const info = result.targetInfo
    if (info.type !== 'page' || !this.origins.has(originOf(info.url) ?? '')) throw new ComputerError('SITE_NOT_ALLOWED', '此标签页的网站尚未获得用户授权')
    return { id: info.targetId, title: info.title, url: info.url, allowed: true }
  }
  private async tabSession(tabId: string, signal?: AbortSignal): Promise<string> {
    const old = this.sessions.get(tabId); if (old) return old
    const result = await this.cdp().send<{ sessionId: string }>('Target.attachToTarget', { targetId: tabId, flatten: true }, undefined, signal)
    this.sessions.set(tabId, result.sessionId); return result.sessionId
  }
  async metrics(tabId: string, signal?: AbortSignal): Promise<ComputerGeometry> {
    await this.permission(tabId, signal)
    const session = await this.tabSession(tabId, signal)
    const result = await this.cdp().send<{ cssLayoutViewport: { clientWidth: number; clientHeight: number } }>('Page.getLayoutMetrics', {}, session, signal)
    return { x: 0, y: 0, width: result.cssLayoutViewport.clientWidth, height: result.cssLayoutViewport.clientHeight, scale: 1 }
  }
  async navigate(tabId: string, url: string, signal?: AbortSignal, beforeInput?: () => void): Promise<void> {
    if (!this.origins.has(originOf(url) ?? '')) throw new ComputerError('SITE_NOT_ALLOWED', '目标网站尚未获得用户授权')
    requireIdentity(tabId, '标签页')
    const session = await this.tabSession(tabId, signal)
    signal?.throwIfAborted(); beforeInput?.()
    const result = await this.cdp().send<{ errorText?: string; loaderId?: string }>('Page.navigate', { url }, session)
    signal?.throwIfAborted(); beforeInput?.()
    if (result.errorText) throw new ComputerError('BROWSER_NAVIGATION_FAILED', result.errorText)
    await this.waitNavigation(tabId, session, result.loaderId, signal, beforeInput)
  }
  private async waitNavigation(tabId: string, session: string, loaderId?: string, signal?: AbortSignal, guard?: () => void): Promise<void> {
    const deadline = Date.now() + (this.options.timeoutMs ?? 15_000)
    while (Date.now() < deadline) {
      signal?.throwIfAborted(); guard?.()
      const tree = await this.cdp().send<{ frameTree: { frame: { url: string; loaderId: string } } }>('Page.getFrameTree', {}, session, signal)
      signal?.throwIfAborted(); guard?.()
      const frame = tree.frameTree.frame
      if (frame.url !== 'about:blank') {
        if (!this.origins.has(originOf(frame.url) ?? '')) throw new ComputerError('SITE_NOT_ALLOWED', '页面跳转到了未经授权的网站')
        if (loaderId && frame.loaderId !== loaderId) { await new Promise(resolve => setTimeout(resolve, 25)); continue }
        const ready = await this.cdp().send<{ result: { value?: string } }>('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, session, signal)
        signal?.throwIfAborted(); guard?.()
        if (ready.result.value === 'complete') { await this.permission(tabId, signal); signal?.throwIfAborted(); guard?.(); return }
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new ComputerError('BROWSER_NAVIGATION_TIMEOUT', '等待页面加载超时')
  }
  async navigationState(tabId: string, signal?: AbortSignal): Promise<{ canGoBack: boolean; canGoForward: boolean; url: string }> {
    await this.permission(tabId, signal)
    const session = await this.tabSession(tabId, signal), history = await this.cdp().send<{ currentIndex: number; entries: { id: number; url: string }[] }>('Page.getNavigationHistory', {}, session, signal)
    const current = await this.permission(tabId, signal); signal?.throwIfAborted()
    const address = new URL(current.url); address.username = ''; address.password = ''
    const allowed = (index: number) => !!history.entries[index] && this.origins.has(originOf(history.entries[index]!.url) ?? '')
    return { canGoBack: allowed(history.currentIndex - 1), canGoForward: allowed(history.currentIndex + 1), url: address.href }
  }
  async history(tabId: string, operation: 'goBack' | 'goForward' | 'reload', signal?: AbortSignal, beforeInput?: () => void): Promise<void> {
    await this.permission(tabId, signal)
    const session = await this.tabSession(tabId, signal)
    if (operation === 'reload') {
      signal?.throwIfAborted(); await this.permission(tabId, signal); beforeInput?.()
      await this.cdp().send('Page.reload', { ignoreCache: false }, session)
    } else {
      const history = await this.cdp().send<{ currentIndex: number; entries: { id: number; url: string }[] }>('Page.getNavigationHistory', {}, session, signal)
      const target = history.entries[history.currentIndex + (operation === 'goBack' ? -1 : 1)]
      if (!target || !Number.isSafeInteger(target.id)) throw new ComputerError('BROWSER_HISTORY_UNAVAILABLE', '没有可以前往的页面')
      if (!this.origins.has(originOf(target.url) ?? '')) throw new ComputerError('SITE_NOT_ALLOWED', '历史页面的网站尚未获得授权')
      await this.permission(tabId, signal); signal?.throwIfAborted(); beforeInput?.()
      await this.cdp().send('Page.navigateToHistoryEntry', { entryId: target.id }, session)
    }
    signal?.throwIfAborted(); beforeInput?.(); this.observations.delete(tabId); this.previewObservations.delete(tabId)
    await this.waitNavigation(tabId, session, undefined, signal, beforeInput)
  }
  async open(url: string, signal?: AbortSignal, beforeInput?: () => void): Promise<BrowserTab> {
    if (!this.origins.has(originOf(url) ?? '')) throw new ComputerError('SITE_NOT_ALLOWED', '目标网站尚未获得用户授权')
    signal?.throwIfAborted(); beforeInput?.()
    const result = await this.cdp().send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' }); this.ownedTabs.add(result.targetId)
    try { signal?.throwIfAborted(); beforeInput?.(); await this.navigate(result.targetId, url, signal, beforeInput); return await this.permission(result.targetId, signal) }
    catch (error) { await this.closeOwnedTab(result.targetId).catch(() => {}); throw error }
  }
  async closeTab(tabId: string, signal?: AbortSignal, beforeInput?: () => void): Promise<void> {
    await this.permission(tabId, signal); signal?.throwIfAborted(); beforeInput?.(); await this.closeTarget(tabId)
  }
  /** Cleanup only: Host may close a target this instance actually created even after site revocation. */
  async closeOwnedTab(tabId: string): Promise<void> {
    if (!this.ownedTabs.has(tabId)) throw new ComputerError('TARGET_NOT_OWNED', '不能清理不属于本次浏览器的标签页')
    await this.closeTarget(tabId)
  }
  private async closeTarget(tabId: string): Promise<void> {
    const result = await this.cdp().send<{ success: boolean }>('Target.closeTarget', { targetId: tabId })
    if (!result.success) throw new ComputerError('BROWSER_CLOSE_FAILED', '无法关闭标签页')
    for (const [id, input] of this.ownedInput) if (input.tabId === tabId) this.ownedInput.delete(id)
    this.sessions.delete(tabId); this.observations.delete(tabId); this.previewObservations.delete(tabId); this.ownedTabs.delete(tabId)
  }
  async observe(tabId: string, signal?: AbortSignal): Promise<ComputerObservation> { return this.capture(tabId, signal, false) }
  async preview(tabId: string, signal?: AbortSignal): Promise<ComputerObservation> { return this.capture(tabId, signal, true) }
  private releaseInput(id: number): Promise<void> {
    const pending = this.inputReleases.get(id); if (pending) return pending
    const input = this.ownedInput.get(id); if (!input) return Promise.resolve()
    const releasing = (async () => {
      try { await this.cdp().send(input.method, input.params, input.sessionId) }
      catch { throw new ComputerError('BROWSER_CLEANUP_FAILED', '浏览器未确认释放本插件按住的键或鼠标，请重试停止后再开始控制。') }
      this.ownedInput.delete(id)
    })()
    this.inputReleases.set(id, releasing)
    void releasing.then(() => this.inputReleases.delete(id), () => this.inputReleases.delete(id))
    return releasing
  }
  async releaseInputs(): Promise<void> {
    const results = await Promise.allSettled([...this.ownedInput.keys()].map(id => this.releaseInput(id)))
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failure) throw failure.reason
  }
  private async capture(tabId: string, signal: AbortSignal | undefined, preview: boolean): Promise<ComputerObservation> {
    await this.permission(tabId, signal)
    const session = await this.tabSession(tabId, signal), geometry = await this.metrics(tabId, signal)
    const tree = preview ? { nodes: [] } : await this.cdp().send<{ nodes: { ignored?: boolean; role?: { value?: string }; name?: { value?: string }; value?: { value?: unknown }; backendDOMNodeId?: number }[] }>('Accessibility.getFullAXTree', {}, session, signal)
    await this.permission(tabId, signal)
    const screenshot = await this.cdp().send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: 65, fromSurface: true, captureBeyondViewport: false }, session, signal)
    await this.permission(tabId, signal)
    const size = jpegSize(screenshot.data)
    const elements = tree.nodes.filter(node => !node.ignored).slice(0, 1500).map(node => JSON.stringify({ role: node.role?.value, name: node.name?.value, value: typeof node.value?.value === 'string' ? node.value.value.slice(0, 4000) : node.value?.value, node: node.backendDOMNodeId })).join('\n').slice(0, 200_000)
    const observation: ComputerObservation = { targetId: tabId, frameId: `browser-${++this.frameId}`, imageBase64: screenshot.data, mediaType: 'image/jpeg', ...size, elements, geometry }
    if (preview) this.previewObservations.set(tabId, observation); else this.observations.set(tabId, observation)
    return observation
  }
  async act(tabId: string, input: ComputerAction | BrowserSelectorAction, signal?: AbortSignal, beforeInput?: () => void): Promise<unknown> {
    if (['navigate', 'openTab', 'closeTab', 'selectorClick', 'selectorType', 'goBack', 'goForward', 'reload'].includes(input.kind)) throw new ComputerError('BROWSER_DRIVER_REQUIRED', '此操作须通过电脑会话控制层执行')
    await this.permission(tabId, signal)
    const session = await this.tabSession(tabId, signal)
    const perform = async (method: string, params: object, beforeDispatch?: () => void) => {
      signal?.throwIfAborted(); await this.permission(tabId, signal); beforeInput?.()
      beforeDispatch?.()
      // An issued CDP input cannot be retracted. Await its actual response,
      // including cleanup, so release() can provide a quiescence barrier.
      return this.cdp().send(method, params, session)
    }
    let action: ComputerAction
    if ('selector' in input) {
      if (typeof input.selector !== 'string' || !input.selector || input.selector.length > 2048 || /[\x00-\x1f\x7f]/u.test(input.selector)) throw new ComputerError('INVALID_SELECTOR', 'CSS 选择器无效')
      if (!['click', 'type', 'scroll'].includes(input.kind)) throw new ComputerError('INVALID_ACTION', '选择器操作无效')
      const expression = `(()=>{const e=document.querySelector(${JSON.stringify(input.selector)});if(!e)return null;e.scrollIntoView({block:'center',inline:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,width:r.width,height:r.height,disabled:!!e.disabled}})()`
      signal?.throwIfAborted(); await this.permission(tabId, signal); beforeInput?.()
      const result = await this.cdp().send<{ result: { value?: { x: number; y: number; width: number; height: number; disabled: boolean } }; exceptionDetails?: unknown }>('Runtime.evaluate', { expression, returnByValue: true }, session)
      signal?.throwIfAborted(); beforeInput?.()
      const rect = result.result.value
      if (!rect || result.exceptionDetails || rect.width <= 0 || rect.height <= 0 || rect.disabled) throw new ComputerError('ELEMENT_NOT_FOUND', '未找到可操作的网站元素')
      if (input.kind === 'type') {
        if (typeof input.text !== 'string' || input.text.length > 100_000 || input.text.includes('\0')) throw new ComputerError('INVALID_ACTION', '输入文本无效')
        let owned: number | undefined
        try { await perform('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: rect.x, y: rect.y }, () => {
          owned = ++this.inputSequence
          this.ownedInput.set(owned, { sessionId: session, tabId, method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', button: 'left', clickCount: 1, x: rect.x, y: rect.y } })
        }) }
        finally { if (owned !== undefined) await this.releaseInput(owned) }
        await perform('Input.insertText', { text: input.text }); return { applied: true }
      }
      action = parseComputerAction({ kind: input.kind, x: rect.x, y: rect.y, ...(input.kind === 'scroll' ? { deltaX: input.deltaX ?? 0, deltaY: input.deltaY ?? 0 } : {}) })
    } else {
      action = parseComputerAction(input)
      if (action.x !== undefined || action.toX !== undefined) {
        const observation = this.observations.get(tabId) ?? this.previewObservations.get(tabId)
        if (!observation) throw new ComputerError('STALE_OBSERVATION', '请先观察当前标签页')
        const geometry = await this.metrics(tabId, signal)
        if (geometry.width !== observation.geometry.width || geometry.height !== observation.geometry.height) throw new ComputerError('STALE_OBSERVATION', '浏览器视口已变化')
        action = { ...action, ...(action.x === undefined ? {} : { x: action.x * geometry.width / observation.width, y: action.y! * geometry.height / observation.height }), ...(action.toX === undefined ? {} : { toX: action.toX * geometry.width / observation.width, toY: action.toY! * geometry.height / observation.height }) }
      }
    }
    const x = action.x ?? 0, y = action.y ?? 0, button = action.button ?? 'left'
    if (action.kind === 'type') await perform('Input.insertText', { text: action.text })
    else if (action.kind === 'move') await perform('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    else if (action.kind === 'scroll') await perform('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: action.deltaX ?? 0, deltaY: action.deltaY ?? 0 })
    else if (action.kind === 'click' || action.kind === 'drag') {
      await perform('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
      let owned: number | undefined
      try {
        await perform('Input.dispatchMouseEvent', { type: 'mousePressed', button, buttons: button === 'left' ? 1 : button === 'right' ? 2 : 4, clickCount: 1, x, y }, () => {
          owned = ++this.inputSequence
          this.ownedInput.set(owned, { sessionId: session, tabId, method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', button, clickCount: 1, x: action.toX ?? x, y: action.toY ?? y } })
        })
        if (action.kind === 'drag') for (let step = 1; step <= 10; step++) await perform('Input.dispatchMouseEvent', { type: 'mouseMoved', button, buttons: button === 'left' ? 1 : button === 'right' ? 2 : 4, x: x + (action.toX! - x) * step / 10, y: y + (action.toY! - y) * step / 10 })
      } finally { if (owned !== undefined) await this.releaseInput(owned) }
    } else if (action.kind === 'key') {
      const pieces = action.key!.split('+'), key = pieces.pop()!, aliases: Record<string, string> = { Esc: 'Escape', Return: 'Enter', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight' }
      const actual = aliases[key] ?? key
      let modifiers = 0
      for (const modifier of pieces) { if (/^(Ctrl|Control)$/iu.test(modifier)) modifiers |= 2; else if (/^(Cmd|Command|Meta)$/iu.test(modifier)) modifiers |= 4; else if (/^Shift$/iu.test(modifier)) modifiers |= 8; else if (/^(Alt|Option)$/iu.test(modifier)) modifiers |= 1; else throw new ComputerError('INVALID_KEY', '不支持的修饰键') }
      const codes: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34, Space: 32 }
      const code = codes[actual] ?? (actual.length === 1 ? actual.toUpperCase().charCodeAt(0) : undefined)
      if (code === undefined) throw new ComputerError('INVALID_KEY', '不支持的按键')
      // Enter needs Chromium's character-capable keyDown to run its default
      // form/newline behavior. Shortcut modifiers suppress text, as in Chromium.
      const text = actual === 'Enter' && (modifiers & 7) === 0 ? '\r' : ''
      let owned: number | undefined
      try { await perform('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: actual === 'Space' ? ' ' : actual, windowsVirtualKeyCode: code, modifiers, ...(text ? { text, unmodifiedText: text } : {}) }, () => {
        owned = ++this.inputSequence
        this.ownedInput.set(owned, { sessionId: session, tabId, method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: actual === 'Space' ? ' ' : actual, windowsVirtualKeyCode: code, modifiers } })
      }) }
      finally { if (owned !== undefined) await this.releaseInput(owned) }
    }
    this.observations.delete(tabId); this.previewObservations.delete(tabId)
    return { applied: true }
  }
  private async recoverOwnedLaunchConnection(child: ChildProcess, deadline: number): Promise<CdpConnection | undefined> {
    const launch = this.ownedLaunch
    const failed = () => new ComputerError('BROWSER_CLEANUP_FAILED', '专用浏览器的启动身份或自然退出尚未确认。')
    const stillOwned = () => { if (this.child !== child || this.ownedLaunch !== launch || !launch || launch.child !== child || launch.ambiguous) throw failed() }
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) return undefined
      stillOwned()
      if (launch?.endpoint) {
        let text: string | undefined
        try { text = await readFile(launch.activePort, { encoding: 'utf8', signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw failed() }
        if (child.exitCode !== null || child.signalCode !== null) return undefined
        stillOwned()
        if (text !== undefined) {
          const lines = text.trim().split('\n'), port = lines[0], path = lines[1]
          if (text.length > 1024 || lines.length !== 2 || !/^[0-9]{1,5}$/u.test(port ?? '') || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/u.test(path ?? '') || `ws://127.0.0.1:${port}${path}` !== launch.endpoint) throw failed()
          const remaining = Math.min(this.options.timeoutMs ?? 15_000, deadline - Date.now())
          if (remaining <= 0) throw failed()
          let connection: CdpConnection
          try { connection = await CdpConnection.open(launch.endpoint, remaining, AbortSignal.timeout(remaining)) } catch { if (child.exitCode !== null || child.signalCode !== null) return undefined; throw failed() }
          if (child.exitCode !== null || child.signalCode !== null) { connection.close(); return undefined }
          try { stillOwned() } catch (error) { connection.close(); throw error }
          this.connection = connection
          connection.subscribe(event => { if (event.method === 'QiuYa.disconnected') { this.sessions.clear(); this.invalidateObservations(); this.emit({ event: 'disconnected' }) } })
          return connection
        }
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))))
    }
    if (child.exitCode !== null || child.signalCode !== null) return undefined
    throw failed()
  }
  async close(): Promise<void> {
    this.closing = true
    let cleanupError: unknown
    try { await this.releaseInputs() } catch (error) { cleanupError = error }
    let connection = this.connection
    if (!this.child && cleanupError) throw cleanupError
    if (this.child) {
      const child = this.child
      // A canceled launch may publish its own endpoint after launch() returned.
      // Recovery, one Browser.close and retirement share the original 5 s budget.
      const deadline = connection ? undefined : Date.now() + 5000
      if (!connection) connection = await this.recoverOwnedLaunchConnection(child, deadline!)
      if (child.exitCode === null && child.signalCode === null && this.child !== child) throw new ComputerError('BROWSER_CLEANUP_FAILED', '浏览器进程身份已变化，不能清理其他运行实例。')
      if (deadline !== undefined && connection && (this.ownedLaunch?.child !== child || this.ownedLaunch.ambiguous || Date.now() >= deadline)) throw new ComputerError('BROWSER_CLEANUP_FAILED', '专用浏览器的启动身份或自然退出尚未确认。')
      const closeSignal = deadline === undefined ? undefined : AbortSignal.timeout(Math.max(1, deadline - Date.now()))
      await connection?.send('Browser.close', {}, undefined, closeSignal).catch(() => {})
      if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { clean(); reject(new ComputerError('BROWSER_CLEANUP_FAILED', '专用浏览器进程未确认退出。')) }, deadline === undefined ? 5000 : Math.max(0, deadline - Date.now()))
        const clean = () => { clearTimeout(timeout); child.off('exit', onExit) }
        const onExit = () => { clean(); resolve() }
        child.once('exit', onExit)
        if (child.exitCode !== null || child.signalCode !== null) onExit()
      })
      if (this.child !== undefined && this.child !== child) throw new ComputerError('BROWSER_CLEANUP_FAILED', '浏览器进程身份已变化，不能清理其他运行实例。')
      if (this.ownedLaunch?.child === child) { this.ownedLaunch.stop(); this.ownedLaunch = undefined }
      this.child = undefined
      this.ownedInput.clear()
    }
    this.connection = undefined; this.sessions.clear(); this.ownedTabs.clear(); this.invalidateObservations()
    connection?.close(); this.listeners.clear()
  }
}

/** Browser operations remain in the chosen tab and do not commandeer the OS pointer. */
export class BrowserDeviceDriver implements DeviceDriver {
  private epoch = 0
  private activeEpoch?: number
  private readonly controllers = new Set<AbortController>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly pendingReleases = new Set<number>()
  constructor(readonly browser: BrowserSession) {}
  subscribe(listener: (event: NativeComputerEvent) => void) { return this.browser.subscribe(listener) }
  async status(signal?: AbortSignal): Promise<ComputerStatus> { const tabs = await this.browser.list(signal); return { available: true, platform: process.platform, protocolVersion: 1, capabilities: { browser: true, capture: true, accessibility: true, input: true, backgroundInput: true, secureDesktop: false }, tabCount: tabs.length, allowedOrigins: this.browser.allowedOrigins() } }
  async targets(signal?: AbortSignal): Promise<NativeTarget[]> {
    const tabs = await this.browser.list(signal), targets: NativeTarget[] = []
    for (const tab of tabs.filter(tab => tab.allowed)) { const geometry = await this.browser.metrics(tab.id, signal); targets.push({ ...geometry, id: tab.id, appId: `${this.browser.deviceId}:${originOf(tab.url)}`, pid: 1, title: tab.title || tab.url }) }
    return targets
  }
  observe(targetId: string, signal?: AbortSignal) { return this.browser.observe(targetId, signal) }
  preview(targetId: string, signal?: AbortSignal) { return this.browser.preview(targetId, signal) }
  async lease(epoch: number): Promise<unknown> {
    if (!Number.isSafeInteger(epoch) || epoch <= this.epoch) throw new ComputerError('STALE_EPOCH', '浏览器控制周期必须递增')
    this.epoch = epoch
    if (this.activeEpoch !== undefined) await this.release(this.activeEpoch)
    if (this.pendingReleases.size) await this.finishRelease()
    if (this.epoch !== epoch) throw new ComputerError('CONTROL_CHANGED', '浏览器租约已被更新的控制周期替代')
    this.activeEpoch = epoch; return { leased: true }
  }
  async release(epoch: number): Promise<unknown> {
    if (this.activeEpoch === epoch) {
      this.pendingReleases.add(epoch)
      this.activeEpoch = undefined; this.browser.invalidateObservations?.()
      for (const controller of this.controllers) controller.abort(new ComputerError('CONTROL_CHANGED', '浏览器输入已暂停'))
    }
    if (this.pendingReleases.has(epoch) || (this.activeEpoch === undefined && this.pendingReleases.size)) await this.finishRelease()
    return { released: true }
  }
  private async finishRelease(): Promise<void> {
    await Promise.allSettled([...this.pending])
    await this.browser.releaseInputs?.()
    this.pendingReleases.clear()
  }
  async act(epoch: number, targetId: string, action: ComputerAction, signal?: AbortSignal): Promise<unknown> {
    const guard = () => { if (this.activeEpoch !== epoch) throw new ComputerError('CONTROL_CHANGED', '浏览器输入租约已变化') }
    guard(); signal?.throwIfAborted()
    const controller = new AbortController(), abort = () => controller.abort(signal?.reason)
    this.controllers.add(controller); signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const operation = (async () => {
      if (action.kind === 'navigate') { await this.browser.navigate(targetId, action.url!, controller.signal, guard); return { applied: true, targetId } }
      if (action.kind === 'goBack' || action.kind === 'goForward' || action.kind === 'reload') { await this.browser.history(targetId, action.kind, controller.signal, guard); return { applied: true, targetId } }
      if (action.kind === 'openTab') { const tab = await this.browser.open(action.url!, controller.signal, guard); return { applied: true, targetId: tab.id } }
      if (action.kind === 'closeTab') { await this.browser.closeTab(targetId, controller.signal, guard); return { applied: true, closed: true } }
      if (action.kind === 'selectorClick') return this.browser.act(targetId, { kind: 'click', selector: action.selector! }, controller.signal, guard)
      if (action.kind === 'selectorType') return this.browser.act(targetId, { kind: 'type', selector: action.selector!, text: action.text! }, controller.signal, guard)
      return this.browser.act(targetId, action, controller.signal, guard)
    })()
    this.pending.add(operation)
    try { const result = await operation; controller.signal.throwIfAborted(); guard(); return result }
    finally { this.pending.delete(operation); this.controllers.delete(controller); signal?.removeEventListener('abort', abort) }
  }
  async resolveActionTarget(target: NativeTarget, action: ComputerAction, result: unknown, signal?: AbortSignal): Promise<NativeTarget | null> {
    if (!target.appId.startsWith(`${this.browser.deviceId}:`)) throw new ComputerError('TARGET_CHANGED', '操作不属于此浏览器')
    if (action.kind === 'closeTab' && (result as { closed?: unknown })?.closed === true) return null
    const id = ['navigate', 'openTab'].includes(action.kind) ? (result as { targetId?: unknown })?.targetId : target.id
    if (typeof id !== 'string') throw new ComputerError('INVALID_TARGET', '浏览器未返回有效标签页')
    const next = (await this.targets(signal)).find(candidate => candidate.id === id)
    if (!next || !next.appId.startsWith(`${this.browser.deviceId}:`)) throw new ComputerError('SITE_NOT_ALLOWED', '目标标签页不在用户允许的网站中')
    return next
  }
  async openPreview(): Promise<unknown> { throw new ComputerError('LOCAL_PREVIEW_REQUIRED', '浏览器预览应使用本机悬浮窗') }
  async closePreview(): Promise<unknown> { return undefined }
  async dispose(): Promise<void> {
    try { if (this.activeEpoch !== undefined) await this.release(this.activeEpoch); else if (this.pendingReleases.size) await this.finishRelease() }
    finally { await this.browser.close() }
    this.pendingReleases.clear()
  }
}
