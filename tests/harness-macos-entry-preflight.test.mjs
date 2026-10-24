import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { assertHarnessMacEntryPrepared, MAC_NATIVE_PREPARATION_REQUIRED } from '../scripts/harness-macos-entry-preflight.mjs'
import { makeMacFullHarnessSource, makeMacFileExchangeSource } from '../scripts/macos-full-harness-policy.mjs'

const exec = promisify(execFile), repository = fileURLToPath(new URL('../', import.meta.url))
const entry = join(repository, 'scripts/e2e-harness.mjs')

test('Mac native public entry rejects even Root flags; Windows and strictly selected headless subsets remain allowed', () => {
  for (const argv of [[], ['--root-approved', '--gui-gate', 'root-approved'], ['--prepared-mac-full12'], ['--feature-evidence-only']]) {
    assert.throws(() => assertHarnessMacEntryPrepared({ platform: 'darwin', argv }), error => error.code === MAC_NATIVE_PREPARATION_REQUIRED && error.message.includes('prepare-macos-full-harness-acceptance.mjs'))
  }
  for (const selection of [{ platform: 'win32' }, { platform: 'darwin', argv: ['--pasted-text-only'] }, { platform: 'darwin', prepared: true }, { platform: 'darwin', headlessSubset: true }]) assert.doesNotThrow(() => assertHarnessMacEntryPrepared({ argv: [], ...selection }))
})

async function isolation() {
  const directory = await mkdtemp('/private/tmp/mac-public-entry-unit-'), marker = join(directory, 'forbidden-boundary.json'), preload = join(directory, 'canary.mjs')
  // Real child execution below may only import/read source or reach the missing
  // synthetic archive. A Host/browser/process/network call would fail this test.
  await writeFile(preload, `import cp from 'node:child_process'; import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import {writeFileSync} from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
Object.defineProperty(process,'platform',{value:'darwin'});
const stop = boundary => {writeFileSync(${JSON.stringify(marker)},JSON.stringify({boundary}));throw Error('FORBIDDEN_BOUNDARY:'+boundary)};
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[name]=()=>stop('process:'+name);
for(const [name,module]of [['http',http],['https',https]])for(const operation of ['request','get','createServer'])module[operation]=()=>stop(name+':'+operation);
for(const name of ['connect','createConnection','createServer'])net[name]=()=>stop('net:'+name);net.Socket.prototype.connect=function(){return stop('socket:connect')};globalThis.fetch=()=>stop('fetch');syncBuiltinESMExports();
`)
  return { directory, marker, preload, output: join(directory, 'output'), screenshots: join(directory, 'screenshots'), missing: join(directory, 'missing-candidate.tgz') }
}

async function child(fixture, target, flags = [], { imported = false } = {}) {
  const args = ['--package', fixture.missing, '--output', fixture.output, '--screenshots-dir', fixture.screenshots, ...flags]
  let actual = target
  if (imported) {
    actual = join(fixture.directory, 'import-entry.mjs')
    await writeFile(actual, `process.argv = ${JSON.stringify([process.execPath, target, ...args])}; await import(${JSON.stringify(pathToFileURL(target).href)});`)
  }
  try { await exec(process.execPath, ['--import', fixture.preload, actual, ...(imported ? [] : args)], { timeout: 10000, maxBuffer: 1024 * 1024, env: { ...process.env, QIUYA_MAC_FULL12_PREPARED: '1', QIUYA_PASSIVE_INPUT_SOURCE: '0' } }); throw Error('Missing expected early stop') }
  catch (error) {
    assert.equal(error.code, 1, error.stderr ?? error.message)
    assert(!error.stderr.includes('FORBIDDEN_BOUNDARY'), error.stderr)
    await assert.rejects(lstat(fixture.marker), { code: 'ENOENT' })
    return error.stderr
  }
}

for (const imported of [false, true]) test('actual Node ' + (imported ? 'import' : 'public CLI') + ' rejects unprepared Mac before output/Host/browser/network, despite forged flags/environment', async () => {
  const fixture = await isolation(), stderr = await child(fixture, entry, ['--root-approved', '--gui-gate', 'root-approved', '--prepared-mac-full12'], { imported })
  assert(stderr.includes(MAC_NATIVE_PREPARATION_REQUIRED))
  assert(stderr.includes('Mac 原生兼容验收需要先绑定当前候选包、组件和源码'))
  assert(stderr.includes('prepare-macos-full-harness-acceptance.mjs'))
  await assert.rejects(lstat(fixture.output), { code: 'ENOENT' })
  await assert.rejects(lstat(fixture.screenshots), { code: 'ENOENT' })
})

test('actual Node pasted-text-only public entry passes preflight and reaches missing archive without any program/network call', async () => {
  const fixture = await isolation(), stderr = await child(fixture, entry, ['--pasted-text-only'])
  assert(stderr.includes('ENOENT') && stderr.includes('missing-candidate.tgz'))
  assert(!stderr.includes(MAC_NATIVE_PREPARATION_REQUIRED))
  assert((await lstat(fixture.output)).isDirectory())
})

test('full12 and file-only transformers bind distinct explicit entry selections, never a command-line bypass', async () => {
  const original = await readFile(entry, 'utf8'), options = { repository, snapshot: '/unit/frozen', policySource: '/unit/policy.mjs', providerSource: '/unit/provider.mjs' }
  const full = makeMacFullHarnessSource(original, options), headless = makeMacFileExchangeSource(original, options)
  assert(full.includes('assertHarnessMacEntryPrepared({ prepared: true, headlessSubset: false })'))
  assert(headless.includes('assertHarnessMacEntryPrepared({ prepared: false, headlessSubset: true })'))
  assert(!full.includes('assertHarnessMacEntryPrepared({ prepared: false, headlessSubset: false })'))
  assert(!headless.includes('assertHarnessMacEntryPrepared({ prepared: false, headlessSubset: false })'))
  assert(original.indexOf('assertHarnessMacEntryPrepared({ prepared: false') < original.indexOf('await mkdir(output'))
})
