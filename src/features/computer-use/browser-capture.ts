import { ComputerError } from './contract.ts'

interface CaptureEvent { method: string; sessionId?: string; params?: Record<string, unknown> }
interface CaptureWire {
  send<T = Record<string, unknown>>(method: string, params: object, sessionId: string): Promise<T>
  subscribe(listener: (event: CaptureEvent) => void): () => void
}
interface Stream {
  sessionId: string; users: number; ready: Promise<unknown>; closing?: Promise<void>
  remove(): void; acks: Set<Promise<void>>; fault?: ComputerError; ackFailure?: unknown
}
const cleanupFailed = () => new ComputerError('BROWSER_CLEANUP_FAILED', '浏览器截图流的退出尚未确认，请先结束这个浏览器环境。')
const changed = () => new ComputerError('CONTROL_CHANGED', '浏览器截图所属的会话已经结束。')
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const clean = () => signal.removeEventListener('abort', abort)
    const abort = () => { clean(); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { clean(); resolve(value) }, error => { clean(); reject(error) })
    if (signal.aborted) abort()
  })
}

/** A bounded, short read stream keeps Chromium's exact background surface live.
 * Its tiny frames are ACKed and discarded; callers receive their own original
 * captureScreenshot response, with its original parameters and wire deadline.
 */
export class BrowserCaptureStreams {
  private readonly streams = new Map<string, Stream>()
  private readonly operations = new Map<Promise<unknown>, string>()
  private readonly retiring = new Set<string>()
  private closed = false
  private disconnected = false
  constructor(private readonly wire: CaptureWire) {}
  private available(sessionId: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    if (this.closed || this.retiring.has(sessionId)) throw changed()
  }
  private create(sessionId: string): Stream {
    if (this.streams.size >= 16) throw new ComputerError('BROWSER_QUEUE_FULL', '同时读取的浏览器画面过多。')
    const stream: Stream = { sessionId, users: 0, ready: Promise.resolve(), remove: () => {}, acks: new Set() }
    this.streams.set(sessionId, stream)
    stream.remove = this.wire.subscribe(event => {
      if (this.disconnected || event.method !== 'Page.screencastFrame' || event.sessionId !== sessionId) return
      const frame = event.params?.sessionId
      if (!Number.isSafeInteger(frame) || Number(frame) < 0 || stream.acks.size >= 8) { stream.ackFailure ??= new ComputerError('BROWSER_CDP_FAILED', '浏览器截图帧回执无效。'); return }
      const ack = this.wire.send('Page.screencastFrameAck', { sessionId: frame }, sessionId).then(() => {}, error => {
        stream.ackFailure ??= error
        // A CDP error is a real negative receipt. A missing receipt must remain
        // quarantined even if another cleanup command happens to succeed.
        if (!(error instanceof ComputerError) || error.code !== 'BROWSER_CDP_FAILED') stream.fault ??= cleanupFailed()
      }).finally(() => stream.acks.delete(ack))
      stream.acks.add(ack)
    })
    // Once issued, a shared acquisition must reach its real ACK/deadline even
    // when one renderer cancels. A different caller may already own this slot.
    stream.ready = this.wire.send('Page.startScreencast', { format: 'jpeg', quality: 1, maxWidth: 16, maxHeight: 16, everyNthFrame: 1 }, sessionId)
    void stream.ready.catch(() => {})
    return stream
  }
  private async release(stream: Stream): Promise<void> {
    stream.users--
    if (stream.users > 0) {
      await Promise.all([...stream.acks])
      if (stream.fault) throw stream.fault
      if (stream.ackFailure) throw stream.ackFailure
      return
    }
    stream.closing = (async () => {
      await stream.ready.catch(() => {})
      try {
        if (this.disconnected) throw cleanupFailed()
        await this.wire.send('Page.stopScreencast', {}, stream.sessionId)
      } catch { stream.fault ??= cleanupFailed() }
      finally { stream.remove(); await Promise.all([...stream.acks]) }
      if (stream.fault) throw stream.fault
      if (this.streams.get(stream.sessionId) === stream) this.streams.delete(stream.sessionId)
      if (stream.ackFailure) throw stream.ackFailure
    })()
    await stream.closing
  }
  private async run<T>(sessionId: string, parameters: object, signal?: AbortSignal): Promise<T> {
    let stream: Stream
    for (;;) {
      this.available(sessionId, signal)
      const current = this.streams.get(sessionId)
      if (current?.fault) throw current.fault
      if (current?.closing) { await abortable(current.closing, signal); continue }
      stream = current ?? this.create(sessionId); stream.users++; break
    }
    let value: T | undefined, failure: unknown, cleanup: unknown, failed = false, cleanupRejected = false
    try {
      await abortable(stream.ready, signal)
      this.available(sessionId, signal)
      if (stream.fault) throw stream.fault
      if (stream.ackFailure) throw stream.ackFailure
      // The caller may reject immediately on abort, but this exact original
      // command stays alive until its real ACK or original wire deadline.
      value = await this.wire.send<T>('Page.captureScreenshot', parameters, sessionId)
      signal?.throwIfAborted()
      if (stream.fault) throw stream.fault
      if (stream.ackFailure) throw stream.ackFailure
    } catch (error) { failure = error; failed = true }
    try { await this.release(stream) } catch (error) { cleanup = error; cleanupRejected = true }
    if (failed) throw failure
    if (cleanupRejected) throw cleanup
    return value!
  }
  capture<T>(sessionId: string, parameters: object, signal?: AbortSignal): Promise<T> {
    try {
      this.available(sessionId, signal)
      if (this.operations.size >= 128) throw new ComputerError('BROWSER_QUEUE_FULL', '浏览器截图请求过多。')
      // Match the original transport's JSON value before an asynchronous shared
      // start can let a caller mutate its parameter object.
      const params = JSON.parse(JSON.stringify(parameters)) as object
      const operation = this.run<T>(sessionId, params, signal)
      this.operations.set(operation, sessionId)
      void operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation))
      return abortable(operation, signal)
    } catch (error) { return Promise.reject(error) }
  }
  /** Detach cannot overtake a canceled annotation's still-issued screenshot. */
  async retireSession<T>(sessionId: string, detached: () => Promise<T>): Promise<T> {
    if (this.retiring.has(sessionId)) throw changed()
    this.retiring.add(sessionId)
    try {
      await Promise.allSettled([...this.operations].filter(([, id]) => id === sessionId).map(([job]) => job))
      const stream = this.streams.get(sessionId)
      if (stream?.closing) await stream.closing
      if (stream) throw stream.fault ?? cleanupFailed()
      return await detached()
    } finally { this.retiring.delete(sessionId) }
  }
  /** Input release is a separate raw channel and must precede owner disposal. */
  async drain(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.operations.keys()])
    await Promise.allSettled([...this.streams.values()].flatMap(stream => stream.closing ? [stream.closing] : []))
    if (this.streams.size) throw cleanupFailed()
  }
  disconnect(): void {
    this.closed = true; this.disconnected = true
    for (const stream of this.streams.values()) { stream.fault ??= cleanupFailed(); stream.remove() }
    // These streams belonged to this now-retired transport. Active jobs still
    // reject/drain their original receipts; none can address a new connection.
    this.streams.clear()
  }
}
