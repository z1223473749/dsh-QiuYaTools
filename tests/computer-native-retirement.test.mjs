import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const directory = await mkdtemp(join(tmpdir(), 'qiuya-retirement-'))
test.after(() => rm(directory, { recursive: true, force: true }))
const output = await build({ entryPoints: ['src/features/computer-use/native-retirement.ts'], bundle: true, write: false, format: 'esm', platform: 'node' })
const retirementModule = join(directory, 'retirement.mjs')
await writeFile(retirementModule, output.outputFiles[0].text)
const { waitForComputerRetirement } = await import(pathToFileURL(retirementModule).href)
let sequence = 0
async function fixture(t, { receipt = 'valid', exitAfter = 1800, early = false, repeat = false, oversized = false } = {}) {
  const file = join(directory, `worker-${++sequence}.cjs`)
  const value = receipt === 'valid' ? { event: 'inputReleased', passed: true } : receipt === 'false' ? { event: 'inputReleased', passed: false } : receipt === 'extra' ? { event: 'inputReleased', passed: true, pid: 999 } : { event: 'inputCleanupFailed' }
  await writeFile(file, `const message=${JSON.stringify(value)},send=()=>process.stdout.write(JSON.stringify(message)+'\\n');const alive=setInterval(()=>{},1000);if(${early})send();process.stdout.write('ready\\n');process.stdin.resume();process.stdin.once('end',()=>{if(${oversized})process.stdout.write('x'.repeat(2097152)+'\\n');if(!${early})send();if(${repeat})setInterval(send,150);if(${exitAfter}>=0)setTimeout(()=>{process.stdout.write(JSON.stringify({event:'browserShutdown',passed:true})+'\\n');clearInterval(alive);process.exit(0)},${exitAfter})});`)
  const child = spawn(process.execPath, [file], { stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdout.setEncoding('utf8'); child.stderr.resume()
  await once(child.stdout, 'data')
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'close') }
  })
  return child
}
test('Windows timely input release permits a real browser drain beyond the old 1500ms, without a signal', async t => {
  const child = await fixture(t), started = performance.now()
  const result = await waitForComputerRetirement(child, 'win32')
  assert.deepEqual(result, { inputReleased: true, browserShutdownPassed: true, forced: false, code: 0, signal: null })
  assert(performance.now() - started >= 1700)
  assert.equal(child.stdout.listenerCount('data'), 0)
})
for (const receipt of ['false', 'extra', 'failure']) test(`Windows ${receipt} receipt cannot extend the input release deadline`, async t => {
  const child = await fixture(t, { receipt, exitAfter: -1 }), started = performance.now()
  const result = await waitForComputerRetirement(child, 'win32')
  assert.equal(result.inputReleased, false); assert.equal(result.forced, true)
  assert.equal(result.signal, 'SIGKILL'); assert(performance.now() - started >= 1400)
})
test('an ACK emitted before retirement cannot extend its later deadline', async t => {
  const child = await fixture(t, { early: true, exitAfter: -1 })
  const result = await waitForComputerRetirement(child, 'win32')
  assert.equal(result.inputReleased, false); assert.equal(result.forced, true)
})
test('Mac keeps the original input release deadline even if an unfamiliar worker emits a Windows ACK', async t => {
  const child = await fixture(t, { exitAfter: -1 })
  const result = await waitForComputerRetirement(child, 'darwin')
  assert.equal(result.inputReleased, false); assert.equal(result.forced, true)
})
test('oversized unrelated output is discarded at the line bound while the later exact ACK remains readable', async t => {
  const child = await fixture(t, { oversized: true })
  const result = await waitForComputerRetirement(child, 'win32')
  assert.equal(result.inputReleased, true); assert.equal(result.forced, false); assert.equal(result.code, 0)
})
test('repeated valid receipts never refresh the absolute Windows retirement limit', async t => {
  const child = await fixture(t, { repeat: true, exitAfter: -1 }), started = performance.now()
  const result = await waitForComputerRetirement(child, 'win32')
  const elapsed = performance.now() - started
  assert.equal(result.inputReleased, true); assert.equal(result.forced, true)
  assert(elapsed >= 7900 && elapsed < 12000)
})

const driverOutput = await build({ entryPoints: ['src/features/computer-use/native.ts'], bundle: true, write: false, format: 'esm', platform: 'node', define: { 'process.platform': '"win32"' } })
const driverModule = join(directory, 'windows-driver.mjs')
await writeFile(driverModule, driverOutput.outputFiles[0].text)
const { NativeCompanionDriver } = await import(pathToFileURL(driverModule).href)
for (const [kind, browser, exitCode] of [['nonzero', true, 1], ['browser-failed', false, 0], ['browser-missing', null, 0]]) {
  test(`a Windows input ACK does not turn ${kind} retirement into successful disposal`, async () => {
    const file = join(directory, `driver-${kind}.cjs`)
    await writeFile(file, `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const r=JSON.parse(line);process.stdout.write(JSON.stringify({requestId:r.requestId,ok:true,result:{available:true,protocolVersion:1}})+'\\n')});rl.on('close',()=>{process.stdout.write(JSON.stringify({event:'inputReleased',passed:true})+'\\n');setTimeout(()=>{if(${browser !== null})process.stdout.write(JSON.stringify({event:'browserShutdown',passed:${browser === true}})+'\\n');process.exit(${exitCode})},100)});`)
    const driver = new NativeCompanionDriver({ executable: process.execPath, args: [file], releaseInputArgs: [] })
    assert.equal((await driver.status()).available, true)
    await assert.rejects(driver.dispose(), { code: 'NATIVE_CLEANUP_FAILED' })
    await assert.rejects(driver.targets(), { code: 'DISPOSED' })
    await assert.rejects(driver.dispose(), { code: 'NATIVE_CLEANUP_FAILED' })
  })
}
test('a dead worker releases its last owned input even when an inherited stdout pipe never closes in time', async () => {
  const file = join(directory, 'driver-inherited-pipe.cjs'), record = join(directory, 'owned-release.json')
  const descendant = `setTimeout(()=>process.stdout.write('late-tail\\n'),3000)`
  await writeFile(file, `const fs=require('node:fs');if(process.argv.includes('--release-input')){process.stdin.once('data',b=>{fs.writeFileSync(${JSON.stringify(record)},b);process.exit(0)})}else{const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const r=JSON.parse(line);process.stdout.write(JSON.stringify({event:'inputHeld',keys:[17],mouseButtons:['left']})+'\\n');process.stdout.write(JSON.stringify({requestId:r.requestId,ok:true,result:{available:true,protocolVersion:1}})+'\\n')});rl.on('close',()=>{const p=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',1,'ignore']});p.unref();process.exit(77)})}`)
  const driver = new NativeCompanionDriver({ executable: process.execPath, args: [file], releaseInputArgs: [file, '--release-input'] })
  await driver.status()
  const child = driver.child, closed = once(child, 'close')
  await assert.rejects(driver.dispose(), { code: 'NATIVE_CLEANUP_FAILED' })
  const { readFile } = await import('node:fs/promises')
  assert.deepEqual(JSON.parse(await readFile(record, 'utf8')), { keys: [17], mouseButtons: ['left'] })
  await closed
})
