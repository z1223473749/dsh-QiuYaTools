import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { packageCandidate } from './package-candidates.mjs'
import { verifyPackage } from './verify-package.mjs'
import { verifyReleaseSources } from './release-source-guard.mjs'
import { nativePackages, packageNative, packageUniversal } from './package-native.mjs'

// Assemble only local assets. Publishing remains a separate workflow step.
if (process.platform !== 'darwin') throw new Error('Assemble the universal Mac and Windows release on macOS')
const root = fileURLToPath(new URL('../', import.meta.url))
const output = join(root, 'artifacts')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const { sourceCommit, productionSourceStatus } = await verifyReleaseSources({ root })
const assets = []
for (const [platform, architecture] of [['darwin', 'universal'], ['win32', 'arm64'], ['win32', 'x64']]) {
  // Validates platform manifests, native architecture, both Mac helpers and the
  // existing 64 MiB archive limit. Missing native builds fail before publication.
  const asset = await packageCandidate(platform, architecture, output)
  await verifyPackage(join(output, asset.name))
  assets.push(asset)
}
// Git/npm share a platform-neutral wrapper. Its data-only optional native
// packages are installed by pnpm before activation, without build scripts.
const alias = 'dsh-qiuya-tools.tgz'
const nativeAssets = []
for (const target of nativePackages) nativeAssets.push(await packageNative(target.name, { root, output }))
const universal = await packageUniversal({ root, output })
await verifyPackage(join(output, alias))
const names = [alias, ...assets.map(asset => asset.name), ...nativeAssets.map(asset => asset.name)]
const lines = []
for (const name of names) lines.push(`${createHash('sha256').update(await readFile(join(output, name))).digest('hex')}  ${name}`)
await writeFile(join(output, 'SHA256SUMS'), `${lines.join('\n')}\n`)
await writeFile(join(output, 'release-assets.json'), JSON.stringify({
  version: pkg.version, status: 'assembled-and-validated-not-published',
  npmAsset: { ...universal, platform: 'universal', nativePackages: nativeAssets.map(asset => asset.package) },
  nativeAssets, assets, signed: false,
}, null, 2) + '\n')
const shippedFiles = {}
for (const file of ['lib/index.js', 'lib/client.js', 'lib/computer-agent.js', 'package.json', 'README.md', 'docs/computer-use-guide.md', 'docs/git-guide.md', 'scripts/computer-agent.mjs']) {
  shippedFiles[file] = createHash('sha256').update(await readFile(join(root, file))).digest('hex')
}
await writeFile(join(output, 'delivery-manifest.json'), JSON.stringify({
  version: pkg.version, sourceCommit,
  productionSourceStatus,
  packages: [universal, ...assets, ...nativeAssets],
  nativeManifests: {
    mac: JSON.parse(await readFile(join(root, 'lib/macos-manifest.json'), 'utf8')),
    windows: JSON.parse(await readFile(join(root, 'lib/native/windows-manifest.json'), 'utf8')),
  },
  shippedFiles, signatureStatus: 'local-beta-not-signed-or-notarized',
  publicationStatus: 'not-pushed-not-published', createdAt: new Date().toISOString(),
}, null, 2) + '\n')
console.log(`Prepared ${pkg.version}: three complete platform archives, three data-only native packages, universal npm wrapper and checksums; no publication performed`)
