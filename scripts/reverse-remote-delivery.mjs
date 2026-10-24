/** Test-only strict reverse-remote evidence. No process or input mutation. */
import { windowsRemoteNaturalExitPassed } from './windows-remote-delivery.mjs'

export const REVERSE_REMOTE_BUSINESS_CHECKS = Object.freeze([
  'REVERSE-WIN-CLIENT-MAC-STATUS', 'REVERSE-MAC-TARGET', 'REVERSE-CAPTURE-AX',
  'REVERSE-ACTUAL-MAC-CLICK', 'REVERSE-ACTUAL-MAC-UNICODE', 'REVERSE-MAC-SHORTCUT',
  'REVERSE-RELEASE-FENCE', 'REVERSE-RESUME', 'REVERSE-PREVIEW',
])
const empty = value => Array.isArray(value) && value.length === 0
const exitZero = value => value?.code === 0 && value.signal === null
export function reverseMacDesktopReleased(os, lease) {
  return os?.sessionExists === true && os.screenLocked === false && os.leftButtonDown === false && os.rightButtonDown === false && os.middleButtonDown === false && empty(os.keysDown) && lease?.passed === true && lease.leaseScopeExists === true && lease.lockFileVerified === true && lease.leaseFree === true && lease.journalAbsent === true && lease.inputPosted === false
}
export function reverseMacNaturalExitPassed(expected, audit) {
  if (!Array.isArray(expected) || !Array.isArray(audit) || expected.length !== audit.length || !expected.length) return false
  const roles = new Set(), signatures = new Set()
  for (const row of expected) {
    if (!row || !Number.isSafeInteger(row.pid) || row.pid <= 0 || !/^[1-9][0-9]*$/u.test(row.startSeconds) || !/^[0-9]+$/u.test(row.startMicroseconds) || typeof row.executablePath !== 'string' || !row.executablePath.startsWith('/')) return false
    const signature = JSON.stringify([row.pid, row.startSeconds, row.startMicroseconds, row.executablePath])
    if (signatures.has(signature)) return false
    signatures.add(signature); roles.add(row.role)
  }
  for (const row of audit) {
    if (!row || !['already-exited', 'reused-pid-skipped'].includes(row.state)) return false
    if (!signatures.delete(JSON.stringify([row.pid, row.startSeconds, row.startMicroseconds, row.executablePath]))) return false
  }
  return signatures.size === 0 && ['fixture', 'native', 'guardian'].every(role => roles.has(role))
}
export function reverseRemoteDeliveryPassed({ clientReport, setupError, cleanup }) {
  if (clientReport?.passed !== true || setupError || !Array.isArray(clientReport.checks) || clientReport.checks.length !== REVERSE_REMOTE_BUSINESS_CHECKS.length || !REVERSE_REMOTE_BUSINESS_CHECKS.every(id => clientReport.checks.filter(row => row?.id === id && row.passed === true).length === 1)) return false
  const expectedWindows = cleanup?.trackedWindows
  return empty(cleanup?.errors) && empty(cleanup.forced) && cleanup.windowsForced === undefined && cleanup.oldTokenRejected === true && cleanup.guestTokenConfigDeleted === true && cleanup.inMemoryConfigRemoved === true && exitZero(cleanup.nativeExit) && exitZero(cleanup.fixtureExit) && empty(cleanup.naturalRemainingMac) && empty(cleanup.remainingMac) && reverseMacNaturalExitPassed(cleanup.trackedMac, cleanup.naturalMacExitAudit) && Array.isArray(expectedWindows) && expectedWindows.filter(row => row?.role === 'client').length === 1 && expectedWindows.every(row => ['client', 'console'].includes(row?.role)) && windowsRemoteNaturalExitPassed(cleanup.windowsExitAudit, expectedWindows) && cleanup.windowsTask?.stateBeforeRemoval === 'Ready' && cleanup.windowsTask.stopRequired === false && cleanup.windowsTask.unregistered === true && cleanup.windowsTask.naturalTaskExit?.state === 'Ready' && cleanup.windowsTask.naturalTaskExit.result === 0 && reverseMacDesktopReleased(cleanup.finalOs, cleanup.desktopLease)
}
