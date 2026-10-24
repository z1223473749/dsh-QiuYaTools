/** Prepared Windows-to-Mac carrier. Preparation/plan performs no native build or PD calls. */
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createInterface } from 'node:readline'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { reverseRemoteDeliveryPassed } from './reverse-remote-delivery.mjs'

export const reverseSnapshotSmoke = "import assert from'node:assert/strict';try{await import(process.argv[1]);throw Error('Unexpected execution beyond import-only gate')}catch(error){assert.equal(error.message,'Set QIUYA_PD_VM and QIUYA_PD_HOST_IP for the authorized test VM');console.log(JSON.stringify({passed:true,staticModuleClosureResolved:true,entryValidationReached:true,pdCommandsExecuted:0,guiStarted:0,nativeCompilations:0}))}"
export async function runReverseRemoteCarrier(base, data, argv = process.argv) {
  const arg = name => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1] }
  const running = argv.includes('--run'), planning = argv.includes('--plan')
  assert.notEqual(running, planning, 'Pass --plan or --run')
  const hash = bytes => createHash('sha256').update(bytes).digest('hex'), execute = promisify(execFile)
  async function verify() {
    assert.equal(hash(await readFile(join(base, 'entry.mjs'))), data.entrySHA256, 'Prepared entry changed')
    for (const [path, expected] of Object.entries(data.sourceHashes)) assert.equal(hash(await readFile(join(data.root, path))), expected, 'Bound source changed: ' + path)
    for (const [path, expected] of Object.entries(data.snapshotHashes)) assert.equal(hash(await readFile(join(base, 'snapshot', path))), expected, 'Prepared snapshot changed: ' + path)
    assert.equal(hash(await readFile(data.helper)), data.helperSHA256, 'Formal Mac helper changed')
    assert.equal(hash(await readFile(data.runtime.nodeArchivePath)), data.runtime.nodeArchiveSHA256, 'Reviewed Node archive changed')
  }
  await verify()
  const smokeEnv = { ...process.env }; delete smokeEnv.QIUYA_PD_VM; delete smokeEnv.QIUYA_PD_HOST_IP
  const smoke = JSON.parse((await execute(process.execPath, ['--input-type=module', '-e', reverseSnapshotSmoke, pathToFileURL(join(base, 'snapshot/scripts/e2e-windows-to-macos-pd.mjs')).href], { env: smokeEnv, timeout: 15000 })).stdout.trim())
  assert.equal(smoke.passed, true)
  if (planning) {
    console.log(JSON.stringify({ status: 'prepared-not-run', preparedId: data.id, output: data.output, helperSHA256: data.helperSHA256, sourceCount: Object.keys(data.sourceHashes).length, snapshotCount: Object.keys(data.snapshotHashes).length, snapshotImportSmoke: smoke, deferredNativeCompilation: data.deferredNativeCompilation, guiStarted: false, pdCommandsExecuted: false, externalDirectoryWritten: false, nativeCompilations: 0 }, null, 2)); return
  }
  assert.equal(arg('--gui-gate'), 'root-approved', 'Root must own both the Mac and PD input slot')
  const output = resolve(data.output), repo = resolve(data.root)
  assert.ok(output !== repo && !output.startsWith(repo + sep), 'Actual screenshots and reports must remain outside Git')
  const prlctl = '/Applications/Parallels Desktop.app/Contents/MacOS/prlctl', node = data.runtime.assetRoot + '\\node-v22.23.3-win-' + data.runtime.architecture + '\\node.exe'
  const quote = value => "'" + value.replaceAll("'", "''") + "'"
  const ps = async code => {
    const encoded = Buffer.from(code, 'utf16le').toString('base64'); assert.ok(encoded.length <= 2000)
    return (await execute(prlctl, ['exec', data.vm, 'powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 })).stdout.trim()
  }
  await mkdir(output)
  await writeFile(join(output, 'carrier-binding.json'), JSON.stringify({ ...data, gate: 'one-shot after independent guest identity/capture checkpoint and fresh empty OS audit', inputReplay: false }, null, 2), { mode: 0o600 })
  let childExit, failure, sourceUnchanged = false, priorPause, pauseRestored = false, stdout = '', stderr = '', gateOpened = false, gatePending, idlePauseSetCalls = 0
  const progress = []
  async function openGate() {
    const probe = JSON.parse((await execute(join(output, 'reverse-oracle'), ['--one-shot', JSON.stringify({ op: 'snapshot' })], { timeout: 8000, maxBuffer: 1024 * 1024 })).stdout)
    assert.equal(probe.ok, true)
    const state = probe.result
    assert.ok(state.sessionExists && !state.screenLocked && state.leftButtonDown === false && state.rightButtonDown === false && state.middleButtonDown === false && state.keysDown?.length === 0, 'Mac OS input must be empty at the one-shot gate; no input replay')
    await writeFile(join(output, 'carrier-gate-preflight.json'), JSON.stringify({ passed: true, sessionExists: state.sessionExists, screenLocked: state.screenLocked, osInputEmpty: true }, null, 2), { mode: 0o600 })
    await writeFile(join(output, 'begin-input'), 'root-approved\n', { flag: 'wx', mode: 0o600 }); gateOpened = true
  }
  try {
    const before = (await execute(prlctl, ['list', '--info', data.vm], { timeout: 30000, killSignal: 'SIGKILL' })).stdout
    priorPause = /Pause idle: (on|off)/u.exec(before)?.[1]; assert.ok(priorPause, 'VM idle-pause state unavailable')
    if(priorPause==='on'){idlePauseSetCalls++;await execute(prlctl, ['set', data.vm, '--pause-idle', 'off'], { timeout: 30000, killSignal: 'SIGKILL' })}
    const actualNodeSHA256 = await ps("$ErrorActionPreference='Stop';(Get-FileHash -LiteralPath " + quote(node) + ' -Algorithm SHA256).Hash.ToLowerInvariant()')
    assert.equal(actualNodeSHA256, data.runtime.nodeExecutableSHA256, 'Read-only guest Node differs from the reviewed archive member')
    await writeFile(join(output, 'carrier-node-proof.json'), JSON.stringify({ actualNodeSHA256, matched: true, noRuntimeWrites: true }, null, 2))
    const env = { ...process.env, QIUYA_PD_VM: data.vm, QIUYA_PD_HOST_IP: data.host, QIUYA_WINDOWS_NODE_ROOT: data.runtime.assetRoot, QIUYA_WINDOWS_NODE_ARCH: data.runtime.architecture, QIUYA_REVERSE_REMOTE_OUTPUT: output }
    childExit = await new Promise((done, reject) => {
      const child = spawn(process.execPath, [join(base, 'snapshot/scripts/e2e-windows-to-macos-pd.mjs')], { cwd: data.root, env, stdio: ['ignore', 'pipe', 'pipe'] })
      const lines = createInterface({ input: child.stdout })
      child.stdout.on('data', bytes => { stdout = (stdout + bytes).slice(-8 * 1024 * 1024) }); child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-2 * 1024 * 1024) })
      lines.on('line', line => {
        let value; try { value = JSON.parse(line) } catch { return }
        if (typeof value.stage === 'string') { progress.push({ stage: value.stage, at: new Date().toISOString() }); console.log(JSON.stringify({ stage: value.stage, output })) }
        if (value.stage === 'capture-only-passed-waiting-for-input-gate' && !gatePending && !gateOpened) gatePending = openGate().catch(error => { failure ??= { message: error.message } })
      })
      child.once('error', reject); child.once('exit', (code, signal) => { lines.close(); done({ code, signal, runnerPid: child.pid }) })
    })
    await gatePending
    assert.deepEqual({ code: childExit.code, signal: childExit.signal }, { code: 0, signal: null }, 'Strict reverse runner did not exit naturally and successfully')
  } catch (error) { failure ??= { message: error.message, code: error.code ?? null } }
  finally {
    if (priorPause) try {
      if(priorPause==='on'){idlePauseSetCalls++;await execute(prlctl, ['set', data.vm, '--pause-idle', priorPause], { timeout: 30000, killSignal: 'SIGKILL' })}
      const info = (await execute(prlctl, ['list', '--info', data.vm], { timeout: 30000, killSignal: 'SIGKILL' })).stdout
      pauseRestored = new RegExp('Pause idle: ' + priorPause).test(info); assert.ok(pauseRestored, 'Original VM idle-pause state was not restored')
    } catch (error) { failure ??= { message: error.message } }
    try { await verify(); sourceUnchanged = true } catch (error) { failure ??= { message: error.message } }
    await writeFile(join(output, 'carrier-stdout.log'), stdout, { mode: 0o600 }); await writeFile(join(output, 'carrier-stderr.log'), stderr, { mode: 0o600 })
    let actual; try { actual = JSON.parse(await readFile(join(output, 'delivery-verdict.json'), 'utf8')) } catch { failure ??= { message: 'Strict reverse delivery verdict missing' } }
    const recomputedPassed = actual && reverseRemoteDeliveryPassed({ clientReport: { passed: actual.clientPassed, checks: actual.checks }, setupError: actual.orchestrationError, cleanup: actual.cleanup })
    const passed = !failure && sourceUnchanged && pauseRestored && gateOpened && actual?.passed === true && recomputedPassed === true
    await writeFile(join(output, 'carrier-verdict.json'), JSON.stringify({ passed, preparedId: data.id, childExit, failure, sourceUnchanged, priorPause, pauseRestored, idlePauseSetCalls, gateOpened, progress, recomputedPassed: recomputedPassed === true, actualPassed: actual?.passed === true, actualCleanupPassed: actual?.cleanup?.passed === true }, null, 2), { mode: 0o600 })
    console.log(JSON.stringify({ passed, output, failure, sourceUnchanged, pauseRestored, gateOpened, checks: actual?.checks?.length, recomputedPassed: recomputedPassed === true }, null, 2)); if (!passed) process.exitCode = 1
  }
}
