import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { ComputerActionCleanupError, ComputerError } from './contract.ts'
import { foregroundContext, foregroundGrant, foregroundRelease, foregroundTicket } from './foreground-handoff.ts'
import type { ComputerAction, ComputerObservation, ComputerStatus, ComputerSystemPermission, DeviceDriver, ForegroundActionTicket, ForegroundHandoffDriver, ForegroundWorkerIdentity, NativeApplication, NativeComputerEvent, NativeTarget } from './contract.ts'

export interface NativeCompanionOptions { executable?: string; args?: string[]; timeoutMs?: number; maxMessageBytes?: number; releaseInputArgs?: string[] }
export function computerCompanionPath(platform: NodeJS.Platform = process.platform, architecture: string = process.arch, base = new URL('./', import.meta.url)): string {
  if (platform === 'darwin') return fileURLToPath(new URL('./QiuYaTools Computer.app/Contents/MacOS/qiuya-computer', base))
  if (platform === 'win32' && ['arm64', 'x64'].includes(architecture)) return fileURLToPath(new URL(`./native/win32-${architecture}/qiuya-windows.exe`, base))
  throw new ComputerError('PLATFORM_UNSUPPORTED', '此系统暂无电脑操控执行器')
}
interface Pending { resolve: (value: unknown) => void; reject: (error: unknown) => void; clean: () => void; transportFailure?: (error: unknown) => void }
interface CaptureWaiter { resolve: (value: ComputerObservation) => void; reject: (error: unknown) => void }
interface NativeCapture {
  controller: AbortController
  waiters: Set<CaptureWaiter>
  result: Promise<ComputerObservation>
}
interface NativeHeldInputs { keys: number[]; mouseButtons: string[]; unicodeUnits?: number[]; ownerId?: string }
function ownedInputs(message: Record<string, unknown>): NativeHeldInputs | undefined {
  if (!Array.isArray(message.keys) || message.keys.length > 256 || !message.keys.every(key => Number.isSafeInteger(key) && key >= 0 && key <= 255)) return
  if (!Array.isArray(message.mouseButtons) || message.mouseButtons.length > 3 || !message.mouseButtons.every(button => ['left', 'right', 'middle'].includes(button))) return
  if (message.unicodeUnits !== undefined && (!Array.isArray(message.unicodeUnits) || message.unicodeUnits.length > 1024 || !message.unicodeUnits.every(unit => Number.isSafeInteger(unit) && unit >= 0 && unit <= 65535))) return
  if (message.ownerId !== undefined && (typeof message.ownerId !== 'string' || !/^[a-f0-9]{32}$/iu.test(message.ownerId))) return
  return { keys: [...message.keys], mouseButtons: [...message.mouseButtons],
    ...(message.unicodeUnits === undefined ? {} : { unicodeUnits: [...message.unicodeUnits as number[]] }),
    ...(message.ownerId === undefined ? {} : { ownerId: message.ownerId as string }) }
}
/** Bounded JSONL companion transport. Requests and secrets never enter argv. */
export class NativeCompanionDriver implements DeviceDriver {
  private child?: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Set<(event: NativeComputerEvent) => void>()
  private buffer = ''
  private disposed = false
  private nextRequestId = 0
  private backendGeneration = 0
  private foreground?: ForegroundHandoffDriver
  private foregroundSequence?: string
  private updateForegroundSequence(value: string): void { if (this.foregroundSequence === undefined || BigInt(value) > BigInt(this.foregroundSequence)) this.foregroundSequence = value }
  get foregroundHandoff() { return this.foreground }
  private protocol?: Promise<ComputerStatus>
  private retiring: Promise<void> = Promise.resolve()
  private held: NativeHeldInputs = { keys: [], mouseButtons: [] }
  private captureTail: Promise<void> = Promise.resolve()
  private readonly captures = new Set<NativeCapture>()
  private readonly previewCaptures = new Map<string, NativeCapture>()
  private captureCallers = 0
  constructor(private readonly options: NativeCompanionOptions = {}) {}
  static defaultPath = computerCompanionPath
  subscribe(listener: (event: NativeComputerEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit(event: NativeComputerEvent): void { for (const listener of this.listeners) { try { listener(event) } catch {} } }
  private fail(error: unknown, child = this.child): void {
    if (child && this.child !== child) return
    const held = this.held; this.held = { keys: [], mouseButtons: [] }
    this.child = undefined; this.buffer = ''; this.protocol = undefined; this.foreground = undefined; this.foregroundSequence = undefined
    if (child) { this.retiring = this.retire(child, held); void this.retiring.catch(() => {}) }
    for (const capture of this.captures) {
      capture.controller.abort(error)
      for (const waiter of [...capture.waiters]) waiter.reject(error)
    }
    for (const entry of this.pending.values()) { entry.clean(); if (entry.transportFailure) entry.transportFailure(error); else entry.reject(error) }
    this.pending.clear()
    this.emit({ event: 'disconnected' })
  }
  private async retire(child: ChildProcessWithoutNullStreams, held: NativeHeldInputs): Promise<void> {
    // EOF asks the independent native message loop to revoke and release first.
    // A wedged worker gets a fixed grace; Windows then uses a separate process
    // to send only the last acknowledged owned keyups/mouseups after it exits.
    if (child.exitCode === null && child.signalCode === null && child.pid) await new Promise<void>((resolve, reject) => {
      let deadline: ReturnType<typeof setTimeout> | undefined
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        deadline = setTimeout(() => reject(new ComputerError('NATIVE_CLEANUP_FAILED', '执行器未确认退出，已阻止新的电脑输入。')), 2000)
        deadline.unref()
      }, 1500)
      timer.unref()
      child.once('exit', () => { clearTimeout(timer); clearTimeout(deadline); resolve() })
      child.stdin.end()
    })
    const args = this.options.releaseInputArgs ?? (process.platform === 'win32' ? ['--release-input'] : undefined)
    if (!args || !held.keys.length && !held.mouseButtons.length && !held.unicodeUnits?.length) return
    await new Promise<void>((resolve, reject) => {
      const cleanup = spawn(this.options.executable ?? computerCompanionPath(), args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
      const timer = setTimeout(() => { cleanup.kill(); reject(new ComputerError('NATIVE_CLEANUP_FAILED', '故障后的按键清理超时，已阻止新的电脑输入。')) }, 2000)
      timer.unref()
      cleanup.once('error', () => { clearTimeout(timer); reject(new ComputerError('NATIVE_CLEANUP_FAILED', '无法启动按键清理，已阻止新的电脑输入。')) })
      cleanup.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new ComputerError('NATIVE_CLEANUP_FAILED', '按键清理失败，已阻止新的电脑输入。')) }); cleanup.stdin.on('error', () => {})
      cleanup.stdin.end(JSON.stringify(held) + '\n')
    })
  }
  private start(): ChildProcessWithoutNullStreams {
    if (this.disposed) throw new ComputerError('DISPOSED', '电脑操控执行器已停用')
    if (this.child) return this.child
    const executable = this.options.executable ?? computerCompanionPath()
    const args = this.options.args ?? (process.platform === 'win32' ? ['--computer'] : [])
    const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, QIUYA_TOOLS_PARENT_PID: String(process.pid) } })
    this.child = child; this.backendGeneration++
    child.stdin.on('error', error => this.fail(new ComputerError('NATIVE_PIPE_FAILED', error.message), child))
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (this.child !== child) return
      this.buffer += chunk
      if (Buffer.byteLength(this.buffer) > (this.options.maxMessageBytes ?? 48 * 1024 * 1024)) { this.fail(new ComputerError('NATIVE_MESSAGE_LIMIT', '执行器响应超出限制'), child); child.kill(); return }
      let end: number
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end).trim(); this.buffer = this.buffer.slice(end + 1)
        if (!line) continue
        let message: Record<string, unknown>
        try { message = JSON.parse(line) } catch { this.fail(new ComputerError('NATIVE_PROTOCOL', '执行器返回了无效 JSON'), child); child.kill(); return }
        if (!message || typeof message !== 'object') continue
        if (typeof message.event === 'string') {
          if (message.event === 'inputHeld') { const held = ownedInputs(message); if (held) this.held = held }
          else {
            if (message.event === 'foregroundContextInvalidated' && typeof message.physicalSequence === 'string' && /^\d{1,20}$/u.test(message.physicalSequence)) this.updateForegroundSequence(message.physicalSequence)
            this.emit(message as NativeComputerEvent)
          }
          continue
        }
        if (typeof message.requestId !== 'number' || !Number.isSafeInteger(message.requestId)) continue
        const entry = this.pending.get(message.requestId)
        if (!entry) continue
        this.pending.delete(message.requestId); entry.clean()
        if (message.ok === true) entry.resolve(message.result)
        else {
          const error = message.error as { code?: unknown; message?: unknown } | undefined
          entry.reject(new ComputerError(typeof error?.code === 'string' ? error.code : 'NATIVE_FAILED', typeof error?.message === 'string' ? error.message : typeof message.error === 'string' ? message.error : '原生操作失败'))
        }
      }
    })
    // Drain stderr without copying arbitrary native output or private contents to logs.
    child.stderr.resume()
    child.once('error', error => this.fail(new ComputerError('NATIVE_UNAVAILABLE', error.message), child))
    child.once('close', () => this.fail(new ComputerError('NATIVE_EXITED', '原生执行器已退出'), child))
    return child
  }
  private async rpc<T>(op: string, payload: object = {}, signal?: AbortSignal, awaitIssuedReply = false, expectedChild?: ChildProcessWithoutNullStreams, retainIssuedResult = false): Promise<T> {
    await this.retiring
    if (expectedChild && this.child !== expectedChild) throw new ComputerError('CONTROL_CHANGED', '前台交接执行器已经变化')
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (this.pending.size >= 128) return Promise.reject(new ComputerError('QUEUE_FULL', '执行器请求过多'))
    let child: ChildProcessWithoutNullStreams
    try { child = this.start() } catch (error) { return Promise.reject(error) }
    return new Promise<T>((resolve, reject) => {
      const requestId = ++this.nextRequestId
      let issued = false
      const timer = setTimeout(() => {
        // A timed-out mutating native request has unknown outcome. Kill the worker;
        // reconnecting requires a fresh service lease and observation.
        this.fail(new ComputerError('NATIVE_TIMEOUT', '原生操作超时，执行器已停止'), child)
      }, this.options.timeoutMs ?? 20_000)
      const abort = () => { const entry = this.pending.get(requestId); if (!entry || awaitIssuedReply && issued) return; this.pending.delete(requestId); entry.clean(); reject(signal?.reason ?? new ComputerError('ABORTED', '操作已取消')) }
      const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
      this.pending.set(requestId, {
        // Preparing allocates a native ticket. Its successful ACK remains owned even
        // if cancellation won the race; the caller must receive and cancel that exact ID.
        resolve: value => { if (awaitIssuedReply && signal?.aborted && !retainIssuedResult) reject(signal.reason); else resolve(value as T) }, reject, clean,
        ...(awaitIssuedReply ? { transportFailure: (error: unknown) => reject(issued ? (op.startsWith('foreground') ? new ComputerError('FOREGROUND_HANDOFF_UNCONFIRMED', '前台交接结果未确认，执行器已停止。请重新连接并确认当前窗口。') : new ComputerError('APPLICATION_LAUNCH_UNCONFIRMED', '应用启动结果未确认，已阻止此电脑的新输入。请由用户重新连接后确认当前窗口。')) : error) } : {}),
      })
      signal?.addEventListener('abort', abort, { once: true })
      // Close the aborted-between-check-and-listener race before writing input.
      if (signal?.aborted) { abort(); return }
      issued = true
      child.stdin.write(`${JSON.stringify({ requestId, op, ...payload })}\n`, error => { if (error) this.fail(new ComputerError('NATIVE_PIPE_FAILED', error.message), child) })
    })
  }
  private compatible(): Promise<ComputerStatus> {
    if (this.disposed) return Promise.reject(new ComputerError('DISPOSED', '电脑操控执行器已停用'))
    if (!this.protocol) this.protocol = this.rpc<ComputerStatus>('status').then(status => {
      if (status?.protocolVersion !== 1) throw new ComputerError('NATIVE_PROTOCOL_VERSION', '执行器协议版本不匹配，请重新安装对应版本的插件。')
      if (status.platform === 'win32' && !Array.isArray(status.capabilities) && status.capabilities?.foregroundHandoff === true && this.child) {
        if (typeof status.foregroundPhysicalSequence !== 'string' || !/^\d{1,20}$/u.test(status.foregroundPhysicalSequence)) throw new ComputerError('NATIVE_PROTOCOL', '前台交接的物理输入状态无效')
        this.foregroundSequence = status.foregroundPhysicalSequence; this.foreground = this.createForegroundHandoff(this.child, this.backendGeneration)
      }
      return status
    })
    return this.protocol
  }
  private createForegroundHandoff(child: ChildProcessWithoutNullStreams, generation: number): ForegroundHandoffDriver {
    let imageSHA256: Promise<string> | undefined
    const current = () => { if (this.child !== child || this.backendGeneration !== generation || this.disposed) throw new ComputerError('CONTROL_CHANGED', '前台交接执行器已经变化') }
    const identity = async (value: ForegroundWorkerIdentity) => {
      current()
      const executable = this.options.executable ?? computerCompanionPath()
      if (value.pid !== child.pid || value.parentPid !== process.pid || value.executablePath.toLowerCase() !== executable.toLowerCase()) throw new ComputerError('NATIVE_PROTOCOL', '前台交接执行器与当前进程不一致')
      imageSHA256 ??= (async () => { const hash = createHash('sha256'); for await (const chunk of createReadStream(executable)) hash.update(chunk); return hash.digest('hex') })()
      if (await imageSHA256 !== value.imageSHA256) throw new ComputerError('NATIVE_PROTOCOL', '前台交接执行器文件不一致')
      current()
    }
    const request = async <T>(op: string, payload: object, signal?: AbortSignal, mutating = false): Promise<T> => {
      current(); const value = await this.rpc<T>(op, payload, signal, mutating, child, op === 'foregroundPrepare'); current(); return value
    }
    const owner = this
    return {
      get physicalSequence() { current(); return owner.foregroundSequence },
      context: async signal => { const value = foregroundContext(await request('foregroundContext', {}, signal)); await identity(value.identity); this.updateForegroundSequence(value.physicalSequence); return value },
      prepare: async (input, signal) => {
        let received = false, ticketId: string | undefined
        try {
          const value = await request<{ ticket: unknown; physicalSequence: unknown }>('foregroundPrepare', input, signal, true)
          received = true
          const raw = value?.ticket
          if (raw && typeof raw === 'object' && 'ticketId' in raw && typeof raw.ticketId === 'string' && /^[a-f0-9]{32}$/iu.test(raw.ticketId)) ticketId = raw.ticketId
          const ticket = foregroundTicket(raw)
          await identity(ticket.identity)
          if (value.physicalSequence !== ticket.physicalSequence || ticket.epoch !== input.epoch || ticket.logicalEpoch !== input.logicalEpoch || ticket.targetId !== input.targetId || ticket.actionSHA256 !== input.actionSHA256 || ticket.surfaceGeneration !== input.surfaceGeneration) throw new ComputerError('NATIVE_PROTOCOL', '前台交接票据与本次操作不一致')
          return { ticket, physicalSequence: ticket.physicalSequence }
        } catch (error) {
          // A successful prepare ACK owns a native side effect before Host validation.
          // Cancel its exact ID even on a bad binding; without an ID retire the worker.
          if (ticketId) try {
            const cancelled = await request<{ cancelled: unknown }>('foregroundCancel', { ticketId }, undefined, true)
            if (typeof cancelled?.cancelled !== 'boolean') throw new ComputerError('NATIVE_PROTOCOL', '前台交接取消回执无效')
          } catch (cleanup) { this.fail(cleanup, child); throw new ComputerActionCleanupError(error, [cleanup]) }
          else if (received) this.fail(error, child)
          throw error
        }
      },
      grant: async (input, signal) => { const value = foregroundGrant(await request('foregroundGrant', input, signal, true)); await identity(value.donor); return value },
      cancel: async input => { const value = await request<{ cancelled: unknown }>('foregroundCancel', input, undefined, true); if (typeof value?.cancelled !== 'boolean') throw new ComputerError('NATIVE_PROTOCOL', '前台交接取消回执无效'); return { cancelled: value.cancelled } },
    }
  }
  private async checked<T>(op: string, payload: object = {}, signal?: AbortSignal, awaitIssuedReply = false): Promise<T> {
    signal?.throwIfAborted()
    await this.compatible()
    signal?.throwIfAborted()
    return this.rpc<T>(op, payload, signal, awaitIssuedReply)
  }
  async status(signal?: AbortSignal): Promise<ComputerStatus> {
    try { signal?.throwIfAborted(); await this.compatible(); const value = await this.rpc<ComputerStatus>('status', {}, signal); if (this.foreground && typeof value.foregroundPhysicalSequence === 'string' && /^\d{1,20}$/u.test(value.foregroundPhysicalSequence)) this.updateForegroundSequence(value.foregroundPhysicalSequence); return value }
    catch (error) { if (signal?.aborted) throw error; return { available: false, platform: process.platform, message: error instanceof Error ? error.message : '执行器不可用' } }
  }
  async targets(signal?: AbortSignal): Promise<NativeTarget[]> {
    const result = await this.checked<NativeTarget[] | { targets: NativeTarget[] }>('targets', {}, signal)
    const targets = Array.isArray(result) ? result : result?.targets
    if (!Array.isArray(targets)) throw new ComputerError('NATIVE_PROTOCOL', '执行器返回的窗口列表无效')
    return targets
  }
  async applications(signal?: AbortSignal): Promise<NativeApplication[]> {
    const result = await this.checked<{ applications: NativeApplication[] }>('applications', {}, signal)
    if (!Array.isArray(result?.applications) || result.applications.length > 1024 || result.applications.some(app => !app || typeof app.appId !== 'string' || !app.appId || app.appId.length > 512 || /[\x00-\x1f\x7f]/u.test(app.appId) || typeof app.name !== 'string' || !app.name || app.name.length > 640 || Array.from(app.name).length > 160 || /[\x00-\x1f\x7f]/u.test(app.name) || typeof app.running !== 'boolean' || app.launchable !== undefined && typeof app.launchable !== 'boolean')) throw new ComputerError('NATIVE_PROTOCOL', '执行器返回的应用目录无效')
    return result.applications.map(({ appId, name, running, launchable }) => ({ appId, name, running, ...(launchable === undefined ? {} : { launchable }) }))
  }
  launchApplication(appId: string, signal?: AbortSignal) {
    // Once written, cancelling a caller cannot undo NSWorkspace/Shell launch.
    // Retain the transport slot until its real reply, or report uncertainty.
    return this.checked('launchApplication', { appId }, signal, true)
  }
  openSystemSettings(kind: ComputerSystemPermission, signal?: AbortSignal) {
    if (!['screenRecording', 'accessibility', 'inputMonitoring'].includes(kind)) return Promise.reject(new ComputerError('INVALID_PERMISSION', '系统权限类型无效'))
    return this.checked('openSystemSettings', { kind }, signal)
  }
  private capture(targetId: string, preview: boolean, signal?: AbortSignal): Promise<ComputerObservation> {
    if (this.disposed) return Promise.reject(new ComputerError('DISPOSED', '电脑操控执行器已停用'))
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (this.captureCallers >= 128) return Promise.reject(new ComputerError('QUEUE_FULL', '等待画面的连接过多'))
    let shared = preview ? this.previewCaptures.get(targetId) : undefined
    if (!shared) {
      if (this.captures.size >= 16) return Promise.reject(new ComputerError('QUEUE_FULL', '等待中的画面请求过多'))
      const controller = new AbortController()
      const result = this.captureTail.then(() => {
        controller.signal.throwIfAborted()
        if (!capture.waiters.size) throw new ComputerError('ABORTED', '画面请求已取消')
        // A viewer cancellation only leaves its own waiter. Once sent, keep the
        // native capture slot until the real reply/timeout; otherwise the next
        // read races Mac's observationBusy even when nobody wants this frame.
        return this.checked<ComputerObservation>('observe', { targetId, ...(preview ? { preview: true } : {}) }, controller.signal)
      })
      // One fan-out per job, rather than a Promise handler per viewer: aborted
      // viewers leave no retained closures on a slow shared native operation.
      const completed = () => {
        this.captures.delete(capture)
        if (this.previewCaptures.get(targetId) === capture) this.previewCaptures.delete(targetId)
      }
      const capture: NativeCapture = { controller, waiters: new Set(), result: result.then(value => {
        completed()
        for (const waiter of [...capture.waiters]) waiter.resolve(value)
        return value
      }, error => {
        completed()
        for (const waiter of [...capture.waiters]) waiter.reject(error)
        throw error
      }) }
      this.captures.add(capture)
      if (preview) this.previewCaptures.set(targetId, capture)
      // The FIFO covers capture only. Lease/release/input/status keep their own
      // immediate RPC path, including while a slow image is being prepared.
      this.captureTail = capture.result.then(() => {}, () => {})
      shared = capture
    }
    const capture = shared
    return new Promise<ComputerObservation>((resolve, reject) => {
      let waiting = true
      const finish = (complete: () => void) => {
        if (!waiting) return
        waiting = false; capture.waiters.delete(waiter); this.captureCallers--
        signal?.removeEventListener('abort', abort); complete()
      }
      const waiter: CaptureWaiter = { resolve: value => finish(() => resolve(value)), reject: error => finish(() => reject(error)) }
      const abort = () => waiter.reject(signal?.reason ?? new ComputerError('ABORTED', '画面请求已取消'))
      capture.waiters.add(waiter); this.captureCallers++
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
  }
  observe(targetId: string, signal?: AbortSignal) { return this.capture(targetId, false, signal) }
  preview(targetId: string, signal?: AbortSignal) { return this.capture(targetId, true, signal) }
  lease(epoch: number, signal?: AbortSignal, options?: { actor: 'ai' | 'human' }) { return this.checked('lease', { epoch, ...(options ? { actor: options.actor } : {}) }, signal) }
  async release(epoch: number, signal?: AbortSignal) {
    const foreground = this.foreground, child = this.child
    const result = await this.rpc<unknown>('release', { epoch }, signal, Boolean(foreground), child, Boolean(foreground))
    if (!foreground || !result || typeof result !== 'object' || !('foregroundRelease' in result) || !result.foregroundRelease) return result
    const raw = result.foregroundRelease
    let tokenId: string | undefined
    if (typeof raw === 'object' && 'tokenId' in raw && typeof raw.tokenId === 'string' && /^[a-f0-9]{32}$/iu.test(raw.tokenId)) tokenId = raw.tokenId
    try { return { ...result, foregroundRelease: foregroundRelease(raw) } }
    catch (error) {
      if (tokenId) try { await foreground.cancel({ releaseTokenId: tokenId }) }
      catch (cleanup) { this.fail(cleanup, child); throw new ComputerActionCleanupError(error, [cleanup]) }
      else this.fail(error, child)
      throw error
    }
  }
  act(epoch: number, targetId: string, action: ComputerAction, signal?: AbortSignal, privateOptions?: { foregroundTicket: ForegroundActionTicket }) { return this.checked('act', { epoch, targetId, action, ...(privateOptions ? { foregroundTicket: privateOptions.foregroundTicket } : {}) }, signal) }
  openPreview(url: string, title: string, sessionId: string, signal?: AbortSignal) { return this.checked('openPreview', { url, title, sessionId }, signal) }
  closePreview(signal?: AbortSignal, options?: { preserveSession?: boolean }) { return this.checked('closePreview', options?.preserveSession ? { preserveSession: true } : {}, signal) }
  async dispose(): Promise<void> {
    if (this.disposed) { await this.retiring; return }
    this.disposed = true
    this.fail(new ComputerError('DISPOSED', '电脑操控执行器已停用'))
    this.listeners.clear()
    await this.retiring
  }
}
