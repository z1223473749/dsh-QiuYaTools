import test from 'node:test'
import assert from 'node:assert/strict'
import { REVERSE_REMOTE_BUSINESS_CHECKS, reverseMacDesktopReleased, reverseMacNaturalExitPassed, reverseRemoteDeliveryPassed } from '../scripts/reverse-remote-delivery.mjs'

const mac = ['fixture', 'native', 'guardian'].map((role, index) => ({ role, pid: 100 + index, startSeconds: '1792670000', startMicroseconds: String(index + 1), executablePath: role === 'fixture' ? '/own/fixture' : '/own/helper' }))
const windows = [{ pid: 200, role: 'client', createdAtTicks: '639281324193729179', expectedExecutablePath: 'C:\\own\\node.exe' }, { pid: 201, role: 'console', createdAtTicks: '639281324193739179', expectedExecutablePath: 'C:\\Windows\\System32\\conhost.exe' }]
const os = { sessionExists: true, screenLocked: false, leftButtonDown: false, rightButtonDown: false, middleButtonDown: false, keysDown: [] }
const lease = { passed: true, leaseScopeExists: true, lockFileVerified: true, leaseFree: true, journalAbsent: true, inputPosted: false }
const golden = () => structuredClone({ clientReport: { passed: true, checks: REVERSE_REMOTE_BUSINESS_CHECKS.map(id => ({ id, passed: true })) }, cleanup: {
  errors: [], forced: [], oldTokenRejected: true, guestTokenConfigDeleted: true, inMemoryConfigRemoved: true,
  nativeExit: { code: 0, signal: null }, fixtureExit: { code: 0, signal: null }, naturalRemainingMac: [], remainingMac: [], trackedMac: mac,
  naturalMacExitAudit: mac.map(row => ({ ...row, state: 'already-exited' })), trackedWindows: windows,
  windowsExitAudit: { passed: true, terminate: false, errors: [], results: windows.map(row => ({ pid: row.pid, state: 'already-exited' })) },
  windowsTask: { stateBeforeRemoval: 'Ready', stopRequired: false, unregistered: true, naturalTaskExit: { state: 'Ready', result: 0 } }, finalOs: os, desktopLease: lease,
} })
test('strict reverse delivery requires all nine distinct real business receipts and both platforms natural cleanup', () => {
  assert.equal(reverseRemoteDeliveryPassed(golden()), true)
  for (const change of [v => v.clientReport.passed = false, v => v.setupError = {}, v => v.clientReport.checks.pop(), v => v.clientReport.checks[1] = v.clientReport.checks[0], v => v.clientReport.checks[0].passed = false]) {
    const v = golden(); change(v); assert.equal(reverseRemoteDeliveryPassed(v), false)
  }
})
test('reverse nine-business success cannot override Stop, fallback signals, missing secrets proof or nonzero exits', () => {
  for (const change of [v => v.cleanup.errors.push('unknown'), v => v.cleanup.forced.push({ signalled: true }), v => v.cleanup.windowsForced = { passed: true, terminate: true, results: [] }, v => v.cleanup.windowsTask.stopRequired = true, v => v.cleanup.windowsTask.unregistered = false, v => v.cleanup.windowsTask.naturalTaskExit.result = 1, v => v.cleanup.nativeExit.code = 1, v => v.cleanup.fixtureExit.signal = 'SIGTERM', v => v.cleanup.oldTokenRejected = false, v => v.cleanup.guestTokenConfigDeleted = false, v => v.cleanup.inMemoryConfigRemoved = false]) {
    const v = golden(); change(v); assert.equal(reverseRemoteDeliveryPassed(v), false)
  }
})
test('reverse Mac retirement requires exact birth/path coverage including guardian and never treats unreadable live processes as gone', () => {
  assert.equal(reverseMacNaturalExitPassed(mac, mac.map(row => ({ ...row, state: 'reused-pid-skipped' }))), true)
  for (const change of [v => v.cleanup.trackedMac.pop(), v => v.cleanup.naturalMacExitAudit.pop(), v => v.cleanup.naturalMacExitAudit[0].state = 'alive', v => v.cleanup.naturalMacExitAudit[0].state = 'unverified', v => v.cleanup.naturalMacExitAudit[0].startMicroseconds = '99', v => v.cleanup.naturalMacExitAudit[0].executablePath = '/foreign/helper', v => v.cleanup.naturalRemainingMac.push(mac[0]), v => v.cleanup.remainingMac.push(mac[0])]) {
    const v = golden(); change(v); assert.equal(reverseRemoteDeliveryPassed(v), false)
  }
})
test('reverse Windows client/console inspection ACK cannot replace natural exit coverage', () => {
  for (const change of [v => v.cleanup.windowsExitAudit.results[0].state = 'alive', v => v.cleanup.windowsExitAudit.results.pop(), v => v.cleanup.windowsExitAudit.terminate = true, v => v.cleanup.trackedWindows[0].role = 'unknown', v => v.cleanup.trackedWindows[0].createdAtTicks = 639281324193729179]) {
    const v = golden(); change(v); assert.equal(reverseRemoteDeliveryPassed(v), false)
  }
})
test('reverse post-exit desktop audit requires empty real OS state and verified free physical lease without a journal', () => {
  assert.equal(reverseMacDesktopReleased(os, lease), true)
  for (const key of ['sessionExists', 'screenLocked', 'leftButtonDown', 'rightButtonDown', 'middleButtonDown']) assert.equal(reverseMacDesktopReleased({ ...os, [key]: !os[key] }, lease), false)
  assert.equal(reverseMacDesktopReleased({ ...os, keysDown: [1] }, lease), false)
  for (const key of Object.keys(lease)) assert.equal(reverseMacDesktopReleased(os, { ...lease, [key]: !lease[key] }), false)
  assert.equal(reverseMacDesktopReleased(os, undefined), false)
})
