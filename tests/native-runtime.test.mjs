import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const result = await build({ entryPoints: [fileURLToPath(new URL('../src/native/runtime.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })
const { resolveNativeExecutable: resolve, nativePackageName } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'qiuya-native-runtime-')))
test.after(() => rm(temporary, { recursive: true, force: true }))
let sequence = 0

function pe(architecture) {
  const bytes = Buffer.alloc(1024)
  bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(128, 60)
  bytes.writeUInt32LE(0x4550, 128); bytes.writeUInt16LE(architecture === 'arm64' ? 0xaa64 : 0x8664, 132)
  bytes.writeUInt16LE(1, 134); bytes.writeUInt16LE(240, 148); bytes.writeUInt16LE(2, 150)
  bytes.writeUInt16LE(0x20b, 152); bytes.writeUInt32LE(128, 408); bytes.writeUInt32LE(512, 412)
  return bytes
}
function universal() {
  const bytes = Buffer.alloc(128)
  bytes.writeUInt32BE(0xcafebabe); bytes.writeUInt32BE(2, 4)
  for (const [index, cpu] of [0x0100000c, 0x01000007].entries()) {
    const row = 8 + index * 20, start = 48 + index * 40
    bytes.writeUInt32BE(cpu, row); bytes.writeUInt32BE(start, row + 8); bytes.writeUInt32BE(40, row + 12)
    bytes.writeUInt32LE(0xfeedfacf, start); bytes.writeUInt32LE(cpu, start + 4); bytes.writeUInt32LE(2, start + 12)
    bytes.writeUInt32LE(1, start + 16); bytes.writeUInt32LE(8, start + 20); bytes.writeUInt32LE(8, start + 36)
  }
  return bytes
}
async function installation(platform = 'win32', architecture = 'x64') {
  const directory = join(temporary, String(++sequence)), plugin = join(directory, 'node_modules/dsh-qiuya-tools')
  const name = nativePackageName(platform, architecture), dependency = join(directory, 'node_modules', name)
  await mkdir(join(plugin, 'lib'), { recursive: true })
  const options = { platform, architecture, version, base: pathToFileURL(join(plugin, 'lib') + '/') }
  const manifestPath = platform === 'win32' ? 'lib/native/windows-manifest.json' : 'lib/macos-manifest.json'
  const files = platform === 'win32' ? [`win32-${architecture}/qiuya-windows.exe`] : ['QiuYaTools Computer.app/Contents/MacOS/qiuya-computer', 'QiuYaTools Sessions.app/Contents/MacOS/qiuya-session-window']
  const binary = platform === 'win32' ? pe(architecture) : universal()
  const manifest = { protocolVersion: 1, version, artifacts: files.map(file => ({ file, bytes: binary.length, sha256: createHash('sha256').update(binary).digest('hex'), ...(platform === 'win32' ? { platform, architecture, protocolVersion: 1, selfContained: true } : {}) })) }
  const metadata = { name, version, type: 'module', os: [platform], cpu: platform === 'darwin' ? ['arm64', 'x64'] : [architecture], exports: { './package.json': './package.json' } }
  const executable = (root = dependency, index = 0) => join(root, 'lib', platform === 'win32' ? 'native' : '', files[index])
  const install = async (root = dependency) => {
    for (let index = 0; index < files.length; index++) { const file = executable(root, index); await mkdir(dirname(file), { recursive: true }); await writeFile(file, binary, { mode: 0o755 }); await chmod(file, 0o755) }
    await writeFile(join(root, 'package.json'), JSON.stringify(root === plugin ? { name: 'dsh-qiuya-tools', version, type: 'module' } : metadata))
    await writeFile(join(root, manifestPath), JSON.stringify(manifest))
  }
  return { options, plugin, dependency, name, install, manifest, metadata, manifestPath, executable }
}

test('Git/npm installations resolve sibling platform packages for both native features', async () => {
  for (const platform of ['darwin', 'win32']) for (const architecture of ['arm64', 'x64']) {
    const fixture = await installation(platform, architecture); await fixture.install()
    assert.equal(resolve('computer', fixture.options), fixture.executable())
    assert.equal(resolve('session-window', fixture.options), fixture.executable(fixture.dependency, platform === 'darwin' ? 1 : 0))
    if (platform === 'win32') assert.equal(resolve('computer', fixture.options), resolve('session-window', fixture.options))
  }
})

test('complete platform archives use verified bundled components without optional dependencies', async () => {
  for (const platform of ['darwin', 'win32']) {
    const fixture = await installation(platform); await fixture.install(fixture.plugin)
    assert.equal(resolve('computer', fixture.options), fixture.executable(fixture.plugin))
  }
})

test('partial or old Git native content falls back to the current platform dependency', async () => {
  const fixture = await installation('darwin'); await fixture.install(fixture.plugin)
  await rm(fixture.executable(fixture.plugin))
  await fixture.install()
  assert.equal(resolve('computer', fixture.options), fixture.executable())
  fixture.manifest.version = '0.0.0'
  await writeFile(join(fixture.plugin, fixture.manifestPath), JSON.stringify(fixture.manifest))
  assert.equal(resolve('session-window', fixture.options), fixture.executable(fixture.dependency, 1))
})

test('missing native dependencies report installation guidance and can be repaired in the same process', async () => {
  const fixture = await installation()
  assert.throws(() => resolve('computer', fixture.options), error => error.code === 'NATIVE_INSTALLATION_INCOMPLETE' && /重新安装/.test(error.message) && !/spawn|ENOENT/.test(error.message))
  await fixture.install()
  assert.equal(resolve('computer', fixture.options), fixture.executable())
})

test('wrong package version, protocol, executable architecture and modified bytes are rejected', async () => {
  for (const fault of ['version', 'protocol', 'architecture', 'bytes']) {
    const fixture = await installation(); await fixture.install()
    assert.equal(resolve('computer', fixture.options), fixture.executable(), 'establish an integrity-cache entry before changing the payload')
    if (fault === 'version') { fixture.metadata.version = '0.0.0'; await writeFile(join(fixture.dependency, 'package.json'), JSON.stringify(fixture.metadata)) }
    if (fault === 'protocol') { fixture.manifest.protocolVersion = 2; await writeFile(join(fixture.dependency, fixture.manifestPath), JSON.stringify(fixture.manifest)) }
    if (fault === 'architecture') {
      const bytes = pe('arm64'); await writeFile(fixture.executable(), bytes)
      fixture.manifest.artifacts[0].sha256 = createHash('sha256').update(bytes).digest('hex')
      await writeFile(join(fixture.dependency, fixture.manifestPath), JSON.stringify(fixture.manifest))
    }
    if (fault === 'bytes') { const bytes = await readFile(fixture.executable()); bytes[900] = 12; await writeFile(fixture.executable(), bytes) }
    assert.throws(() => resolve('computer', fixture.options), { code: 'NATIVE_INSTALLATION_INCOMPLETE' }, fault)
  }
})

test('unsupported platforms and architectures never fall back to a different native binary', () => {
  for (const [platform, architecture] of [['win32', 'ia32'], ['linux', 'x64']]) assert.throws(() => nativePackageName(platform, architecture), { code: 'PLATFORM_UNSUPPORTED' })
})
