import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'

const source = (await build({ entryPoints: [fileURLToPath(new URL('../src/features/computer-use/macos-launch.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })).outputFiles[0].text
const { launchMacCompanion, retireMacCompanion } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const directory = await mkdtemp(join(tmpdir(), 'qyt-ls-tests-'))
test.after(() => rm(directory, { recursive: true, force: true }))
const fixture = join(directory, 'launch.cjs')
await writeFile(fixture, `const fs=require('node:fs'),net=require('node:net');
const [mode,journal,...args]=process.argv.slice(2),get=key=>args[args.indexOf(key)+1],nonce=get('--qiuya-control-nonce'),ownerPid=Number(get('--qiuya-owner-pid')),path=get('--qiuya-control-socket');
const log=value=>fs.appendFileSync(journal,JSON.stringify(value)+'\\n');
log({event:'launch',args,mode,directoryMode:fs.statSync(require('node:path').dirname(path)).mode&511,socketMode:fs.statSync(path).mode&511});
if(mode==='early-exit')process.exit(0);
const socket=net.connect({path,allowHalfOpen:true}),ready={event:'launchReady',nonce,pid:process.pid,bundleIdentifier:'com.qiuya.tools.computer-use',ownerPid,nativeBirth:{startSeconds:'100',startMicroseconds:'12',uniqueId:'99'}};
socket.on('error',()=>process.exit(0));
const readyMode=mode.startsWith('bad-')?mode.slice(4):mode;
if(readyMode==='nonce')ready.nonce='0'.repeat(64);if(readyMode==='owner')ready.ownerPid++;
if(readyMode==='bundle')ready.bundleIdentifier='other.app';if(readyMode==='pid')ready.pid=ownerPid;
if(readyMode==='birth')ready.nativeBirth={startSeconds:'100',startMicroseconds:'1000000',uniqueId:'99'};
socket.on('connect',()=>{if(mode==='silent')return;setTimeout(()=>{if(mode==='invalid-json')socket.write('{broken\\n');else if(mode==='before-ready')socket.write(JSON.stringify({requestId:1,ok:true,result:{available:true}})+'\\n');else if(mode==='huge-ready')socket.write('x'.repeat(5000));else socket.write(JSON.stringify(ready)+'\\n');if(mode==='duplicate')socket.write(JSON.stringify(ready)+'\\n')},mode==='delayed'?75:0)});
let buffer='';socket.on('data',chunk=>{buffer+=chunk.toString();let index;while((index=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line)continue;const request=JSON.parse(line);log({event:'request',request});socket.write(JSON.stringify({requestId:request.requestId,ok:true,result:{available:true,protocolVersion:1,permissions:{screenRecording:true,accessibility:true,postEvents:true,inputMonitoring:true}}})+'\\n')}});
socket.on('end',()=>{log({event:'eof'});if(mode==='hang-retirement'){setInterval(()=>{},1000);return;}const receipt={event:'launchRetired',nonce,pid:process.pid,ownerPid,inputReleased:true,captureStopped:true};if(mode==='false-retired')receipt.captureStopped=false;if(mode==='wrong-retired')receipt.pid++;if(mode!=='missing-retired')socket.write(JSON.stringify(receipt)+'\\n');socket.end(()=>process.exit(0))});
`)
let sequence = 0
async function make(mode = 'normal', options = {}) {
  const journal = join(directory, `${++sequence}.jsonl`), launchers = [], args = []
  const child = launchMacCompanion('/Applications/QiuYaTools Computer.app', {
    launchTimeoutMs: 1000, retirementTimeoutMs: 700, ...options,
    launch(command, values) {
      args.push({ command, values })
      const launcher = spawn(process.execPath, [fixture, mode, journal, ...values], { stdio: ['pipe', 'pipe', 'pipe'] })
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
      await waitFor(() => child.pid)
      await assert.rejects(retireMacCompanion(child), { code: 'NATIVE_CLEANUP_FAILED' })
      assert.equal(child.exitCode, null, mode)
      assert.equal(fixture.errors[0].code, 'NATIVE_CLEANUP_FAILED', mode)
    } finally { await fixture.cleanup() }
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

test('invalid app paths and system launcher errors never claim the app exited safely', async () => {
  for (const mode of ['invalid-path', 'spawn-error']) {
    const child = launchMacCompanion(mode === 'invalid-path' ? '/Applications/Other.app' : '/Applications/QiuYaTools Computer.app', {
      launch: () => spawn('/this-launcher-does-not-exist', [], { stdio: ['pipe', 'pipe', 'pipe'] }), launchTimeoutMs: 100,
    })
    const errors = []; child.on('error', error => errors.push(error))
    await waitFor(() => errors[0])
    assert.equal(errors[0].code, 'NATIVE_UNAVAILABLE')
    await assert.rejects(retireMacCompanion(child), { code: 'NATIVE_CLEANUP_FAILED' })
    assert.equal(child.exitCode, null)
  }
})

test('Native Driver uses LaunchServices only for the default macOS app and retains the Windows and explicit executable transport', async () => {
  const native = await readFile(new URL('../src/features/computer-use/native.ts', import.meta.url), 'utf8')
  assert.match(native, /process\.platform === 'darwin' && this\.options\.executable === undefined\s*\? launchMacCompanion\(dirname\(dirname\(dirname\(executable\)\)\)\)/)
  assert.match(native, /const macRetirement = retireMacCompanion\(child\)\s*if \(macRetirement\) \{ await macRetirement; return \}/)
  assert.match(native, /: spawn\(executable, args,/)
})
