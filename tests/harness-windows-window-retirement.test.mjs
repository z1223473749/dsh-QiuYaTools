import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { startHarnessWindowsWindowRetirement as start } from '../scripts/harness-windows-window-retirement.mjs'
const code = ({ second = 'host-console-released', delay = 0, early = false, malformed = false } = {}) => `import{createInterface}from'node:readline';const say=v=>process.stdout.write(JSON.stringify(v)+'\\n');${malformed ? "process.stdout.write('invalid\\n');" : "say({phase:'window-group-released',passed:true})"};${early ? "say({phase:'host-console-released',passed:true})" : ''};const rl=createInterface({input:process.stdin});rl.on('line',line=>{if(line!=='host-eof')throw Error('Unexpected input');say({phase:${JSON.stringify(second)},passed:true,receipt:'actual-original-test-child'});rl.close();process.stdin.destroy();${delay ? `setTimeout(()=>{},${delay})` : ''}})`
function observer(options = {}, limits = {}) { let child, kills = 0; const value = start({ command: process.execPath, args: ['--input-type=module', '-e', code(options)], readyMs: 1000, retireMs: 1000, ...limits, spawnChild(...args) { child = spawn(...args); child.kill = () => { kills++; throw Error('No process signal permitted') }; return child } }); return { value, get child() { return child }, get kills() { return kills } } }
test('real owned stdio child keeps its exact handle across the two normal-close/HostEOF phases and naturally exits0', async () => {
  const o = observer(); assert.equal((await o.value.ready()).phase, 'window-group-released'); o.value.beginHostEOF(); assert.throws(() => o.value.beginHostEOF(), /exactly once/); const r = await o.value.finish(); assert.equal(r.receipt, 'actual-original-test-child'); assert.deepEqual(r.observerExit, { code: 0, signal: null }); assert.equal(r.processSignalsSent, 0); assert.equal(o.kills, 0)
})
test('real late natural exit0 stays unknown under its original deadline and EOF is never replayed', async () => {
  const o = observer({ delay: 100 }, { retireMs: 20 }); await o.value.ready(); o.value.beginHostEOF(); await assert.rejects(o.value.finish(), /within3000ms/); assert.throws(() => o.value.beginHostEOF(), /within3000ms/); await new Promise(done => o.child.once('close', done)); assert.equal(o.child.exitCode, 0); assert.equal(o.kills, 0)
})
for (const [name, opts] of [['foreign phase', { second: 'different-host' }], ['malformed initial JSON', { malformed: true }]]) test('real observer rejects ' + name + ' without terminating any process', async () => {
  const o = observer(opts); try { await o.value.ready(); o.value.beginHostEOF(); await assert.rejects(o.value.finish()) } catch (error) { assert.match(error.message, /JSON|phase/) } await new Promise(done => { if (o.child.exitCode !== null) done(); else o.child.once('close', done) }); assert.equal(o.kills, 0)
})
test('abort before HostEOF sends only normal observer stdin EOF and cannot authorize a Host command', async () => {
  const o = observer(); await o.value.ready(); o.value.abortBeforeHostEOF(); await assert.rejects(o.value.finish(), /naturally finish/); assert.equal(o.kills, 0)
})
test('production caller retains exact original30s preparation and3s Host/console natural retirement caps', async () => {
  const s = await readFile(new URL('../scripts/e2e-harness.mjs', import.meta.url), 'utf8'), bridge = await readFile(new URL('../scripts/harness-windows-window-retirement.mjs', import.meta.url), 'utf8')
  assert(bridge.includes('readyMs = 30000, retireMs = 3000')); assert(s.includes("const sourceFailure=process.platform === 'darwin' ? ownedMacInputSourceFailure(profileHome,host.pid) : null")); assert(s.includes('windowsWindowRetirementObserver?.beginHostEOF() } finally { host?.stdin.end() }')); assert(s.includes('windowsSessionConsoleRetirement.observerExit, { code: 0, signal: null }')); assert(!/\.kill\(|process\.exit\(/u.test(bridge))
})
