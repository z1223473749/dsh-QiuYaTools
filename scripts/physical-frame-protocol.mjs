import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { open, lstat, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
export const PRL_PHYSICAL_SOURCE = 'parallels-prlctl-primary-physical-frame'
export const MAX_RAW_BYTES = 64 * 1024 * 1024
export const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const decimal = value => typeof value === 'string' && /^\d{1,20}$/u.test(value)
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
export function publicationEvidenceValid(value) {
  const p = value?.publication, times = value?.hostStageNs
  if (!p) return value?.captureCompletionRequiredBeforeFinalize !== true
  const keys = ['requestReceived', 'captureStarted', 'filePinned', 'headerChecked', 'filePublicationObserved', 'stableFileConfirmed', 'replyReady']
  return Boolean(value.captureCompletionRequiredBeforeFinalize === true && p.method === 'one-original-prl-file-complete-PNG-publication' && p.inspectedBytes === 45 && p.headerBytes === 33 && p.terminalBytes === 12 && p.terminalIEND === true && p.terminalSHA256 === digest(Buffer.from('0000000049454e44ae426082', 'hex')) && Number.isInteger(p.stableMs) && p.stableMs >= 10 && p.stableMs <= 100 && p.decoded === false && p.fullReadBeforeGate === false && keys.every((key, i) => decimal(times?.[key]) && (i === 0 || BigInt(times[keys[i - 1]]) <= BigInt(times[key]))) && BigInt(times.stableFileConfirmed) - BigInt(times.filePublicationObserved) >= BigInt(p.stableMs) * 1000000n)
}
export function pinnedStat(value) {
  assert.ok(value.isFile() && !value.isSymbolicLink?.() && value.nlink === 1n && value.size >= 33n && value.size <= BigInt(MAX_RAW_BYTES), 'A bounded ordinary single-link PNG file is required')
  return Object.fromEntries(['ino', 'dev', 'size', 'mode', 'nlink', 'mtimeNs', 'ctimeNs'].map(key => [key, String(value[key])]))
}
export const samePinnedStat = (a, b) => Boolean(a && b && ['ino', 'dev', 'size', 'mode', 'nlink', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]))
export function pngPhysicalHeader(bytes, screen) {
  assert.equal(bytes.length, 33); assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
  assert.equal(bytes.readUInt32BE(8), 13); assert.equal(bytes.subarray(12, 16).toString('ascii'), 'IHDR')
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
  assert.ok(Number.isSafeInteger(screen?.width) && Number.isSafeInteger(screen?.height) && width > 0 && height > 0 && width === screen.width && height === screen.height, 'The actual physical PNG header must match the original screen dimensions')
  return { width, height, bitDepth: bytes[24], colorType: bytes[25], headerSHA256: digest(bytes), inspectedBytes: 33, decoded: false }
}
export async function pinPhysicalFrame(path, screen) {
  assert.ok(Number.isInteger(constants.O_NOFOLLOW), 'No-follow file open must be available')
  const initial = pinnedStat(await lstat(path, { bigint: true })), fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = pinnedStat(await fd.stat({ bigint: true })); assert.ok(samePinnedStat(initial, opened), 'Opening changed the exact physical frame identity')
    const filePinned = String(process.hrtime.bigint())
    const headerBytes = Buffer.alloc(33), read = await fd.read(headerBytes, 0, 33, 0); assert.equal(read.bytesRead, 33)
    const header = pngPhysicalHeader(headerBytes, screen), after = pinnedStat(await fd.stat({ bigint: true })), pathAfter = pinnedStat(await lstat(path, { bigint: true }))
    assert.ok(samePinnedStat(opened, after) && samePinnedStat(after, pathAfter), 'Physical frame changed while pinning its header')
    return { path, fd, identity: after, header, pinStageNs: { filePinned, headerChecked: String(process.hrtime.bigint()) }, fullReadStarted: false, closed: false }
  } catch (error) { await fd.close(); throw error }
}
export async function readPinnedPhysicalFrame(pin, authorization) {
  assert.equal(authorization, 'post-original-held-gate'); assert.ok(pin && !pin.closed && !pin.fullReadStarted)
  pin.fullReadStarted = true
  const before = pinnedStat(await pin.fd.stat({ bigint: true })), pathBefore = pinnedStat(await lstat(pin.path, { bigint: true }))
  assert.ok(samePinnedStat(pin.identity, before) && samePinnedStat(before, pathBefore), 'The pinned raw physical frame was replaced or mutated before finalize')
  const size = Number(before.size), bytes = Buffer.alloc(size); let offset = 0
  while (offset < size) { const result = await pin.fd.read(bytes, offset, Math.min(size - offset, 1024 * 1024), offset); assert.ok(result.bytesRead > 0, 'Physical frame ended early'); offset += result.bytesRead }
  const tail = await pin.fd.read(Buffer.alloc(1), 0, 1, size); assert.equal(tail.bytesRead, 0)
  const after = pinnedStat(await pin.fd.stat({ bigint: true })), pathAfter = pinnedStat(await lstat(pin.path, { bigint: true }))
  assert.ok(samePinnedStat(before, after) && samePinnedStat(after, pathAfter), 'The exact pinned raw physical frame changed during finalize')
  assert.equal(digest(bytes.subarray(0, 33)), pin.header.headerSHA256)
  return { bytes, rawFrameSHA256: digest(bytes), fileBefore: before, fileAfter: after, pathBefore, pathAfter }
}
export async function closePinnedPhysicalFrame(pin) { if (pin && !pin.closed) { await pin.fd.close(); pin.closed = true } }
export function acquisitionCausalInterval(before, after, acquisition) {
  let clocks = false
  try { clocks = decimal(before?.os?.ticks) && decimal(after?.os?.beforeTicks) && before.os.frequency === after.os.frequency && Number.isSafeInteger(before.os.frequency) && before.os.frequency > 0 && BigInt(before.os.ticks) < BigInt(after.os.beforeTicks) } catch {}
  const originalOwner = before?.passed === true && after?.passed === true && before.epoch === after.epoch && before.logicalEpoch === after.logicalEpoch && hash(before.ownerSHA256) && before.ownerSHA256 === after.ownerSHA256
  const acquired = acquisition?.acquired === true && acquisition.captureCount === 1 && acquisition.captureSource === PRL_PHYSICAL_SOURCE && acquisition.physicalDisplay === true && acquisition.hypervisorFramebuffer === true && acquisition.targetWindowCapture === false && acquisition.previewCache === false && acquisition.manuallyComposited === false && acquisition.resized === false && /^[a-f0-9-]{36}$/u.test(acquisition.captureId ?? '') && acquisition.beforeSHA256 === digest(JSON.stringify(before)) && acquisition.header?.decoded === false && acquisition.header.inspectedBytes === 33
  return { passed: Boolean(clocks && originalOwner && acquired && publicationEvidenceValid(acquisition)), clocks, sameOriginalOwner: Boolean(originalOwner), causalOrder: acquisition?.publication ? 'Original before-held completed before the one capture start; complete PNG header/IEND and stable exact file pin replied before original after-held. The same capture client must naturally exit0 before post-gate full read. Host and guest clocks remain unmapped.' : 'Original before-held gate completed before acquire request; exact capture CLI completion/file pin replied before original after-held gate. PNG decode/classification/finalize occurs only after that gate.', before, after, acquisition }
}
export class TwoPhasePhysicalRaster {
  constructor() { this.state = 'empty'; this.captureCount = 0; this.finalizeCount = 0 }
  claimAcquire(request) { assert.equal(this.state, 'empty', 'Only one original physical capture is allowed'); this.state = 'acquiring'; this.captureCount++; this.captureId = randomUUID(); this.request = structuredClone(request); return this.captureId }
  sealAcquisition(pin, stageNs) {
    assert.equal(this.state, 'acquiring'); assert.ok(pin?.fd && pin.fullReadStarted === false)
    this.pin = pin
    const keys = ['requestReceived', 'captureStarted', 'captureCompleted', 'filePinned', 'headerChecked', 'replyReady']
    assert.ok(keys.every((key, i) => decimal(stageNs[key]) && (i === 0 || BigInt(stageNs[keys[i - 1]]) <= BigInt(stageNs[key]))))
    this.receipt = { acquired: true, captureId: this.captureId, captureCount: this.captureCount, captureSource: PRL_PHYSICAL_SOURCE, physicalDisplay: true, hypervisorFramebuffer: true, targetWindowCapture: false, previewCache: false, manuallyComposited: false, resized: false, header: pin.header, fileIdentity: pin.identity, beforeSHA256: digest(JSON.stringify(this.request.before)), hostClockDomain: 'host-process-hrtime-unmapped-to-guest-QPC', hostStageNs: stageNs, entireFrameRetainedInEvidence: false }
    this.state = 'acquired'; return structuredClone(this.receipt)
  }
  sealPublishedAcquisition(pin, stageNs) {
    assert.equal(this.state, 'acquiring'); assert.ok(pin?.fd && pin.fullReadStarted === false && pin.publication)
    const candidate = { publication: pin.publication, hostStageNs: stageNs, captureCompletionRequiredBeforeFinalize: true }
    assert.ok(publicationEvidenceValid(candidate), 'Complete publication and causal host stages are required')
    this.pin = pin
    this.receipt = { acquired: true, captureId: this.captureId, captureCount: this.captureCount, captureSource: PRL_PHYSICAL_SOURCE, physicalDisplay: true, hypervisorFramebuffer: true, targetWindowCapture: false, previewCache: false, manuallyComposited: false, resized: false, header: pin.header, fileIdentity: pin.identity, beforeSHA256: digest(JSON.stringify(this.request.before)), hostClockDomain: 'host-process-hrtime-unmapped-to-guest-QPC', hostStageNs: stageNs, publication: pin.publication, captureCompletionRequiredBeforeFinalize: true, entireFrameRetainedInEvidence: false }
    this.state = 'acquired'; return structuredClone(this.receipt)
  }
  authorizeFinalize(value) {
    assert.equal(this.state, 'acquired', 'Finalize requires the one acquired original frame and cannot repeat'); this.state = 'finalize-attempted'; this.finalizeCount++; assert.equal(this.finalizeCount, 1); assert.equal(value.captureId, this.captureId)
    for (const key of ['runId', 'architecture', 'stage', 'helperSHA256']) assert.equal(value[key], this.request[key])
    for (const key of ['before', 'screen', 'crop', 'target']) assert.equal(digest(JSON.stringify(value[key])), digest(JSON.stringify(this.request[key])), 'The original acquisition binding changed')
    const interval = acquisitionCausalInterval(this.request.before, value.after, this.receipt); assert.ok(interval.passed, 'Original after-held native/OS gate did not preserve exact owner and epochs')
    this.state = 'finalizing'; return interval
  }
  async readFinalFrame() { assert.equal(this.state, 'finalizing', 'No full raw frame read may precede the original after-held gate'); return readPinnedPhysicalFrame(this.pin, 'post-original-held-gate') }
  finish() { assert.equal(this.state, 'finalizing'); this.state = 'finalized' }
  async close() { await closePinnedPhysicalFrame(this.pin) }
}
export function twoPhaseRasterComplete(raster, cleanup, receipts) {
  const value = receipts?.[0]
  return Boolean(raster?.state === 'finalized' && raster.captureCount === 1 && raster.finalizeCount === 1 && raster.pin?.fullReadStarted === true && raster.pin.closed === true && cleanup?.rawFrameDeleted === true && cleanup.rawDirectoryDeleted === true && cleanup.pinnedFDClosed === true && cleanup.entireFrameRetained === false && receipts?.length === 1 && value?.passed === true && (!raster.receipt?.publication || value.captureLifecycle?.status === 'exited' && value.captureLifecycle?.exitCode === 0 && value.captureLifecycle?.naturalExit === true && value.captureLifecycle?.signal === null && value.captureLifecycle?.killed === false) && value.captureCount === 1 && value.finalizeCount === 1 && value.captureId === raster.captureId && value.captureSource === PRL_PHYSICAL_SOURCE && value.physicalDisplay === true && value.resized === false && hash(value.rawFrameSHA256) && samePinnedStat(raster.pin.identity, value.rawFileBeforeFinalize) && samePinnedStat(value.rawFileBeforeFinalize, value.rawFileAfterFinalize))
}
