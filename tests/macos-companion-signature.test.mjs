import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile), application = fileURLToPath(new URL('../lib/QiuYaTools Computer.app/', import.meta.url))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

test('the real Mac companion binds its fixed app identity, branded resource and post-signing executable manifest', { skip: process.platform !== 'darwin' }, async () => {
  await run('/usr/bin/codesign', ['--verify', '--strict', application])
  const { stderr } = await run('/usr/bin/codesign', ['--display', '--verbose=2', application])
  assert.match(stderr, /^Identifier=com\.qiuya\.tools\.computer-use$/mu)
  assert.doesNotMatch(stderr, /Info\.plist=not bound|Sealed Resources=none/u)
  const plist = join(application, 'Contents/Info.plist')
  assert.equal((await run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist])).stdout.trim(), 'com.qiuya.tools.computer-use')
  assert.equal((await run('/usr/bin/plutil', ['-extract', 'CFBundleIconFile', 'raw', '-o', '-', plist])).stdout.trim(), 'QiuYaTools.icns')
  assert.equal((await readFile(join(application, 'Contents/Resources/QiuYaTools.icns'))).subarray(0, 4).toString(), 'icns')
  const manifest = JSON.parse(await readFile(new URL('../lib/macos-manifest.json', import.meta.url), 'utf8'))
  const record = manifest.artifacts.find(row => row.file === 'QiuYaTools Computer.app/Contents/MacOS/qiuya-computer')
  const executable = await readFile(join(application, 'Contents/MacOS/qiuya-computer'))
  assert.equal(record.bytes, executable.length); assert.equal(record.sha256, sha(executable))
})

test('changing the authorization app identity or drag icon invalidates a copied sealed companion without touching the original', { skip: process.platform !== 'darwin' }, async t => {
  const work = await mkdtemp(join(tmpdir(), 'qiuya-app-seal-'))
  t.after(() => rm(work, { recursive: true, force: true }))
  const identityCopy = join(work, 'Identity.app'), iconCopy = join(work, 'Icon.app')
  await cp(application, identityCopy, { recursive: true }); await cp(application, iconCopy, { recursive: true })
  await run('/usr/bin/codesign', ['--verify', '--strict', identityCopy])
  await run('/usr/bin/codesign', ['--verify', '--strict', iconCopy])
  await run('/usr/bin/plutil', ['-replace', 'CFBundleIdentifier', '-string', 'com.qiuya.unrelated', join(identityCopy, 'Contents/Info.plist')])
  await assert.rejects(run('/usr/bin/codesign', ['--verify', '--strict', identityCopy]))
  const icon = join(iconCopy, 'Contents/Resources/QiuYaTools.icns'), bytes = await readFile(icon)
  await writeFile(icon, Buffer.concat([bytes, Buffer.from('copied-resource-tamper-only')]))
  await assert.rejects(run('/usr/bin/codesign', ['--verify', '--strict', iconCopy]))
  await run('/usr/bin/codesign', ['--verify', '--strict', application])
})
