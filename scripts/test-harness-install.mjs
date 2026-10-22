/** Real official plugin-manager install/upgrade/failure/rollback in a disposable profile. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { waitForHarnessHostUrl } from './harness-host-readiness.mjs'
const arg = (name, fallback) => { const at = process.argv.indexOf(name); return at < 0 ? fallback : process.argv[at + 1] }
const current = resolve(arg('--package', 'artifacts/candidates/dsh-qiuya-tools-darwin-universal.tgz'))
const previous = arg('--old-package')
if (!previous) throw new Error('Pass --old-package <previous verified local .tgz>')
const cli = JSON.parse(arg('--cli-json', JSON.stringify(['/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'])))
assert.ok(Array.isArray(cli) && cli.length && cli.every(value => typeof value === 'string'))
const output = resolve(arg('--output', 'artifacts/install-e2e'))
await mkdir(output, { recursive: true })
const temporary = await mkdtemp(join(tmpdir(), 'qiuya-install-e2e-'))
const home = join(temporary, 'home'), profile = join(home, 'profiles', 'web')
const env = { ...process.env, DSH_HOME: home }, checks = []
const sleep = milliseconds => new Promise(done => setTimeout(done, milliseconds))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const packages = [resolve(previous), current], originalHashes = await Promise.all(packages.map(async path => digest(await readFile(path))))
let host
const redact = value => value.replace(/([?&]token=)[^&\s]+/gu, '$1<redacted>')
async function command(args, expectedSuccess = true) {
  return new Promise((done, reject) => {
    const process = spawn(cli[0], [...cli.slice(1), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''; process.stdout.on('data', chunk => { log += chunk }); process.stderr.on('data', chunk => { log += chunk })
    const timer = setTimeout(() => { process.kill(); reject(new Error('Isolated official plugin-manager command timed out')) }, 120000)
    process.once('error', error => { clearTimeout(timer); reject(error) })
    process.once('exit', code => { clearTimeout(timer); (code === 0) === expectedSuccess ? done({ code, log: redact(log) }) : reject(new Error(redact(log).slice(-5000))) })
  })
}
async function stop() {
  const child = host; host = undefined
  if (!child || child.exitCode !== null || child.signalCode) return
  child.stdin.end(); child.kill()
  await Promise.race([new Promise(done => child.once('exit', done)), sleep(5000).then(() => child.kill('SIGKILL'))])
}
async function loaded() {
  const metadata = JSON.parse(await readFile(join(profile, 'node_modules/dsh-qiuya-tools/package.json'), 'utf8'))
  host = spawn(cli[0], [...cli.slice(1), '--profile', 'web', '--no-open', '--port', '0'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let log = ''; const append = chunk => { log += chunk }; host.stdout.on('data', append); host.stderr.on('data', append)
  const url = await waitForHarnessHostUrl(() => ({
    exited: host.exitCode !== null || host.signalCode !== null,
    error: redact(log).slice(-5000),
    url: log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/u)?.[0],
  }))
  const bootstrap = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
  assert.equal(bootstrap.status, 303)
  const cookie = bootstrap.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  assert.ok(cookie, 'The real Host must issue its owner cookie')
  const response = await fetch(new URL('/', url), { headers: { cookie }, signal: AbortSignal.timeout(10000) })
  assert.equal(response.status, 200); assert.match(await response.text(), /<html/iu)
  assert.doesNotMatch(log, /ERR_MODULE_NOT_FOUND|SyntaxError|Failed to resolve package/u)
  await stop()
  return metadata.version
}
async function check(name, operation) { const start = Date.now(); const details = await operation(); checks.push({ name, status: 'passed', elapsedMs: Date.now() - start, ...details }); console.log(`PASS ${name}`) }
try {
  await command(['--profile', 'web', '--dump-config'])
  await check('previous-version-clean-install-and-real-host-start', async () => {
    await command(['plugin', '--profile', 'web', 'add', packages[0]])
    return { version: await loaded() }
  })
  const patch = join(profile, 'cordis.patch.yml')
  // This is a freshly created test profile: replace its empty [] document with
  // one valid JSON/YAML patch array, rather than appending a second YAML root.
  await writeFile(patch, JSON.stringify([{ id: 'qiuya-tools', config: { pasteCharacterThreshold: 4321, pasteLineThreshold: 23, qThemeEnabled: true } }], null, 2) + '\n')
  const saved = await readFile(patch, 'utf8')
  let upgradedVersion
  await check('candidate-upgrade-restart-and-settings-preserved', async () => {
    await command(['plugin', '--profile', 'web', 'add', current]); upgradedVersion = await loaded()
    assert.equal(await readFile(patch, 'utf8'), saved)
    return { version: upgradedVersion, settings: { pasteCharacterThreshold: 4321, pasteLineThreshold: 23, qThemeEnabled: true } }
  })
  await check('broken-package-install-fails-and-current-version-still-starts', async () => {
    const corrupt = join(temporary, 'broken.tgz'); await writeFile(corrupt, 'This is intentionally not a tar archive.')
    await command(['plugin', '--profile', 'web', 'add', corrupt], false)
    assert.equal(await loaded(), upgradedVersion); assert.equal(await readFile(patch, 'utf8'), saved)
    return { version: upgradedVersion }
  })
  await check('explicit-rollback-restart-and-settings-preserved', async () => {
    await command(['plugin', '--profile', 'web', 'add', packages[0]])
    const version = await loaded(); assert.equal(version, checks[0].version)
    assert.equal(await readFile(patch, 'utf8'), saved)
    return { version }
  })
  await check('candidate-reinstall-after-rollback', async () => {
    await command(['plugin', '--profile', 'web', 'add', current]); assert.equal(await loaded(), upgradedVersion)
    assert.equal(await readFile(patch, 'utf8'), saved)
    assert.deepEqual(await Promise.all(packages.map(async path => digest(await readFile(path)))), originalHashes)
    return { version: upgradedVersion }
  })
  await writeFile(join(output, 'report.json'), JSON.stringify({ status: 'passed', kind: 'official-Harness-plugin-manager-disposable-profile', platform: process.platform, architecture: process.arch, checks, candidateSha256: originalHashes[1], previousSha256: originalHashes[0], isolation: true, limitations: ['This verifies local official-manager replacement and recovery; GitHub download, updater UI and platform validation have separate tests.'], testedAt: new Date().toISOString() }, null, 2))
} catch (error) {
  await writeFile(join(output, 'report.json'), JSON.stringify({ status: 'failed', checks, reason: redact(error.message) }, null, 2)); console.error(redact(error.message)); process.exitCode = 1
} finally { await stop(); await rm(temporary, { recursive: true, force: true }) }
