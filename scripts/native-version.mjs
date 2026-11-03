import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const defaultRoot = fileURLToPath(new URL('../', import.meta.url))
const nativeNames = ['dsh-qiuya-tools-native-darwin-universal', 'dsh-qiuya-tools-native-win32-arm64', 'dsh-qiuya-tools-native-win32-x64']
const inputs = ['src/native/macos', 'src/native/windows', 'src/features/session-windows/SessionWindow.swift', 'src/features/session-windows/build-helper.mjs', 'scripts/build-macos-computer.mjs', 'scripts/macos-computer-build-cache.mjs', 'scripts/build-windows-native.mjs', 'assets/icon-color.webp']

/** Include new source files; exclude compiler intermediates and diagnostic fixtures. */
export async function nativeSourceDigest(root = defaultRoot) {
  const files = []
  async function visit(path) {
    const entries = await readdir(join(root, path), { withFileTypes: true })
    for (const entry of entries) {
      if (['bin', 'obj', 'fixtures'].includes(entry.name)) continue
      const child = `${path}/${entry.name}`
      if (entry.isDirectory()) await visit(child)
      else if (/\.(?:swift|cs|csproj|json|manifest|txt)$/u.test(entry.name)) files.push(child)
    }
  }
  for (const path of inputs) {
    if (path === 'src/native/macos' || path === 'src/native/windows') await visit(path)
    else files.push(path)
  }
  const hash = createHash('sha256')
  for (const path of files.sort()) hash.update(path).update('\0').update(await readFile(join(root, path))).update('\0')
  return hash.digest('hex')
}

export async function checkNativeVersion(root = defaultRoot) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const receipt = JSON.parse(await readFile(join(root, 'native-sources.json'), 'utf8'))
  if (receipt.version !== pkg.qiuyaNative?.version || receipt.sha256 !== await nativeSourceDigest(root)) throw Error('Native sources changed: run node scripts/native-version.mjs <new-native-version> before releasing')
  if (nativeNames.some(name => pkg.optionalDependencies?.[name] !== receipt.version)) throw Error('Native optional dependencies must pin qiuyaNative.version')
}

export async function setNativeVersion(version, root = defaultRoot) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)) throw Error('Expected a stable native version')
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (version === pkg.qiuyaNative?.version) throw Error('Native changes require a new immutable version')
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
  pkg.qiuyaNative = { ...pkg.qiuyaNative, version }
  for (const name of nativeNames) {
    pkg.optionalDependencies[name] = version
    const entry = lock.packages[`node_modules/${name}`]
    entry.version = version
    entry.resolved = `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`
    delete entry.integrity
  }
  lock.packages[''].optionalDependencies = pkg.optionalDependencies
  for (const [path, value] of [['package.json', pkg], ['package-lock.json', lock], ['native-sources.json', { version, sha256: await nativeSourceDigest(root) }]]) await writeFile(join(root, path), JSON.stringify(value, null, 2) + '\n')
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] === '--check') await checkNativeVersion()
  else await setNativeVersion(process.argv[2])
  console.log('Native version and source fingerprint verified')
}
