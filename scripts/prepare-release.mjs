import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { packageCandidate } from './package-candidates.mjs'
import { verifyPackage } from './verify-package.mjs'

// Assemble only local assets. Publishing remains a separate workflow step.
if (process.platform !== 'darwin') throw new Error('Assemble the universal Mac and Windows release on macOS')
const root = fileURLToPath(new URL('../', import.meta.url))
const output = join(root, 'artifacts')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const assets = []
for (const [platform, architecture] of [['darwin', 'universal'], ['win32', 'arm64'], ['win32', 'x64']]) {
  // Validates platform manifests, native architecture, both Mac helpers and the
  // existing 64 MiB archive limit. Missing native builds fail before publication.
  const asset = await packageCandidate(platform, architecture, output)
  await verifyPackage(join(output, asset.name))
  assets.push(asset)
}
// Keep the existing npm release identity. It contains the universal Mac build;
// Windows installations and updates use their explicit architecture assets.
const alias = 'dsh-qiuya-tools.tgz'
await copyFile(join(output, assets[0].name), join(output, alias))
await verifyPackage(join(output, alias))
const names = [alias, ...assets.map(asset => asset.name)]
const lines = []
for (const name of names) lines.push(`${createHash('sha256').update(await readFile(join(output, name))).digest('hex')}  ${name}`)
await writeFile(join(output, 'SHA256SUMS'), `${lines.join('\n')}\n`)
await writeFile(join(output, 'release-assets.json'), JSON.stringify({
  version: pkg.version, status: 'assembled-and-validated-not-published',
  npmAsset: { name: alias, platform: 'darwin', architectures: ['arm64', 'x64'] },
  assets, signed: false,
}, null, 2) + '\n')
console.log(`Prepared ${pkg.version}: universal Mac, Windows ARM64, Windows x64 and checksums; no publication performed`)
