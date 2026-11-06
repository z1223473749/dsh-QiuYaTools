import assert from 'node:assert/strict'
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const bundle = await build({
  stdin: {
    contents: "export * from './src/theme-art.ts'; export * from './src/features/theme-art-host.ts'; export * from './src/client/theme-art-api.ts'",
    resolveDir: process.cwd(),
  },
  bundle: true, write: false, platform: 'node', format: 'esm',
})
const {
  installThemeArtHost, THEME_ART_FILES, THEME_ART_METHOD, THEME_ART_CHANNEL,
  ensureThemeArt, resolveThemeArt, subscribeThemeArt, themeArtFailed,
} = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))

test('preset art Host verifies an original before caching and reads it after restarting offline', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qyt-theme-art-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const id = 'q-ocean-scene.webp'
  const original = await readFile(new URL('../assets/' + id, import.meta.url))
  const artifact = THEME_ART_FILES[id]
  const remote = t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, artifact.url)
    return new Response(original)
  })
  let route
  const peer = { principal: { kind: 'guest' } }
  const start = () => installThemeArtHost({
    profileContext: { dir: directory },
    connection: { browserPeer: peer, fetch: { register(value) { route = value; return async () => { route = undefined } } } },
  })
  const request = (requested = id) => route.fetch(new Request('http://fixture' + route.path, {
    method: 'POST',
    body: JSON.stringify({ type: 'client-request', rpcId: 'test-art-request', method: THEME_ART_METHOD, payload: { id: requested } }),
  }))
  const stop = start()
  assert.equal(route.path, THEME_ART_CHANNEL + '/' + THEME_ART_METHOD)
  assert.equal((await request()).status, 403)
  peer.principal.kind = 'owner'
  assert.equal((await (await request('../q-ocean-scene.webp')).json()).result.ok, false)
  assert.equal(remote.mock.callCount(), 0)
  const responses = await Promise.all([request(), request()])
  for (const response of responses) assert.equal((await response.json()).result.value, original.toString('base64'))
  assert.equal(remote.mock.callCount(), 1)
  const cache = join(directory, 'qiuya-theme-art')
  const filename = artifact.sha256 + '.image'
  assert.deepEqual(await readdir(cache), [filename])
  assert.deepEqual(await readFile(join(cache, filename)), original)
  stop()
  assert.equal(route, undefined)

  remote.mock.mockImplementation(async () => { throw new Error('offline') })
  const stopAgain = start()
  try {
    assert.equal((await (await request()).json()).result.value, original.toString('base64'))
    assert.equal(remote.mock.callCount(), 1)
  } finally { stopAgain() }
})

test('static mode loads only the scene and dynamic mode retries the missing plate independently', async () => {
  const scene = 'q-ocean-scene.webp', plate = 'q-ocean-clean-plate.jpg'
  const bytes = Object.fromEntries(await Promise.all([scene, plate].map(async id => [id, (await readFile(new URL('../assets/' + id, import.meta.url))).toString('base64')])))
  const calls = []
  let failPlate = true
  const ctx = { get: () => ({ rpc: { async call(channel, method, { id }) {
    assert.equal(channel, '/api')
    assert.equal(method, 'qiuya-tools/theme-art/get')
    calls.push(id)
    return id === plate && failPlate ? { ok: false } : { ok: true, value: bytes[id] }
  } } }) }
  const theme = { id: 'ocean', art: 'cover', installLayeredScene() {} }
  const nextChange = () => new Promise(resolve => {
    const stop = subscribeThemeArt(() => { stop(); resolve() })
  })

  assert.equal(resolveThemeArt(theme).art, 'cover')
  assert.equal(resolveThemeArt(theme).installScene, undefined)
  const sceneReady = nextChange()
  ensureThemeArt(ctx, 'ocean', 'static')
  ensureThemeArt(ctx, 'ocean', 'static')
  await sceneReady
  assert.deepEqual(calls, [scene])
  assert.equal(resolveThemeArt(theme).art, 'data:image/webp;base64,' + bytes[scene])
  assert.equal(resolveThemeArt(theme).installScene, undefined)

  const plateFailed = nextChange()
  ensureThemeArt(ctx, 'ocean', 'dynamic')
  await plateFailed
  assert.equal(themeArtFailed('ocean', 'dynamic'), true)
  assert.equal(themeArtFailed('ocean', 'static'), false)
  ensureThemeArt(ctx, 'ocean', 'dynamic')
  assert.deepEqual(calls, [scene, plate])
  failPlate = false
  const plateReady = nextChange()
  ensureThemeArt(ctx, 'ocean', 'dynamic', true)
  await plateReady
  assert.deepEqual(calls, [scene, plate, plate])
  assert.equal(themeArtFailed('ocean', 'dynamic'), false)
  assert.equal(typeof resolveThemeArt(theme).installScene, 'function')
})
