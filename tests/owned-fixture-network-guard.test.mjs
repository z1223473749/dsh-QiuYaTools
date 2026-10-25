import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { connect } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { createOwnedFixtureProxy } from '../scripts/owned-fixture-network-guard.mjs'

async function fixture(t) {
  const hits = [], sockets = new Set()
  let hold = false
  const server = createServer((q, s) => {
    hits.push({ method: q.method, url: q.url, headers: q.headers })
    if (hold) return
    s.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'FIXTURE_COOKIE=PRIVATE', 'x-fixture-secret': 'PRIVATE_RESPONSE_HEADER', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; connect-src 'none'" })
    s.end(q.method === 'HEAD' ? undefined : 'OWNED_FIXTURE_BODY')
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { for (const socket of sockets) socket.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  return { origin: `http://127.0.0.1:${server.address().port}`, hits, hold: () => { hold = true } }
}
async function setup(t) {
  const owned = await fixture(t), trap = await fixture(t), path = '/owned-fixture.html'
  const guard = await createOwnedFixtureProxy({ fixtureOrigin: owned.origin, fixturePath: path })
  t.after(() => guard.close())
  const uri = variant => `${owned.origin}${path}?task=${variant}`
  return { owned, trap, guard, path, uri }
}
function via(guard, uri, { method = 'GET', host = new URL(uri).host, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = request(guard.endpoint, { method, path: uri, headers: { host, ...headers }, agent: false }, incoming => {
      const chunks = []
      incoming.on('data', chunk => chunks.push(chunk))
      incoming.once('error', reject)
      incoming.once('end', () => resolve({ status: incoming.statusCode, headers: incoming.headers, body: Buffer.concat(chunks).toString() }))
    })
    outgoing.once('error', reject)
    outgoing.end(body)
  })
}
async function raw(guard, bytes) {
  return new Promise((resolve, reject) => {
    const socket = connect(Number(new URL(guard.endpoint).port), '127.0.0.1'), chunks = []
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('FIXTURE_TIMEOUT')) })
    socket.once('connect', () => socket.write(bytes))
    socket.on('data', chunk => chunks.push(chunk))
    socket.once('error', reject)
    socket.once('close', () => resolve(Buffer.concat(chunks).toString()))
  })
}

test('only six fixed GET/HEAD routes reach the existing fixture and original headers are never forwarded', async t => {
  const { owned, guard, uri } = await setup(t)
  for (const variant of ['default', 'orders', 'browser']) {
    for (const method of ['GET', 'HEAD']) {
      const result = await via(guard, uri(variant), { method, headers: { cookie: 'PRIVATE_COOKIE', authorization: 'Bearer PRIVATE_TOKEN', 'x-private': 'PRIVATE_HEADER', 'proxy-connection': 'keep-alive' } })
      assert.equal(result.status, 200)
      assert.equal(result.body, method === 'HEAD' ? '' : 'OWNED_FIXTURE_BODY')
      assert.equal(result.headers['content-security-policy'], "default-src 'none'; style-src 'unsafe-inline'; connect-src 'none'")
      assert.equal(result.headers['set-cookie'], undefined)
      assert.equal(result.headers['x-fixture-secret'], undefined)
    }
  }
  assert.equal(owned.hits.length, 6)
  for (const hit of owned.hits) assert.deepEqual(Object.keys(hit.headers).sort(), ['connection', 'host'])
  assert.deepEqual(guard.snapshot(), { allowed: 6, denied: 0, variants: { default: 2, orders: 2, browser: 2 }, closed: false })
  assert.equal(JSON.stringify(guard.snapshot()).includes('PRIVATE'), false)
})

test('different origins, encoded hostnames, credentials, paths and every unknown query are rejected without contacting a trap', async t => {
  const { owned, trap, guard, path, uri } = await setup(t)
  const port = new URL(owned.origin).port
  const attacks = [
    `${trap.origin}${path}?task=default`,
    `http://localhost:${port}${path}?task=default`,
    `http://%31%32%37.0.0.1:${port}${path}?task=default`,
    `http://127.1:${port}${path}?task=default`,
    `http://2130706433:${port}${path}?task=default`,
    `http://user:PRIVATE@127.0.0.1:${port}${path}?task=default`,
    `https://127.0.0.1:${port}${path}?task=default`,
    `${owned.origin}/other.html?task=default`,
    `${owned.origin}/x/../owned-fixture.html?task=default`,
    `${owned.origin}/%6fwned-fixture.html?task=default`,
    `${owned.origin}${path}`,
    `${owned.origin}${path}?task=unknown`,
    `${owned.origin}${path}?task=default&private=NO_SAVE`,
    `${owned.origin}${path}?task=default&task=orders`,
    `${owned.origin}${path}?task=%64efault`,
    `${owned.origin}${path}?TASK=default`,
    `${owned.origin}${path}?task=default#fragment`,
    `${path}?task=default`,
  ]
  for (const attack of attacks) {
    const result = await via(guard, attack, { host: new URL(owned.origin).host })
    assert.equal(result.status, 403, attack)
  }
  assert.equal((await via(guard, uri('default'), { host: new URL(trap.origin).host })).status, 403)
  assert.equal(owned.hits.length, 0)
  assert.equal(trap.hits.length, 0)
  assert.equal(guard.snapshot().allowed, 0)
  assert.equal(guard.snapshot().denied, attacks.length + 1)
})

test('POST and body framing, CONNECT, upgrades and ambiguous Host headers cannot reach any destination', async t => {
  const { owned, trap, guard, uri } = await setup(t)
  const host = new URL(owned.origin).host
  assert.equal((await via(guard, uri('default'), { method: 'POST', body: 'PRIVATE_BODY' })).status, 403)
  assert.equal((await via(guard, uri('default'), { headers: { 'content-length': '12' }, body: 'PRIVATE_BODY' })).status, 403)
  assert.equal((await via(guard, uri('default'), { headers: { 'content-length': '0' } })).status, 403)
  assert.equal((await via(guard, uri('default'), { headers: { 'proxy-authorization': 'PRIVATE_PROXY_TOKEN' } })).status, 403)
  const rawRequests = [
    `CONNECT ${new URL(trap.origin).host} HTTP/1.1\r\nHost: ${new URL(trap.origin).host}\r\n\r\n`,
    `CONNECT ${host} HTTP/1.1\r\nHost: ${host}\r\n\r\n`,
    `GET ${uri('default')} HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
    `GET ${uri('default')} HTTP/1.1\r\nHost: ${host}\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
    `GET ${uri('default')} HTTP/1.1\r\nConnection: close\r\n\r\n`,
    `GET ${uri('default')} HTTP/1.1\r\nHost: ${host}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n1\r\nx\r\n0\r\n\r\n`,
    `GET ${uri('default')} HTTP/1.1\r\nHost: ${host}\r\nExpect: 100-continue\r\nContent-Length: 12\r\n\r\n`,
  ]
  for (const bytes of rawRequests) assert.match(await raw(guard, bytes), /^HTTP\/1\.1 403 /u)
  assert.equal(owned.hits.length, 0)
  assert.equal(trap.hits.length, 0)
  assert.equal(guard.snapshot().allowed, 0)
  assert.equal(guard.snapshot().denied, 4 + rawRequests.length)
})

test('oversized and excessive headers are denied while report metadata remains a fixed counter projection', async t => {
  const { owned, guard, uri } = await setup(t), host = new URL(owned.origin).host
  const excessive = Array.from({ length: 40 }, (_, index) => `X-Fixture-${index}: PRIVATE`).join('\r\n')
  for (const extra of [`X-Large: ${'P'.repeat(9000)}`, excessive]) {
    assert.match(await raw(guard, `GET ${uri('default')} HTTP/1.1\r\nHost: ${host}\r\n${extra}\r\nConnection: close\r\n\r\n`), /^HTTP\/1\.1 403 /u)
  }
  assert.equal(owned.hits.length, 0)
  const snapshot = guard.snapshot()
  assert.deepEqual(Object.keys(snapshot).sort(), ['allowed', 'closed', 'denied', 'variants'])
  assert.deepEqual(Object.keys(snapshot.variants).sort(), ['browser', 'default', 'orders'])
  assert.equal(snapshot.denied, 2)
  snapshot.variants.default = 999
  assert.equal(guard.snapshot().variants.default, 0)
})

test('close aborts only guard-owned pending upstream work and leaves the fixture and trap servers alive', async t => {
  const { owned, trap, guard, uri } = await setup(t)
  owned.hold()
  const pending = via(guard, uri('orders')).then(() => 'unexpected-response', () => 'closed')
  const deadline = performance.now() + 1000
  while (owned.hits.length === 0 && performance.now() < deadline) await delay(5)
  assert.equal(owned.hits.length, 1)
  await guard.close()
  await guard.close()
  assert.equal(await pending, 'closed')
  assert.equal(guard.snapshot().closed, true)
  await assert.rejects(via(guard, uri('default')))
  assert.equal((await fetch(trap.origin)).status, 200)
  // Prove the existing fixture still accepts new connections, even though its
  // intentionally held response requires cancellation by this test itself.
  const direct = request(owned.origin)
  const reached = new Promise(resolve => direct.once('socket', socket => socket.once('connect', resolve)))
  direct.on('error', () => {})
  direct.end()
  await reached
  direct.destroy()
})

test('the fixed fixture upstream has a bounded deadline and cannot keep a proxy request open forever', async t => {
  const { owned, guard, uri } = await setup(t)
  owned.hold()
  const started = performance.now()
  const result = await via(guard, uri('browser'))
  assert.equal(result.status, 502)
  assert.ok(performance.now() - started >= 4500)
  assert.ok(performance.now() - started < 6500)
  assert.deepEqual(guard.snapshot(), { allowed: 1, denied: 0, variants: { default: 0, orders: 0, browser: 1 }, closed: false })
})

test('configuration rejects noncanonical origins and ambiguous fixture paths before listening', async () => {
  for (const fixtureOrigin of ['https://127.0.0.1:1234', 'http://localhost:1234', 'http://127.1:1234', 'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://user:PRIVATE@127.0.0.1:1234', 'http://127.0.0.1:1234/', 'http://127.0.0.1:01234']) {
    await assert.rejects(createOwnedFixtureProxy({ fixtureOrigin, fixturePath: '/fixture.html' }))
  }
  for (const fixturePath of ['fixture.html', '//other.invalid/fixture.html', '/a/../fixture.html', '/fixture.html?private=NO_SAVE', '/%66ixture.html', '/fixture.html#fragment', '/bad\\path', '/bad path']) {
    await assert.rejects(createOwnedFixtureProxy({ fixtureOrigin: 'http://127.0.0.1:1234', fixturePath }))
  }
})
