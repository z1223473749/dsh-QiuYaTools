import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const root = new URL('../', import.meta.url)
const executable = new URL('../lib/QiuYaTools Sessions.app/Contents/MacOS/qiuya-session-window', import.meta.url)
if (process.platform !== 'darwin') throw new Error('Publish the native release on macOS')
const inspected = spawnSync('/usr/bin/lipo', ['-archs', fileURLToPath(executable)], { encoding: 'utf8' })
if (inspected.status !== 0 || !inspected.stdout.includes('arm64') || !inspected.stdout.includes('x86_64')) {
  throw new Error('Release requires a universal helper; build with QIUYA_TOOLS_UNIVERSAL=1')
}
const original = new URL(`artifacts/${pkg.name}-${pkg.version}.tgz`, root)
const names = ['dsh-qiuya-tools.tgz', 'dsh-qiuya-tools-darwin-universal.tgz']
const lines = []
for (const name of names) {
  const target = new URL(`artifacts/${name}`, root)
  await copyFile(original, target)
  lines.push(`${createHash('sha256').update(await readFile(target)).digest('hex')}  ${name}`)
}
await writeFile(new URL('artifacts/SHA256SUMS', root), `${lines.join('\n')}\n`)
console.log(`Prepared ${pkg.version}: universal macOS release and checksums`)
