import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdtemp, readFile, readdir, rm, writeFile, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const temporary = await mkdtemp(join(tmpdir(), 'qiuya-update-host-test-'))
await build({ entryPoints: [new URL('../src/updates/host.ts', import.meta.url).pathname], bundle: true, outfile: join(temporary, 'host.mjs'), platform: 'node', format: 'esm', packages: 'external' })
const { installPluginUpdatesHost, isGitHubAssetRedirect } = await import(pathToFileURL(join(temporary, 'host.mjs')).href)
const repository = 'https://github.com/QiuYa/QiuYaTools'
const checkEndpoint = 'qiuya-tools.updates.check'
const installEndpoint = 'qiuya-tools.updates.install'
const architecture = process.arch === 'arm64' ? 'arm64' : 'x64'

test.after(async () => { await rm(temporary, { recursive: true, force: true }) })

function archive(version = '1.1.0', name = 'dsh-qiuya-tools') {
  const helper = Buffer.alloc(56)
  helper.writeUInt32LE(0xfeedfacf, 0)
  helper.writeUInt32LE(architecture === 'arm64' ? 0x0100000c : 0x01000007, 4)
  helper.writeUInt32LE(2, 12)
  helper.writeUInt32LE(1, 16)
  helper.writeUInt32LE(24, 20)
  helper.writeUInt32LE(0x1b, 32)
  helper.writeUInt32LE(24, 36)
  const entries = [
    ['package/package.json', Buffer.from(JSON.stringify({ name, version, dsh: { bundle: { patch: './cordis.patch.yml' } } })), 0o644],
    ['package/cordis.patch.yml', Buffer.from('- insert: []\n'), 0o644],
    ['package/lib/index.js', Buffer.from('export function apply() {}'), 0o644],
    ['package/lib/client.js', Buffer.from('/* browser bundle */'), 0o644],
    ['package/lib/QiuYaTools Sessions.app/Contents/MacOS/qiuya-session-window', helper, 0o755],
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
          calls.push({ spec, options, bytes: await readFile(spec.slice('file:'.length)) })
          if (extra.install) return extra.install(spec, options)
          return { changed: true, application: 'restart-required', bundle: 'dsh-qiuya-tools', version: releaseVersion }
        },
      }
      return undefined
    },
  }
  const fetch = async (url, options) => {
    network.push({ url, options })
    assert.equal(options.method, 'GET')
    assert.equal(options.credentials, 'omit')
    if (url === 'https://api.github.com/repos/QiuYa/QiuYaTools/releases/latest') return new Response(JSON.stringify({
      id: 1, tag_name: `v${releaseVersion}`, draft: false, prerelease: false,
      url: 'https://api.github.com/repos/QiuYa/QiuYaTools/releases/1',
      html_url: `${repository}/releases/tag/v${releaseVersion}`, published_at: '2026-10-20T10:00:00Z',
      assets: [{ id: 2, name: 'dsh-qiuya-tools-darwin-universal.tgz', state: 'uploaded', size: packageBytes.length,
        url: 'https://api.github.com/repos/QiuYa/QiuYaTools/releases/assets/2',
        browser_download_url: `${repository}/releases/download/v${releaseVersion}/dsh-qiuya-tools-darwin-universal.tgz`,
        digest: `sha256:${digest}` }],
    }))
    if (assetMode === 'evil-redirect') return new Response(null, { status: 302, headers: { location: 'https://evil.test/package.tgz' } })
    if (assetMode === 'github-redirect' && url.startsWith('https://github.com/')) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/github-production-release-asset/verified' } })
    return new Response(assetMode === 'corrupt' ? new Uint8Array(packageBytes.length).fill(1) : packageBytes)
  }
  const dispose = installPluginUpdatesHost(ctx, { repository, version: '1.0.0', packageName: 'dsh-qiuya-tools', fetch, ...extra.options })
  t.after(() => dispose())
  const response = async (endpoint, payload = {}) => routes.get(`/api/${endpoint}`).fetch(new Request(`http://127.0.0.1:19444/api/${endpoint}`, {
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
    directory, routes, calls, network, packageBytes, digest, call, response, dispose,
    setPeer(value) { peer = value }, setManager(value) { managerAvailable = value },
    setVersion(value) { releaseVersion = value }, setAssetMode(value) { assetMode = value },
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
  }
  f.setPeer({ principal: { kind: 'owner' } })
  assert.equal((await f.response(checkEndpoint, { url: 'https://evil.test/' })).status, 400)
  assert.equal((await f.response(installEndpoint, { version: '1.1.0', spec: 'file:/tmp/evil' })).status, 400)
  assert.equal((await f.response(installEndpoint, { version: '--malicious' })).status, 400)
  assert.equal(f.network.length, 0)
  assert.equal(f.calls.length, 0)
})

test('updates remain read-only until explicit installation and expose unavailable manager or repository state', async t => {
  const f = await fixture(t)
  const result = await f.call(checkEndpoint)
  assert.equal(result.status, 'available')
  assert.equal(result.release.version, '1.1.0')
  assert.equal(result.canInstall, process.platform === 'darwin')
  assert.equal('asset' in result.release, false)
  assert.deepEqual(await readdir(f.directory), [])
  f.setManager(false)
  const unavailable = await f.call(checkEndpoint)
  assert.equal(unavailable.canInstall, false)
  if (process.platform === 'darwin') assert.equal(unavailable.problem.code, 'manager-unavailable')
  const missing = await fixture(t, { options: { repository: undefined } })
  assert.equal((await missing.call(checkEndpoint)).status, 'not-configured')
  assert.equal(missing.network.length, 0)
})

test('an explicit update validates bytes and delegates an immutable file package to the official manager', { skip: process.platform !== 'darwin' }, async t => {
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

test('digest mismatches, unsafe redirects, changed releases and invalid packages never invoke installation', { skip: process.platform !== 'darwin' }, async t => {
  for (const mode of ['corrupt', 'evil-redirect']) {
    const f = await fixture(t)
    f.setAssetMode(mode)
    const result = await f.call(installEndpoint, { version: '1.1.0' })
    assert.equal(result.status, 'failed')
    assert.equal(f.calls.length, 0)
    assert.deepEqual(await readdir(f.directory), [])
  }
  const changed = await fixture(t)
  await changed.call(checkEndpoint)
  changed.setVersion('1.2.0')
  assert.equal((await changed.call(installEndpoint, { version: '1.1.0' })).problem.code, 'version-changed')
  assert.equal(changed.calls.length, 0)
  const invalid = await fixture(t, { packageBytes: archive('1.1.0', 'another-package') })
  assert.equal((await invalid.call(installEndpoint, { version: '1.1.0' })).problem.code, 'archive-invalid')
  assert.equal(invalid.calls.length, 0)
})

test('updates refuse cache symlinks and preserve profile files when the official manager fails', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t)
  const outside = await mkdtemp(join(temporary, 'outside-'))
  await symlink(outside, join(f.directory, 'qiuya-tools-updates'))
  assert.equal((await f.call(installEndpoint, { version: '1.1.0' })).problem.code, 'profile-unavailable')
  assert.equal(f.calls.length, 0)
  assert.deepEqual(await readdir(outside), [])
  const failed = await fixture(t, { install: async () => ({ changed: false, application: 'failed', error: { code: 'already-installed' } }) })
  await writeFile(join(failed.directory, 'package.json'), '{"dependencies":{"dsh-qiuya-tools":"link:/workspace/source"}}')
  const before = await readFile(join(failed.directory, 'package.json'), 'utf8')
  const result = await failed.call(installEndpoint, { version: '1.1.0' })
  assert.equal(result.status, 'failed')
  assert.equal(result.problem.code, 'install-failed')
  assert.equal(await readFile(join(failed.directory, 'package.json'), 'utf8'), before)
  failed.dispose()
  assert.equal(failed.routes.size, 0)
})
