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
  builder.onLoad({ filter: /[/\\]theme-video\.ts$/ }, () => ({ contents: `export const THEME_VIDEO_CHANNEL='/api';export const THEME_VIDEO_METHOD='qiuya-tools/theme-video/get';export const THEME_VIDEOS={fox:{url:'https://github.com/fixture/video.mp4',sha256:'${hash}',bytes:${bytes.length}}}`, loader: 'js' }))
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
