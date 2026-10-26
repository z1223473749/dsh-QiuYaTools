import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { gunzipSync } from 'node:zlib'

const execute = promisify(execFile)
const rootDirectory = fileURLToPath(new URL('../', import.meta.url))
const repository = 'git+https://github.com/z1223473749/dsh-QiuYaTools.git'
const maximumArchive = 64 * 1024 * 1024
const maximumUnpacked = 256 * 1024 * 1024
const windowsNotices = ['WEBVIEW2-LICENSE.txt', 'WEBVIEW2-NOTICE.txt', 'DOTNET-LICENSE.txt', 'DOTNET-THIRD-PARTY-NOTICES.txt']
const macApps = ['QiuYaTools Sessions.app', 'QiuYaTools Computer.app']

export const nativePackages = Object.freeze([
  { name: 'dsh-qiuya-tools-native-darwin-universal', platform: 'darwin', architecture: 'universal', cpu: ['arm64', 'x64'], manifest: 'lib/macos-manifest.json', executables: ['QiuYaTools Sessions.app/Contents/MacOS/qiuya-session-window', 'QiuYaTools Computer.app/Contents/MacOS/qiuya-computer'] },
  ...['arm64', 'x64'].map(architecture => ({ name: `dsh-qiuya-tools-native-win32-${architecture}`, platform: 'win32', architecture, cpu: [architecture], manifest: 'lib/native/windows-manifest.json', executables: [`win32-${architecture}/qiuya-windows.exe`] })),
].map(value => Object.freeze({ ...value, cpu: Object.freeze(value.cpu), executables: Object.freeze(value.executables) })))

export function nativeOptionalDependencies(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version)) throw Error('Invalid native package version')
  return Object.fromEntries(nativePackages.map(target => [target.name, version]))
}

function targetByName(name) {
  const target = nativePackages.find(value => value.name === name)
  if (!target) throw Error('Unsupported native package identity')
  return target
}

export function nativePackageMetadata(metadata, name) {
  const target = targetByName(name)
  nativeOptionalDependencies(metadata.version)
  if (metadata.name !== 'dsh-qiuya-tools' || metadata.repository?.url !== repository) throw Error('Unexpected parent package identity')
  return {
    name: target.name, version: metadata.version, description: `Precompiled ${target.platform} ${target.architecture} helpers for QiuYaTools`,
    type: 'module', license: metadata.license, repository: metadata.repository,
    main: `./${target.manifest}`, exports: { './package.json': './package.json' },
    os: [target.platform], cpu: [...target.cpu], files: ['lib/', 'LICENSE', 'NOTICE'],
    publishConfig: { access: 'public', registry: 'https://registry.npmjs.org' },
  }
}

function failure(reason) { throw Error(`Invalid native distribution: ${reason}`) }
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const text = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes)
const nullText = bytes => text(bytes.subarray(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0)))
function octal(bytes) {
  const value = nullText(bytes).trim()
  if (!/^[0-7]+$/u.test(value)) failure('invalid tar number')
  const parsed = Number.parseInt(value, 8)
  if (!Number.isSafeInteger(parsed)) failure('invalid tar number')
  return parsed
}
function safePath(path) {
  if (!path.startsWith('package/') || /[\\\x00-\x1f\x7f]/u.test(path) || path.split('/').some(value => !value || value === '.' || value === '..')) failure('unsafe archive path')
  return path
}

/** Read fixed package members without extracting links or running package code. */
export function readDistributionArchive(bytes) {
  if (!bytes.length || bytes.length > maximumArchive) failure('archive size exceeds 64 MiB')
  let archive
  try { archive = gunzipSync(bytes, { maxOutputLength: maximumUnpacked }) } catch { failure('invalid or oversized gzip archive') }
  const files = new Map(), names = new Set()
  let offset = 0, ended = false
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512); offset += 512
    if (header.every(value => value === 0)) {
      if (offset + 512 > archive.length || !archive.subarray(offset).every(value => value === 0)) failure('invalid tar ending')
      ended = true; break
    }
    const expected = octal(header.subarray(148, 156))
    let sum = 0
    for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 32 : header[index]
    if (sum !== expected) failure('tar checksum mismatch')
    const prefix = nullText(header.subarray(345, 500)), leaf = nullText(header.subarray(0, 100))
    const path = safePath((prefix ? `${prefix}/${leaf}` : leaf).replace(/\/$/u, ''))
    const lower = path.toLowerCase()
    if (names.has(lower) || names.size >= 4096) failure('duplicate or excessive archive members')
    names.add(lower)
    const size = octal(header.subarray(124, 136)), type = header[156]
    if (![0, 48, 53].includes(type) || type === 53 && size !== 0) failure('archive must contain only ordinary files and directories')
    if (size > archive.length - offset) failure('truncated tar member')
    if (type !== 53) files.set(path, { bytes: archive.subarray(offset, offset + size), mode: octal(header.subarray(100, 108)) })
    offset += Math.ceil(size / 512) * 512
  }
  if (!ended) failure('missing tar ending')
  return files
}

function jsonMember(files, path) {
  const bytes = files.get(path)?.bytes
  if (!bytes?.length || bytes.length > 128 * 1024) failure('missing or oversized package metadata')
  try { return JSON.parse(text(bytes)) } catch { failure('invalid package metadata') }
}
function architecture(bytes, platform) {
  if (platform === 'win32') {
    if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) failure('invalid Windows executable')
    const offset = bytes.readUInt32LE(60)
    if (offset > bytes.length - 24 || bytes.readUInt32LE(offset) !== 0x4550) failure('invalid Windows executable')
    const machine = bytes.readUInt16LE(offset + 4)
    if (![0xaa64, 0x8664].includes(machine)) failure('unsupported Windows architecture')
    return [machine === 0xaa64 ? 'arm64' : 'x64']
  }
  const cpu = value => value === 0x0100000c ? 'arm64' : value === 0x01000007 ? 'x64' : failure('unsupported Mac architecture')
  const thin = value => {
    if (value.length < 32) failure('invalid Mach-O helper')
    const magic = value.readUInt32LE(0), little = magic === 0xfeedfacf
    if (!little && magic !== 0xcffaedfe) failure('invalid Mach-O helper')
    const uint32 = offset => little ? value.readUInt32LE(offset) : value.readUInt32BE(offset)
    if (uint32(12) !== 2) failure('Mac helper is not executable')
    return cpu(uint32(4))
  }
  if (bytes.length < 8) failure('invalid Mach-O helper')
  const magic = bytes.readUInt32BE(0), fat64 = [0xcafebabf, 0xbfbafeca].includes(magic), little = [0xbebafeca, 0xbfbafeca].includes(magic)
  if (![0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic)) return [thin(bytes)]
  const uint32 = offset => little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset)
  const uint64 = offset => {
    const value = little ? bytes.readBigUInt64LE(offset) : bytes.readBigUInt64BE(offset)
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) failure('invalid universal helper offset')
    return Number(value)
  }
  const count = uint32(4), rowSize = fat64 ? 32 : 20, tableEnd = 8 + count * rowSize, result = [], ranges = []
  if (count < 1 || count > 16 || tableEnd > bytes.length) failure('invalid universal helper')
  for (let index = 0; index < count; index++) {
    const row = 8 + index * rowSize, declared = cpu(uint32(row)), start = fat64 ? uint64(row + 8) : uint32(row + 8), size = fat64 ? uint64(row + 16) : uint32(row + 12), end = start + size
    if (!Number.isSafeInteger(end) || start < tableEnd || size < 32 || end > bytes.length || result.includes(declared) || ranges.some(range => start < range.end && end > range.start) || thin(bytes.subarray(start, end)) !== declared) failure('invalid universal helper slice')
    ranges.push({ start, end }); result.push(declared)
  }
  return result
}

/** Native archives carry data only: no bundle activation, dependency resolution or lifecycle scripts. */
export function validateNativeArchive(bytes, { packageName, version }) {
  const target = targetByName(packageName), files = readDistributionArchive(bytes), metadata = jsonMember(files, 'package/package.json')
  if (metadata.name !== packageName || metadata.version !== version || metadata.type !== 'module' || metadata.repository?.url !== repository) failure('native package identity mismatch')
  if (metadata.main !== `./${target.manifest}` || metadata.exports?.['./package.json'] !== './package.json' || Object.keys(metadata.exports).length !== 1) failure('native package exports mismatch')
  if (JSON.stringify(metadata.os) !== JSON.stringify([target.platform]) || JSON.stringify(metadata.cpu) !== JSON.stringify(target.cpu)) failure('native package platform mismatch')
  for (const key of ['scripts', 'dsh', 'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bin']) if (key in metadata) failure('native package may not execute scripts or contribute dependencies/bundles')
  for (const path of files.keys()) {
    const relative = path.slice('package/'.length)
    const allowed = ['package.json', 'LICENSE', 'NOTICE', target.manifest].includes(relative) || (target.platform === 'darwin'
      ? macApps.some(app => relative.startsWith(`lib/${app}/`))
      : [target.executables[0], ...windowsNotices.map(name => `win32-${target.architecture}/${name}`)].some(file => relative === `lib/native/${file}`))
    if (!allowed || /(?:^|\/)(?:node_modules|\.DS_Store)(?:\/|$)/u.test(relative) || /\.(?:swift|pdb|xml|js|mjs|cjs|sh|ps1|bat|cmd|py)$/u.test(relative)) failure('unexpected file in native package')
  }
  for (const file of ['LICENSE', 'NOTICE', ...(target.platform === 'win32' ? windowsNotices.map(name => `lib/native/win32-${target.architecture}/${name}`) : [])]) if (!files.get(`package/${file}`)?.bytes.length) failure('missing native license or notice')
  const manifest = jsonMember(files, `package/${target.manifest}`)
  if (manifest.version !== version || manifest.protocolVersion !== 1 || !Array.isArray(manifest.artifacts) || manifest.artifacts.length !== target.executables.length) failure('native manifest identity mismatch')
  for (const executable of target.executables) {
    const matches = manifest.artifacts.filter(value => value?.file === executable), payload = files.get(`package/lib/${target.platform === 'win32' ? 'native/' : ''}${executable}`)
    if (matches.length !== 1 || !payload?.bytes.length) failure('missing native executable identity')
    const asset = matches[0]
    if (asset.bytes !== payload.bytes.length || asset.sha256 !== sha256(payload.bytes)) failure('native executable integrity mismatch')
    if (target.platform === 'win32' && (asset.platform !== 'win32' || asset.architecture !== target.architecture || asset.protocolVersion !== 1 || asset.selfContained !== true)) failure('native Windows protocol mismatch')
    if (target.platform === 'darwin' && (payload.mode & 0o111) === 0) failure('Mac helper is not executable')
    if (JSON.stringify(architecture(payload.bytes, target.platform).sort()) !== JSON.stringify([...target.cpu].sort())) failure('native executable architecture mismatch')
  }
  return { name: packageName, version, platform: target.platform, architectures: [...target.cpu], files: [...files.keys()] }
}

/** The universal npm/Git wrapper has no native bytes and resolves its pinned optional payloads at runtime. */
export function validateUniversalArchive(bytes, { version }) {
  const files = readDistributionArchive(bytes), metadata = jsonMember(files, 'package/package.json')
  if (metadata.name !== 'dsh-qiuya-tools' || metadata.version !== version || metadata.repository?.url !== repository || !metadata.dsh?.bundle) failure('universal package identity mismatch')
  if (metadata.scripts !== undefined || metadata.os !== undefined || metadata.cpu !== undefined) failure('universal package must be script-free and platform-neutral')
  const expected = nativeOptionalDependencies(version)
  if (JSON.stringify(Object.entries(metadata.optionalDependencies ?? {}).sort()) !== JSON.stringify(Object.entries(expected).sort())) failure('native optional dependencies must match the exact package version')
  for (const file of ['lib/index.js', 'lib/client.js', 'lib/computer-agent.js', 'cordis.patch.yml']) if (!files.get(`package/${file}`)?.bytes.length) failure('missing universal public entry')
  for (const path of files.keys()) if (path.startsWith('package/lib/') && !['package/lib/index.js', 'package/lib/client.js', 'package/lib/computer-agent.js'].includes(path)) failure('universal package must not carry native files')
  return { name: metadata.name, version, files: [...files.keys()] }
}

async function pack(stage, destination, validate) {
  const temporary = await mkdtemp(join(tmpdir(), 'qiuya-native-pack-'))
  try {
    const args = ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary, `--cache=${join(temporary, 'npm-cache')}`]
    const npmCli = process.env.npm_execpath?.endsWith('npm-cli.js') ? process.env.npm_execpath : join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
    const { stdout } = await execute(process.platform === 'win32' ? process.execPath : 'npm', process.platform === 'win32' ? [npmCli, ...args] : args, { cwd: stage, encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })
    const rows = JSON.parse(stdout)
    if (!Array.isArray(rows) || rows.length !== 1 || !/^[a-z0-9._-]+\.tgz$/u.test(rows[0].filename)) failure('unexpected npm pack result')
    const bytes = await readFile(join(temporary, rows[0].filename)), checked = validate(bytes)
    await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, bytes)
    const metadata = { name: basename(destination), package: checked.name, version: checked.version, platform: checked.platform ?? 'universal', architectures: checked.architectures ?? ['arm64', 'x64'], bytes: bytes.length, sha256: sha256(bytes), status: 'package-validated', signed: false }
    await writeFile(`${destination}.json`, JSON.stringify(metadata, null, 2) + '\n')
    return metadata
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

export async function packageNative(packageName, { root = rootDirectory, output = join(root, 'artifacts') } = {}) {
  const target = targetByName(packageName), parent = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const temporary = await mkdtemp(join(tmpdir(), 'qiuya-native-stage-')), stage = join(temporary, 'package')
  try {
    await mkdir(join(stage, 'lib'), { recursive: true })
    await writeFile(join(stage, 'package.json'), JSON.stringify(nativePackageMetadata(parent, packageName), null, 2) + '\n')
    for (const file of ['LICENSE', 'NOTICE']) await cp(join(root, file), join(stage, file))
    const manifest = JSON.parse(await readFile(join(root, target.manifest), 'utf8'))
    if (target.platform === 'darwin') {
      for (const app of macApps) await cp(join(root, 'lib', app), join(stage, 'lib', app), { recursive: true, filter: path => !path.endsWith('.DS_Store') })
    } else {
      const directory = `lib/native/win32-${target.architecture}`
      await mkdir(join(stage, directory), { recursive: true })
      for (const file of ['qiuya-windows.exe', ...windowsNotices]) await cp(join(root, directory, file), join(stage, directory, file))
      manifest.artifacts = manifest.artifacts.filter(value => value.architecture === target.architecture)
    }
    await mkdir(dirname(join(stage, target.manifest)), { recursive: true })
    await writeFile(join(stage, target.manifest), JSON.stringify(manifest, null, 2) + '\n')
    return await pack(stage, join(output, `${packageName}.tgz`), bytes => validateNativeArchive(bytes, { packageName, version: parent.version }))
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

export async function packageUniversal({ root = rootDirectory, output = join(root, 'artifacts') } = {}) {
  const parent = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')), temporary = await mkdtemp(join(tmpdir(), 'qiuya-universal-stage-')), stage = join(temporary, 'package')
  try {
    const dependencies = nativeOptionalDependencies(parent.version)
    if (JSON.stringify(Object.entries(parent.optionalDependencies ?? {}).sort()) !== JSON.stringify(Object.entries(dependencies).sort())) failure('checkout native dependencies must match the exact package version')
    const metadata = { ...parent, optionalDependencies: dependencies }
    for (const key of ['scripts', 'devDependencies', 'os', 'cpu']) delete metadata[key]
    await mkdir(join(stage, 'lib'), { recursive: true })
    await writeFile(join(stage, 'package.json'), JSON.stringify(metadata, null, 2) + '\n')
    for (const file of ['README.md', 'LICENSE', 'NOTICE', 'cordis.patch.yml']) await cp(join(root, file), join(stage, file))
    for (const file of ['index.js', 'client.js', 'computer-agent.js']) await cp(join(root, 'lib', file), join(stage, 'lib', file))
    for (const directory of ['assets', 'locale']) await cp(join(root, directory), join(stage, directory), { recursive: true, filter: path => !path.endsWith('.DS_Store') })
    for (const file of ['scripts/computer-agent.mjs', 'docs/computer-use-guide.md', 'docs/git-guide.md']) { await mkdir(dirname(join(stage, file)), { recursive: true }); await cp(join(root, file), join(stage, file)) }
    return await pack(stage, join(output, 'dsh-qiuya-tools.tgz'), bytes => validateUniversalArchive(bytes, { version: parent.version }))
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [name = 'all', output = join(rootDirectory, 'artifacts')] = process.argv.slice(2)
  const result = []
  for (const target of name === 'all' ? nativePackages : [targetByName(name)]) result.push(await packageNative(target.name, { output }))
  if (name === 'all') result.push(await packageUniversal({ output }))
  console.log(JSON.stringify(result, null, 2))
}
