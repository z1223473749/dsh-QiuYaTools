import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const directory = await mkdtemp(join(tmpdir(), 'qiuya-computer-native-'))
const source = (await build({ entryPoints: [fileURLToPath(new URL('../src/features/computer-use/native.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })).outputFiles[0].text
const { NativeCompanionDriver, computerCompanionPath } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
test.after(() => rm(directory, { recursive: true, force: true }))
const script = join(directory, 'fixture.cjs'), records = join(directory, 'requests.jsonl')
await writeFile(script, `const fs=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const r=JSON.parse(line);fs.appendFileSync(${JSON.stringify(records)},JSON.stringify({...r,pid:process.pid,argv:process.argv.slice(2)})+'\\n');if(r.op==='observe')return;if(r.op==='closePreview'){process.stdout.write(JSON.stringify({event:'previewClosed',sessionId:'fixture'})+'\\n')}if(r.op==='act'){process.stdout.write(JSON.stringify({requestId:r.requestId,ok:false,error:{code:'CONTROL_CHANGED',message:'fenced'}})+'\\n');return}process.stdout.write(JSON.stringify({requestId:r.requestId,ok:true,result:r.op==='status'?{available:true,protocolVersion:process.argv.includes('--wrong-protocol')?99:1}:r})+'\\n')});rl.on('close',()=>process.exit(0));`)

test('platform resolver selects fixed native assets and rejects unsupported architectures', () => {
  const base = pathToFileURL(directory + '/')
  assert.equal(computerCompanionPath('darwin', 'arm64', base), join(directory, 'QiuYaTools Computer.app/Contents/MacOS/qiuya-computer'))
  assert.equal(computerCompanionPath('win32', 'x64', base), join(directory, 'native/win32-x64/qiuya-windows.exe'))
  assert.throws(() => computerCompanionPath('win32', 'ia32', base), { code: 'PLATFORM_UNSUPPORTED' })
})

test('one companion receives RPC and authenticated preview URL through stdin; native errors preserve code', async () => {
  const driver = new NativeCompanionDriver({ executable: process.execPath, args: [script] })
  try {
    assert.equal((await driver.status()).available, true)
    await driver.openPreview('http://127.0.0.1:1/?token=fixture-secret', 'Fixture', 'fixture')
    await assert.rejects(driver.act(10, 'target', { kind: 'key', key: 'Enter' }), { code: 'CONTROL_CHANGED' })
    const lines = (await readFile(records, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(new Set(lines.slice(-3).map(value => value.pid)).size, 1)
    assert.ok(lines.every(value => !value.argv.join(' ').includes('fixture-secret')))
    assert.ok(lines.at(-2).url.includes('fixture-secret'))
  } finally { driver.dispose() }
})

test('abort releases local wait without killing companion, so service can fence native input with release', async () => {
  const driver = new NativeCompanionDriver({ executable: process.execPath, args: [script] }), abort = new AbortController()
  try {
    await driver.status()
    const observing = driver.observe('target', abort.signal)
    const rejected = assert.rejects(observing)
    abort.abort(new Error('cancelled')); await rejected
    const result = await driver.release(10)
    assert.equal(result.op, 'release')
    assert.equal((await driver.status()).available, true)
  } finally { driver.dispose() }
})

test('unsolicited preview-close events reach Host listeners and disposal rejects pending reads', async () => {
  const driver = new NativeCompanionDriver({ executable: process.execPath, args: [script] }), events = []
  driver.subscribe(event => events.push(event))
  await driver.closePreview()
  assert.equal(events[0].event, 'previewClosed')
  const pending = driver.observe('target'), rejected = assert.rejects(pending, { code: 'DISPOSED' })
  driver.dispose(); await rejected
  await assert.rejects(driver.targets(), { code: 'DISPOSED' })
})

test('timeout kills a hung native worker and reports failure instead of silently replaying a request', async () => {
  const driver = new NativeCompanionDriver({ executable: process.execPath, args: [script], timeoutMs: 100 })
  try { await assert.rejects(driver.observe('target'), { code: 'NATIVE_TIMEOUT' }) } finally { driver.dispose() }
})


test('incompatible companion is rejected before target enumeration or input', async () => {
  const driver = new NativeCompanionDriver({ executable: process.execPath, args: [script, '--wrong-protocol'] })
  try {
    assert.equal((await driver.status()).available, false)
    await assert.rejects(driver.targets(), { code: 'NATIVE_PROTOCOL_VERSION' })
    await assert.rejects(driver.lease(50), { code: 'NATIVE_PROTOCOL_VERSION' })
    await assert.rejects(driver.act(50, 'target', { kind: 'key', key: 'Enter' }), { code: 'NATIVE_PROTOCOL_VERSION' })
    const lines = (await readFile(records, 'utf8')).trim().split('\n').map(JSON.parse).filter(row => row.argv.includes('--wrong-protocol'))
    assert.deepEqual(lines.map(row => row.op), ['status'])
  } finally { driver.dispose() }
})

test('unexpected worker exit clears its recorded owned inputs in a separate cleanup process without replaying the action', async () => {
  const worker = join(directory, 'crash.cjs'), cleanup = join(directory, 'released.json')
  await writeFile(worker, `const fs=require('node:fs');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{if(process.argv.includes('--release-input')){fs.writeFileSync(${JSON.stringify(cleanup)},line);process.exit(0)}const r=JSON.parse(line);if(r.op==='status')process.stdout.write(JSON.stringify({requestId:r.requestId,ok:true,result:{available:true,protocolVersion:1}})+'\\n');else if(r.op==='observe'){process.stdout.write(JSON.stringify({event:'inputHeld',keys:[17],mouseButtons:['left']})+'\\n',()=>process.exit(77))}})`)
  const driver = new NativeCompanionDriver({ executable: process.execPath, args: [worker], releaseInputArgs: [worker, '--release-input'] })
  await assert.rejects(driver.observe('fixture'), { code: 'NATIVE_EXITED' })
  await driver.dispose()
  assert.deepEqual(JSON.parse(await readFile(cleanup, 'utf8')), { keys: [17], mouseButtons: ['left'] })
})

test('failed emergency cleanup blocks subsequent workers and makes disposal report the failure', async () => {
  const worker = join(directory, 'cleanup-failure.cjs')
  await writeFile(worker, `if(process.argv.includes('--release-input')){process.stdin.resume();process.stdin.once('end',()=>process.exit(2))}else{require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.op==='status')process.stdout.write(JSON.stringify({requestId:r.requestId,ok:true,result:{available:true,protocolVersion:1}})+'\\n');else process.stdout.write(JSON.stringify({event:'inputHeld',keys:[],mouseButtons:['left']})+'\\n',()=>process.exit(77))})}`)
  const driver = new NativeCompanionDriver({ executable: process.execPath, args: [worker], releaseInputArgs: [worker, '--release-input'] })
  await assert.rejects(driver.observe('fixture'), { code: 'NATIVE_EXITED' })
  await assert.rejects(driver.targets(), { code: 'NATIVE_CLEANUP_FAILED' })
  await assert.rejects(driver.dispose(), { code: 'NATIVE_CLEANUP_FAILED' })
})

test('emergency cleanup preserves the native owner and Unicode units while ignoring malformed held-input events', async () => {
  const worker = join(directory, 'unicode-crash.cjs'), cleanup = join(directory, 'unicode-released.json')
  const owned = { ownerId: 'a'.repeat(32), keys: [], mouseButtons: [], unicodeUnits: [0xd83d, 0xde00] }
  await writeFile(worker, `const fs=require('node:fs');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{if(process.argv.includes('--release-input')){fs.writeFileSync(${JSON.stringify(cleanup)},line);process.exit(0)}const r=JSON.parse(line);if(r.op==='status')process.stdout.write(JSON.stringify({requestId:r.requestId,ok:true,result:{available:true,protocolVersion:1}})+'\\n');else{process.stdout.write(JSON.stringify({event:'inputHeld',...${JSON.stringify(owned)}})+'\\n');process.stdout.write(JSON.stringify({event:'inputHeld',ownerId:'invalid',keys:[],mouseButtons:[],unicodeUnits:[]})+'\\n',()=>process.exit(77))}})`)
  const driver = new NativeCompanionDriver({ executable: process.execPath, args: [worker], releaseInputArgs: [worker, '--release-input'] })
  await assert.rejects(driver.observe('fixture'), { code: 'NATIVE_EXITED' })
  await driver.dispose()
  assert.deepEqual(JSON.parse(await readFile(cleanup, 'utf8')), owned)
})
