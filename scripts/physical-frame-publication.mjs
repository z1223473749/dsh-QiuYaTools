/** Observe publication of the one original prl PNG; never starts a capture or reads pixels. */
import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { open, lstat } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { MAX_RAW_BYTES, digest, pinnedStat, samePinnedStat, pngPhysicalHeader } from './physical-frame-protocol.mjs'

export const PNG_IEND = Buffer.from('0000000049454e44ae426082', 'hex')
const ordinary = value => {
  assert.ok(value.isFile() && !value.isSymbolicLink() && value.nlink === 1n && value.size >= 0n && value.size <= BigInt(MAX_RAW_BYTES), 'Publication requires one bounded ordinary single-link file')
}
export function requireNaturalCaptureCompletion(value) {
  assert.ok(value?.status === 'exited' && value.exitCode === 0 && value.signal === null && value.killed === false && value.naturalExit === true && /^\d{1,20}$/u.test(value.completedHostNs), 'The original capture client must naturally exit0 before finalize')
  return value
}
export async function pinPublishedPhysicalFrame(path, screen, { stableMs = 20 } = {}) {
  assert.ok(Number.isInteger(stableMs) && stableMs >= 10 && stableMs <= 100)
  assert.ok(Number.isInteger(constants.O_NOFOLLOW))
  let stat
  try { stat = await lstat(path, { bigint: true }) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  ordinary(stat)
  if (stat.size < 45n) return null
  const initial = pinnedStat(stat), fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let retained = false
  try {
    const openedStat = await fd.stat({ bigint: true }); ordinary(openedStat)
    // The one writer may still append before complete IEND is observed. Identity cannot change.
    assert.ok(['ino', 'dev', 'mode', 'nlink'].every(key => initial[key] === String(openedStat[key])), 'Publication path identity changed before pinning')
    if (openedStat.size < 45n) return null
    const opened = pinnedStat(openedStat)
    const filePinned = String(process.hrtime.bigint()), headerBytes = Buffer.alloc(33), terminal = Buffer.alloc(12)
    assert.equal((await fd.read(headerBytes, 0, 33, 0)).bytesRead, 33)
    const headerChecked = String(process.hrtime.bigint())
    assert.equal((await fd.read(terminal, 0, 12, Number(opened.size) - 12)).bytesRead, 12)
    // Growing/truncated PNG is pending. No pixel read, decode, content hash or second capture.
    if (!terminal.equals(PNG_IEND)) return null
    const header = pngPhysicalHeader(headerBytes, screen), filePublicationObserved = String(process.hrtime.bigint())
    const afterRead = pinnedStat(await fd.stat({ bigint: true })), pathAfterRead = pinnedStat(await lstat(path, { bigint: true }))
    assert.ok(samePinnedStat(opened, afterRead) && samePinnedStat(afterRead, pathAfterRead), 'Complete PNG changed during publication observation')
    const stableDeadline = BigInt(filePublicationObserved) + BigInt(stableMs) * 1000000n
    while (process.hrtime.bigint() < stableDeadline) await sleep(Math.max(1, Math.ceil(Number(stableDeadline - process.hrtime.bigint()) / 1000000)))
    const stable = pinnedStat(await fd.stat({ bigint: true })), pathStable = pinnedStat(await lstat(path, { bigint: true }))
    assert.ok(samePinnedStat(opened, stable) && samePinnedStat(stable, pathStable), 'Complete PNG changed before the stable-publication fence')
    const stableFileConfirmed = String(process.hrtime.bigint())
    retained = true
    return { path, fd, identity: stable, header, pinStageNs: { filePinned, headerChecked, filePublicationObserved, stableFileConfirmed },
      publication: { method: 'one-original-prl-file-complete-PNG-publication', inspectedBytes: 45, headerBytes: 33, terminalBytes: 12, terminalSHA256: digest(terminal), terminalIEND: true, stableMs, decoded: false, fullReadBeforeGate: false }, fullReadStarted: false, closed: false }
  } finally { if (!retained) await fd.close() }
}
export async function waitForPublishedPhysicalFrame(path, screen, { timeoutMs = 12000, pollMs = 10, stableMs = 20, captureOutcome = () => null, captureStartedHostNs } = {}) {
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 20 && timeoutMs <= 12000)
  assert.ok(Number.isInteger(pollMs) && pollMs >= 5 && pollMs <= 100)
  const began = process.hrtime.bigint()
  assert.ok(captureStartedHostNs === undefined || typeof captureStartedHostNs === 'string' && /^\d{1,20}$/u.test(captureStartedHostNs) && BigInt(captureStartedHostNs) <= began)
  const deadline = (captureStartedHostNs === undefined ? began : BigInt(captureStartedHostNs)) + BigInt(timeoutMs) * 1000000n
  let polls = 0
  while (process.hrtime.bigint() < deadline) {
    const outcome = captureOutcome()
    if (outcome && outcome.status !== 'pending') requireNaturalCaptureCompletion(outcome)
    const pin = await pinPublishedPhysicalFrame(path, screen, { stableMs })
    polls++
    if (pin) {
      const latest = captureOutcome()
      if (latest && latest.status !== 'pending') { try { requireNaturalCaptureCompletion(latest) } catch (error) { await pin.fd.close(); pin.closed = true; throw error } }
      if (process.hrtime.bigint() >= deadline) { await pin.fd.close(); pin.closed = true; throw new Error('Complete physical PNG publication exceeded the original capture deadline') }
      pin.publication.polls = polls; pin.publication.observationStartedHostNs = String(began)
      return pin
    }
    await sleep(Math.min(pollMs, Math.max(1, Number((deadline - process.hrtime.bigint()) / 1000000n))))
  }
  throw new Error('The original capture did not publish a complete physical PNG within its original deadline')
}
