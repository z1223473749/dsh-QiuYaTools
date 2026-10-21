import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const temporary = await mkdtemp(join(tmpdir(), 'qiuya-session-window-version-'))
const root = new URL('../', import.meta.url)
const pluginDirectory = join(temporary, 'profile', 'node_modules', '.pnpm', 'dsh-qiuya-tools', 'node_modules', 'dsh-qiuya-tools', 'lib')
await mkdir(pluginDirectory, { recursive: true })
const hostBuild = await build({ entryPoints: [fileURLToPath(new URL('src/features/session-windows/host.ts', root))], bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external' })
await writeFile(join(pluginDirectory, 'host.mjs'), hostBuild.outputFiles[0].text)
await build({ entryPoints: [fileURLToPath(new URL('src/features/session-windows/compatibility.ts', root))], bundle: true, outfile: join(temporary, 'compatibility.mjs'), platform: 'node', format: 'esm' })
const { installSessionWindowsHost, getOfficialHarnessVersion } = await import(pathToFileURL(join(pluginDirectory, 'host.mjs')).href)
const { sessionWindowVersionCompatibility, MINIMUM_SESSION_WINDOW_HARNESS_VERSION } = await import(pathToFileURL(join(temporary, 'compatibility.mjs')).href)
const installation = join(temporary, 'official-installation')
const installAnchor = join(installation, 'package.json')
const officialPackage = join(installation, 'node_modules', '@deepseek-ai', 'dsh-app-boot')
await mkdir(officialPackage, { recursive: true })
await writeFile(installAnchor, JSON.stringify({ name: '@deepseek-ai/dsh-desktop-runtime', version: '0.2.1-rc.2', type: 'module' }))
const localPackage = join(pluginDirectory, '..', 'node_modules', '@deepseek-ai', 'dsh-app-boot')
await mkdir(localPackage, { recursive: true })
await writeFile(join(localPackage, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-app-boot', exports: './index.mjs', type: 'module', version: '99.0.0' }))
await writeFile(join(localPackage, 'index.mjs'), 'export function getDshRuntimeVersion() { return "99.0.0" }')
const manifest = join(officialPackage, 'package.json')
const writeRuntimeVersion = version => writeFile(manifest, JSON.stringify({ name: '@deepseek-ai/dsh-app-boot', type: 'module', exports: './index.mjs', version }))
await writeRuntimeVersion('0.2.0')
await writeFile(join(officialPackage, 'index.mjs'), `import { readFileSync } from 'node:fs'; export function getDshRuntimeVersion() { return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version }`)
const records = join(temporary, 'commands.jsonl')
const helper = join(temporary, 'helper.cjs')
await writeFile(helper, `const fs = require('node:fs'); const input = require('node:readline').createInterface({ input: process.stdin }); input.on('line', line => { const command = JSON.parse(line); fs.appendFileSync(${JSON.stringify(records)}, JSON.stringify(command)+'\\n'); process.stdout.write(JSON.stringify({requestId:command.requestId,ok:true})+'\\n') }); input.on('close',()=>process.exit(0));`)
const commands = async () => (await readFile(records, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse)
const supportedPlatform = ['darwin', 'win32'].includes(process.platform) && ['arm64', 'x64'].includes(process.arch)
test.after(() => rm(temporary, { recursive: true, force: true }))

function fixture(getHarnessVersion, options = {}, profileAnchor = installAnchor) {
  const routes = new Map()
  const calls = { targetReads: 0, authenticatedUrls: 0 }
  let enabled = true
  const services = {
    get(name) { return name === 'profileContext' ? { installAnchor: profileAnchor } : this[name] },
    connection: {
      authenticatedUrl(base) { calls.authenticatedUrls++; return `${base}?token=fixture-only` },
      browserPeer: { principal: { kind: 'owner' }, ctx: { get() {} } },
      fetch: { register(route) { routes.set(route.path, route); return async () => { routes.delete(route.path) } } },
    },
    webServer: { port: 19444 },
    sessionController: { async list() { calls.targetReads++; return { items: [{ sessionId: 'existing', title: 'Fixture' }] } } },
  }
  const dispose = installSessionWindowsHost(services, () => enabled, { executable: process.execPath, args: [helper], ...(getHarnessVersion === undefined ? {} : { getHarnessVersion }), ...options })
  return {
    calls, dispose,
    disable() { enabled = false },
    async call(operation, payload = {}) {
      const endpoint = `qiuya-tools.session-windows.${operation}`
      const route = routes.get(`/api/${endpoint}`)
      const response = await route.fetch(new Request(`http://127.0.0.1:19444/api/${endpoint}`, { method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: 'version-test', method: endpoint, payload }) }))
      return (await response.json()).result
    },
  }
}

test('session window minimum follows SemVer precedence across prereleases, releases, and build metadata', () => {
  assert.equal(MINIMUM_SESSION_WINDOW_HARNESS_VERSION, '0.2.1-rc.2')
  for (const version of ['0.1.99', '0.2.0', '0.2.1-alpha.99', '0.2.1-beta.9', '0.2.1-rc', '0.2.1-rc.1', '0.2.1-rc.1+build.99']) {
    assert.equal(sessionWindowVersionCompatibility(version).versionSupported, false, version)
  }
  for (const version of ['0.2.1-rc.2', '0.2.1-rc.2+build.1', '0.2.1-rc.3', '0.2.1-rc.10', '0.2.1', '0.2.2-alpha.1', '0.3.0', '1.0.0', '10.0.0']) {
    assert.equal(sessionWindowVersionCompatibility(version).versionSupported, true, version)
  }
  for (const version of [undefined, null, 2, '', 'unknown', '0.2', '0.2.1-rc.02', '0.2.1-rc.2 ', '0.2.1-rc.2\n', '01.2.1']) {
    assert.deepEqual(sessionWindowVersionCompatibility(version), { minimumHarnessVersion: '0.2.1-rc.2', versionSupported: false }, String(version))
  }
})

test('isolated installed plugin resolves the official Host anchor and never trusts newer local development dependencies', async () => {
  assert.match(hostBuild.outputFiles[0].text, /import\(pathToFileURL\(entry\)\.href\)/u)
  assert.equal(await getOfficialHarnessVersion(installAnchor), '0.2.0')
  await writeRuntimeVersion('0.2.1-rc.2')
  assert.equal(await getOfficialHarnessVersion(installAnchor), '0.2.1-rc.2')
  const h = fixture()
  try {
    const result = await h.call('status')
    assert.equal(result.ok, true)
    assert.equal(result.value.harnessVersion, '0.2.1-rc.2')
    assert.equal(result.value.minimumHarnessVersion, '0.2.1-rc.2')
    assert.equal(result.value.versionSupported, true)
    await writeRuntimeVersion('0.2.1-rc.1')
    assert.equal((await h.call('status')).value.versionSupported, false)
    assert.equal((await h.call('open', { sessionId: 'existing', source: 'menu' })).ok, false)
    assert.equal(h.calls.targetReads, 0)
  } finally { h.dispose() }
  assert.equal(await getOfficialHarnessVersion(undefined), undefined, 'an unknown launch installation cannot fall back to plugin-local 99.0.0')
  const missingAnchor = fixture(undefined, {}, null)
  try {
    assert.equal((await missingAnchor.call('status')).value.versionSupported, false)
    assert.equal((await missingAnchor.call('open', { sessionId: 'existing', source: 'menu' })).ok, false)
  } finally { missingAnchor.dispose() }
})

test('Host rejects menu opens, drag opens, and hidden preparation before any target or credential access on unsupported or unknown versions', async () => {
  const before = await commands()
  for (const getVersion of [() => '0.2.1-rc.1', () => '0.2.0', () => undefined, () => 'invalid', async () => { throw new Error('runtime unavailable') }]) {
    const h = fixture(getVersion)
    try {
      const status = await h.call('status')
      assert.equal(status.ok, true)
      assert.equal(status.value.available, false)
      assert.equal(status.value.versionSupported, false)
      assert.equal(status.value.minimumHarnessVersion, '0.2.1-rc.2')
      assert.equal(status.value.reason, status.value.harnessVersion === undefined ? 'harness-version-unknown' : 'harness-version')
      for (const request of [{ source: 'menu' }, { source: 'drag' }, { source: 'drag', action: 'prepare' }]) {
        const result = await h.call('open', { sessionId: 'existing', ...request, harnessVersion: '99.0.0', versionSupported: true })
        assert.equal(result.ok, false)
        assert.match(result.error.message, /最低支持官方 HARNESS 0\.2\.1-rc\.2/u)
      }
      assert.equal(h.calls.targetReads, 0)
      assert.equal(h.calls.authenticatedUrls, 0)
    } finally { h.dispose() }
  }
  assert.deepEqual(await commands(), before, 'blocked requests never send native commands')
})

test('Host keeps version support independent from native helper availability', async () => {
  const h = fixture(() => '0.2.1-rc.2', { executable: join(temporary, 'missing-helper') })
  try {
    const result = await h.call('status')
    assert.equal(result.value.versionSupported, true)
    assert.equal(result.value.available, false)
    assert.equal(result.value.reason, supportedPlatform ? 'helper-missing' : 'platform')
  } finally { h.dispose() }
})

test('cancel during an asynchronous version lookup prevents late hidden preparation', { skip: !supportedPlatform }, async () => {
  let entered
  const reading = new Promise(resolve => { entered = resolve })
  let finish
  const h = fixture(() => { entered(); return new Promise(resolve => { finish = resolve }) })
  const before = await commands()
  try {
    const pending = h.call('open', { sessionId: 'existing', source: 'drag', action: 'prepare' })
    await reading
    assert.deepEqual(await h.call('open', { sessionId: 'existing', source: 'drag', action: 'cancel' }), { ok: true, value: { canceled: true } })
    finish('0.2.1-rc.2')
    assert.deepEqual(await pending, { ok: true, value: { prepared: false } })
    assert.equal(h.calls.targetReads, 0)
    assert.deepEqual(await commands(), before)
  } finally { h.dispose() }
})

test('Host permits the minimum and newer Harness versions while allowing cleanup after compatibility is lost', { skip: !supportedPlatform }, async () => {
  for (const version of ['0.2.1-rc.2', '0.2.1-rc.10', '0.2.1', '0.3.0']) {
    let current = version
    const h = fixture(() => current)
    const before = (await commands()).length
    try {
      assert.equal((await h.call('status')).value.available, true)
      assert.deepEqual(await h.call('open', { sessionId: 'existing', source: 'drag', action: 'prepare' }), { ok: true, value: { prepared: true } })
      assert.deepEqual(await h.call('open', { sessionId: 'existing', source: 'menu' }), { ok: true, value: { opened: true } })
      current = '0.2.0'
      h.disable()
      assert.deepEqual(await h.call('open', { sessionId: 'existing', source: 'drag', action: 'cancel' }), { ok: true, value: { canceled: true } })
      assert.deepEqual((await commands()).slice(before).map(command => command.op), ['prepare', 'open', 'cancel'])
      assert.equal(h.calls.targetReads, 2)
      assert.equal(h.calls.authenticatedUrls, 2)
    } finally { h.dispose() }
  }
})
