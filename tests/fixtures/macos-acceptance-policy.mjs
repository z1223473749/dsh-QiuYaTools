/**
 * Portable unit inputs for the historical Mac acceptance preparation policies.
 * Only their reviewed file paths and SHA256 pins are rebound in a temporary
 * copy. The production policy, its assertions, and its generated plan stay
 * intact. These archives/runtimes cannot establish actual Mac acceptance.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'

const repository = fileURLToPath(new URL('../../', import.meta.url))
const execute = promisify(execFile)
export const acceptanceFixtureHash = bytes => createHash('sha256').update(bytes).digest('hex')
const historicalCandidate = '/Users/qiuya/QiuYaTools-验收/2026-10-22/安装包/Mac-键盘修复-66ae-验证包/dsh-qiuya-tools-darwin-universal.tgz'
const historicalCandidateSHA256 = '9b828d9bac4b08291bbdcef151096fcc2903b8fbbc87ae03a4f6ba26b3c5e6f3'

export async function macAcceptancePolicyFixture(t, kind) {
  assert(['file-exchange', 'install'].includes(kind))
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'qiuya-mac-policy-unit-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await symlink(join(repository, 'node_modules'), join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  const bundled = await build({ entryPoints: [join(repository, 'src/features/computer-use/remote.ts')], bundle: true, write: false, platform: 'node', format: 'esm' })
  const bundle = bundled.outputFiles[0].text
  const helper = Buffer.from('SYNTHETIC UNIT INPUT: not a Mach-O executable; never run as Mac acceptance.\n')
  const payload = join(directory, 'payload'), packageRoot = join(payload, 'package')
  const helperPath = join(packageRoot, 'lib/QiuYaTools Computer.app/Contents/MacOS/qiuya-computer')
  await mkdir(dirname(helperPath), { recursive: true })
  await writeFile(helperPath, helper, { mode: 0o600 })
  await writeFile(join(packageRoot, 'lib/computer-agent.js'), bundle)
  await writeFile(join(packageRoot, 'lib/index.js'), '// Synthetic unit archive: never loaded by Harness.\n')
  await writeFile(join(packageRoot, 'lib/client.js'), '// Synthetic unit archive: no client or GUI startup.\n')
  const writeMetadata = version => writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'dsh-qiuya-tools', version, type: 'module', syntheticUnitFixture: true }))
  const candidate = join(directory, 'synthetic-candidate.tgz'), previous = join(directory, 'synthetic-previous.tgz')
  await writeMetadata('0.6.0-test.fixture')
  await execute('/usr/bin/tar', ['-czf', candidate, '-C', payload, 'package'])
  await writeMetadata('0.5.2-test.fixture')
  await execute('/usr/bin/tar', ['-czf', previous, '-C', payload, 'package'])
  const candidateBytes = await readFile(candidate), previousBytes = await readFile(previous)
  const candidateSHA256 = acceptanceFixtureHash(candidateBytes), previousSHA256 = acceptanceFixtureHash(previousBytes), helperSHA256 = acceptanceFixtureHash(helper)
  const sourcePath = join(repository, `scripts/prepare-macos-${kind}-acceptance.mjs`)
  let source = await readFile(sourcePath, 'utf8')
  const replace = (before, after) => {
    assert.equal(source.split(before).length, 2, 'Expected exactly one fixture binding: ' + before)
    source = source.replace(before, after)
  }
  replace(historicalCandidate, candidate)
  replace(historicalCandidateSHA256, candidateSHA256)
  const runtimes = []
  if (kind === 'install') {
    replace("join(repository, 'artifacts/harness-e2e/windows-feature-evidence-prepared-7da13ea6-3146-4a71-83cb-c6158247d8d0/packages/dsh-qiuya-tools-0.5.2.tgz')", JSON.stringify(previous))
    replace('c30441ec6cf75ec12963ad3e1b46911fbebe10d10259773ed93576b86c0fc0a7', previousSHA256)
    replace('66ae37d056385e3053724a07a982993c9f8356481666b2d8ee59f65d1356e502', helperSHA256)
    for (const [name, original] of [
      ['cli', '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'],
      ['host', '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'],
      ['asar', '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'],
    ]) {
      const path = join(directory, `synthetic-${name}`)
      await writeFile(path, `SYNTHETIC ${name}: hash-binding input only; never executable.\n`, { mode: 0o600 })
      // The CLI hash list refers back to cli[0], preserving the same binding.
      replace(original, path)
      runtimes.push(path)
    }
  }
  const policySource = join(directory, 'unit-policy.mjs')
  await writeFile(policySource, source)
  const policy = await import(pathToFileURL(policySource).href)
  const marker = join(directory, 'unexpected-execution'), preload = join(directory, 'no-execution.mjs')
  await writeFile(preload, `import fs from 'node:fs';import child from 'node:child_process';import net from 'node:net';import http from 'node:http';import https from 'node:https';import {syncBuiltinESMExports} from 'node:module';const forbid=()=>{fs.appendFileSync(${JSON.stringify(marker)},'Unexpected process/network execution\\n');throw Error('Unit plan must not start Host, GUI, browser, PD or network')};for(const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])child[key]=forbid;net.connect=forbid;net.createConnection=forbid;http.request=forbid;http.get=forbid;https.request=forbid;https.get=forbid;globalThis.fetch=forbid;syncBuiltinESMExports();`)
  return {
    repository, directory, candidate, previous, candidateBytes, previousBytes, candidateSHA256, previousSHA256, helperSHA256, bundle, runtimes, policy,
    async prepare() {
      const result = await (kind === 'install' ? policy.prepareMacInstallAcceptance : policy.prepareMacFileExchangeAcceptance)({ repository })
      t.after(() => rm(result.base, { recursive: true, force: true }))
      return result
    },
    async plan(entry) {
      return JSON.parse((await execute(process.execPath, ['--import', preload, entry, '--plan'], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 })).stdout)
    },
    marker,
  }
}
