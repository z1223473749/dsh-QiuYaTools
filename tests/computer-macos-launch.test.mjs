import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'

const source = (await build({ entryPoints: [fileURLToPath(new URL('../src/features/computer-use/macos-launch.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })).outputFiles[0].text
const { launchHostedMacCompanion, launchMacCompanion, retireMacCompanion } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const directory = await mkdtemp(join(tmpdir(), 'qyt-ls-tests-'))
test.after(() => rm(directory, { recursive: true, force: true }))
const fixture = join(directory, 'launch.cjs')
async function transportDriverBundle() {
  return build({
    entryPoints: [fileURLToPath(new URL('../src/features/computer-use/native.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'esm', define: { 'process.platform': '"darwin"' },
    plugins: [{ name: 'transport-only-native-resolver', setup(builder) {
      builder.onLoad({ filter: /[\\/]native[\\/]runtime\.ts$/ }, async ({ path }) => {
        // These fixtures execute a Node worker behind the real Mac socket
        // transport, not a distributable Mach-O. Keep the production path
        // mapping but bypass only package verification in this test bundle.
        // tests/native-runtime.test.mjs covers the actual resolver and repair.
        const runtime = await readFile(path, 'utf8'), declaration = 'export function resolveNativeExecutable('
        assert.ok(runtime.includes(declaration))
        return { loader: 'ts', resolveDir: dirname(path), contents: runtime.replace(declaration, 'function verifiedNativeExecutable(') + `
export function resolveNativeExecutable(component: NativeComponent, options: NativeRuntimeOptions = {}): string {
  return bundledNativePath(component, options.platform ?? process.platform, options.architecture ?? process.arch, options.base ?? new URL('./', import.meta.url))
}
` }
      })
    } }],
  })
}
await writeFile(fixture, `const fs=require('node:fs'),net=require('node:net');
const [mode,journal,...args]=process.argv.slice(2),get=key=>args[args.indexOf(key)+1],nonce=get('--qiuya-control-nonce'),ownerPid=Number(get('--qiuya-owner-pid')),path=get('--qiuya-control-socket');
const log=value=>fs.appendFileSync(journal,JSON.stringify(value)+'\\n');
log({event:'launch',args,mode,parentPid:process.ppid,parentEnvironment:process.env.QIUYA_TOOLS_PARENT_PID,directoryMode:fs.statSync(require('node:path').dirname(path)).mode&511,socketMode:fs.statSync(path).mode&511});
if(mode==='early-exit')process.exit(0);
const socket=net.connect({path,allowHalfOpen:true}),ready={event:'launchReady',nonce,pid:process.pid,bundleIdentifier:'com.qiuya.tools.computer-use',ownerPid,nativeBirth:{startSeconds:'100',startMicroseconds:'12',uniqueId:'99'}};
socket.on('error',()=>process.exit(0));
const readyMode=mode.startsWith('bad-')?mode.slice(4):mode;
if(readyMode==='nonce')ready.nonce='0'.repeat(64);if(readyMode==='owner')ready.ownerPid++;
if(readyMode==='bundle')ready.bundleIdentifier='other.app';if(readyMode==='pid')ready.pid=ownerPid;
if(readyMode==='child')ready.pid++;if(readyMode==='birth')ready.nativeBirth={startSeconds:'100',startMicroseconds:'1000000',uniqueId:'99'};
socket.on('connect',()=>{if(mode==='silent')return;setTimeout(()=>{if(mode==='invalid-json')socket.write('{broken\\n');else if(mode==='before-ready')socket.write(JSON.stringify({requestId:1,ok:true,result:{available:true}})+'\\n');else if(mode==='huge-ready')socket.write('x'.repeat(5000));else socket.write(JSON.stringify(ready)+'\\n');if(mode==='duplicate')socket.write(JSON.stringify(ready)+'\\n')},mode==='delayed'?75:0)});
let buffer='',quitting=false;socket.on('data',chunk=>{buffer+=chunk.toString();let index;while((index=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line)continue;const request=JSON.parse(line);log({event:'request',request});if(mode==='restart-on-status'&&request.op==='status'){quitting=true;socket.end(()=>process.exit(0));continue;}const result=request.op==='applications'?{applications:[]}:request.op==='targets'?{targets:[]}:request.op==='openSystemSettings'?{opened:true,kind:request.kind,guideReady:true}:{available:true,platform:'darwin',protocolVersion:1,permissionOwner:{kind:args.includes('--qiuya-hosted')?'host':'companion',appName:args.includes('--qiuya-hosted')?'DeepSeek Harness':'QiuYaTools Computer',bundleIdentifier:args.includes('--qiuya-hosted')?'com.deepseek.harness':'com.qiuya.tools.computer-use'},permissions:{screenRecording:!mode.startsWith('system-restart'),accessibility:!mode.startsWith('system-restart'),postEvents:!mode.startsWith('system-restart'),inputMonitoring:!mode.startsWith('system-restart')}};socket.write(JSON.stringify({requestId:request.requestId,ok:true,result})+'\\n');if(mode.startsWith('system-restart')&&request.op==='openSystemSettings'){quitting=true;log({event:'system-quit'});if(mode==='system-restart-held')socket.write(JSON.stringify({event:'inputHeld',keys:[17],mouseButtons:[]})+'\\n');if(mode==='system-restart-tail')socket.write('{incomplete');socket.end(()=>{if(mode==='system-restart-delayed')setTimeout(()=>process.exit(0),150);else process.exit(mode==='system-restart-failed'?7:0)})}}});
socket.on('end',()=>{if(quitting)return;log({event:'eof'});if(mode==='hang-retirement'){setInterval(()=>{},1000);return;}const receipt={event:'launchRetired',nonce,pid:process.pid,ownerPid,inputReleased:true,captureStopped:true};if(mode==='false-retired')receipt.captureStopped=false;if(mode==='wrong-retired')receipt.pid++;if(mode!=='missing-retired')socket.write(JSON.stringify(receipt)+'\\n');socket.end(()=>{if(mode==='retired-delayed')setTimeout(()=>process.exit(0),150);else process.exit(mode==='retired-failed'?7:0)})});
`)
let sequence = 0
async function make(mode = 'normal', options = {}) {
  const journal = join(directory, `${++sequence}.jsonl`), launchers = [], args = []
  const { hosted = false, ...launchOptions } = options
  const child = (hosted ? launchHostedMacCompanion : launchMacCompanion)('/Applications/QiuYaTools Computer.app', {
    launchTimeoutMs: 1000, retirementTimeoutMs: 700, ...launchOptions,
    launch(command, values, spawnOptions) {
      args.push({ command, values, parentEnvironment: spawnOptions.env.QIUYA_TOOLS_PARENT_PID })
      const launcher = spawn(process.execPath, [fixture, mode, journal, ...values], spawnOptions)
      launchers.push(launcher); return launcher
    },
  })
  const errors = []; child.on('error', error => errors.push(error))
  return { child, errors, args, read: async () => (await readFile(journal, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse),
    async cleanup() { for (const launcher of launchers) if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGKILL'); await delay(20) } }
}
async function waitFor(check) {
  const deadline = performance.now() + 2000
  while (performance.now() < deadline) { const value = await check(); if (value) return value; await delay(5) }
  throw new Error('The real UNIX socket fixture did not reach its checkpoint')
}

test('LaunchServices uses exact app, private canonical socket and authenticated helper PID; controls never reach JSONL consumers', async () => {
  const fixture = await make(), { child } = fixture
  let output = ''; child.stdout.on('data', chunk => { output += chunk })
  try {
    child.stdin.write(JSON.stringify({ requestId: 1, op: 'status' }) + '\n')
    await waitFor(() => output.includes('"requestId":1'))
    const [row] = await fixture.read(), launch = fixture.args[0]
    assert.equal(launch.command, '/usr/bin/open')
    assert.deepEqual(launch.values.slice(0, 6), ['-n', '-g', '-W', '-a', '/Applications/QiuYaTools Computer.app', '--args'])
    assert.match(launch.values[launch.values.indexOf('--qiuya-control-nonce') + 1], /^[a-f0-9]{64}$/)
    assert.equal(row.directoryMode, 0o700); assert.equal(row.socketMode, 0o600)
    assert.ok(child.pid > 1 && child.pid !== process.pid)
    assert.equal(JSON.parse(output).result.permissions.inputMonitoring, true)
    assert.ok(!output.includes('launchReady') && !output.includes('launchRetired'))
    const closed = once(child, 'close'); await retireMacCompanion(child)
    assert.deepEqual(await closed, [0, null]); assert.equal(child.exitCode, 0)
    await waitFor(async () => { const path = launch.values[launch.values.indexOf('--qiuya-control-socket') + 1]; return readdir(path.slice(0, path.lastIndexOf('/'))).then(() => false, error => error.code === 'ENOENT') })
    assert.deepEqual((await fixture.read()).map(row => row.event), ['launch', 'request', 'eof'])
  } finally { await fixture.cleanup() }
})

test('no queued request reaches a peer before a valid ready handshake and EOF cancels startup work', async () => {
  const fixture = await make('delayed'), { child } = fixture
  try {
    child.stdin.write(JSON.stringify({ requestId: 1, op: 'act', action: { kind: 'click' } }) + '\n')
    await waitFor(async () => (await fixture.read()).some(row => row.event === 'launch'))
    assert.equal((await fixture.read()).filter(row => row.event === 'request').length, 0)
    await retireMacCompanion(child)
    assert.equal((await fixture.read()).filter(row => row.event === 'request').length, 0)
    assert.equal(child.exitCode, 0)
  } finally { await fixture.cleanup() }
})

test('bad nonce, owner, bundle, PID, birth, malformed and non-ready first messages fail closed', async () => {
  for (const mode of ['bad-nonce', 'bad-owner', 'bad-bundle', 'bad-pid', 'bad-birth', 'invalid-json', 'before-ready', 'huge-ready', 'duplicate']) {
    const fixture = await make(mode), { child } = fixture
    try {
      child.stdin.write('{"requestId":1,"op":"act"}\n')
      const error = await waitFor(() => fixture.errors[0])
      assert.equal(error.code, 'NATIVE_PROTOCOL', mode)
      await assert.rejects(retireMacCompanion(child), { code: 'NATIVE_CLEANUP_FAILED' })
      assert.equal(child.exitCode, null, 'An unconfirmed process is never declared dead')
      if (mode !== 'duplicate') assert.equal((await fixture.read()).filter(row => row.event === 'request').length, 0, mode)
    } finally { await fixture.cleanup() }
  }
})

test('launcher success alone cannot authenticate a helper or prove retirement', async () => {
  const fixture = await make('early-exit', { launchTimeoutMs: 100 }), { child } = fixture
  let exited = false; child.on('exit', () => { exited = true })
  try {
    await waitFor(() => fixture.errors[0])
    assert.equal(fixture.errors[0].code, 'NATIVE_LAUNCH_TIMEOUT')
    assert.equal(exited, false); assert.equal(child.pid, undefined); assert.equal(child.exitCode, null)
    await assert.rejects(retireMacCompanion(child), { code: 'NATIVE_CLEANUP_FAILED' })
  } finally { await fixture.cleanup() }
})

test('a connected peer which never authenticates times out without forwarding model requests', async () => {
  const fixture = await make('silent', { launchTimeoutMs: 100 }), { child } = fixture
  try {
    child.stdin.write('{\"requestId\":1,\"op\":\"act\"}\n')
    await waitFor(() => fixture.errors[0])
    assert.equal(fixture.errors[0].code, 'NATIVE_LAUNCH_TIMEOUT')
    assert.equal((await fixture.read()).filter(row => row.event === 'request').length, 0)
    await assert.rejects(retireMacCompanion(child), { code: 'NATIVE_CLEANUP_FAILED' })
  } finally { await fixture.cleanup() }
})

test('missing, negative or mismatched native cleanup receipts never become a successful exit', async () => {
  for (const mode of ['missing-retired', 'false-retired', 'wrong-retired']) {
    const fixture = await make(mode), { child } = fixture
    try {
      child.stdin.write('{"requestId":1,"op":"observe","targetId":"fixture"}\n')
      await waitFor(async () => (await fixture.read()).some(row => row.event === 'request'))
      await assert.rejects(retireMacCompanion(child), { code: 'NATIVE_CLEANUP_FAILED' })
      assert.equal(child.exitCode, null, mode)
      assert.equal(fixture.errors[0].code, 'NATIVE_CLEANUP_FAILED', mode)
    } finally { await fixture.cleanup() }
  }
})

test('System Settings can retire an authenticated metadata-only worker after its socket, launcher and actual PID all exit', async () => {
  const fixture = await make('system-restart'), { child } = fixture
  let output = ''; child.stdout.on('data', chunk => { output += chunk })
  const closed = once(child, 'close')
  try {
    for (const [index, op] of ['status', 'applications', 'targets'].entries()) child.stdin.write(JSON.stringify({ requestId: index + 1, op }) + '\n')
    await waitFor(() => output.includes('"requestId":3'))
    child.stdin.write('{"requestId":4,"op":"openSystemSettings","kind":"screenRecording"}\n')
    assert.deepEqual(await closed, [0, null])
    await retireMacCompanion(child)
    assert.equal(fixture.errors.length, 0)
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' })
    const rows = await fixture.read()
    assert.deepEqual(rows.filter(row => row.event === 'request').map(row => row.request.op), ['status', 'applications', 'targets', 'openSystemSettings'])
    assert.ok(rows.some(row => row.event === 'system-quit'))
    assert.ok(!rows.some(row => row.event === 'eof'), 'A system quit must not be mistaken for a native cleanup receipt')
  } finally { await fixture.cleanup() }
})

test('permission-only exit still rejects live, reused or unreadable PIDs, failed launchers and unexpected native output', async () => {
  for (const [mode, processAbsent] of [['system-restart', () => false], ['system-restart', () => { throw Object.assign(new Error('unreadable'), { code: 'EPERM' }) }], ['system-restart-failed'], ['system-restart-held'], ['system-restart-tail']]) {
    const fixture = await make(mode, { processAbsent, retirementTimeoutMs: 80 }), { child } = fixture
    try {
      child.stdin.write('{"requestId":1,"op":"openSystemSettings","kind":"accessibility"}\n')
      await waitFor(() => fixture.errors[0])
      await assert.rejects(retireMacCompanion(child), { code: 'NATIVE_CLEANUP_FAILED' })
      assert.equal(child.exitCode, null, mode)
    } finally { await fixture.cleanup() }
  }
})

test('partial or formerly hazardous commands keep requiring the exact cleanup receipt even after a later status', async () => {
  for (const op of ['lease', 'release', 'observe', 'openPreview', 'launchApplication', 'act', 'unknown', 'partial']) {
    const fixture = await make('missing-retired'), { child } = fixture
    try {
      child.stdin.write(JSON.stringify({ requestId: 1, op: op === 'partial' ? 'status' : op }) + '\n')
      child.stdin.write('{"requestId":2,"op":"status"}\n')
      await waitFor(async () => (await fixture.read()).filter(row => row.event === 'request').length === 2)
      if (op === 'partial') child.stdin.write('{"requestId":3,"op":"act"')
      await assert.rejects(retireMacCompanion(child), { code: 'NATIVE_CLEANUP_FAILED' })
      assert.equal(child.exitCode, null, op)
    } finally { await fixture.cleanup() }
  }
})

test('Native Driver refreshes OS permission state on a new helper after an actual metadata-only system restart', async () => {
  const result = await transportDriverBundle()
  const module = join(directory, 'driver.mjs'); await writeFile(module, result.outputFiles[0].text)
  const { NativeCompanionDriver } = await import(`file://${module}`)
  const journal = join(directory, 'driver-restart.jsonl'), launchers = [], originalSpawn = childProcess.spawn
  let launches = 0
  childProcess.spawn = (command, args, options) => {
    assert.notEqual(command, '/usr/bin/open', 'The default Mac driver must not create a standalone LaunchServices permission owner')
    if (!command.endsWith('/QiuYaTools Computer.app/Contents/MacOS/qiuya-computer')) return originalSpawn(command, args, options)
    const launcher = originalSpawn(process.execPath, [fixture, ++launches === 1 ? 'system-restart-delayed' : 'normal', journal, ...args], options)
    launchers.push(launcher); return launcher
  }
  syncBuiltinESMExports()
  const driver = new NativeCompanionDriver()
  try {
    const initial = await driver.status()
    assert.equal(initial.available, true)
    assert.deepEqual(initial.permissionOwner, { kind: 'host', appName: 'DeepSeek Harness', bundleIdentifier: 'com.deepseek.harness' })
    assert.deepEqual(initial.permissions, { screenRecording: false, accessibility: false, postEvents: false, inputMonitoring: false })
    assert.deepEqual(await driver.applications(), [])
    assert.deepEqual(await driver.targets(), [])
    const oldChild = driver.child, closed = once(oldChild, 'close')
    await driver.openSystemSettings('screenRecording')
    await waitFor(() => oldChild.socketEnded)
    assert.equal(oldChild.exitCode, null, 'The system quit is still awaiting launcher / PID proof')
    const status = await driver.status()
    await closed
    assert.equal(status.available, true)
    assert.deepEqual(status.permissions, { screenRecording: true, accessibility: true, postEvents: true, inputMonitoring: true })
    assert.equal(launches, 2, 'Exactly one replacement helper is created, with no settings or input replay')
    const rows = (await readFile(journal, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(rows.filter(row => row.event === 'request' && row.request.op === 'openSystemSettings').length, 1)
    assert.ok(rows.filter(row => row.event === 'request').every(row => ['status', 'applications', 'targets', 'openSystemSettings'].includes(row.request.op)))
    await driver.dispose()
    launches = 0; await writeFile(journal, '')
    const unsafe = new NativeCompanionDriver()
    assert.equal((await unsafe.status()).available, true)
    await unsafe.lease(1)
    await unsafe.openSystemSettings('screenRecording')
    await waitFor(() => unsafe.child === undefined)
    assert.equal((await unsafe.status()).available, false, 'A worker that received a lease still requires the explicit native cleanup receipt')
    assert.equal(launches, 1, 'Unknown cleanup cannot be bypassed by the status retry')
    await assert.rejects(unsafe.dispose(), { code: 'NATIVE_CLEANUP_FAILED' })
  } finally {
    childProcess.spawn = originalSpawn; syncBuiltinESMExports()
    for (const launcher of launchers) if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGKILL')
  }
})

test('kill only requests authenticated EOF; an unresponsive helper remains unconfirmed', async () => {
  const fixture = await make('hang-retirement', { retirementTimeoutMs: 80 }), { child } = fixture
  try {
    await waitFor(() => child.pid)
    assert.equal(child.kill('SIGKILL'), true)
    await assert.rejects(retireMacCompanion(child), { code: 'NATIVE_CLEANUP_FAILED' })
    assert.equal(child.exitCode, null)
    assert.ok((await fixture.read()).some(row => row.event === 'eof'))
    assert.ok(!fixture.args[0].values.includes('SIGKILL'))
  } finally { await fixture.cleanup() }
})

test('pre-launch preparation failure can retire without claiming a successful app exit', async () => {
  for (const launch of [launchMacCompanion, launchHostedMacCompanion]) {
    let invoked = false, exited = false
    const child = launch('/Applications/Other.app', { launch: () => { invoked = true; throw new Error('Unexpected launcher invocation') } })
    const errors = []; child.on('error', error => errors.push(error)); child.on('exit', () => { exited = true })
    await waitFor(() => errors[0])
    assert.equal(errors[0].code, 'NATIVE_UNAVAILABLE')
    await retireMacCompanion(child)
    assert.equal(invoked, false); assert.equal(exited, false); assert.equal(child.exitCode, null)
  }
})

test('a failed standalone launcher still cannot prove that its app never started', async () => {
  const child = launchMacCompanion('/Applications/QiuYaTools Computer.app', {
    launch: () => spawn('/this-launcher-does-not-exist', [], { stdio: ['pipe', 'pipe', 'pipe'] }), launchTimeoutMs: 100,
  })
  const errors = []; child.on('error', error => errors.push(error))
  await waitFor(() => errors[0])
  assert.equal(errors[0].code, 'NATIVE_UNAVAILABLE')
  await assert.rejects(retireMacCompanion(child), { code: 'NATIVE_CLEANUP_FAILED' })
  assert.equal(child.exitCode, null)
})

for (const failure of ['ENOENT', 'EACCES']) test(`hosted ${failure} does not leave the Native Driver permanently fenced after the executable is repaired`, async () => {
  const result = await transportDriverBundle()
  const module = join(directory, `driver-spawn-${failure}.mjs`); await writeFile(module, result.outputFiles[0].text)
  const { NativeCompanionDriver } = await import(`file://${module}`)
  const root = await mkdtemp(join(directory, 'repair-')), executable = join(root, 'QiuYaTools Computer.app/Contents/MacOS/qiuya-computer')
  const journal = join(root, 'requests.jsonl'), launchers = [], errors = [], originalSpawn = childProcess.spawn
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`
  const worker = `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} normal ${quote(journal)} "$@"\n`
  await mkdir(join(root, 'QiuYaTools Computer.app/Contents/MacOS'), { recursive: true })
  if (failure === 'EACCES') await writeFile(executable, worker, { mode: 0o600 })
  childProcess.spawn = (command, args, options) => {
    assert.ok(command.endsWith('/QiuYaTools Computer.app/Contents/MacOS/qiuya-computer'))
    const launcher = originalSpawn(executable, args, options)
    launcher.once('error', error => errors.push(error))
    launchers.push(launcher); return launcher
  }
  syncBuiltinESMExports()
  const driver = new NativeCompanionDriver()
  try {
    const first = await driver.status()
    assert.equal(first.available, false); assert.equal(errors[0].code, failure)
    const absent = launchers[0], transport = driver.retiring
    assert.equal(absent.pid, undefined, 'The OS rejected creation of the worker')
    await transport
    const second = await driver.status()
    assert.equal(second.available, false); assert.equal(second.message, first.message)
    assert.equal(launchers.length, 2, 'A missing executable remains unavailable without a permanent cleanup fence')
    assert.equal(errors[1].code, failure)
    await writeFile(executable, worker); await chmod(executable, 0o700)
    const repaired = await driver.status()
    assert.equal(repaired.available, true); assert.equal(launchers.length, 3)
    assert.deepEqual(await driver.applications(), []); assert.deepEqual(await driver.targets(), [])
    await driver.dispose()
    const rows = (await readFile(journal, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(rows.filter(row => row.event === 'launch').length, 1, 'Failed spawns never ran the native worker')
    assert.deepEqual(rows.filter(row => row.event === 'request').map(row => row.request.op), ['status', 'status', 'applications', 'targets'])
    assert.ok(rows.some(row => row.event === 'eof'))
  } finally {
    childProcess.spawn = originalSpawn; syncBuiltinESMExports()
    for (const launcher of launchers) if (launcher.pid && launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGKILL')
  }
})

test('Native Driver uses the authenticated hosted transport for the default Mac app and retains Windows and explicit executable transport', async () => {
  const native = await readFile(new URL('../src/features/computer-use/native.ts', import.meta.url), 'utf8')
  assert.match(native, /process\.platform === 'darwin' && this\.options\.executable === undefined\s*\? launchHostedMacCompanion\(dirname\(dirname\(dirname\(executable\)\)\)\)/)
  assert.match(native, /const macRetirement = retireMacCompanion\(child\)\s*if \(macRetirement\) \{ await macRetirement; return \}/)
  assert.match(native, /: spawn\(executable, args,/)
})

test('hosted launch directly spawns the real helper with private socket authentication and its actual parent binding', async () => {
  const fixture = await make('normal', { hosted: true }), { child } = fixture
  let output = ''; child.stdout.on('data', chunk => { output += chunk })
  try {
    child.stdin.write('{"requestId":1,"op":"status"}\n')
    await waitFor(() => output.includes('"requestId":1'))
    const [row] = await fixture.read(), launch = fixture.args[0]
    assert.equal(launch.command, '/Applications/QiuYaTools Computer.app/Contents/MacOS/qiuya-computer')
    assert.equal(launch.values.length, 7); assert.equal(launch.values.at(-1), '--qiuya-hosted')
    assert.ok(!launch.values.includes('--args') && !launch.values.includes('-a'))
    assert.equal(launch.values[launch.values.indexOf('--qiuya-owner-pid') + 1], String(process.pid))
    assert.equal(launch.parentEnvironment, String(process.pid)); assert.equal(row.parentPid, process.pid)
    assert.equal(row.parentEnvironment, String(process.pid)); assert.equal(row.directoryMode, 0o700); assert.equal(row.socketMode, 0o600)
    assert.ok(child.pid > 1 && child.pid !== process.pid)
    assert.ok(!output.includes('launchReady') && !output.includes('launchRetired'))
    await retireMacCompanion(child); assert.equal(child.exitCode, 0)
  } finally { await fixture.cleanup() }
})

test('hosted handshake binds ready PID to the exact direct child and rejects all unauthenticated peers', async () => {
  for (const mode of ['bad-child', 'bad-owner', 'bad-nonce', 'bad-bundle', 'bad-birth', 'bad-pid']) {
    const fixture = await make(mode, { hosted: true }), { child } = fixture
    try {
      child.stdin.write('{"requestId":1,"op":"act"}\n')
      assert.equal((await waitFor(() => fixture.errors[0])).code, 'NATIVE_PROTOCOL', mode)
      await assert.rejects(retireMacCompanion(child), { code: 'NATIVE_CLEANUP_FAILED' })
      assert.equal(child.pid, undefined, 'An unrelated claimed PID never becomes this worker identity')
      assert.equal((await fixture.read()).filter(row => row.event === 'request').length, 0)
    } finally { await fixture.cleanup() }
  }
})

test('hosted retirement requires the exact child to exit normally after authenticated cleanup and socket closure', async () => {
  const fixture = await make('retired-delayed', { hosted: true }), { child } = fixture
  let output = ''; child.stdout.on('data', chunk => { output += chunk })
  try {
    child.stdin.write('{"requestId":1,"op":"observe"}\n')
    await waitFor(() => output.includes('"requestId":1'))
    const retired = retireMacCompanion(child)
    await waitFor(() => child.socketClosed)
    assert.equal(child.exitCode, null, 'Socket closure and the native receipt cannot substitute for a real child exit')
    await retired; assert.equal(child.exitCode, 0)
  } finally { await fixture.cleanup() }
  const failed = await make('retired-failed', { hosted: true })
  try {
    await waitFor(() => failed.child.pid)
    await assert.rejects(retireMacCompanion(failed.child), { code: 'NATIVE_CLEANUP_FAILED' })
    assert.equal(failed.child.exitCode, null, 'A cleanup receipt does not hide a nonzero direct child exit')
  } finally { await failed.cleanup() }
})

test('hosted metadata-only system exit preserves the exact PID proof and hazardous work cannot use that exemption', async () => {
  const fixture = await make('system-restart-delayed', { hosted: true }), { child } = fixture
  child.stdout.resume()
  try {
    const closed = once(child, 'close')
    child.stdin.write('{"requestId":1,"op":"openSystemSettings","kind":"accessibility"}\n')
    await waitFor(() => child.socketEnded)
    assert.equal(child.exitCode, null)
    assert.deepEqual(await closed, [0, null])
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' })
    await retireMacCompanion(child)
  } finally { await fixture.cleanup() }
  for (const mode of ['system-restart-held', 'system-restart-tail', 'system-restart-failed']) {
    const unsafe = await make(mode, { hosted: true, retirementTimeoutMs: 100 })
    try {
      unsafe.child.stdin.write('{"requestId":1,"op":"openSystemSettings","kind":"screenRecording"}\n')
      await waitFor(() => unsafe.errors[0])
      await assert.rejects(retireMacCompanion(unsafe.child), { code: 'NATIVE_CLEANUP_FAILED' })
      assert.equal(unsafe.child.exitCode, null)
    } finally { await unsafe.cleanup() }
  }
  for (const op of ['lease', 'release', 'observe', 'act', 'unknown', 'partial']) {
    const unsafe = await make('missing-retired', { hosted: true, retirementTimeoutMs: 100 })
    try {
      unsafe.child.stdin.write(JSON.stringify({ requestId: 1, op: op === 'partial' ? 'status' : op }) + '\n')
      await waitFor(async () => (await unsafe.read()).some(row => row.event === 'request'))
      if (op === 'partial') unsafe.child.stdin.write('{"requestId":2,"op":"act"')
      await assert.rejects(retireMacCompanion(unsafe.child), { code: 'NATIVE_CLEANUP_FAILED' })
      assert.equal(unsafe.child.exitCode, null, op)
    } finally { await unsafe.cleanup() }
  }
})

test('hosted status retries at most once after confirmed metadata-only exit without replaying commands', async () => {
  const result = await transportDriverBundle()
  const module = join(directory, 'driver-repeated-status-exit.mjs'); await writeFile(module, result.outputFiles[0].text)
  const { NativeCompanionDriver } = await import(`file://${module}`)
  const journal = join(directory, 'driver-repeated-status-exit.jsonl'), launchers = [], originalSpawn = childProcess.spawn
  let launches = 0
  childProcess.spawn = (command, args, options) => {
    assert.notEqual(command, '/usr/bin/open')
    if (!command.endsWith('/QiuYaTools Computer.app/Contents/MacOS/qiuya-computer')) return originalSpawn(command, args, options)
    launches++
    const launcher = originalSpawn(process.execPath, [fixture, 'restart-on-status', journal, ...args], options)
    launchers.push(launcher); return launcher
  }
  syncBuiltinESMExports()
  const driver = new NativeCompanionDriver()
  try {
    assert.equal((await driver.status()).available, false)
    assert.equal(launches, 2, 'A second metadata-only exit ends this status read rather than looping')
    const rows = (await readFile(journal, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.deepEqual(rows.filter(row => row.event === 'request').map(row => row.request.op), ['status', 'status'])
    await driver.dispose()
  } finally {
    childProcess.spawn = originalSpawn; syncBuiltinESMExports()
    for (const launcher of launchers) if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGKILL')
  }
})
