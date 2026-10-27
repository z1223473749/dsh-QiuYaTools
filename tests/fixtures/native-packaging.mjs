import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'

export const version = '0.6.1'
export const repository = { type: 'git', url: 'git+https://github.com/z1223473749/dsh-QiuYaTools.git' }
export const nativeNames = ['dsh-qiuya-tools-native-darwin-universal', 'dsh-qiuya-tools-native-win32-arm64', 'dsh-qiuya-tools-native-win32-x64']
export const rootPackage = {
  name: 'dsh-qiuya-tools', version, type: 'module', license: 'MIT', repository,
  main: './lib/index.js', exports: { '.': './lib/index.js', './package.json': './package.json' },
  dsh: { bundle: { patch: './cordis.patch.yml' } }, qiuyaNative: { protocolVersion: 1, computerUse: true },
  optionalDependencies: Object.fromEntries(nativeNames.map(name => [name, version])),
}
export const digest = bytes => createHash('sha256').update(bytes).digest('hex')
export function windowsBinary(arch) {
  const bytes = Buffer.alloc(1024)
  bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(128, 60); bytes.writeUInt32LE(0x4550, 128)
  bytes.writeUInt16LE(arch === 'arm64' ? 0xaa64 : 0x8664, 132); bytes.writeUInt16LE(1, 134); bytes.writeUInt16LE(240, 148)
  bytes.writeUInt16LE(2, 150); bytes.writeUInt16LE(0x20b, 152); bytes.writeUInt32LE(128, 408); bytes.writeUInt32LE(512, 412)
  return bytes
}
export function universalBinary() {
  const bytes = Buffer.alloc(168); bytes.writeUInt32BE(0xcafebabe); bytes.writeUInt32BE(2, 4)
  for (const [index, cpu] of [0x0100000c, 0x01000007].entries()) {
    const row = 8 + index * 20, start = 64 + index * 64
    bytes.writeUInt32BE(cpu, row); bytes.writeUInt32BE(start, row + 8); bytes.writeUInt32BE(40, row + 12)
    bytes.writeUInt32LE(0xfeedfacf, start); bytes.writeUInt32LE(cpu, start + 4); bytes.writeUInt32LE(2, start + 12)
    bytes.writeUInt32LE(1, start + 16); bytes.writeUInt32LE(8, start + 20); bytes.writeUInt32LE(8, start + 36)
  }
  return bytes
}
export function tarball(entries) {
  const blocks = []
  for (const [name, value, mode = 0o644, type = '0'] of entries) {
    const body = Buffer.isBuffer(value) ? value : Buffer.from(value), header = Buffer.alloc(512)
    if (Buffer.byteLength(name) > 100) throw Error('Fixture archive path too long')
    header.write(name); header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100)
    header.write('0000000\0', 108); header.write('0000000\0', 116)
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124); header.write('00000000000\0', 136)
    header.fill(32, 148, 156); header.write(type, 156); header.write('ustar\0', 257); header.write('00', 263)
    header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148)
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512))
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}
export function nativeEntries(name, { metadata: changes, manifest: changeManifest, extra = [] } = {}) {
  const mac = name.endsWith('darwin-universal'), architecture = name.endsWith('arm64') ? 'arm64' : 'x64'
  const manifestPath = mac ? 'lib/macos-manifest.json' : 'lib/native/windows-manifest.json'
  const executableNames = mac ? ['QiuYaTools Sessions.app/Contents/MacOS/qiuya-session-window', 'QiuYaTools Computer.app/Contents/MacOS/qiuya-computer'] : [`win32-${architecture}/qiuya-windows.exe`]
  const binary = mac ? universalBinary() : windowsBinary(architecture)
  const metadata = { name, version, type: 'module', license: 'MIT', repository, main: `./${manifestPath}`, exports: { './package.json': './package.json' }, os: [mac ? 'darwin' : 'win32'], cpu: mac ? ['arm64', 'x64'] : [architecture], ...changes }
  const manifest = { version, protocolVersion: 1, artifacts: executableNames.map(file => ({ file, bytes: binary.length, sha256: digest(binary), ...mac ? {} : { platform: 'win32', architecture, protocolVersion: 1, selfContained: true } })) }
  changeManifest?.(manifest)
  return [
    ['package/package.json', JSON.stringify(metadata)], ['package/LICENSE', 'MIT license'], ['package/NOTICE', 'Native distribution notices'],
    [`package/${manifestPath}`, JSON.stringify(manifest)],
    ...executableNames.map(file => [`package/lib/${mac ? '' : 'native/'}${file}`, binary, mac ? 0o755 : 0o644]),
    ...mac ? [] : ['WEBVIEW2-LICENSE.txt', 'WEBVIEW2-NOTICE.txt', 'DOTNET-LICENSE.txt', 'DOTNET-THIRD-PARTY-NOTICES.txt'].map(file => [`package/lib/native/win32-${architecture}/${file}`, 'redistribution notice']),
    ...extra,
  ]
}
export async function nativeSource(t) {
  const root = await mkdtemp(join(tmpdir(), 'qiuya-native-source-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const put = async (path, bytes, mode = 0o644) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), bytes, { mode }) }
  for (const name of nativeNames) for (const [path, bytes, mode] of nativeEntries(name)) {
    if (path === 'package/package.json') continue
    if (path.endsWith('windows-manifest.json')) continue
    await put(path.slice('package/'.length), bytes, mode)
  }
  const windows = { version, protocolVersion: 1, artifacts: ['arm64', 'x64'].map(architecture => { const bytes = windowsBinary(architecture); return { file: `win32-${architecture}/qiuya-windows.exe`, platform: 'win32', architecture, protocolVersion: 1, selfContained: true, bytes: bytes.length, sha256: digest(bytes) } }) }
  await put('lib/native/windows-manifest.json', JSON.stringify(windows))
  await put('package.json', JSON.stringify({ ...rootPackage, scripts: { prepare: 'node should-never-run.mjs', prepack: 'node should-never-run.mjs', postpack: 'node should-never-run.mjs', test: 'node consumer-test.mjs' }, devDependencies: { 'not-installed-build-tool': '1.0.0' } }))
  for (const file of ['README.md', 'cordis.patch.yml', 'docs/computer-use-guide.md', 'docs/git-guide.md', 'docs/q-theme-framework.md', 'scripts/computer-agent.mjs', 'lib/index.js', 'lib/client.js', 'lib/computer-agent.js', 'assets/icon-color.webp', 'locale/zh.json']) await put(file, file.endsWith('.json') ? '{}' : file.endsWith('.yml') ? '[]\n' : 'fixture data\n')
  await put('lib/SessionWindow.swift', 'must never ship in native package')
  await put('lib/QiuYaTools Sessions.app/Contents/Info.plist', '<plist/>')
  await put('lib/QiuYaTools Computer.app/Contents/Info.plist', '<plist/>')
  return { root, put }
}
