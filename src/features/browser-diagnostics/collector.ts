import { createHash } from 'node:crypto'
import { DIAGNOSTICS_LIMITS } from './contract.ts'
import type { DiagnosticEntry, DiagnosticEvent, DiagnosticAssociation } from './contract.ts'
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : undefined
const errorClass = (v: unknown) => typeof v === 'string' && /^(TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError|AggregateError|Error)(:|$)/u.test(v) ? v.split(':', 1)[0]! : 'Error'
const argumentType = (v: unknown) => { const a = object(v), type = a.type; return typeof type === 'string' && ['object', 'function', 'undefined', 'string', 'number', 'boolean', 'symbol', 'bigint'].includes(type) ? type : 'unknown' }
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE'])
const failures = new Set(['net::ERR_FAILED', 'net::ERR_ABORTED', 'net::ERR_TIMED_OUT', 'net::ERR_CONNECTION_REFUSED', 'net::ERR_NAME_NOT_RESOLVED', 'net::ERR_INTERNET_DISCONNECTED', 'net::ERR_CONNECTION_RESET', 'net::ERR_CERT_AUTHORITY_INVALID'])
/** Retains no raw message/object/body/header/URL. Text hashes are intentionally absent too. */
export class DiagnosticCollector {
  private rows: DiagnosticEntry[] = []; private next = 0; private bytes = 2; private lost = 0
  private readonly requests = new Map<string, { at: number | undefined; method: string; pathHash: string; status?: number }>()
  private closed = false
  private readonly since: number
  constructor(readonly origin: string, readonly association?: () => DiagnosticAssociation | undefined, private readonly clock = Date.now) { this.since = clock() }
  get dropped() { return this.lost }
  private push(value: Omit<DiagnosticEntry, 'sequence' | 'at' | 'association'>) {
    if (this.closed) return
    const association = this.association?.(), row: DiagnosticEntry = { ...value, sequence: ++this.next, at: this.clock(), ...(association ? { association: { ...association } } : {}) }, size = Buffer.byteLength(JSON.stringify(row)) + 1
    if (size > DIAGNOSTICS_LIMITS.bytes) { this.lost++; return }
    while (this.rows.length && (this.rows.length >= DIAGNOSTICS_LIMITS.entries || this.bytes + size > DIAGNOSTICS_LIMITS.bytes)) { this.bytes -= Buffer.byteLength(JSON.stringify(this.rows.shift()!)) + 1; this.lost++ }
    this.rows.push(row); this.bytes += size
  }
  ingest(event: DiagnosticEvent) {
    if (this.closed) return
    const p = object(event.params)
    if (event.method === 'Runtime.consoleAPICalled' || event.method === 'Runtime.exceptionThrown') { const timestamp = number(p.timestamp); if (timestamp === undefined || timestamp < this.since) { this.lost++; return } }
    if (event.method === 'Runtime.consoleAPICalled') {
      const types = Array.isArray(p.args) ? p.args.slice(0, 16).map(argumentType) : []
      const level = typeof p.type === 'string' && ['error', 'warning', 'warn', 'log', 'info', 'debug', 'assert', 'trace'].includes(p.type) ? p.type : 'other'
      this.push({ kind: 'console', level, summary: '控制台输出（已省略原始文本与对象）', argumentTypes: types, count: Array.isArray(p.args) ? Math.min(p.args.length, 100000) : 0 }); return
    }
    if (event.method === 'Runtime.exceptionThrown') {
      const d = object(p.exceptionDetails), x = object(d.exception)
      this.push({ kind: 'exception', level: 'error', summary: '未捕获异常（已省略原始文本与堆栈）', errorClass: errorClass(x.className ?? x.description ?? d.text) }); return
    }
    const id = typeof p.requestId === 'string' && p.requestId.length <= 256 ? p.requestId : undefined
    if (!id) return
    if (event.method === 'Network.requestWillBeSent') {
      const request = object(p.request), wallTime = number(p.wallTime); if (wallTime === undefined || wallTime * 1000 < this.since) { this.lost++; return }; let url: URL
      try { if (typeof request.url !== 'string' || request.url.length > 8192) return; url = new URL(request.url) } catch { return }
      if (url.origin !== this.origin || url.username || url.password) { this.lost++; this.requests.delete(id); return }
      if (this.requests.size >= DIAGNOSTICS_LIMITS.requests && !this.requests.has(id)) { this.lost++; return }
      // Cross-document redirects never reuse a prior request's content association.
      if (this.requests.has(id)) { this.requests.delete(id); this.lost++ }
      this.requests.set(id, { at: number(p.timestamp), method: typeof request.method === 'string' && methods.has(request.method) ? request.method : 'OTHER', pathHash: createHash('sha256').update(url.pathname).digest('hex').slice(0, 16) }); return
    }
    const request = this.requests.get(id); if (!request) return
    if (event.method === 'Network.responseReceived') {
      const response = object(p.response), status = number(response.status)
      // A response which changes origin is excluded even when request id is recycled.
      try { if (typeof response.url !== 'string' || new URL(response.url).origin !== this.origin) { this.requests.delete(id); this.lost++; return } } catch { this.requests.delete(id); this.lost++; return }
      if (status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599) request.status = status
    } else if (event.method === 'Network.loadingFinished' || event.method === 'Network.loadingFailed') {
      this.requests.delete(id); const at = number(p.timestamp), elapsed = at === undefined || request.at === undefined || at < request.at ? undefined : Math.min(Math.round((at - request.at) * 1000), 86400000)
      const failed = event.method.endsWith('Failed'), failure = failed ? p.canceled === true ? 'cancelled' : typeof p.errorText === 'string' && failures.has(p.errorText) ? p.errorText : 'request-failed' : undefined
      this.push({ kind: 'network', level: failed || (request.status ?? 0) >= 400 ? 'error' : 'info', summary: failed ? '同源请求失败' : '同源请求完成', method: request.method, pathHash: request.pathHash, ...(request.status === undefined ? {} : { status: request.status }), ...(elapsed === undefined ? {} : { durationMs: elapsed }), ...(failure ? { failure } : {}) })
    }
  }
  snapshot(filter: 'all' | 'errors' | 'network' = 'all'): DiagnosticEntry[] { return structuredClone(this.rows.filter(row => filter === 'all' || (filter === 'network' ? row.kind === 'network' : row.level === 'error'))) }
  stop() { this.closed = true; this.requests.clear() }
  clear() { this.stop(); this.rows = []; this.bytes = 2 }
}
