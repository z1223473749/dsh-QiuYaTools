import assert from 'node:assert/strict'
import { validateWindowsOwnedStartupReceipt as validateActivation, WINDOWS_OWNED_STARTUP_SCOPE as ACTIVATION_SCOPE } from './normal-startup-policy.mjs'

export const WINDOWS_OWNED_STARTUP_SCOPE = 'owned-foreground-credit-before-business'
const same = (actual, expected) => {
  for (const key of ['pid', 'sessionId', 'createdAtTicks']) assert.equal(String(actual?.[key]), String(expected?.[key]), 'Exact owned credit identity changed: ' + key)
  assert.equal(actual?.executablePath?.toLowerCase(), expected.executablePath.toLowerCase())
  assert.equal(actual?.canonicalExecutablePath?.toLowerCase(), expected.canonicalExecutablePath.toLowerCase())
  assert.equal(actual?.imageSHA256, expected.imageSHA256)
}

export function validateWindowsOwnedStartupReceipt(value, expected) {
  assert.equal(value?.scope, WINDOWS_OWNED_STARTUP_SCOPE)
  const { fixture: a, fixtureB: b, hwnd, hwndB, titleB, nativeA, nativeB } = expected
  assert.equal(new Set([a?.pid, b?.pid, nativeA?.pid, nativeB?.pid]).size, 4)
  assert(Number.isSafeInteger(b?.pid) && b.pid > 0)
  assert.match(b.createdAtTicks ?? '', /^\d{1,20}$/u)
  assert.equal(b.sessionId, a.sessionId)
  assert.equal(b.imageSHA256, a.imageSHA256)
  assert.equal(b.executablePath?.toLowerCase(), a.executablePath.toLowerCase())
  assert.equal(b.canonicalExecutablePath?.toLowerCase(), a.canonicalExecutablePath.toLowerCase())
  assert.match(String(hwndB), /^\d{1,20}$/u)
  assert(BigInt(hwndB) > 0n)
  assert.notEqual(String(hwndB), String(hwnd))
  assert.equal(value.creditAttempts, 1)
  assert.equal(value.activation.scope, WINDOWS_OWNED_STARTUP_SCOPE)
  const projected = { ...value, scope: ACTIVATION_SCOPE, activation: { ...value.activation, scope: ACTIVATION_SCOPE } }
  // Preserve every original A/native/SHA/window/held0/physical-sequence/30s check.
  const result = validateActivation(projected, expected)
  validateActivation({ ...projected, before: value.afterGrant }, expected)
  for (const state of [value.before, value.afterGrant, value.after]) {
    same(state.peerIndependentIdentity, b)
    for (const key of ['pid', 'sessionId', 'createdAtTicks']) assert.equal(String(state.peerFixture[key]), String(b[key]))
    assert.equal(state.peerFixture.executablePath?.toLowerCase(), b.executablePath.toLowerCase())
    assert.equal(state.peerFixture.hwnd, String(hwndB))
    assert.equal(state.peerFixture.title, titleB)
    assert.equal(state.peerFixture.visible, true)
    for (const key of ['downs', 'ups', 'drags', 'clicks']) assert.equal(state.peerFixture.counts[key], 0)
    const rows = state.peerWindows.filter(row => row.pid === b.pid && String(row.hwnd) === String(hwndB))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].title, titleB)
    assert.equal(rows[0].visible, true)
    assert.equal(rows[0].enabled, true)
    for (const key of ['x', 'y', 'width', 'height']) assert.equal(rows[0][key], state.peerFixture.bounds[key])
  }
  for (const state of [value.before, value.afterGrant]) {
    assert.equal(state.os.foreground, String(hwndB), 'Only the exact current foreground B may grant initial credit')
    assert.equal(state.fixture.foreground, String(hwndB))
    assert.equal(state.peerFixture.foreground, String(hwndB))
  }
  assert.equal(value.after.peerFixture.foreground, String(hwnd))
  const grant = value.credit
  assert.equal(grant.scope, WINDOWS_OWNED_STARTUP_SCOPE)
  assert.equal(grant.runId, expected.runId)
  assert.equal(grant.nonce, value.nonce)
  same(grant.caller, b)
  same(grant.callee, a)
  assert.equal(grant.callerWindow, String(hwndB))
  assert.equal(grant.calleeWindow, String(hwnd))
  assert.equal(grant.foregroundBefore, String(hwndB))
  assert.equal(grant.foregroundAfter, String(hwndB))
  assert.deepEqual(grant.heldKeys, [])
  assert.equal(grant.attempted, true)
  assert.equal(grant.allowed, true)
  assert.equal(grant.error, 0)
  assert.equal(grant.grantCalls, 1)
  assert.equal(grant.extraInputEvents, 0)
  assert.equal(grant.focusChangesRequested, 0)
  assert.equal(grant.physicalCUAVerified, false)
  assert.equal(value.activation.foregroundBefore, String(hwndB))
  return { ...result, scope: WINDOWS_OWNED_STARTUP_SCOPE, normalActivationOnly: false, initialOwnedForegroundCredit: true, creditAttempts: 1, fixtureB: structuredClone(b), hwndB: String(hwndB), titleB }
}

export function createWindowsOwnedStartupGate(expected) {
  let receipt
  return {
    finish(value) {
      assert.equal(receipt, undefined, 'Owned initial foreground credit cannot replay')
      receipt = validateWindowsOwnedStartupReceipt(value, expected)
      return structuredClone(receipt)
    },
    snapshot() { return { finished: receipt !== undefined, scope: WINDOWS_OWNED_STARTUP_SCOPE, physicalCUAVerified: false, receipt: receipt ? structuredClone(receipt) : null } },
  }
}
