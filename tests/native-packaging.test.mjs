import assert from 'node:assert/strict'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { join } from 'node:path'
import test from 'node:test'
import { nativePackages, nativeOptionalDependencies, packageNative, packageUniversal, readDistributionArchive, validateNativeArchive, validateUniversalArchive } from '../scripts/package-native.mjs'
import { packageCandidate } from '../scripts/package-candidates.mjs'
import { digest, nativeEntries, nativeNames, nativeSource, rootPackage, tarball, version, windowsBinary } from './fixtures/native-packaging.mjs'

const metadata = bytes => JSON.parse(readDistributionArchive(bytes).get('package/package.json').bytes.toString('utf8'))

test('three real npm native archives contain only their exact precompiled platform and require no lifecycle scripts', async t => {
  const { root } = await nativeSource(t), output = join(root, 'out')
  for (const target of nativePackages) {
    const result = await packageNative(target.name, { root, output }), bytes = await readFile(join(output, result.name)), packed = metadata(bytes)
    assert.deepEqual(packed.os, [target.platform]); assert.deepEqual(packed.cpu, target.platform === 'darwin' ? ['arm64', 'x64'] : [target.architecture])
    assert.deepEqual(packed.exports, { './package.json': './package.json' })
    for (const key of ['scripts', 'dsh', 'dependencies', 'optionalDependencies', 'devDependencies', 'bin']) assert.equal(packed[key], undefined)
    const checked = validateNativeArchive(bytes, { packageName: target.name, version })
    assert.ok(checked.files.includes(`package/${target.manifest}`))
    assert.equal(checked.files.some(path => path.endsWith('.js') || path.endsWith('.swift')), false)
    if (target.platform === 'win32') assert.equal(checked.files.some(path => path.includes(`win32-${target.architecture === 'x64' ? 'arm64' : 'x64'}/`)), false)
    // Resolve the actual packed exports from a consumer, without executing a
    // native helper or any package script.
    const installed = join(root, 'consumer', 'node_modules', target.name)
    for (const [path, entry] of readDistributionArchive(bytes)) {
      const destination = join(installed, path.slice('package/'.length))
      await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, entry.bytes)
    }
    assert.equal(createRequire(join(root, 'consumer', 'index.cjs')).resolve(`${target.name}/package.json`), await realpath(join(installed, 'package.json')))
  }
})

test('the npm alias is a script-free universal wrapper with all native dependencies pinned exactly and no embedded native files', async t => {
  const { root } = await nativeSource(t), output = join(root, 'out'), result = await packageUniversal({ root, output }), bytes = await readFile(join(output, result.name))
  assert.equal(result.name, 'dsh-qiuya-tools.tgz')
  const checked = validateUniversalArchive(bytes, { version }), packed = metadata(bytes)
  assert.deepEqual(packed.optionalDependencies, Object.fromEntries(nativeNames.map(name => [name, version])))
  assert.equal(packed.scripts, undefined); assert.equal(packed.devDependencies, undefined)
  assert.deepEqual(checked.files.filter(path => path.startsWith('package/lib/')).sort(), ['package/lib/client.js', 'package/lib/computer-agent.js', 'package/lib/index.js'])
  assert.equal(readDistributionArchive(bytes).get('package/docs/git-guide.md').bytes.toString('utf8'), 'fixture data\n', 'The npm wrapper carries its linked Git guide')
  const entries = [...readDistributionArchive(bytes)].map(([path, entry]) => [path, entry.bytes, entry.mode])
  for (const path of ['package/lib/native/unreviewed.exe', 'package/lib/extra.js']) assert.throws(() => validateUniversalArchive(tarball([...entries, [path, 'must not ship']]), { version }), /must not carry native files/, 'Adding the Git guide does not widen the public lib entry allowlist')
  assert.deepEqual(nativeOptionalDependencies(version), rootPackage.optionalDependencies)
})

test('complete Windows archives retain their executable and omit universal optional dependencies', async t => {
  const { root } = await nativeSource(t), output = join(root, 'out')
  const result = await packageCandidate('win32', 'x64', output, { sourceRoot: root }), bytes = await readFile(join(output, result.name)), files = readDistributionArchive(bytes)
  assert.equal(metadata(bytes).optionalDependencies, undefined)
  assert.deepEqual(metadata(bytes).scripts, { test: 'node consumer-test.mjs' }, 'Compiled platform packages omit pack lifecycle hooks while preserving other commands')
  assert.ok(files.has('package/lib/native/win32-x64/qiuya-windows.exe'))
  assert.equal(files.has('package/lib/native/win32-arm64/qiuya-windows.exe'), false)
})

test('native validation refuses scripts, bundle activation, platform drift, tampered bytes and missing redistribution licenses', () => {
  const name = nativeNames[2], options = { packageName: name, version }
  for (const metadata of [{ scripts: {} }, { dsh: {} }, { dependencies: {} }, { os: ['darwin'] }, { cpu: ['arm64'] }, { version: '0.6.0' }, { exports: {} }]) assert.throws(() => validateNativeArchive(tarball(nativeEntries(name, { metadata })), options))
  for (const manifest of [value => { value.version = '0.6.0' }, value => { value.artifacts[0].sha256 = '0'.repeat(64) }, value => { value.artifacts[0].architecture = 'arm64' }, value => { value.artifacts[0].selfContained = false }]) assert.throws(() => validateNativeArchive(tarball(nativeEntries(name, { manifest })), options))
  assert.throws(() => validateNativeArchive(tarball(nativeEntries(name).filter(([path]) => !path.endsWith('DOTNET-LICENSE.txt'))), options), /license/)
  assert.throws(() => validateNativeArchive(tarball(nativeEntries(name, { extra: [['package/lib/installer.js', 'must never execute']] })), options), /unexpected file/)
  const wrongArchitecture = nativeEntries(name), binary = windowsBinary('arm64')
  const manifestRow = wrongArchitecture.find(([path]) => path.endsWith('windows-manifest.json')), manifest = JSON.parse(manifestRow[1])
  manifest.artifacts[0].sha256 = digest(binary); manifest.artifacts[0].bytes = binary.length; manifestRow[1] = JSON.stringify(manifest)
  wrongArchitecture.find(([path]) => path.endsWith('qiuya-windows.exe'))[1] = binary
  assert.throws(() => validateNativeArchive(tarball(wrongArchitecture), options), /executable architecture/)
})

test('archive validation rejects links, traversal and duplicate paths before inspecting native metadata', () => {
  for (const extra of [[['package/link', '', 0o644, '2']], [['package/../outside', 'unsafe']], [['package/LICENSE', 'duplicate']]]) assert.throws(() => readDistributionArchive(tarball(nativeEntries(nativeNames[2], { extra }))))
})

test('packaging rejects a stale native manifest instead of publishing mismatched platform versions', async t => {
  const { root, put } = await nativeSource(t)
  const manifest = JSON.parse(await readFile(join(root, 'lib/native/windows-manifest.json'), 'utf8')); manifest.version = '0.6.0'
  await put('lib/native/windows-manifest.json', JSON.stringify(manifest))
  await assert.rejects(packageNative(nativeNames[2], { root, output: join(root, 'out') }), /manifest identity/)
})
