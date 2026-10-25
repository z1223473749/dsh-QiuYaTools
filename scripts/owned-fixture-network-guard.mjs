/** Isolated-test HTTP egress guard. It cannot open tunnels or forward arbitrary origins. */
import { createServer, request as upstreamRequest } from 'node:http'

const VARIANTS = ['default', 'orders', 'browser']
const MAX_HEADER_BYTES = 8192
const MAX_HEADER_COUNT = 32
const UPSTREAM_TIMEOUT_MS = 5000

export async function createOwnedFixtureProxy({ fixtureOrigin, fixturePath } = {}) {
  if (typeof fixtureOrigin !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(fixtureOrigin)) throw new Error('INVALID_OWNED_FIXTURE')
  const origin = new URL(fixtureOrigin)
  if (origin.origin !== fixtureOrigin || Number(origin.port) > 65535 || !origin.port) throw new Error('INVALID_OWNED_FIXTURE')
  if (typeof fixturePath !== 'string' || !fixturePath.startsWith('/') || /[%\\\s?#]/u.test(fixturePath) || new URL(fixturePath, origin).origin !== fixtureOrigin || new URL(fixturePath, origin).pathname !== fixturePath) throw new Error('INVALID_OWNED_FIXTURE')

  const authority = origin.host
  const allowed = new Map(VARIANTS.map(variant => [`${fixtureOrigin}${fixturePath}?task=${variant}`, variant]))
  const counts = { allowed: 0, denied: 0, variants: { default: 0, orders: 0, browser: 0 } }
  const sockets = new Set(), requests = new Set()
  let closed = false
  const deny = response => {
    counts.denied++
    response.writeHead(403, { 'content-length': '0', connection: 'close', 'cache-control': 'no-store' })
    response.end()
  }
  const denySocket = socket => {
    counts.denied++
    if (!socket.destroyed) socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
  }

  const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES, requireHostHeader: false, headersTimeout: 5000, requestTimeout: 5000, connectionsCheckingInterval: 1000 }, (request, response) => {
    const variant = allowed.get(request.url)
    const hostHeaders = request.rawHeaders.filter((_value, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === 'host').length
    if (closed || !variant || !['GET', 'HEAD'].includes(request.method) || request.headers.host !== authority || hostHeaders !== 1 || request.rawHeaders.length / 2 > MAX_HEADER_COUNT || ['content-length', 'transfer-encoding', 'expect', 'upgrade', 'proxy-authorization'].some(name => request.headers[name] !== undefined)) {
      deny(response)
      return
    }

    let hasBody = false
    request.on('data', () => { hasBody = true })
    request.once('end', () => {
      if (closed || hasBody) { deny(response); return }
      counts.allowed++
      counts.variants[variant]++
      // Construct the entire destination and headers ourselves. No caller URL,
      // Cookie, Authorization, Proxy-* header or request body is forwarded.
      const outbound = upstreamRequest({ protocol: 'http:', hostname: '127.0.0.1', port: Number(origin.port), path: `${fixturePath}?task=${variant}`, method: request.method, headers: { host: authority }, agent: false, timeout: UPSTREAM_TIMEOUT_MS, maxHeaderSize: MAX_HEADER_BYTES }, incoming => {
        if (closed || response.destroyed) { incoming.destroy(); return }
        const headers = { 'cache-control': 'no-store', connection: 'close' }
        if (typeof incoming.headers['content-type'] === 'string') headers['content-type'] = incoming.headers['content-type']
        if (typeof incoming.headers['content-length'] === 'string') headers['content-length'] = incoming.headers['content-length']
        if (typeof incoming.headers['content-security-policy'] === 'string' && incoming.headers['content-security-policy'].length <= MAX_HEADER_BYTES) headers['content-security-policy'] = incoming.headers['content-security-policy']
        response.writeHead(incoming.statusCode ?? 502, headers)
        incoming.once('error', () => response.destroy())
        incoming.pipe(response)
      })
      requests.add(outbound)
      const deadline = setTimeout(() => outbound.destroy(new Error('OWNED_FIXTURE_TIMEOUT')), UPSTREAM_TIMEOUT_MS)
      deadline.unref()
      outbound.once('close', () => { clearTimeout(deadline); requests.delete(outbound) })
      outbound.once('timeout', () => outbound.destroy(new Error('OWNED_FIXTURE_TIMEOUT')))
      outbound.once('error', () => {
        if (response.headersSent) response.destroy()
        else if (!response.destroyed) { response.writeHead(502, { 'content-length': '0', connection: 'close' }); response.end() }
      })
      response.once('close', () => outbound.destroy())
      outbound.end()
    })
    request.once('error', () => { if (!response.destroyed) response.destroy() })
  })
  server.maxHeadersCount = MAX_HEADER_COUNT + 1
  server.keepAliveTimeout = 1000
  server.maxRequestsPerSocket = 64
  server.on('connection', socket => {
    sockets.add(socket)
    socket.setTimeout(6000, () => socket.destroy())
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('connect', (_request, socket) => denySocket(socket))
  server.on('upgrade', (_request, socket) => denySocket(socket))
  server.on('checkContinue', (_request, response) => deny(response))
  server.on('checkExpectation', (_request, response) => deny(response))
  server.on('clientError', (_error, socket) => denySocket(socket))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const endpoint = `http://127.0.0.1:${server.address().port}`
  let closing
  return {
    endpoint,
    snapshot: () => ({ allowed: counts.allowed, denied: counts.denied, variants: { ...counts.variants }, closed }),
    close() {
      if (closing) return closing
      closed = true
      closing = new Promise(resolve => {
        server.close(resolve)
        for (const outbound of requests) outbound.destroy()
        for (const socket of sockets) socket.destroy()
        server.closeAllConnections()
      })
      return closing
    },
  }
}
