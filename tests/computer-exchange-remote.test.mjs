import test from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { mkdtemp, mkdir, realpath, readdir, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'
const source = (await build({ entryPoints: [fileURLToPath(new URL('../src/features/computer-use/remote.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })).outputFiles[0].text
const { createComputerAgentServer, RemoteComputerDriver } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const token = 'exchange-test-pair-token-0123456789-abcdefghijklmnopqrstuvwxyz'
const entries = async directory => (await readdir(directory)).filter(name => !['.qiuya-exchange.lock', '.qiuya-exchange.recovery'].includes(name))
const sha = value => createHash('sha256').update(value).digest('hex')
async function fixture(t, enabled = true) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'qyt-exchange-http-'))), directory = join(base, 'shared'); await mkdir(directory)
  const agent = await createComputerAgentServer({ async status() { return { available: true } } }, { token, maxRequestBytes: 256000, ...(enabled ? { exchangeDirectory: directory } : {}) })
  const clients = []
  const client = (extra = {}) => { const remote = new RemoteComputerDriver({ endpoint: agent.endpoint, token, ...extra }); clients.push(remote); return remote }
  t.after(async () => { await Promise.allSettled(clients.map(remote => remote.dispose())); await agent.close(); await rm(base, { recursive: true, force: true }) })
  return { directory, agent, client }
}

test('authenticated loopback chunk upload/download preserves bytes below existing request limits and rejects unauthorized/disabled access', async t => {
  const f = await fixture(t), remote = f.client(), bytes = Buffer.concat([Buffer.from('跨端🙂\r\n'), Buffer.alloc(400000, 0xa7)])
  await assert.rejects(f.client({ token: `${token}-wrong` }).exchange({ action: 'list' }), { code: 'PAIR_UNAUTHORIZED' })
  const status = await remote.exchange({ action: 'status' }); assert.equal(status.enabled, true); assert.equal(status.maxBytes, 8388608)
  const { id } = await remote.exchange({ action: 'begin', name: '手动传输.bin', size: bytes.length, sha256: sha(bytes) })
  for (let offset = 0; offset < bytes.length; offset += status.chunkBytes) await remote.exchange({ action: 'chunk', id, offset, data: bytes.subarray(offset, offset + status.chunkBytes).toString('base64') })
  const published = await remote.exchange({ action: 'commit', id }); assert.equal(published.file.size, bytes.length)
  const chunks = []; let offset = 0
  do { const part = await remote.exchange({ action: 'read', name: published.file.name, version: published.file.version, offset }); chunks.push(Buffer.from(part.data, 'base64')); offset = part.offset; if (part.done) break } while (true)
  assert.deepEqual(Buffer.concat(chunks), bytes); assert.deepEqual(await readFile(join(f.directory, published.file.name)), bytes)
  const disabled = await fixture(t, false), disabledClient = disabled.client()
  assert.equal((await disabledClient.exchange({ action: 'status' })).enabled, false)
  await assert.rejects(disabledClient.exchange({ action: 'list' }), { code: 'EXCHANGE_DISABLED' })
})

test('pair rotation and agent close clear unfinished files, retain published files and reject old credentials', async t => {
  const f = await fixture(t), a = f.client({ clientId: 'owner-a' })
  const pending = await a.exchange({ action: 'begin', name: 'pending', size: 3, sha256: sha('abc') })
  await a.exchange({ action: 'chunk', id: pending.id, offset: 0, data: Buffer.from('abc').toString('base64') })
  await f.agent.revoke(`${token}-rotated`)
  assert.deepEqual(await entries(f.directory), [])
  await assert.rejects(a.exchange({ action: 'commit', id: pending.id }), { code: 'PAIR_UNAUTHORIZED' })
  const b = f.client({ token: `${token}-rotated`, clientId: 'owner-b' })
  const completed = await b.exchange({ action: 'begin', name: 'completed', size: 0, sha256: sha('') })
  await b.exchange({ action: 'commit', id: completed.id })
  await b.exchange({ action: 'begin', name: 'unfinished', size: 0, sha256: sha('') })
  await f.agent.close()
  assert.deepEqual(await entries(f.directory), ['completed'])
  await assert.rejects(b.exchange({ action: 'list' }))
})

test('lost begin reply is cancelled by client disposal even when its transaction ID never reached the owner', async t => {
  const f = await fixture(t); let lose = true
  const remote = f.client({ fetch: async (url, options) => {
    const response = await fetch(url, options), input = JSON.parse(options.body)
    if (lose && input.op === 'exchange' && input.payload.request.action === 'begin') { lose = false; await response.arrayBuffer(); throw new Error('simulated lost begin response') }
    return response
  } })
  await assert.rejects(remote.exchange({ action: 'begin', name: 'lost', size: 0, sha256: sha('') }), /lost begin response/)
  assert.equal((await entries(f.directory)).length, 1)
  await remote.dispose(); assert.deepEqual(await entries(f.directory), [])
})

test('rotation during a partial HTTP body cannot authorize a late begin after revocation', async t => {
  const f = await fixture(t)
  let entered; const observed = new Promise(done => { entered = done }); f.agent.server.once('request', entered)
  const body = JSON.stringify({ version: 1, requestId: 1, clientId: 'slow-owner', op: 'exchange', payload: { request: { action: 'begin', name: 'late', size: 0, sha256: sha('') } } })
  let request
  const response = new Promise((done, reject) => {
    request = httpRequest(f.agent.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => { let value = ''; response.on('data', chunk => { value += chunk }); response.on('end', () => done(JSON.parse(value))) })
    request.on('error', reject); request.write(body.slice(0, 20))
  })
  await observed; await f.agent.revoke(`${token}-new`); request.end(body.slice(20))
  assert.equal((await response).error.code, 'PAIR_UNAUTHORIZED'); assert.deepEqual(await entries(f.directory), [])
})

test('file transport cannot borrow the image transport 48 MiB limit or send an oversized control body', async () => {
  let requests = 0
  const remote = new RemoteComputerDriver({ endpoint: 'http://127.0.0.1:1', token, fetch: async () => { requests++; return new Response('x'.repeat(256001)) } })
  await assert.rejects(remote.exchange({ action: 'list' }), { code: 'REMOTE_RESPONSE_LIMIT' })
  await assert.rejects(remote.exchange({ action: 'chunk', id: 'fixture', offset: 0, data: 'x'.repeat(256000) }), { code: 'EXCHANGE_REQUEST_LIMIT' })
  assert.equal(requests, 1); await remote.dispose()
})

test('HTTP listen failure releases a newly acquired exchange directory for another server', async t => {
  const f = await fixture(t), directory = join(f.directory, 'listen-failure'); await mkdir(directory)
  const driver = { async status() { return { available: true } } }
  await assert.rejects(createComputerAgentServer(driver, { token, exchangeDirectory: directory, port: Number(new URL(f.agent.endpoint).port) }), { code: 'EADDRINUSE' })
  assert.deepEqual(await readdir(directory), [])
  const retry = await createComputerAgentServer(driver, { token, exchangeDirectory: directory })
  try { assert.ok(retry.endpoint.startsWith('http://127.0.0.1:')) } finally { await retry.close() }
})

test('completed uploads do not make retired credentials block disposal after pair rotation', async t => {
  const f = await fixture(t), remote = f.client()
  const created = await remote.exchange({ action: 'begin', name: 'complete-before-rotation', size: 0, sha256: sha('') })
  await remote.exchange({ action: 'commit', id: created.id }); await f.agent.revoke(`${token}-new`)
  await remote.dispose()
  const next = f.client({ token: `${token}-new` })
  assert.equal((await next.exchange({ action: 'list' })).files[0].name, 'complete-before-rotation')
})

test('disposal waits for a late begin reply then cancels once, while a lost commit reply is never replayed', async t => {
  const f = await fixture(t); let entered, finish
  const begun = new Promise(done => { entered = done }), barrier = new Promise(done => { finish = done })
  const remote = f.client({ fetch: async (url, options) => {
    const response = await fetch(url, options), input = JSON.parse(options.body)
    if (input.payload.request?.action === 'begin') { entered(); await barrier }
    return response
  } })
  const starting = remote.exchange({ action: 'begin', name: 'late-reply', size: 0, sha256: sha('') }), rejected = assert.rejects(starting)
  await begun; let closed = false; const closing = remote.dispose().then(() => { closed = true })
  await new Promise(done => setImmediate(done)); assert.equal(closed, false)
  finish(); await rejected; await closing; assert.deepEqual(await entries(f.directory), [])
  let commits = 0
  const lost = f.client({ fetch: async (url, options) => {
    const response = await fetch(url, options), input = JSON.parse(options.body)
    if (input.payload.request?.action === 'commit') { commits++; await response.arrayBuffer(); throw new Error('lost commit reply') }
    return response
  } })
  const upload = await lost.exchange({ action: 'begin', name: 'commit-result-unknown', size: 0, sha256: sha('') })
  await assert.rejects(lost.exchange({ action: 'commit', id: upload.id }), /lost commit reply/)
  await lost.dispose(); assert.equal(commits, 1); assert.deepEqual(await entries(f.directory), ['commit-result-unknown'])
})

test('revoked unfinished file scopes can retire while failed server cleanup still fences new uploads', async t => {
  const f = await fixture(t), old = f.client()
  await old.exchange({ action: 'begin', name: 'unfinished-before-rotation', size: 0, sha256: sha('') })
  await f.agent.revoke(`${token}-second`); await old.dispose()
  assert.deepEqual(await entries(f.directory), [])
  const second = f.client({ token: `${token}-second` })
  const ids = []
  for (const name of ['held-slot-a', 'held-slot-b']) ids.push((await second.exchange({ action: 'begin', name, size: 0, sha256: sha('') })).id)
  // A real filesystem failure prevents unlinking the reserved temporary names.
  // Keep both tracked reservations until recovery; a new pair cannot bypass it.
  for (const id of ids) { const path = join(f.directory, `.qiuya-upload-${id}.tmp`); await rm(path); await mkdir(path) }
  await assert.rejects(f.agent.revoke(`${token}-third`), { code: 'EXCHANGE_CLEANUP_FAILED' })
  await second.dispose()
  const third = f.client({ token: `${token}-third` })
  await assert.rejects(third.exchange({ action: 'begin', name: 'must-not-bypass', size: 0, sha256: sha('') }), { code: 'EXCHANGE_IO' })
  assert.equal((await entries(f.directory)).length, 2)
  for (const id of ids) await rm(join(f.directory, `.qiuya-upload-${id}.tmp`), { recursive: true })
  const retry = await third.exchange({ action: 'begin', name: 'after-recovery', size: 0, sha256: sha('') })
  await third.exchange({ action: 'abort', id: retry.id })
  assert.deepEqual(await entries(f.directory), [])
})
