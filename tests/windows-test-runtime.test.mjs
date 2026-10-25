import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import test from 'node:test'
import { loadWindowsTestRuntime, windowsTestRuntimePlan } from '../scripts/prepare-windows-test-runtime.mjs'

test('Windows test runtimes share the integrity lock while pinning different official Node architectures', async () => {
  const arm64 = await windowsTestRuntimePlan(), x64 = await windowsTestRuntimePlan('x64')
  assert.equal(arm64.architecture, 'arm64')
  assert.equal(x64.architecture, 'x64')
  assert.equal(arm64.lockSha256, x64.lockSha256)
  assert.deepEqual(arm64.dependencies, x64.dependencies)
  assert.notEqual(arm64.archiveName, x64.archiveName)
  assert.equal(arm64.node.sha256, '33dad22e4cef5ee8f9fbb1b0d037fdacd0e56d12a4580f0d63f68b894deab535')
  assert.equal(x64.node.sha256, '2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71')
})

test('Windows runtime loading rejects a manifest from the other architecture before reading its payloads', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qiuya-runtime-architecture-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const plan = await windowsTestRuntimePlan('arm64'), manifestPath = join(directory, 'manifest.json')
  await writeFile(manifestPath, JSON.stringify({ ...plan, archive: { file: plan.archiveName, sha256: '0'.repeat(64) } }))
  await assert.rejects(loadWindowsTestRuntime({ architecture: 'x64', manifestPath }), /manifest or dependency lock mismatch/u)
})

test('both Windows architectures reject unverified Node payloads even with a matching portable archive', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qiuya-runtime-integrity-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const architecture of ['arm64', 'x64']) {
    const plan = await windowsTestRuntimePlan(architecture), portable = Buffer.from('disposable portable fixture')
    const manifestPath = join(directory, `manifest-${architecture}.json`)
    await writeFile(join(directory, plan.archiveName), portable)
    await writeFile(join(directory, plan.node.file), 'unverified node payload')
    await writeFile(manifestPath, JSON.stringify({ ...plan, archive: { file: plan.archiveName, sha256: createHash('sha256').update(portable).digest('hex') } }))
    await assert.rejects(loadWindowsTestRuntime({ architecture, manifestPath }), /pinned official SHA256/u)
  }
})

test('unsupported Windows test architectures cannot fall back to an ARM64 runtime', async () => {
  await assert.rejects(windowsTestRuntimePlan('ia32'), /must be arm64 or x64/u)
  await assert.rejects(loadWindowsTestRuntime({ architecture: 'ia32' }), /must be arm64 or x64/u)
})


test('portable overlays contain the exact native static import closure, and both architectures can compile it in isolation', async t => {
  const repository = fileURLToPath(new URL('../', import.meta.url)), directory = await mkdtemp(join(tmpdir(), 'qiuya-runtime-native-closure-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const expected = ['application-icon.ts', 'contract.ts', 'foreground-handoff.ts', 'macos-launch.ts', 'native-retirement.ts', 'native.ts'].map(name => 'src/features/computer-use/' + name)
  for (const architecture of ['arm64', 'x64']) {
    const plan = await windowsTestRuntimePlan(architecture), snapshot = join(directory, architecture)
    const sources = plan.overlays.filter(name => name.startsWith('src/')).sort()
    assert.deepEqual(sources, expected)
    for (const name of sources) {
      await mkdir(dirname(join(snapshot, name)), { recursive: true })
      await copyFile(join(repository, name), join(snapshot, name))
    }
    const compiled = await build({ entryPoints: ['src/features/computer-use/native.ts'], absWorkingDir: snapshot, bundle: true, write: false, platform: 'node', format: 'esm', target: 'node22', metafile: true, define: { 'process.platform': '\"win32\"' } })
    assert.deepEqual(Object.keys(compiled.metafile.inputs).sort(), expected, 'No import may silently rely on the repository or stale portable source')
    assert.equal(compiled.errors.length, 0)
    assert.equal(compiled.warnings.length, 0)
    assert.equal(compiled.outputFiles.length, 1)
    const loaded = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'))
    assert.equal(typeof loaded.NativeCompanionDriver, 'function')
  }
})

test('PD Harness source transfer and evidence hashes include every native dependency from the portable plan', async () => {
  const source = await readFile(new URL('../scripts/e2e-windows-harness-pd.mjs', import.meta.url), 'utf8')
  const plan = await windowsTestRuntimePlan()
  for (const path of plan.overlays.filter(name => name.startsWith('src/'))) {
    const name = path.split('/').at(-1)
    assert.ok(source.includes(`[${JSON.stringify(name).replaceAll('"', "'")}, await readFile('${path}')]`), 'Same-source read missing: ' + path)
    assert.ok(source.includes(`['${name}', '${path}']`), 'Guest download missing: ' + path)
    const hashes = source.slice(source.indexOf('const testSourceHashes ='), source.indexOf('const testSourceHashes =') + 1500)
    assert.ok(hashes.includes(`'${name}'`), 'Final evidence binding missing: ' + path)
  }
})
