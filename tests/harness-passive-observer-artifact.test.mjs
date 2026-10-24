import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, lstat, link, symlink, unlink, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { stagePassiveObserverForProvider } from '../scripts/harness-passive-observer-artifact.mjs'
import { makeMacFullHarnessSource } from '../scripts/macos-full-harness-policy.mjs'

const repository = fileURLToPath(new URL('../', import.meta.url)), exec = promisify(execFile)
const binaryName = 'harness-passive-input-observer', receiptName = binaryName + '.binding.json', hash = value => createHash('sha256').update(value).digest('hex')
async function fixture() {
  const directory = await mkdtemp('/private/tmp/mac-provider-observer-unit-'), sourceDirectory = join(directory, 'source'), providerDirectory = join(directory, 'provider')
  await mkdir(sourceDirectory); await mkdir(providerDirectory)
  // These harmless bytes are never executed. This is a filesystem/bundling
  // contract test, with actualCompilation:false in its explicit test receipt.
  const bytes = Buffer.from('SYNTHETIC OBSERVER FILE - NEVER EXECUTED'), expectedSHA256 = hash(bytes)
  const receipt = { version: 1, binary: { name: binaryName, bytes: bytes.length, sha256: expectedSHA256 }, compileOnly: true, actualCompilation: false, outputExecuted: false, permissionRequests: 0, inputCalls: 0, signals: 0 }
  await writeFile(join(sourceDirectory, binaryName), bytes, { mode: 0o700 })
  await writeFile(join(sourceDirectory, receiptName), JSON.stringify(receipt), { mode: 0o600 })
  return { directory, sourceDirectory, providerDirectory, bytes, receipt, expectedSHA256 }
}

test('real filesystem deployment copies exact prepared bytes/receipt beside provider, exclusive single-link executable, without execution', async () => {
  const f = await fixture(), result = await stagePassiveObserverForProvider(f)
  assert.equal(result.sha256, f.expectedSHA256); assert.equal(result.actualCompilation, false); assert.equal(result.outputExecuted, false)
  const destination = join(f.providerDirectory, binaryName), info = await lstat(destination)
  assert(info.isFile() && info.nlink === 1 && info.uid === process.getuid() && (info.mode & 0o111) !== 0)
  assert.deepEqual(await readFile(destination), f.bytes)
  assert.deepEqual(await readFile(join(f.providerDirectory, receiptName)), await readFile(join(f.sourceDirectory, receiptName)))
})

test('actual esbuild bundle relocates import.meta.url: red missing runtime file, green secure deployment passes binary gate; native spawn is replaced by canary', async () => {
  const f = await fixture(), sourcePath = join(f.sourceDirectory, 'harness-passive-input-source.mjs')
  const original = await readFile(join(repository, 'tests/fixtures/harness-passive-input-source.mjs'), 'utf8')
  assert(original.includes("fileURLToPath(new URL('./harness-passive-input-observer',import.meta.url))"))
  await writeFile(sourcePath, original.replace(/export const HARNESS_PASSIVE_OBSERVER_SHA256='[a-f\d]{64}'/u, "export const HARNESS_PASSIVE_OBSERVER_SHA256='" + f.expectedSHA256 + "'"))
  await writeFile(join(f.sourceDirectory, 'harness-native-observation-binding.mjs'), await readFile(join(repository, 'tests/fixtures/harness-native-observation-binding.mjs')))
  const bundle = join(f.providerDirectory, 'index.mjs'), result = await build({ stdin: { contents: "export {OwnedMacInputSourceTrace} from './harness-passive-input-source.mjs'", resolveDir: f.sourceDirectory }, outfile: bundle, bundle: true, write: false, platform: 'node', format: 'esm' })
  await writeFile(bundle, result.outputFiles[0].contents)
  const canary = join(f.directory, 'no-native-spawn.mjs'), marker = join(f.directory, 'blocked-spawn')
  await writeFile(canary, `import cp from 'node:child_process';import{writeFileSync}from'node:fs';import{syncBuiltinESMExports}from'node:module';cp.spawn=()=>{writeFileSync(${JSON.stringify(marker)},'native spawn replaced; no executable launched');throw Error('NATIVE_SPAWN_CANARY')};syncBuiltinESMExports();`)
  async function probe() {
    const temporary = await mkdtemp('/private/tmp/qiuya-harness-e2e-'), profile = join(temporary, 'qiuya-harness-home'); await mkdir(profile)
    const program = `const {OwnedMacInputSourceTrace}=await import(${JSON.stringify(pathToFileURL(bundle).href)});const value=new OwnedMacInputSourceTrace(${JSON.stringify(profile)});const prepared=await value.prepare('mac-window:1',process.pid);await value.close();console.log(JSON.stringify({prepared,failure:value.failure}));`
    return JSON.parse((await exec(process.execPath, ['--import', canary, '--input-type=module', '-e', program], { timeout: 5000, maxBuffer: 65536 })).stdout)
  }
  const red = await probe()
  assert.deepEqual(red, { prepared: false, failure: { code: 'SOURCE_BINARY_UNSAFE', stage: 'binary' } })
  await assert.rejects(lstat(marker), { code: 'ENOENT' })
  await stagePassiveObserverForProvider(f)
  const green = await probe()
  assert.deepEqual(green, { prepared: false, failure: { code: 'SOURCE_DIAGNOSTIC_FAILED', stage: 'spawn' } })
  assert.equal(await readFile(marker, 'utf8'), 'native spawn replaced; no executable launched')
})

for (const kind of ['source-sha', 'receipt-sha', 'source-symlink', 'source-hardlink', 'receipt-hardlink', 'not-executable', 'zero-digest', 'directory-symlink']) test('real filesystem deployment refuses ' + kind + ' before a runtime artifact is written', async () => {
  const f = await fixture(), source = join(f.sourceDirectory, binaryName)
  if (kind === 'source-sha') await writeFile(source, 'changed bytes')
  if (kind === 'receipt-sha') { f.receipt.binary.sha256 = 'f'.repeat(64); await writeFile(join(f.sourceDirectory, receiptName), JSON.stringify(f.receipt)) }
  if (kind === 'source-symlink') { await unlink(source); const elsewhere = join(f.directory, 'elsewhere'); await writeFile(elsewhere, f.bytes, { mode: 0o700 }); await symlink(elsewhere, source) }
  if (kind === 'source-hardlink') await link(source, join(f.directory, 'second-source-link'))
  if (kind === 'receipt-hardlink') await link(join(f.sourceDirectory, receiptName), join(f.directory, 'second-receipt-link'))
  if (kind === 'not-executable') { await unlink(source); await writeFile(source, f.bytes, { mode: 0o600 }) }
  if (kind === 'zero-digest') f.expectedSHA256 = '0'.repeat(64)
  if (kind === 'directory-symlink') { const real = f.providerDirectory; f.providerDirectory = join(f.directory, 'aliased-provider'); await symlink(real, f.providerDirectory) }
  await assert.rejects(stagePassiveObserverForProvider(f))
  await assert.rejects(lstat(join(f.providerDirectory, binaryName)), { code: 'ENOENT' })
})

for (const kind of ['existing', 'symlink']) test('real filesystem deployment never overwrites a ' + kind + ' runtime destination', async () => {
  const f = await fixture(), destination = join(f.providerDirectory, binaryName), sentinel = join(f.directory, 'sentinel')
  await writeFile(sentinel, 'keep exact original')
  if (kind === 'existing') await writeFile(destination, 'keep exact original')
  else await symlink(sentinel, destination)
  await assert.rejects(stagePassiveObserverForProvider(f), { code: 'EEXIST' })
  assert.equal(await readFile(destination, 'utf8'), 'keep exact original')
  assert.equal(await readFile(sentinel, 'utf8'), 'keep exact original')
})

test('runner deploys before Host and only for selected Mac native computer case; failed full12 profile is retained', async () => {
  const source = await readFile(join(repository, 'scripts/e2e-harness.mjs'), 'utf8'), policy = await readFile(join(repository, 'scripts/macos-full-harness-policy.mjs'), 'utf8')
  const deploy = source.indexOf('const observerDeployment = await stagePassiveObserverForProvider'), host = source.indexOf('host = spawn(')
  assert(deploy > 0 && deploy < host)
  assert(source.includes("process.platform === 'darwin' && (!featureEvidenceOnly || featureEvidenceCases.has('computer-main-agent-tools-and-image-adapter-pipeline'))"))
  assert(policy.includes("report.status === 'passed'"))
})


test('actual generated cleanup expression retains failed/unknown real profile directories and removes only passed/retired own profile', async () => {
  const source=makeMacFullHarnessSource(await readFile(join(repository,'scripts/e2e-harness.mjs'),'utf8'),{repository,snapshot:'/unit/frozen',policySource:'/unit/policy.mjs'})
  const line=source.split('\n').find(value=>value.includes("if (!process.argv.includes('--keep-profile')")&&value.includes('await rm(temporary,'))
  assert(line && line.includes("report.status === 'passed'"))
  const execute=new Function('return async function(process,report,errors,ownedCleanupErrors,host,temporary,rm){'+line+'}')()
  for(const row of[{status:'failed',host:null,retained:true},{status:'passed',host:{exitCode:null,signalCode:null},retained:true},{status:'passed',host:{exitCode:0,signalCode:null},retained:false}]){
    const temporary=await mkdtemp('/private/tmp/mac-observer-retention-unit-')
    await execute({argv:[]},{status:row.status},[],[],row.host,temporary,rm)
    if(row.retained)assert((await lstat(temporary)).isDirectory())
    else await assert.rejects(lstat(temporary),{code:'ENOENT'})
  }
})
