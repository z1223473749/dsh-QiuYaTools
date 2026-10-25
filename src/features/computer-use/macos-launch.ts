import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { isAbsolute, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { ComputerError } from './contract.ts'

const BUNDLE_ID = 'com.qiuya.tools.computer-use'
const MAX_READY_BYTES = 4096
const MAX_MESSAGE_BYTES = 48 * 1024 * 1024
const MAX_QUEUED_BYTES = 4 * 1024 * 1024
const launches = new WeakMap<ChildProcessWithoutNullStreams, MacLaunch>()
interface LaunchOptions {
  /** Injectable launcher for transport tests; production always uses /usr/bin/open. */
  launch?: (command: string, args: string[]) => ChildProcessWithoutNullStreams
  launchTimeoutMs?: number
  retirementTimeoutMs?: number
}
interface NativeBirth { startSeconds: string; startMicroseconds: string; uniqueId: string }
function nativeBirth(value: unknown): value is NativeBirth {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const birth = value as Record<string, unknown>
  return typeof birth.startSeconds === 'string' && /^[1-9]\d{0,19}$/u.test(birth.startSeconds)
    && typeof birth.startMicroseconds === 'string' && /^(?:0|[1-9]\d{0,5})$/u.test(birth.startMicroseconds) && Number(birth.startMicroseconds) < 1_000_000
    && typeof birth.uniqueId === 'string' && /^[1-9]\d{0,19}$/u.test(birth.uniqueId)
}

/** LaunchServices owns the app's privacy identity; its JSONL channel remains private to this Host. */
class MacLaunch extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  pid: number | undefined
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  private readonly nonce = randomBytes(32).toString('hex')
  private server?: Server
  private socket?: Socket
  private launcher?: ChildProcessWithoutNullStreams
  private directory?: string
  private launchTimer?: ReturnType<typeof setTimeout>
  private retireTimer?: ReturnType<typeof setTimeout>
  private queued: Buffer[] = []
  private queuedBytes = 0
  private authenticated = false
  private eofRequested = false
  private socketEnded = false
  private launcherPassed = false
  private retiredReceipt = false
  private finished = false
  private failure?: ComputerError
  private retirement?: Promise<void>
  private resolveRetirement?: () => void
  private rejectRetirement?: (error: Error) => void

  constructor(private readonly appPath: string, private readonly options: LaunchOptions) {
    super()
    this.stdin.on('data', (chunk: Buffer) => {
      if (this.finished) return
      if (this.authenticated && this.socket && !this.eofRequested) { this.socket.write(chunk); return }
      this.queuedBytes += chunk.length
      if (this.queuedBytes > MAX_QUEUED_BYTES) { this.fail(new ComputerError('NATIVE_MESSAGE_LIMIT', '执行器启动队列超出限制。')); return }
      this.queued.push(Buffer.from(chunk))
    })
    this.stdin.once('end', () => this.requestEOF())
    this.stdin.on('error', error => this.fail(new ComputerError('NATIVE_PIPE_FAILED', error.message)))
    // Native stderr is deliberately not copied into Host logs.
    this.stderr.resume()
    void this.start().catch(error => this.fail(error instanceof ComputerError ? error : new ComputerError('NATIVE_UNAVAILABLE', '无法通过系统启动电脑操控执行器。')))
  }
  private async start(): Promise<void> {
    if (!isAbsolute(this.appPath) || !this.appPath.endsWith('/QiuYaTools Computer.app')) throw new ComputerError('NATIVE_UNAVAILABLE', '电脑操控应用路径无效。')
    // macOS's sockaddr_un is short; the usual per-user TMPDIR is often too long.
    this.directory = await mkdtemp(join(await realpath('/tmp'), 'qyt-cu-'))
    await chmod(this.directory, 0o700)
    if (this.finished) { await this.cleanup(); return }
    const socketPath = join(this.directory, 'control.sock')
    if (Buffer.byteLength(socketPath) > 103) throw new ComputerError('NATIVE_UNAVAILABLE', '电脑操控连接路径过长。')
    this.server = createServer({ allowHalfOpen: true }, socket => this.accept(socket))
    this.server.on('error', () => this.fail(new ComputerError('NATIVE_PIPE_FAILED', '无法建立电脑操控私有连接。')))
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(socketPath, () => { this.server!.off('error', reject); resolve() })
    })
    await chmod(socketPath, 0o600)
    if (this.finished) { await this.cleanup(); return }
    const args = ['-n', '-g', '-W', '-a', this.appPath, '--args', '--qiuya-control-socket', socketPath,
      '--qiuya-control-nonce', this.nonce, '--qiuya-owner-pid', String(process.pid)]
    this.launchTimer = setTimeout(() => this.fail(new ComputerError('NATIVE_LAUNCH_TIMEOUT', '电脑操控应用未确认启动。')), this.options.launchTimeoutMs ?? 15_000)
    this.launcher = (this.options.launch ?? ((command, value) => spawn(command, value, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })) )('/usr/bin/open', args)
    this.launcher.stdin.end(); this.launcher.stdout.resume(); this.launcher.stderr.resume()
    this.launcher.once('error', () => this.fail(new ComputerError('NATIVE_UNAVAILABLE', '系统未能启动电脑操控应用。')))
    this.launcher.once('exit', (code, signal) => {
      if (this.finished) return
      if (code !== 0 || signal !== null) { this.fail(new ComputerError('NATIVE_CLEANUP_FAILED', '系统未确认电脑操控应用正常退出。')); return }
      this.launcherPassed = true
      // open -W exiting is never, by itself, evidence that native input retired.
      this.finishIfConfirmed()
    })
  }
  private accept(socket: Socket): void {
    if (this.finished || this.socket) { socket.destroy(); return }
    this.socket = socket
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      if (this.finished) return
      buffer += chunk
      if (Buffer.byteLength(buffer) > (this.authenticated ? MAX_MESSAGE_BYTES : MAX_READY_BYTES)) { this.fail(new ComputerError('NATIVE_PROTOCOL', '电脑操控连接响应无效。')); return }
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0 && !this.finished) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        this.line(line)
      }
    })
    socket.once('error', () => this.fail(new ComputerError('NATIVE_PIPE_FAILED', '电脑操控私有连接已中断。')))
    socket.once('end', () => {
      this.socketEnded = true
      if (buffer.trim() || !this.authenticated || !this.retiredReceipt) { this.fail(new ComputerError('NATIVE_CLEANUP_FAILED', '执行器未确认输入与画面已清理。')); return }
      socket.end(); this.finishIfConfirmed()
    })
    socket.once('close', () => {
      if (!this.finished && !this.socketEnded) this.fail(new ComputerError('NATIVE_CLEANUP_FAILED', '执行器连接退出状态未确认。'))
    })
  }
  private line(line: string): void {
    let record: Record<string, unknown>
    try { record = JSON.parse(line) } catch { this.fail(new ComputerError('NATIVE_PROTOCOL', '电脑操控连接返回了无效 JSON。')); return }
    if (!record || typeof record !== 'object' || Array.isArray(record)) { this.fail(new ComputerError('NATIVE_PROTOCOL', '电脑操控连接回执无效。')); return }
    if (!this.authenticated) {
      if (record.event !== 'launchReady' || record.nonce !== this.nonce || record.bundleIdentifier !== BUNDLE_ID || record.ownerPid !== process.pid
        || !Number.isSafeInteger(record.pid) || Number(record.pid) <= 1 || Number(record.pid) > 2_147_483_647 || record.pid === process.pid || !nativeBirth(record.nativeBirth)) {
        this.fail(new ComputerError('NATIVE_PROTOCOL', '电脑操控应用身份未通过验证。')); return
      }
      this.pid = record.pid as number; this.authenticated = true; clearTimeout(this.launchTimer)
      this.server?.close()
      const queued = this.queued; this.queued = []; this.queuedBytes = 0
      if (!this.eofRequested) for (const chunk of queued) this.socket!.write(chunk)
      if (this.eofRequested) this.socket!.end()
      return
    }
    if (record.event === 'launchReady') { this.fail(new ComputerError('NATIVE_PROTOCOL', '电脑操控应用重复发送启动回执。')); return }
    if (record.event === 'launchRetired') {
      if (this.retiredReceipt || record.nonce !== this.nonce || record.pid !== this.pid || record.ownerPid !== process.pid || record.inputReleased !== true || record.captureStopped !== true) {
        this.fail(new ComputerError('NATIVE_CLEANUP_FAILED', '执行器未确认输入与画面已清理。')); return
      }
      this.retiredReceipt = true; this.finishIfConfirmed(); return
    }
    if (this.retiredReceipt) { this.fail(new ComputerError('NATIVE_PROTOCOL', '执行器清理后仍返回操作数据。')); return }
    this.stdout.write(line + '\n')
  }
  private requestEOF(): void {
    if (this.eofRequested || this.finished) return
    this.eofRequested = true
    this.queued = []; this.queuedBytes = 0
    // Ending only this authenticated channel asks the app to revoke and release.
    // Never signal a numeric PID: it may have exited and been reused meanwhile.
    if (this.authenticated) this.socket?.end()
    this.retireTimer = setTimeout(() => this.fail(new ComputerError('NATIVE_CLEANUP_FAILED', '执行器未确认退出，已阻止新的电脑输入。')), this.options.retirementTimeoutMs ?? 8_000)
  }
  private finishIfConfirmed(): void {
    if (this.finished || !this.authenticated || !this.retiredReceipt || !this.socketEnded || !this.launcherPassed) return
    this.finished = true; clearTimeout(this.launchTimer); clearTimeout(this.retireTimer)
    this.exitCode = 0
    this.stdout.end(); this.stderr.end()
    this.resolveRetirement?.()
    this.emit('exit', 0, null); this.emit('close', 0, null)
    void this.cleanup()
  }
  private fail(error: ComputerError): void {
    if (this.finished) return
    this.finished = true; this.failure = error
    clearTimeout(this.launchTimer); clearTimeout(this.retireTimer)
    this.queued = []; this.queuedBytes = 0
    // The app's EOF/owner watchdog owns cleanup. An unconfirmed app is never
    // represented as dead merely because its launcher or socket disappeared.
    this.socket?.end(); this.socket?.destroy()
    this.stdout.end(); this.stderr.end()
    this.rejectRetirement?.(new ComputerError('NATIVE_CLEANUP_FAILED', '执行器退出状态未确认，已阻止新的电脑输入。'))
    this.emit('error', error)
    void this.cleanup()
  }
  private async cleanup(): Promise<void> {
    if (this.server?.listening) this.server.close()
    if (this.directory) await rm(this.directory, { recursive: true, force: true }).catch(() => {})
  }
  kill(_signal?: NodeJS.Signals | number): boolean { this.requestEOF(); this.stdin.end(); return true }
  retire(): Promise<void> {
    if (!this.retirement) {
      this.retirement = this.failure ? Promise.reject(new ComputerError('NATIVE_CLEANUP_FAILED', '执行器退出状态未确认，已阻止新的电脑输入。')) : this.exitCode === 0 ? Promise.resolve() : new Promise<void>((resolve, reject) => { this.resolveRetirement = resolve; this.rejectRetirement = reject })
      void this.retirement.catch(() => {})
      this.requestEOF(); this.stdin.end()
    }
    return this.retirement
  }
}

export function launchMacCompanion(appPath: string, options: LaunchOptions = {}): ChildProcessWithoutNullStreams {
  const launch = new MacLaunch(appPath, options)
  const child = launch as unknown as ChildProcessWithoutNullStreams
  launches.set(child, launch)
  return child
}
/** Undefined means the original spawned-child retirement contract still applies. */
export function retireMacCompanion(child: ChildProcessWithoutNullStreams): Promise<void> | undefined { return launches.get(child)?.retire() }
