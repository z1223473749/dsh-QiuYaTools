/** Test-only Windows fixture rendezvous; never exposes its oracle to the model. */
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve, win32 } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { RemoteComputerDriver, COMPUTER_AGENT_PATH } from '../src/features/computer-use/remote.ts'
import { readPrivateJSON, writePrivateJSON, removePrivateJSON, externalFile, visionDigest } from './live-vision-external-core.mjs'
import { windowsVisionDesktopPassed } from './live-vision-windows-audit.mjs'
import { createWindowsVisionCancel, validateWindowsVisionCancelAck } from './live-vision-windows-cancel.mjs'
import { visionPreauthorizationPassed } from './live-vision-guard-core.mjs'

const fail = code => { throw Object.assign(new Error(code), { code }) }
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value)
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const sid = value => typeof value === 'string' && value.startsWith('qiuya-vision-') && uuid(value.slice('qiuya-vision-'.length))
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase()
const exactIdentity = value => value && Number.isSafeInteger(value.pid) && value.pid > 1 && /^\d{10,30}$/u.test(value.createdAtTicks) && typeof value.executablePath === 'string' && /^[a-z]:[\\/]/iu.test(value.executablePath)
export function sameWindowsVisionIdentity(a, b) { return exactIdentity(a) && exactIdentity(b) && a.pid === b.pid && a.createdAtTicks === b.createdAtTicks && samePath(a.executablePath, b.executablePath) }
export function validateWindowsVisionConfig(value, now = Date.now()) {
  if (!value || value.version !== 1 || value.platform !== 'win32' || !uuid(value.runId) || !sha(value.rendezvousNonce) ||
      !['directory', 'native', 'fixture', 'carrier'].every(key => typeof value[key] === 'string' && isAbsolute(value[key]) && resolve(value[key]) === value[key]) ||
      !['nativeSha256', 'fixtureSha256', 'carrierSha256', 'auditSha256'].every(key => sha(value[key])) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now || value.expiresAt > now + 20 * 60_000) fail('VISION_EXTERNAL_CONFIG')
  return value
}
export function validateWindowsVisionBinding(value, request, config) {
  if (!value || value.version !== 1 || value.runId !== config.runId || value.rendezvousNonce !== config.rendezvousNonce || value.task !== request.task || value.sessionId !== request.sessionId || value.requestId !== request.requestId) fail('VISION_EXTERNAL_BINDING')
  return value
}
function localURL(value, path) {
  let url; try { url = new URL(value) } catch { fail('VISION_EXTERNAL_BINDING') }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== path || url.username || url.password || url.search || url.hash) fail('VISION_EXTERNAL_BINDING')
  return url
}
export function validateWindowsVisionReady(value, request, config) {
  validateWindowsVisionBinding(value, request, config)
  const endpoint = localURL(value.endpoint, COMPUTER_AGENT_PATH), control = localURL(value.controlEndpoint, '/test/status')
  if (endpoint.origin !== control.origin || !sha(value.token) || !sha(value.controlToken) || value.token === value.controlToken ||
      value.nativeSha256 !== config.nativeSha256 || value.fixtureSha256 !== config.fixtureSha256 || value.auditSha256 !== config.auditSha256 ||
      !exactIdentity(value.fixtureIdentity) || !exactIdentity(value.nativeIdentity) || typeof value.guestRoot !== 'string' ||
      !Number.isSafeInteger(value.nativeIdentity.sessionId) || value.nativeIdentity.sessionId <= 0 || value.fixtureIdentity.sessionId !== value.nativeIdentity.sessionId ||
      !value.guestRoot.toLowerCase().includes(config.runId.toLowerCase()) || !/^\d+$/u.test(value.windowId)) fail('VISION_EXTERNAL_BINDING')
  const parts = typeof value.target?.id === 'string' && /^window:([a-f0-9]+):(\d+):(\d+)$/u.exec(value.target.id)
  if (!parts || BigInt('0x' + parts[1]) !== BigInt(value.windowId) || Number(parts[2]) !== value.fixtureIdentity.pid || parts[3] !== value.fixtureIdentity.createdAtTicks || value.target.pid !== value.fixtureIdentity.pid ||
      !samePath(value.target.appId, value.fixtureIdentity.executablePath) ||
      !samePath(win32.dirname(value.fixtureIdentity.executablePath), value.guestRoot) || !samePath(win32.dirname(value.nativeIdentity.executablePath), value.guestRoot)) fail('VISION_EXTERNAL_BINDING')
  return value
}
export function projectWindowsVisionOracle(value, record) {
  const ready = record.windows.ready
  if (value?.fixtureAlive !== true || !sameWindowsVisionIdentity(value.fixtureIdentity, ready.fixtureIdentity) || value.windowId !== ready.windowId || value.oracle?.task !== record.task) fail('VISION_EXTERNAL_FIXTURE_CHANGED')
  const oracle = value.oracle
  if (!['passed', 'submitted', 'textMatches'].every(key => typeof oracle[key] === 'boolean') || !['correctClicks', 'wrongClicks', 'mouseDown', 'mouseUp', 'dragged'].every(key => Number.isSafeInteger(oracle[key]) && oracle[key] >= 0 && oracle[key] <= 0x7fffffff)) fail('VISION_FIXTURE_PROTOCOL')
  return Object.fromEntries(['task', 'passed', 'correctClicks', 'wrongClicks', 'mouseDown', 'mouseUp', 'dragged', 'submitted', 'textMatches'].map(key => [key, oracle[key]]))
}
export function windowsVisionCleanupPassed(value, { auditSha256, sessionId } = {}) {
  return value?.passed === true && Array.isArray(value.errors) && value.errors.length === 0 && value.nativeNaturalExit === true && value.fixtureNaturalExit === true && value.forced === false &&
    value.auditSha256 === auditSha256 && value.expectedSessionId === sessionId && windowsVisionDesktopPassed(value.desktopAudit, { auditSha256, sessionId })
}
async function readSoon(path, milliseconds) {
  const deadline = Date.now() + milliseconds
  while (Date.now() < deadline) {
    try { return await readPrivateJSON(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
    await sleep(50)
  }
  fail('VISION_EXTERNAL_DEADLINE')
}
export function createWindowsVisionAdapter(configPath, directory) {
  let configuration
  async function control(record) {
    const ready = record.windows.ready
    const response = await fetch(ready.controlEndpoint, { method: 'GET', headers: { Authorization: 'Bearer ' + ready.controlToken }, redirect: 'error', signal: AbortSignal.timeout(5000) })
    if (!response.ok) fail('VISION_EXTERNAL_FIXTURE_CHANGED')
    const reader = response.body?.getReader(); if (!reader) fail('VISION_FIXTURE_PROTOCOL')
    const chunks = []; let length = 0
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > 65536) { await reader.cancel(); fail('VISION_FIXTURE_PROTOCOL') }; chunks.push(value) } }
    finally { reader.releaseLock() }
    let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { fail('VISION_FIXTURE_PROTOCOL') }
    validateWindowsVisionBinding(value, record.windows.request, record.windows.config)
    if (record.testOnlyNaturalEntry) record.preauthorization = undefined
    if (record.testOnlyNaturalEntry && value.preauthorization) {
      const passed = visionPreauthorizationPassed(value.preauthorization, { sessionId: ready.nativeIdentity.sessionId, auditSha256: record.windows.config.auditSha256 })
      record.preauthorization = { ...value.preauthorization, passed }
      if (!passed) fail('VISION_NATURAL_PREAUTH_AUDIT')
    }
    return projectWindowsVisionOracle(value, record)
  }
  return {
    async cancelRun({ phase }) {
      const cfg = validateWindowsVisionConfig(await readPrivateJSON(configPath)); if (cfg.directory !== directory || cfg.probeOnly === true || configuration) fail('VISION_CANCEL_NOT_IDLE')
      for (const key of ['native', 'fixture', 'carrier']) if (visionDigest(await readFile(cfg[key])) !== cfg[key + 'Sha256']) fail('VISION_EXTERNAL_SOURCE_CHANGED')
      const carrier = await readPrivateJSON(join(directory, 'external/carrier-ready.json'))
      if (carrier.runId !== cfg.runId || carrier.rendezvousNonce !== cfg.rendezvousNonce || carrier.platform !== 'win32' || ['nativeSha256','fixtureSha256','auditSha256'].some(key => carrier[key] !== cfg[key])) fail('VISION_EXTERNAL_BINDING')
      const cancellation = createWindowsVisionCancel(cfg, phase)
      await writePrivateJSON(join(directory, 'external/carrier-cancel.json'), cancellation)
      const ack = validateWindowsVisionCancelAck(await readSoon(join(directory, 'external/carrier-cancelled.json'), 30000), cfg, cancellation, carrier.carrierIdentity)
      return { requested: true, confirmed: true, status: ack.status, modelCompleted: false, records: 0 }
    },
    async prepare(record) {
      const cfg = validateWindowsVisionConfig(await readPrivateJSON(configPath)); configuration = cfg
      if (cfg.directory !== directory) fail('VISION_EXTERNAL_CONFIG')
      for (const key of ['native', 'fixture', 'carrier']) if (visionDigest(await readFile(cfg[key])) !== cfg[key + 'Sha256']) fail('VISION_EXTERNAL_SOURCE_CHANGED')
      const carrier = await readSoon(join(directory, 'external/carrier-ready.json'), 20000)
      if (carrier.version !== 1 || carrier.platform !== 'win32' || carrier.runId !== cfg.runId || carrier.rendezvousNonce !== cfg.rendezvousNonce || carrier.nativeSha256 !== cfg.nativeSha256 || carrier.fixtureSha256 !== cfg.fixtureSha256 || carrier.auditSha256 !== cfg.auditSha256) fail('VISION_EXTERNAL_BINDING')
      if (!sid(record.sessionId) || ![1, 2, 3].includes(record.task) || !/^[0-9A-F]{6}$/u.test(record.nonce)) fail('VISION_EXTERNAL_BINDING')
      const request = { version: 1, runId: cfg.runId, rendezvousNonce: cfg.rendezvousNonce, requestId: randomUUID(), task: record.task, sessionId: record.sessionId, nonce: record.nonce,
        note: `青山路18号，请轻放，核验码${record.nonce}`, seed: randomBytes(2).readUInt16BE() }
      if (record.testOnlyNaturalEntry) request.testOnlyNaturalEntry = true
      record.windows = { config: cfg, request }
      await writePrivateJSON(externalFile(cfg, record.task, 'request'), request)
      const ready = validateWindowsVisionReady(await readSoon(externalFile(cfg, record.task, 'ready'), 20000), request, cfg)
      record.windows.ready = ready
      record.target = ready.target; record.pairEndpoint = ready.endpoint; record.pairToken = ready.token
      record.native = new RemoteComputerDriver({ endpoint: ready.endpoint, token: ready.token })
      await control(record)
    },
    check: control,
    snapshot: control,
    async cleanup(record) {
      if (!record.windows) return { passed: false, errors: ['VISION_EXTERNAL_BINDING'], fixtureNaturalExit: false, nativeNaturalExit: false, forced: false }
      const { config: cfg, request } = record.windows
      await writePrivateJSON(externalFile(cfg, record.task, 'stop'), { version: 1, runId: cfg.runId, rendezvousNonce: cfg.rendezvousNonce, requestId: request.requestId, sessionId: request.sessionId, task: record.task })
      const receipt = validateWindowsVisionBinding(await readSoon(externalFile(cfg, record.task, 'cleanup'), 30000), request, cfg)
      if (!windowsVisionCleanupPassed(receipt.cleanup, { auditSha256: cfg.auditSha256, sessionId: record.windows.ready.nativeIdentity.sessionId })) fail('VISION_EXTERNAL_CLEANUP_FAILED')
      await removePrivateJSON(externalFile(cfg, record.task, 'cleanup'))
      return receipt.cleanup
    },
    async delivery(records) {
      if (!configuration || records.length !== 3) return false
      const result = await readSoon(join(directory, 'evidence/external-carrier-report.json'), 30000)
      return result.runId === configuration.runId && result.nativeSha256 === configuration.nativeSha256 && result.status === 'completed' && result.cleanupErrors?.length === 0 && result.records?.length === 3 &&
        result.records.every(row => records.some(record => record.windows?.request.requestId === row.requestId && record.sessionId === row.sessionId && record.task === row.task && windowsVisionCleanupPassed(row.cleanup, { auditSha256: configuration.auditSha256, sessionId: record.windows.ready.nativeIdentity.sessionId })))
    },
  }
}
