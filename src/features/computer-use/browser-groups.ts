import { createServer, type ServerResponse } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { BROWSER_GROUP_EXTENSION_ID, BROWSER_GROUP_PORT } from './browser-group-identity.ts'

export interface BrowserTabIdentity { appId: string; title: string; window: { left: number; top: number; width: number; height: number } }
export interface BrowserGroupResult { status: 'grouped' | 'unavailable' | 'ambiguous' | 'unconfirmed'; title?: string; message?: string }
interface Command { id: string; operation: string; label: string; tab: BrowserTabIdentity; expiresAt: number }
interface Client { browser: string; seen: number; response?: ServerResponse }
interface Pending { command: Command; client: string; complete: (result: BrowserGroupResult) => void; timer: ReturnType<typeof setTimeout> }
const browsers: Record<string, string> = { 'com.google.Chrome': 'chrome', 'com.google.Chrome.canary': 'chrome', 'com.microsoft.edgemac': 'edge' }
export function browserGroupTitle(label: string): string { return '🤖 ' + Array.from(label.replace(/[\x00-\x1f\x7f]/gu, ' ').trim() || '电脑任务').slice(0, 28).join('') }
export function browserTabIdentity(value: unknown): BrowserTabIdentity | undefined {
  if (!value || typeof value !== 'object') return
  const tab = value as BrowserTabIdentity
  if (!browsers[tab.appId] || typeof tab.title !== 'string' || !tab.title || tab.title.length > 2048 || !tab.window) return
  if (!['left', 'top', 'width', 'height'].every(key => Number.isFinite(tab.window[key as keyof BrowserTabIdentity['window']]))) return
  if (tab.window.width <= 0 || tab.window.height <= 0) return
  return { appId: tab.appId, title: tab.title, window: { ...tab.window } }
}
/** Browser-native groups only. No page content, URLs, clipboard or OS input. */
export class BrowserTaskGroups {
  private readonly clients = new Map<string, Client>()
  private readonly pending = new Map<string, Pending>()
  private readonly server = createServer((request, response) => {
    const origin = request.headers.origin, identity = request.headers['x-qiuya-extension']
    if (identity !== BROWSER_GROUP_EXTENSION_ID || origin && origin !== `chrome-extension://${BROWSER_GROUP_EXTENSION_ID}`) { response.writeHead(403).end(); return }
    response.setHeader('Access-Control-Allow-Origin', `chrome-extension://${BROWSER_GROUP_EXTENSION_ID}`)
    response.setHeader('Cache-Control', 'no-store')
    const address = new URL(request.url ?? '/', 'http://127.0.0.1')
    const clientId = address.searchParams.get('client') ?? '', browser = address.searchParams.get('browser') ?? ''
    if (!/^[a-f0-9-]{36}$/u.test(clientId) || !['chrome', 'edge'].includes(browser)) { response.writeHead(400).end(); return }
    if (request.method === 'GET' && address.pathname === '/poll') {
      if (!this.clients.has(clientId) && this.clients.size >= 8) { response.writeHead(429).end(); return }
      this.clients.get(clientId)?.response?.end('{}')
      const client: Client = { browser, seen: Date.now(), response }; this.clients.set(clientId, client)
      response.setHeader('Content-Type', 'application/json'); response.flushHeaders()
      const ended = this.revocations.get(clientId)
      if (ended?.size) { this.revocations.delete(clientId); client.response = undefined; response.end(JSON.stringify({ kind: 'end', operations: [...ended] })); return }
      const command = [...this.pending.values()].find(row => row.client === clientId && !this.sent.has(row.command.id))
      if (command) { this.sent.add(command.command.id); this.send(client, command.command); return }
      const timer = setTimeout(() => { if (client.response === response) { client.response = undefined; response.end('{}') } }, 20_000); timer.unref()
      response.on('close', () => { clearTimeout(timer); if (client.response === response) client.response = undefined })
    } else if (request.method === 'POST' && address.pathname === '/reply') {
      let text = ''
      request.on('data', chunk => { text += chunk; if (text.length > 4096) request.destroy() })
      request.on('end', () => {
        try {
          const data = JSON.parse(text), entry = this.pending.get(data.id)
          if (entry?.client === clientId && ['grouped', 'ambiguous', 'unavailable', 'unconfirmed'].includes(data.status)) entry.complete({ status: data.status, title: entry.command.label, ...(data.status === 'grouped' ? {} : { message: '浏览器没有确认任务分组；请检查标签状态，勿重放已完成的页面操作。' }) })
          response.end('{}')
        } catch { response.writeHead(400).end() }
      })
    } else { response.writeHead(404).end() }
  })
  private readonly sent = new Set<string>()
  private readonly revocations = new Map<string, Set<string>>()
  private listening = false
  status() { const address = this.server.address(); return { listening: this.listening, connected: [...this.clients.values()].some(row => Date.now() - row.seen < 45_000), port: address && typeof address !== 'string' ? address.port : 0 } }
  constructor(port = BROWSER_GROUP_PORT) {
    this.server.on('error', () => { this.listening = false })
    this.server.listen(port, '127.0.0.1', () => { this.listening = true }); this.server.unref()
  }
  private send(client: Client, command: Command) { const response = client.response; client.response = undefined; response?.end(JSON.stringify(command)) }
  end(operationId: string) {
    const operation = createHash('sha256').update(operationId).digest('hex').slice(0, 24)
    for (const row of this.pending.values()) if (row.command.operation === operation) row.complete({ status: 'unconfirmed' })
    for (const [id, client] of this.clients) {
      const operations = this.revocations.get(id) ?? new Set<string>(); operations.add(operation)
      if (client.response) { const response = client.response; client.response = undefined; response.end(JSON.stringify({ kind: 'end', operations: [...operations] })); this.revocations.delete(id) }
      else this.revocations.set(id, operations)
    }
  }
  async group(value: unknown, operationId: string, label: string, signal?: AbortSignal): Promise<BrowserGroupResult | undefined> {
    const tab = browserTabIdentity(value)
    if (!tab) return
    const clients = [...this.clients].filter(([, row]) => row.browser === browsers[tab.appId] && Date.now() - row.seen < 45_000)
    if (!this.listening || !clients.length) return { status: 'unavailable', message: '未连接可选标签分组扩展。页面操作已完成，仅缺少标签组；可在操作环境面板下载配套扩展，不安装也能继续使用。' }
    if (clients.length !== 1) return { status: 'ambiguous', message: '连接了多个同类浏览器配置，无法唯一确定标签归属。页面操作已经完成。' }
    if (signal?.aborted || this.pending.size >= 64) return { status: 'unavailable' }
    const [clientId, client] = clients[0]
    const command: Command = { id: randomUUID(), operation: createHash('sha256').update(operationId).digest('hex').slice(0, 24), label: browserGroupTitle(label), tab, expiresAt: Date.now() + 4000 }
    return new Promise(resolve => {
      const complete = (result: BrowserGroupResult) => { const entry = this.pending.get(command.id); if (!entry) return; clearTimeout(entry.timer); this.pending.delete(command.id); this.sent.delete(command.id); signal?.removeEventListener('abort', abort); resolve(result) }
      const abort = () => complete({ status: 'unconfirmed', message: '任务分组已取消或结果未确认。' })
      const timer = setTimeout(() => complete({ status: 'unconfirmed', message: '任务分组结果未确认；勿重放已完成的页面操作。' }), 4000); timer.unref()
      this.pending.set(command.id, { command, client: clientId, complete, timer }); signal?.addEventListener('abort', abort, { once: true })
      if (client.response) { this.sent.add(command.id); this.send(client, command) }
    })
  }
  dispose() { for (const entry of this.pending.values()) entry.complete({ status: 'unavailable' }); for (const row of this.clients.values()) row.response?.end('{}'); this.clients.clear(); this.server.close() }
}
