import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { platform, arch, release } from 'node:os'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const index = process.argv.indexOf('--output'), output = resolve(index < 0 ? 'artifacts/computer-use/preflight' : process.argv[index + 1])
const targetIndex = process.argv.indexOf('--target'), target = targetIndex < 0 ? 'local' : process.argv[targetIndex + 1]
if (target !== 'local') throw new Error('Run this preflight inside the selected guest for its actual interactive desktop; use the PD native runner to dispatch guest tests')
await mkdir(output, { recursive: true })
const compiled = await build({ entryPoints: [join(root, 'src/features/computer-use/native.ts')], bundle: true, write: false, platform: 'node', format: 'esm' })
const { NativeCompanionDriver, computerCompanionPath } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
const checks = [], pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const record = (id, passed, detail) => checks.push({ id, status: passed ? 'passed' : 'blocked', detail })
let driver, native
try {
  const executable = computerCompanionPath(platform(), arch(), new URL('../lib/', import.meta.url))
  await access(executable)
  record('native-payload-present', true, { platform: platform(), architecture: arch() })
  const manifestPath = platform() === 'darwin' ? 'lib/macos-manifest.json' : 'lib/native/windows-manifest.json'
  const manifest = JSON.parse(await readFile(join(root, manifestPath), 'utf8'))
  let integrity = manifest.version === pkg.version
  for (const asset of manifest.artifacts) {
    const path = join(root, 'lib', platform() === 'win32' ? 'native' : '', asset.file)
    const bytes = await readFile(path)
    integrity &&= bytes.length === asset.bytes && createHash('sha256').update(bytes).digest('hex') === asset.sha256
  }
  record('native-manifest-integrity', integrity, { packageVersion: pkg.version })
  driver = new NativeCompanionDriver({ executable })
  native = await driver.status()
  record('native-protocol', native.available === true && native.protocolVersion === 1, { available: native.available, protocolVersion: native.protocolVersion, message: native.message })
  const required = platform() === 'darwin' ? ['screenRecording', 'accessibility', 'postEvents'] : ['screen', 'accessibility']
  for (const permission of required) record(`permission-${permission}`, native.permissions?.[permission] === true, 'Read-only check; this script never grants or changes OS permissions')
  if (platform() === 'darwin') {
    const { stdout } = await promisify(execFile)('/usr/bin/swift', ['-e', 'import CoreGraphics; let session = CGSessionCopyCurrentDictionary() as? [String:Any]; print((session?["CGSSessionScreenIsLocked"] as? Bool) == true ? "locked" : "unlocked")'], { timeout: 20000 })
    record('session-unlocked', stdout.trim() === 'unlocked', 'A locked Mac cannot perform native foreground input. The owner must unlock it; no login settings are modified.')
  }
} catch (error) { record('preflight-execution', false, error.message) }
finally { await driver?.dispose().catch(error => record('native-cleanup', false, error.message)) }
const report = { status: checks.every(check => check.status === 'passed') ? 'passed' : 'blocked', packageVersion: pkg.version, environment: { platform: platform(), architecture: arch(), osRelease: release(), node: process.versions.node }, native, checks, testedAt: new Date().toISOString(), note: 'Preflight proves readiness only; it does not inject input, start a model, or substitute for desktop E2E.' }
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
if (report.status !== 'passed') process.exitCode = 2
