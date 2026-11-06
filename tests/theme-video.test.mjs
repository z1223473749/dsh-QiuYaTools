import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const bytes = Buffer.from('bounded video fixture'), hash = createHash('sha256').update(bytes).digest('hex')
// Use tiny deterministic media for cache/transport tests; the browser script
// separately downloads and decodes the actual GitHub artifact.
const result = await build({ entryPoints: ['src/features/theme-video/host.ts'], bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'fixture-video-manifest', setup(builder) {
  builder.onLoad({ filter: /[/\\]theme-video\.ts$/ }, async ({ path }) => {
    const source = await readFile(path, 'utf8')
    return { contents: source.slice(0, source.indexOf('export const THEME_VIDEOS')) + `export const THEME_VIDEOS={fox:{url:'https://github.com/fixture/video.mp4',sha256:'${hash}',bytes:${bytes.length}}}`, loader: 'ts' }
  })
} }] })
const { createThemeVideoCache, installThemeVideoHost } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'qyt-theme-video-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}
test('video download is lazy, accepts fixed ids only and shares concurrent first-use downloads', async t => {
  const path = await directory(t)
  let calls = 0, unblock
  const gate = new Promise(resolve => { unblock = resolve })
  const cache = createThemeVideoCache(path, { fetch: async url => { calls++; assert.equal(url, 'https://github.com/fixture/video.mp4'); await gate; return new Response(bytes) } })
  assert.equal(calls, 0)
  for (const id of ['__proto__', '../fox', 'https://evil.test/video', null]) await assert.rejects(cache.get(id), /invalid-request/)
  const a = cache.get('fox'), b = cache.get('fox')
  unblock()
  assert.deepEqual(await a, bytes); assert.deepEqual(await b, bytes)
  assert.equal(calls, 1)
  assert.deepEqual(await readdir(path), [hash + '.mp4'])
  assert.deepEqual(await readFile(join(path, hash + '.mp4')), bytes)
})
test('a new cache instance works offline and corrupt cached bytes are redownloaded', async t => {
  const path = await directory(t)
  await writeFile(join(path, hash + '.mp4'), bytes)
  let calls = 0
  const cache = createThemeVideoCache(path, { fetch: async () => { calls++; return new Response(bytes) } })
  assert.deepEqual(await cache.get('fox'), bytes)
  assert.equal(calls, 0)
  await writeFile(join(path, hash + '.mp4'), Buffer.alloc(bytes.length))
  assert.deepEqual(await cache.get('fox'), bytes)
  assert.equal(calls, 1)
})
test('size, digest, response and interrupted download failures never become a cache file and may retry', async t => {
  const path = await directory(t)
  for (const response of [new Response('missing', { status: 404 }), new Response(bytes, { headers: { 'content-length': '10000' } }), new Response(Buffer.alloc(bytes.length + 1)), new Response(Buffer.alloc(bytes.length)), new Response(bytes.subarray(0, 3))]) {
    let first = true
    const cache = createThemeVideoCache(path, { fetch: async () => { if (first) { first = false; return response } return new Response(bytes) } })
    await assert.rejects(cache.get('fox'), /video-unavailable/)
    assert.deepEqual(await readdir(path), [])
    assert.deepEqual(await cache.get('fox'), bytes)
    await rm(join(path, hash + '.mp4'))
  }
  const controller = new AbortController()
  const cache = createThemeVideoCache(path, { signal: controller.signal, fetch: async (_url, { signal }) => {
    controller.abort()
    signal.throwIfAborted()
    return new Response(bytes)
  } })
  await assert.rejects(cache.get('fox'))
  assert.deepEqual(await readdir(path), [])
})
test('Host rejects nonowners and malformed envelopes, transports cached video and unregisters on disposal', async t => {
  const path = await directory(t), routes = new Map()
  const ctx = { profileContext: { dir: path }, connection: { browserPeer: { principal: { kind: 'guest' } }, fetch: { register(route) { routes.set(route.path, route); return async () => routes.delete(route.path) } } } }
  const stop = installThemeVideoHost(ctx); t.after(stop)
  const route = routes.get('/api/qiuya-tools/theme-video/get')
  const request = body => route.fetch(new Request('http://fixture', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }))
  const valid = { type: 'client-request', rpcId: 'rpc/client:1', method: 'qiuya-tools/theme-video/get', payload: { id: 'fox' } }
  assert.equal((await request(valid)).status, 403)
  ctx.connection.browserPeer.principal.kind = 'owner'
  assert.equal((await request('{')).status, 400)
  assert.equal((await request('x'.repeat(1025))).status, 413)
  assert.equal((await request({ ...valid, method: 'other' })).status, 400)
  const invalid = await (await request({ ...valid, payload: { id: '../video' } })).json()
  assert.equal(invalid.result.error.code, 'invalid-request')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(path, 'qiuya-theme-videos'))
  await writeFile(join(path, 'qiuya-theme-videos', hash + '.mp4'), bytes)
  const response = await (await request(valid)).json()
  assert.equal(response.rpcId, valid.rpcId)
  assert.deepEqual(Buffer.from(response.result.value, 'base64'), bytes)
  stop(); stop()
  assert.equal(routes.size, 0)
  assert.equal((await request(valid)).status, 403)
})

test('local video uploads and byte ranges stay owner-only, and only unreferenced assets can be discarded', async t => {
  const path = await directory(t), routes = new Map(), references = new Set()
  const ctx = { profileContext: { dir: path }, connection: { browserPeer: { principal: { kind: 'guest' } }, fetch: { register(route) { routes.set(route.path, route); return async () => routes.delete(route.path) } } } }
  const stop = installThemeVideoHost(ctx, id => references.has(id)); t.after(stop)
  const uploadPath = '/api/qiuya-tools/theme-video/upload'
  const mediaPath = '/api/qiuya-tools/theme-video/local'
  const upload = (body, options = {}) => routes.get(uploadPath).fetch(new Request('http://fixture' + uploadPath, {
    method: 'POST', headers: { 'content-type': 'video/mp4' }, body, ...options,
  }))
  const media = (id, init) => routes.get(mediaPath).fetch(new Request('http://fixture' + mediaPath + '?id=' + encodeURIComponent(id), init))
  assert.equal((await upload(bytes)).status, 403)
  assert.equal((await media('../video')).status, 403)
  ctx.connection.browserPeer.principal.kind = 'owner'
  assert.equal((await media('../video')).status, 400)
  assert.equal((await upload(bytes)).status, 415)
  const box = (type, ...parts) => {
    const header = Buffer.alloc(8)
    header.writeUInt32BE(8 + parts.reduce((size, part) => size + part.length, 0))
    header.write(type, 4, 'ascii')
    return Buffer.concat([header, ...parts])
  }
  const track = type => box('trak', box('mdia', box('hdlr', Buffer.alloc(8), Buffer.from(type))))
  const clip = Buffer.concat([
    box('ftyp', Buffer.from('isom0000')), box('mdat', Buffer.alloc(64 * 1024, 1)),
    box('moov', track('vide'), track('soun')),
  ])
  const { id } = await (await upload(clip)).json()
  assert.match(id, /^[0-9a-f-]{36}$/)
  assert.equal((await media(id)).status, 404)
  references.add(id)
  const info = await media(id, { method: 'HEAD' })
  assert.equal(info.headers.get('content-length'), String(clip.length))
  assert.equal(info.headers.get('x-qyt-video-size'), String(clip.length), 'desktop bridge strips standard Content-Length')
  assert.equal(info.headers.get('x-qyt-video-audio'), '1')
  for (const [range, start, end] of [['bytes=2-9', 2, 9], ['bytes=8-', 8, clip.length - 1], ['bytes=-6', clip.length - 6, clip.length - 1]]) {
    const response = await media(id, { headers: { range } })
    assert.equal(response.status, 206)
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${clip.length}`)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), clip.subarray(start, end + 1))
  }
  const unsatisfied = await media(id, { headers: { range: `bytes=${clip.length}-` } })
  assert.equal(unsatisfied.status, 416)
  assert.equal(unsatisfied.headers.get('content-range'), `bytes */${clip.length}`)
  assert.equal((await media(id, { method: 'POST' })).status, 204)
  assert.deepEqual(Buffer.from(await (await media(id)).arrayBuffer()), clip)
  references.delete(id)
  assert.equal((await media(id, { method: 'POST' })).status, 204)
  assert.deepEqual(await readdir(join(path, 'qiuya-local-theme-videos')), [])

  const abort = new AbortController()
  const partial = new ReadableStream({ start(controller) { controller.enqueue(clip.subarray(0, 32)) } })
  const pending = upload(partial, { duplex: 'half', signal: abort.signal })
  abort.abort()
  await pending
  assert.deepEqual(await readdir(join(path, 'qiuya-local-theme-videos')), [])
})
