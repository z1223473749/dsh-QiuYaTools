import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdtemp, readFile, readdir, rm, writeFile, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const temporary = await mkdtemp(join(tmpdir(), 'qiuya-update-host-test-'))
await build({ entryPoints: [fileURLToPath(new URL('../src/updates/host.ts', import.meta.url))], bundle: true, outfile: join(temporary, 'host.mjs'), platform: 'node', format: 'esm', packages: 'external' })
const { installPluginUpdatesHost, isGitHubAssetRedirect } = await import(pathToFileURL(join(temporary, 'host.mjs')).href)
const repository = 'https://github.com/QiuYa/QiuYaTools'
const checkEndpoint = 'qiuya-tools.updates.check'
const installEndpoint = 'qiuya-tools.updates.install'
const progressEndpoint = 'qiuya-tools.updates.progress'
const architecture = process.arch === 'arm64' ? 'arm64' : 'x64'
const supportedPlatform = ['darwin', 'win32'].includes(process.platform) && ['arm64', 'x64'].includes(process.arch)
const assetName = process.platform === 'win32' ? `dsh-qiuya-tools-win32-${architecture}.tgz` : 'dsh-qiuya-tools-darwin-universal.tgz'

test.after(async () => { await rm(temporary, { recursive: true, force: true }) })

function archive(version = '1.1.0', name = 'dsh-qiuya-tools') {
  const helper = Buffer.alloc(process.platform === 'win32' ? 1024 : 56)
  if (process.platform === 'win32') {
    helper.writeUInt16LE(0x5a4d); helper.writeUInt32LE(128, 60)
    helper.writeUInt32LE(0x4550, 128); helper.writeUInt16LE(architecture === 'arm64' ? 0xaa64 : 0x8664, 132)
    helper.writeUInt16LE(1, 134); helper.writeUInt16LE(240, 148); helper.writeUInt16LE(2, 150)
    helper.writeUInt16LE(0x20b, 152); helper.writeUInt32LE(128, 392 + 16); helper.writeUInt32LE(512, 392 + 20)
  } else {
    helper.writeUInt32LE(0xfeedfacf, 0)
    helper.writeUInt32LE(architecture === 'arm64' ? 0x0100000c : 0x01000007, 4)
    helper.writeUInt32LE(2, 12)
    helper.writeUInt32LE(1, 16)
    helper.writeUInt32LE(24, 20)
    helper.writeUInt32LE(0x1b, 32)
    helper.writeUInt32LE(24, 36)
  }
  const entries = [
    ['package/package.json', Buffer.from(JSON.stringify({ name, version, dsh: { bundle: { patch: './cordis.patch.yml' } } })), 0o644],
    ['package/cordis.patch.yml', Buffer.from('- insert: []\n'), 0o644],
    ['package/lib/index.js', Buffer.from('export function apply() {}'), 0o644],
    ['package/lib/client.js', Buffer.from('/* browser bundle */'), 0o644],
    [process.platform === 'win32' ? `package/lib/native/win32-${architecture}/qiuya-windows.exe` : 'package/lib/QiuYaTools Sessions.app/Contents/MacOS/qiuya-session-window', helper, 0o755],
  ]
  const chunks = []
  for (const [path, content, mode] of entries) {
    const header = Buffer.alloc(512)
    header.write(path, 0, 100)
    const octal = (value, at, length) => header.write(value.toString(8).padStart(length - 1, '0') + '\0', at, length)
    octal(mode, 100, 8); octal(0, 108, 8); octal(0, 116, 8)
    octal(content.length, 124, 12); octal(0, 136, 12)
    header.fill(32, 148, 156)
    header[156] = 48
    header.write('ustar\0', 257, 6); header.write('00', 263, 2)
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
    chunks.push(header, content, Buffer.alloc((512 - content.length % 512) % 512))
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]))
}

async function fixture(t, extra = {}) {
  const directory = await mkdtemp(join(temporary, 'profile-'))
  const routes = new Map()
  const calls = []
  const cancellations = []
  const network = []
  const packageBytes = extra.packageBytes ?? archive()
  const digest = createHash('sha256').update(packageBytes).digest('hex')
  let releaseVersion = '1.1.0'
  let peer = { principal: { kind: 'owner' } }
  let managerAvailable = true
  let assetMode = 'valid'
  const ctx = {
    connection: {
      get browserPeer() { return peer },
      fetch: { register(route) { assert.equal(routes.has(route.path), false); routes.set(route.path, route); return async () => { routes.delete(route.path) } } },
    },
    get(key) {
      if (key === 'profileContext') return { dir: directory }
      if (key === 'pluginManager' && managerAvailable) return {
        async installBundle(spec, options) {
          calls.push({ spec, options, bytes: await readFile(new URL(spec)) })
          if (extra.install) return extra.install(spec, options)
          return { changed: true, application: 'restart-required', bundle: 'dsh-qiuya-tools', version: releaseVersion }
        },
        async cancelInstall(requestId) {
          cancellations.push(requestId)
          return extra.cancelInstall?.(requestId)
        },
      }
      return undefined
    },
  }
  const fetch = async (url, options) => {
    network.push({ url, options })
    assert.equal(options.method, 'GET')
    assert.equal(options.credentials, 'omit')
    if (url === 'https://api.github.com/repos/QiuYa/QiuYaTools/releases/latest') {
      if (extra.beforeRelease) await extra.beforeRelease(options)
      return new Response(JSON.stringify({
        id: 1, tag_name: `v${releaseVersion}`, draft: false, prerelease: false,
        url: 'https://api.github.com/repos/QiuYa/QiuYaTools/releases/1',
        html_url: `${repository}/releases/tag/v${releaseVersion}`, published_at: '2026-10-20T10:00:00Z',
        assets: [{ id: 2, name: assetName, state: 'uploaded', size: packageBytes.length,
          url: 'https://api.github.com/repos/QiuYa/QiuYaTools/releases/assets/2',
          browser_download_url: `${repository}/releases/download/v${releaseVersion}/${assetName}`,
          digest: `sha256:${digest}` }],
      }))
    }
    if (extra.assetResponse) return extra.assetResponse({ packageBytes, url, options })
    if (assetMode === 'evil-redirect') return new Response(null, { status: 302, headers: { location: 'https://evil.test/package.tgz' } })
    if (assetMode === 'github-redirect' && url.startsWith('https://github.com/')) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/github-production-release-asset/verified' } })
    return new Response(assetMode === 'corrupt' ? new Uint8Array(packageBytes.length).fill(1) : packageBytes)
  }
  const dispose = installPluginUpdatesHost(ctx, { repository, version: '1.0.0', packageName: 'dsh-qiuya-tools', fetch, ...extra.options })
  t.after(() => dispose())
  const handlers = new Map(routes)
  const response = async (endpoint, payload = {}) => handlers.get(`/api/${endpoint}`).fetch(new Request(`http://127.0.0.1:19444/api/${endpoint}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'fixture-request', method: endpoint, payload }),
  }))
  const call = async (endpoint, payload = {}) => {
    const result = await response(endpoint, payload)
    assert.equal(result.status, 200)
    const envelope = await result.json()
    assert.equal(envelope.result.ok, true)
    return envelope.result.value
  }
  return {
    directory, routes, calls, cancellations, network, packageBytes, digest, call, response, dispose,
    setPeer(value) { peer = value }, setManager(value) { managerAvailable = value },
    setVersion(value) { releaseVersion = value }, setAssetMode(value) { assetMode = value },
  }
}

function deferred() {
  let resolve, reject
  const promise = new Promise((ok, no) => { resolve = ok; reject = no })
  return { promise, resolve, reject }
}

function controlledDownload(t) {
  const requested = deferred()
  let controller
  const body = new ReadableStream({ start(value) { controller = value } })
  t.after(() => { try { controller.error(new Error('Test finished')) } catch {} })
  return {
    requested: requested.promise,
    response({ options }) {
      options.signal.addEventListener('abort', () => controller.error(options.signal.reason), { once: true })
      requested.resolve()
      // Deliberately omit Content-Length: the trusted size is GitHub's validated asset metadata.
      return new Response(body)
    },
    push(bytes) { controller.enqueue(bytes) },
    close() { controller.close() },
  }
}

async function waitForProgress(f, stage, bytes) {
  const deadline = Date.now() + 2_000
  for (;;) {
    const result = await f.call(progressEndpoint, { version: '1.1.0' })
    if (result.progress?.stage === stage && (bytes === undefined || result.progress.downloadedBytes === bytes)) return result.progress
    assert.ok(Date.now() < deadline, `Expected ${stage} progress with ${bytes ?? 'any'} bytes; received ${JSON.stringify(result)}`)
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

test('update asset redirects allow only the explicit GitHub-owned release CDN hosts', () => {
  for (const url of ['https://release-assets.githubusercontent.com/path?signature=public-download', 'https://objects.githubusercontent.com/path']) assert.equal(isGitHubAssetRedirect(url), true)
  for (const url of ['http://release-assets.githubusercontent.com/path', 'https://release-assets.githubusercontent.com.evil.test/path', 'https://user:pass@objects.githubusercontent.com/path', 'https://evil.test/path', 'file:///tmp/pkg.tgz', 'https://objects.githubusercontent.com:444/path', 'https://objects.githubusercontent.com/path#fragment']) assert.equal(isGitHubAssetRedirect(url), false)
})

test('update routes reject delegated or absent browser principals and arbitrary renderer URL/spec inputs', async t => {
  const f = await fixture(t)
  for (const peer of [undefined, { principal: { kind: 'api' } }]) {
    f.setPeer(peer)
    assert.equal((await f.response(checkEndpoint)).status, 403)
    assert.equal((await f.response(installEndpoint, { version: '1.1.0' })).status, 403)
    assert.equal((await f.response(progressEndpoint, { version: '1.1.0' })).status, 403)
  }
  f.setPeer({ principal: { kind: 'owner' } })
  assert.equal((await f.response(checkEndpoint, { url: 'https://evil.test/' })).status, 400)
  assert.equal((await f.response(installEndpoint, { version: '1.1.0', spec: 'file:/tmp/evil' })).status, 400)
  assert.equal((await f.response(installEndpoint, { version: '--malicious' })).status, 400)
  for (const payload of [{}, { version: '--malicious' }, { version: '1.1.0', url: 'https://evil.test/' }]) assert.equal((await f.response(progressEndpoint, payload)).status, 400)
  const route = f.routes.get(`/api/${progressEndpoint}`)
  for (const envelope of [
    { type: 'client-request', rpcId: 'id', method: installEndpoint, payload: { version: '1.1.0' } },
    { type: 'client-request', rpcId: '\u0000', method: progressEndpoint, payload: { version: '1.1.0' } },
    { type: 'client-request', rpcId: 'id', method: progressEndpoint, payload: [] },
  ]) assert.equal((await route.fetch(new Request('http://localhost/', { method: 'POST', body: JSON.stringify(envelope) }))).status, 400)
  assert.deepEqual(await f.call(progressEndpoint, { version: '1.1.0' }), { progress: null })
  assert.equal(f.network.length, 0)
  assert.equal(f.calls.length, 0)
})

test('active progress reports actual stream bytes without Content-Length and isolates versions and concurrent installs', { skip: !supportedPlatform }, async t => {
  const releaseGate = deferred()
  const managerGate = deferred()
  const managerEntered = deferred()
  const stream = controlledDownload(t)
  const f = await fixture(t, { beforeRelease: () => releaseGate.promise, assetResponse: stream.response, install: () => { managerEntered.resolve(); return managerGate.promise } })
  t.after(() => managerGate.resolve({ changed: false, application: 'cancelled' }))
  const pending = f.call(installEndpoint, { version: '1.1.0' })
  assert.deepEqual(await waitForProgress(f, 'checking'), { version: '1.1.0', stage: 'checking', downloadedBytes: 0, totalBytes: null, percentage: null })
  const duplicate = f.call(installEndpoint, { version: '1.1.0' })
  assert.equal((await f.call(installEndpoint, { version: '1.2.0' })).problem.code, 'install-failed')
  assert.deepEqual(await f.call(progressEndpoint, { version: '1.2.0' }), { progress: null })
  f.setPeer({ principal: { kind: 'api' } })
  assert.equal((await f.response(progressEndpoint, { version: '1.1.0' })).status, 403)
  f.setPeer({ principal: { kind: 'owner' } })
  releaseGate.resolve()
  await stream.requested
  assert.deepEqual(await waitForProgress(f, 'downloading', 0), { version: '1.1.0', stage: 'downloading', downloadedBytes: 0, totalBytes: f.packageBytes.length, percentage: 0 })
  const first = Math.floor(f.packageBytes.length / 4)
  const second = Math.floor(f.packageBytes.length * 3 / 5)
  stream.push(f.packageBytes.subarray(0, first))
  const firstProgress = await waitForProgress(f, 'downloading', first)
  assert.equal(firstProgress.percentage, first / f.packageBytes.length * 100)
  stream.push(f.packageBytes.subarray(first, second))
  const secondProgress = await waitForProgress(f, 'downloading', second)
  assert.equal(secondProgress.percentage, second / f.packageBytes.length * 100)
  stream.push(f.packageBytes.subarray(second))
  assert.equal((await waitForProgress(f, 'downloading', f.packageBytes.length)).percentage, 100)
  assert.equal(f.calls.length, 0, 'reaching the declared length is not completion until the stream closes and validates')
  stream.close()
  assert.equal((await waitForProgress(f, 'verifying')).percentage, 100)
  assert.deepEqual(await waitForProgress(f, 'installing'), { version: '1.1.0', stage: 'installing', downloadedBytes: f.packageBytes.length, totalBytes: f.packageBytes.length, percentage: 100 })
  await managerEntered.promise
  assert.equal(f.calls.length, 1)
  assert.equal(f.network.length, 2, 'duplicate requests share the same metadata check and download')
  managerGate.resolve({ changed: true, application: 'restart-required', bundle: 'dsh-qiuya-tools', version: '1.1.0' })
  assert.equal((await pending).status, 'restart-required')
  assert.deepEqual(await duplicate, await pending)
  assert.deepEqual(await f.call(progressEndpoint, { version: '1.1.0' }), { progress: null })
  await f.call(installEndpoint, { version: '1.1.0' })
  assert.deepEqual(await f.call(progressEndpoint, { version: '1.1.0' }), { progress: null })
})

test('failed integrity checks clear the snapshot and a retry starts from zero', { skip: !supportedPlatform }, async t => {
  let stream = controlledDownload(t)
  const f = await fixture(t, { assetResponse: value => stream.response(value) })
  const first = f.call(installEndpoint, { version: '1.1.0' })
  await stream.requested
  const partial = Math.floor(f.packageBytes.length / 2)
  stream.push(new Uint8Array(partial).fill(1))
  await waitForProgress(f, 'downloading', partial)
  stream.push(new Uint8Array(f.packageBytes.length - partial).fill(1))
  stream.close()
  assert.equal((await first).problem.code, 'integrity-failed')
  assert.equal(f.calls.length, 0)
  assert.deepEqual(await f.call(progressEndpoint, { version: '1.1.0' }), { progress: null })
  stream = controlledDownload(t)
  const retry = f.call(installEndpoint, { version: '1.1.0' })
  await stream.requested
  assert.equal((await waitForProgress(f, 'downloading', 0)).percentage, 0)
  stream.push(f.packageBytes)
  stream.close()
  assert.equal((await retry).status, 'restart-required')
  assert.equal(f.calls.length, 1)
  assert.deepEqual(await f.call(progressEndpoint, { version: '1.1.0' }), { progress: null })
})

test('disposing during download aborts the stream and removes active progress', { skip: !supportedPlatform }, async t => {
  const stream = controlledDownload(t)
  const f = await fixture(t, { assetResponse: stream.response })
  const pending = f.call(installEndpoint, { version: '1.1.0' })
  await stream.requested
  stream.push(f.packageBytes.subarray(0, 10))
  await waitForProgress(f, 'downloading', 10)
  f.dispose()
  assert.deepEqual(await f.call(progressEndpoint, { version: '1.1.0' }), { progress: null })
  assert.equal((await pending).problem.code, 'disposed')
  assert.equal(f.calls.length, 0)
  assert.equal(f.routes.size, 0)
})

test('disposing during manager installation preserves request cancellation and clears progress', { skip: !supportedPlatform }, async t => {
  const managerGate = deferred()
  const managerEntered = deferred()
  const f = await fixture(t, { install: () => { managerEntered.resolve(); return managerGate.promise }, cancelInstall: () => managerGate.resolve({ changed: false, application: 'cancelled' }) })
  const pending = f.call(installEndpoint, { version: '1.1.0' })
  await waitForProgress(f, 'installing')
  await managerEntered.promise
  f.dispose()
  assert.deepEqual(await f.call(progressEndpoint, { version: '1.1.0' }), { progress: null })
  assert.deepEqual(f.cancellations, [f.calls[0].options.requestId])
  assert.equal((await pending).status, 'failed')
  assert.deepEqual(await f.call(progressEndpoint, { version: '1.1.0' }), { progress: null })
})

test('updates remain read-only until explicit installation and expose unavailable manager or repository state', async t => {
  const f = await fixture(t)
  const result = await f.call(checkEndpoint)
  assert.equal(result.status, 'available')
  assert.equal(result.release.version, '1.1.0')
  assert.equal(result.canInstall, supportedPlatform)
  assert.equal('asset' in result.release, false)
  assert.deepEqual(await readdir(f.directory), [])
  f.setManager(false)
  const unavailable = await f.call(checkEndpoint)
  assert.equal(unavailable.canInstall, false)
  if (supportedPlatform) assert.equal(unavailable.problem.code, 'manager-unavailable')
  const missing = await fixture(t, { options: { repository: undefined } })
  assert.equal((await missing.call(checkEndpoint)).status, 'not-configured')
  assert.equal(missing.network.length, 0)
})

test('an explicit update validates bytes and delegates an immutable file package to the official manager', { skip: !supportedPlatform }, async t => {
  const f = await fixture(t)
  await f.call(checkEndpoint)
  f.setAssetMode('github-redirect')
  const result = await f.call(installEndpoint, { version: '1.1.0' })
  assert.equal(result.status, 'restart-required')
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].spec, pathToFileURL(join(await realpath(f.directory), 'qiuya-tools-updates', `${f.digest}.tgz`)).href)
  assert.deepEqual(f.calls[0].bytes, f.packageBytes)
  assert.equal(f.calls[0].options.enabled, true)
  assert.equal(f.calls[0].options.saveExact, true)
  assert.match(f.calls[0].options.requestId, /^[a-f0-9-]{36}$/)
  assert.equal(f.network.some(item => item.url.startsWith('https://release-assets.githubusercontent.com/')), true)
  const checked = await f.call(checkEndpoint)
  assert.equal(checked.pendingVersion, '1.1.0')
  assert.equal(checked.currentVersion, '1.0.0')
  assert.equal(checked.canInstall, false)
  assert.equal((await f.call(installEndpoint, { version: '1.1.0' })).status, 'restart-required')
  assert.equal(f.calls.length, 1)
})

test('digest mismatches, unsafe redirects, changed releases and invalid packages never invoke installation', { skip: !supportedPlatform }, async t => {
  for (const mode of ['corrupt', 'evil-redirect']) {
    const f = await fixture(t)
    f.setAssetMode(mode)
    const result = await f.call(installEndpoint, { version: '1.1.0' })
    assert.equal(result.status, 'failed')
    assert.equal(f.calls.length, 0)
    assert.deepEqual(await readdir(f.directory), [])
    assert.deepEqual(await f.call(progressEndpoint, { version: '1.1.0' }), { progress: null })
  }
  const changed = await fixture(t)
  await changed.call(checkEndpoint)
  changed.setVersion('1.2.0')
  assert.equal((await changed.call(installEndpoint, { version: '1.1.0' })).problem.code, 'version-changed')
  assert.equal(changed.calls.length, 0)
  assert.deepEqual(await changed.call(progressEndpoint, { version: '1.1.0' }), { progress: null })
  const invalid = await fixture(t, { packageBytes: archive('1.1.0', 'another-package') })
  assert.equal((await invalid.call(installEndpoint, { version: '1.1.0' })).problem.code, 'archive-invalid')
  assert.equal(invalid.calls.length, 0)
  assert.deepEqual(await invalid.call(progressEndpoint, { version: '1.1.0' }), { progress: null })
})

test('updates refuse cache symlinks and preserve profile files when the official manager fails', { skip: !supportedPlatform }, async t => {
  const f = await fixture(t)
  const outside = await mkdtemp(join(temporary, 'outside-'))
  await symlink(outside, join(f.directory, 'qiuya-tools-updates'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await f.call(installEndpoint, { version: '1.1.0' })).problem.code, 'profile-unavailable')
  assert.equal(f.calls.length, 0)
  assert.deepEqual(await readdir(outside), [])
  const failed = await fixture(t, { install: async () => ({ changed: false, application: 'failed', error: { code: 'already-installed' } }) })
  await writeFile(join(failed.directory, 'package.json'), '{"dependencies":{"dsh-qiuya-tools":"link:/workspace/source"}}')
  const before = await readFile(join(failed.directory, 'package.json'), 'utf8')
  const result = await failed.call(installEndpoint, { version: '1.1.0' })
  assert.equal(result.status, 'failed')
  assert.equal(result.problem.code, 'install-failed')
  assert.deepEqual(await failed.call(progressEndpoint, { version: '1.1.0' }), { progress: null })
  assert.equal(await readFile(join(failed.directory, 'package.json'), 'utf8'), before)
  failed.dispose()
  assert.equal(failed.routes.size, 0)
})
