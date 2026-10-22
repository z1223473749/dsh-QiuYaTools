/** Explicit test carrier launched by Codex. Never launched by the Harness plugin. */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { createComputerAgentServer, NativeCompanionDriver } from '../src/features/computer-use/remote.ts'
import { projectVisionNativeStatus, withVisionFailureEvidence } from './live-vision-guard-core.mjs'
import { visionDigest, visionExternalFailure as fail, validateExternalConfig, validateExternalRequest, validateExternalBinding,
  verifyExternalFixture, sameExternalIdentity, sameExternalExecutable, externalIdentityRetired, readPrivateJSON, writePrivateJSON, removePrivateJSON, externalFile } from './live-vision-external-core.mjs'

function oracleRPC(path) {
  const child = spawn(path, [], { stdio: ['pipe', 'pipe', 'pipe'] }), pending = new Map(); let sequence = 0, readyResolve, readyReject
  const ready = new Promise((done, reject) => { readyResolve = done; readyReject = reject }), exits = new Promise(done => child.once('exit', (code, signal) => done({ code, signal })))
  child.stderr.resume(); child.stdin.on('error', () => {})
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    if (line.length > 65536) { readyReject(Error('VISION_EXTERNAL_ORACLE')); return }
    let value; try { value = JSON.parse(line) } catch { readyReject(Error('VISION_EXTERNAL_ORACLE')); return }
    if (value.event === 'ready') readyResolve(value.identity)
    const entry = pending.get(value.requestId); if (entry) { pending.delete(value.requestId); clearTimeout(entry.timer); value.ok ? entry.done(value.result) : entry.reject(Error('VISION_EXTERNAL_ORACLE')) }
  })
  child.once('error', () => readyReject(Error('VISION_EXTERNAL_ORACLE')))
  exits.then(() => { readyReject(Error('VISION_EXTERNAL_ORACLE')); for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('VISION_EXTERNAL_ORACLE')) }; pending.clear(); lines.close() })
  return { child, ready, exits, request: (op, payload = {}) => new Promise((done, reject) => {
    const requestId = ++sequence, timer = setTimeout(() => { pending.delete(requestId); reject(Error('VISION_EXTERNAL_ORACLE_TIMEOUT')) }, 5000)
    pending.set(requestId, { done, reject, timer }); child.stdin.write(JSON.stringify({ requestId, op, ...payload }) + '\n', error => { if (error) { clearTimeout(timer); pending.delete(requestId); reject(Error('VISION_EXTERNAL_ORACLE')) } })
  }) }
}
async function bounded(promise, ms, code) {
  let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(Error(code), { code })), ms) })]) } finally { clearTimeout(timer) }
}
export async function runExternalVisionCarrier(configPath) {
  if (process.platform !== 'darwin') fail('VISION_MAC_REQUIRED')
  const config = validateExternalConfig(await readPrivateJSON(resolve(configPath))), evidence = join(config.directory, 'evidence')
  const hashFile = async path => visionDigest(await readFile(path)), records = [], known = new Map(), cleanupErrors = []
  let oracle, active, stopping = false, carrierIdentity, fatal, task = 1, oracleNaturalExit = false
  const report = () => ({ kind: 'Codex-launched-test-only-standard-paired-agent', status: fatal || cleanupErrors.length || records.some(row => !row.cleanup?.passed) ? 'failed' : records.length === 3 ? 'completed' : 'cancelled',
    carrierDifference: 'Helper inherits this explicitly launched test carrier, not the installed Harness process. This does not establish Harness local TCC or installed local-desktop acceptance.',
    modelRequestsSentByCarrier: 0, permissionsChanged: false, runId: config.runId, nativeSha256: config.nativeSha256, oracleSha256: config.oracleSha256, fixtureSha256: config.fixtureSha256, carrierIdentity,
    records: records.map(row => ({ task: row.task, requestId: row.request?.requestId, sessionId: row.request?.sessionId,
      fixtureIdentity: row.fixtureIdentity, nativeIdentity: row.nativeIdentity, nativeStatus: row.nativeStatus, inputFailures: row.inputFailures ?? [], cleanup: row.cleanup })), oracleNaturalExit, cleanupErrors, fatal })
  const stop = () => { stopping = true }; process.once('SIGTERM', stop); process.once('SIGINT', stop)
  const remember = (value, role) => { if (!value?.pid) fail('VISION_EXTERNAL_IDENTITY'); known.set(`${value.pid}:${value.startSeconds}:${value.startMicroseconds}`, { ...value, role }); return value }
  const identity = async pid => (await oracle.request('identity', { pid })).identity
  async function retire(record) {
    if (!record || record.cleanup) return record?.cleanup
    const errors = [], child = record.child
    if (!child || !record.nativeIdentity) errors.push('VISION_EXTERNAL_IDENTITY')
    try { await record.server?.revoke() } catch { errors.push('VISION_PAIR_REVOKE_FAILED') }
    try { await record.server?.close() } catch { errors.push('VISION_PAIR_CLOSE_FAILED') }
    try { if (record.nativeIdentity) for (const row of (await oracle.request('children', { identity: record.nativeIdentity })).identities) remember(row, 'native-child') } catch { errors.push('VISION_EXTERNAL_IDENTITY') }
    try { await bounded(record.driver.dispose(), 10000, 'VISION_NATIVE_CLEANUP_FAILED') } catch { errors.push('VISION_NATIVE_CLEANUP_FAILED') }
    if (child) try { const exit = await bounded(record.exits, 5000, 'VISION_NATIVE_CLEANUP_FAILED'); if (exit.code !== 0 || exit.signal !== null) errors.push('VISION_NATIVE_CLEANUP_FAILED') } catch { errors.push('VISION_NATIVE_CLEANUP_FAILED') }
    for (const row of [...known.values()].filter(row => row.ownerTask === record.task || row.pid === record.nativeIdentity?.pid || row.parentPid === record.nativeIdentity?.pid)) {
      try {
        const deadline = performance.now() + 5000
        while (!externalIdentityRetired(await identity(row.pid), row) && performance.now() < deadline) await sleep(25)
        if (!externalIdentityRetired(await identity(row.pid), row)) errors.push('VISION_EXTERNAL_REMAINS')
      } catch { errors.push('VISION_EXTERNAL_IDENTITY') }
    }
    record.cleanup = { passed: errors.length === 0, errors, nativeNaturalExit: !!child && child.exitCode === 0 && child.signalCode === null, forced: false }
    for (const kind of ['ready', 'request', 'stop']) try { await removePrivateJSON(externalFile(config, record.task, kind)) } catch { record.cleanup.errors.push('VISION_EXTERNAL_FILE_BOUNDARY'); record.cleanup.passed = false }
    if (record.request) await writePrivateJSON(externalFile(config, record.task, 'cleanup'), { version: 1, runId: config.runId, rendezvousNonce: config.rendezvousNonce,
      requestId: record.request.requestId, sessionId: record.request.sessionId, task: record.task, cleanup: record.cleanup })
    await writeFile(join(evidence, `external-task-${record.task}.json`), JSON.stringify({ task: record.task, requestId: record.request?.requestId,
      fixtureIdentity: record.fixtureIdentity, nativeIdentity: record.nativeIdentity, nativeStatus: record.nativeStatus, inputFailures: record.inputFailures ?? [], cleanup: record.cleanup }, null, 2))
    return record.cleanup
  }
  try {
    for (const [path, expected] of [[config.native, config.nativeSha256], [config.oracle, config.oracleSha256], [config.carrier, config.carrierSha256]]) if (await hashFile(path) !== expected) fail('VISION_EXTERNAL_SOURCE_CHANGED')
    oracle = oracleRPC(config.oracle); const oracleIdentity = remember(await bounded(oracle.ready, 5000, 'VISION_EXTERNAL_ORACLE_TIMEOUT'), 'oracle')
    if (oracleIdentity.pid !== oracle.child.pid || !await sameExternalExecutable(oracleIdentity.executablePath, config.oracle)) fail('VISION_EXTERNAL_IDENTITY')
    carrierIdentity = await identity(process.pid); if (!await sameExternalExecutable(carrierIdentity.executablePath, process.execPath)) fail('VISION_EXTERNAL_IDENTITY')
    await writePrivateJSON(join(config.directory, 'external', 'carrier-ready.json'), { version: 1, runId: config.runId, rendezvousNonce: config.rendezvousNonce, carrierIdentity })
    while (!stopping && task <= 3 && Date.now() < config.expiresAt) {
      let request
      try { request = await readPrivateJSON(externalFile(config, task, 'request')) } catch (error) { if (error.code !== 'ENOENT') throw error; await sleep(50); continue }
      validateExternalRequest(request, config, task)
      const driver = new NativeCompanionDriver({ executable: config.native }), record = { task, request, driver }; active = record; records.push(record)
      record.nativeStatus = projectVisionNativeStatus(await driver.status())
      record.child = Reflect.get(driver, 'child'); if (!record.child?.pid) fail('VISION_EXTERNAL_IDENTITY')
      record.exits = record.child.exitCode !== null || record.child.signalCode !== null ? Promise.resolve({ code: record.child.exitCode, signal: record.child.signalCode }) : new Promise(done => record.child.once('exit', (code, signal) => done({ code, signal })))
      record.nativeIdentity = remember(await identity(record.child.pid), 'native'); record.nativeIdentity.ownerTask = task
      if (!await sameExternalExecutable(record.nativeIdentity.executablePath, config.native) || record.nativeIdentity.parentPid !== process.pid) fail('VISION_EXTERNAL_IDENTITY')
      if (!record.nativeStatus.available || record.nativeStatus.permissions?.screenRecording !== true || record.nativeStatus.permissions?.accessibility !== true || record.nativeStatus.permissions?.postEvents !== true) fail('VISION_EXTERNAL_NATIVE_PERMISSION')
      const check = async targetId => {
        if (targetId !== undefined && targetId !== `mac-window:${request.windowId}`) fail('VISION_TARGET_CHANGED')
        if (await hashFile(config.native) !== config.nativeSha256) fail('VISION_EXTERNAL_SOURCE_CHANGED')
        const value = await verifyExternalFixture(request, config, { identity, fileHash: hashFile, targets: () => driver.targets(), pinned: record.fixtureIdentity })
        record.fixtureIdentity ??= value.identity; return value.target
      }
      const target = await check(), fixed = {
        async status(signal) { await check(); return driver.status(signal) }, async targets() { return [await check()] },
        async observe(targetId, signal) { await check(targetId); return driver.observe(targetId, signal) }, async preview(targetId, signal) { await check(targetId); return driver.preview(targetId, signal) },
        async lease(epoch, signal, options) { await check(); return driver.lease(epoch, signal, options) }, release: (epoch, signal) => driver.release(epoch, signal),
        async act(epoch, targetId, action, signal) { await check(targetId); return withVisionFailureEvidence(() => driver.act(epoch, targetId, action, signal),
          () => driver.status(AbortSignal.timeout(1000)), failure => { record.inputFailures ??= []; if (record.inputFailures.length < 32) record.inputFailures.push(failure) }) },
        async openPreview() { fail('VISION_PREVIEW_NOT_EXPOSED') }, async closePreview() {}, subscribe: listener => driver.subscribe(listener),
      }
      const token = (await import('node:crypto')).randomBytes(32).toString('hex')
      record.server = await createComputerAgentServer(fixed, { token, host: '127.0.0.1', port: 0 })
      await writePrivateJSON(externalFile(config, task, 'ready'), { version: 1, runId: config.runId, rendezvousNonce: config.rendezvousNonce, requestId: request.requestId,
        sessionId: request.sessionId, task, target, fixtureIdentity: record.fixtureIdentity, nativeIdentity: record.nativeIdentity, nativeStatus: record.nativeStatus, carrierIdentity, endpoint: record.server.endpoint, token })
      const deadline = Date.now() + 240000
      while (!stopping && Date.now() < deadline && Date.now() < config.expiresAt) {
        let stopped
        try { stopped = await readPrivateJSON(externalFile(config, task, 'stop')) } catch (error) { if (error.code !== 'ENOENT') throw error }
        if (stopped) { validateExternalBinding(stopped, request, config); break }
        if (!sameExternalIdentity(await identity(request.pid), record.fixtureIdentity)) fail('VISION_EXTERNAL_FIXTURE_CHANGED')
        await sleep(100)
      }
      if (stopping || Date.now() >= deadline || Date.now() >= config.expiresAt) fatal = 'VISION_EXTERNAL_DEADLINE'
      await retire(record); active = undefined
      if (fatal || !record.cleanup.passed) break
      task++
    }
  } catch (error) { fatal = typeof error.code === 'string' && /^VISION_[A-Z_]+$/u.test(error.code) ? error.code : 'VISION_EXTERNAL_FAILED' }
  finally {
    if (active) try { await retire(active) } catch { cleanupErrors.push('VISION_CLEANUP_FAILED') }
    const secretFiles = [join(config.directory, 'external', 'carrier-ready.json'), configPath,
      ...[1, 2, 3].flatMap(task => ['request', 'ready', 'stop'].map(kind => externalFile(config, task, kind)))]
    for (const path of secretFiles) try { await removePrivateJSON(path) } catch { cleanupErrors.push('VISION_EXTERNAL_FILE_BOUNDARY') }
    if (oracle) try { oracle.child.stdin.end(); const exit = await bounded(oracle.exits, 5000, 'VISION_EXTERNAL_ORACLE_TIMEOUT'); oracleNaturalExit = exit.code === 0 && exit.signal === null; if (!oracleNaturalExit) cleanupErrors.push('VISION_EXTERNAL_ORACLE') } catch { cleanupErrors.push('VISION_EXTERNAL_ORACLE') }
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop)
    await writePrivateJSON(join(evidence, 'external-carrier-report.json'), report())
  }
  const result = report(); if (result.status === 'failed') process.exitCode = 1
  console.log(JSON.stringify({ kind: result.kind, status: result.status, tasks: records.length, cleanupErrors, fatal: fatal ?? null }))
  return result
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--config'); if (index < 0 || !process.argv[index + 1]) fail('VISION_EXTERNAL_CONFIG')
  runExternalVisionCarrier(resolve(process.argv[index + 1])).catch(() => { process.stderr.write('VISION_EXTERNAL_FAILED\n'); process.exitCode = 1 })
}
