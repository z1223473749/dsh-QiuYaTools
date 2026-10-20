import assert from 'node:assert/strict'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { build } from 'esbuild'
import { createHash } from 'node:crypto'

async function load(path) {
  const result = await build({ entryPoints: [new URL(path, import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'esm' })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}
const { windowsExecutableArchitecture, validateUpdateArchive } = await load('../src/updates/archive.ts')
const { updateAssetNames } = await load('../src/updates/release.ts')
function pe(arch = 'arm64') {
  const data = Buffer.alloc(1024)
  data.writeUInt16LE(0x5a4d); data.writeUInt32LE(128, 60)
  data.writeUInt32LE(0x4550, 128); data.writeUInt16LE(arch === 'arm64' ? 0xaa64 : 0x8664, 132)
  data.writeUInt16LE(1, 134); data.writeUInt16LE(240, 148); data.writeUInt16LE(2, 150)
  data.writeUInt16LE(0x20b, 152); data.writeUInt32LE(128, 392 + 16); data.writeUInt32LE(512, 392 + 20)
  return data
}
function entry(path, value) {
  const body = Buffer.from(value), head = Buffer.alloc(512)
  head.write(path); head.write('0000644\0', 100); head.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124)
  head[156] = 48; head.write('ustar\0', 257); head.write('00', 263); head.fill(32, 148, 156)
  head.write(`${head.reduce((n, b) => n + b, 0).toString(8).padStart(6, '0')}\0 `, 148)
  return Buffer.concat([head, body, Buffer.alloc((512 - body.length % 512) % 512)])
}
function archive(arch, binary = pe(arch)) {
  return gzipSync(Buffer.concat([
    entry('package/package.json', JSON.stringify({ name: 'dsh-qiuya-tools', version: '0.5.3', dsh: { bundle: { patch: './cordis.patch.yml' } } })),
    entry('package/cordis.patch.yml', '- insert: []\n'),
    entry(`package/lib/native/win32-${arch}/qiuya-windows.exe`, binary), Buffer.alloc(1024),
  ]))
}
test('Windows assets bind OS and architecture without falling back to Mac/universal', () => {
  assert.deepEqual(updateAssetNames('dsh-qiuya-tools', 'arm64', 'win32'), ['dsh-qiuya-tools-win32-arm64.tgz'])
  assert.deepEqual(updateAssetNames('dsh-qiuya-tools', 'x64', 'win32'), ['dsh-qiuya-tools-win32-x64.tgz'])
  assert.throws(() => updateAssetNames('dsh-qiuya-tools', 'x64', 'linux'))
})
test('Windows PE architecture and section bounds are inspected before installation', () => {
  for (const arch of ['arm64', 'x64']) {
    assert.equal(windowsExecutableArchitecture(pe(arch)), arch)
    const metadata = validateUpdateArchive(archive(arch), { packageName: 'dsh-qiuya-tools', version: '0.5.3', platform: 'win32', architecture: arch })
    assert.deepEqual(metadata.architectures, [arch])
  }
  const wrong = { packageName: 'dsh-qiuya-tools', version: '0.5.3', platform: 'win32', architecture: 'arm64' }
  assert.throws(() => validateUpdateArchive(archive('arm64', pe('x64')), wrong), /architecture/)
  for (const corrupt of [Buffer.alloc(1024), pe().subarray(0, 200)]) assert.throws(() => windowsExecutableArchitecture(corrupt))
  const corrupt = pe(); corrupt.writeUInt32LE(2000, 392 + 16)
  assert.throws(() => windowsExecutableArchitecture(corrupt), /section/)
})

test('computer-capable Windows package binds the matching native runtime and protocol to a single platform asset', () => {
  const binary = pe('arm64'), version = '0.6.0-beta.1', file = 'win32-arm64/qiuya-windows.exe'
  const native = { version, artifacts: [{ file, architecture: 'arm64', protocolVersion: 1, bytes: binary.length, sha256: createHash('sha256').update(binary).digest('hex') }] }
  const candidate = payload => gzipSync(Buffer.concat([
    entry('package/package.json', JSON.stringify({ name: 'dsh-qiuya-tools', version, dsh: { bundle: { patch: './cordis.patch.yml' } }, qiuyaNative: { protocolVersion: 1, computerUse: true } })),
    entry('package/cordis.patch.yml', '- insert: []\n'), entry(`package/lib/native/${file}`, binary),
    entry('package/lib/native/windows-manifest.json', JSON.stringify(payload)), Buffer.alloc(1024),
  ]))
  const options = { packageName: 'dsh-qiuya-tools', version, platform: 'win32', architecture: 'arm64' }
  validateUpdateArchive(candidate(native), options)
  for (const patch of [{ sha256: '0'.repeat(64) }, { protocolVersion: 99 }, { architecture: 'x64' }, { bytes: 2 }]) assert.throws(() => validateUpdateArchive(candidate({ ...native, artifacts: [{ ...native.artifacts[0], ...patch }] }), options), /native payload/)
})
