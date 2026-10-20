import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ComputerError } from './contract.ts'
import type { ComputerAction, ComputerObservation, ComputerStatus, DeviceDriver, NativeComputerEvent, NativeTarget } from './contract.ts'

export interface NativeCompanionOptions { executable?: string; args?: string[]; timeoutMs?: number; maxMessageBytes?: number; releaseInputArgs?: string[] }
export function computerCompanionPath(platform: NodeJS.Platform = process.platform, architecture: string = process.arch, base = new URL('./', import.meta.url)): string {
  if (platform === 'darwin') return fileURLToPath(new URL('./QiuYaTools Computer.app/Contents/MacOS/qiuya-computer', base))
  if (platform === 'win32' && ['arm64', 'x64'].includes(architecture)) return fileURLToPath(new URL(`./native/win32-${architecture}/qiuya-windows.exe`, base))
  throw new ComputerError('PLATFORM_UNSUPPORTED', '此系统暂无电脑操控执行器')
}
interface Pending { resolve: (value: unknown) => void; reject: (error: unknown) => void; clean: () => void }
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
  private protocol?: Promise<ComputerStatus>
  private retiring: Promise<void> = Promise.resolve()
  private held: NativeHeldInputs = { keys: [], mouseButtons: [] }
  constructor(private readonly options: NativeCompanionOptions = {}) {}
  static defaultPath = computerCompanionPath
  subscribe(listener: (event: NativeComputerEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit(event: NativeComputerEvent): void { for (const listener of this.listeners) { try { listener(event) } catch {} } }
  private fail(error: unknown, child = this.child): void {
    if (child && this.child !== child) return
    const held = this.held; this.held = { keys: [], mouseButtons: [] }
    this.child = undefined; this.buffer = ''; this.protocol = undefined
    if (child) { this.retiring = this.retire(child, held); void this.retiring.catch(() => {}) }
    for (const entry of this.pending.values()) { entry.clean(); entry.reject(error) }
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
    this.child = child
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
          else this.emit(message as NativeComputerEvent)
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
  private async rpc<T>(op: string, payload: object = {}, signal?: AbortSignal): Promise<T> {
    await this.retiring
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (this.pending.size >= 128) return Promise.reject(new ComputerError('QUEUE_FULL', '执行器请求过多'))
    let child: ChildProcessWithoutNullStreams
    try { child = this.start() } catch (error) { return Promise.reject(error) }
    return new Promise<T>((resolve, reject) => {
      const requestId = ++this.nextRequestId
      const timer = setTimeout(() => {
        // A timed-out mutating native request has unknown outcome. Kill the worker;
        // reconnecting requires a fresh service lease and observation.
        this.fail(new ComputerError('NATIVE_TIMEOUT', '原生操作超时，执行器已停止'), child)
      }, this.options.timeoutMs ?? 20_000)
      const abort = () => { const entry = this.pending.get(requestId); if (!entry) return; this.pending.delete(requestId); entry.clean(); reject(signal?.reason ?? new ComputerError('ABORTED', '操作已取消')) }
      const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
      this.pending.set(requestId, { resolve: value => resolve(value as T), reject, clean })
      signal?.addEventListener('abort', abort, { once: true })
      // Close the aborted-between-check-and-listener race before writing input.
      if (signal?.aborted) { abort(); return }
      child.stdin.write(`${JSON.stringify({ requestId, op, ...payload })}\n`, error => { if (error) this.fail(new ComputerError('NATIVE_PIPE_FAILED', error.message), child) })
    })
  }
  private compatible(): Promise<ComputerStatus> {
    if (this.disposed) return Promise.reject(new ComputerError('DISPOSED', '电脑操控执行器已停用'))
    if (!this.protocol) this.protocol = this.rpc<ComputerStatus>('status').then(status => {
      if (status?.protocolVersion !== 1) throw new ComputerError('NATIVE_PROTOCOL_VERSION', '执行器协议版本不匹配，请重新安装对应版本的插件。')
      return status
    })
    return this.protocol
  }
  private async checked<T>(op: string, payload: object = {}, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    await this.compatible()
    signal?.throwIfAborted()
    return this.rpc<T>(op, payload, signal)
  }
  async status(signal?: AbortSignal): Promise<ComputerStatus> {
    try { signal?.throwIfAborted(); await this.compatible(); return await this.rpc<ComputerStatus>('status', {}, signal) }
    catch (error) { if (signal?.aborted) throw error; return { available: false, platform: process.platform, message: error instanceof Error ? error.message : '执行器不可用' } }
  }
  async targets(signal?: AbortSignal): Promise<NativeTarget[]> {
    const result = await this.checked<NativeTarget[] | { targets: NativeTarget[] }>('targets', {}, signal)
    const targets = Array.isArray(result) ? result : result?.targets
    if (!Array.isArray(targets)) throw new ComputerError('NATIVE_PROTOCOL', '执行器返回的窗口列表无效')
    return targets
  }
  observe(targetId: string, signal?: AbortSignal) { return this.checked<ComputerObservation>('observe', { targetId }, signal) }
  preview(targetId: string, signal?: AbortSignal) { return this.checked<ComputerObservation>('observe', { targetId, preview: true }, signal) }
  lease(epoch: number, signal?: AbortSignal) { return this.checked('lease', { epoch }, signal) }
  release(epoch: number, signal?: AbortSignal) { return this.rpc('release', { epoch }, signal) }
  act(epoch: number, targetId: string, action: ComputerAction, signal?: AbortSignal) { return this.checked('act', { epoch, targetId, action }, signal) }
  openPreview(url: string, title: string, sessionId: string, signal?: AbortSignal) { return this.checked('openPreview', { url, title, sessionId }, signal) }
  closePreview(signal?: AbortSignal) { return this.checked('closePreview', {}, signal) }
  async dispose(): Promise<void> {
    if (this.disposed) { await this.retiring; return }
    this.disposed = true
    this.fail(new ComputerError('DISPOSED', '电脑操控执行器已停用'))
    this.listeners.clear()
    await this.retiring
  }
}
