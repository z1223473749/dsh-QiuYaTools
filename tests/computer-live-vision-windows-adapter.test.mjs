import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { randomUUID } from 'node:crypto'
const bundled = await build({ entryPoints: [new URL('../scripts/live-vision-windows-adapter.mjs', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'esm' })
const { validateWindowsVisionConfig, validateWindowsVisionReady, projectWindowsVisionOracle, windowsVisionCleanupPassed, sameWindowsVisionIdentity } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'))
const config = { version: 1, platform: 'win32', runId: randomUUID(), rendezvousNonce: 'a'.repeat(64), directory: '/private/tmp/own-windows-vision', native: '/private/tmp/native.exe', fixture: '/private/tmp/fixture.exe', carrier: '/private/tmp/carrier.mjs', nativeSha256: 'b'.repeat(64), fixtureSha256: 'c'.repeat(64), carrierSha256: 'd'.repeat(64), auditSha256: '9'.repeat(64), expiresAt: Date.now() + 600000 }
const request = { version: 1, runId: config.runId, rendezvousNonce: config.rendezvousNonce, requestId: randomUUID(), sessionId: 'qiuya-vision-' + randomUUID(), task: 1 }
const root = 'C:\\Users\\test\\AppData\\Local\\Temp\\QiuYaTools-vision-' + config.runId
const fixture = { pid: 42, createdAtTicks: '639282542717808148', executablePath: root + '\\fixture.exe', sessionId: 1 }, native = { pid: 43, createdAtTicks: '639282542717808149', executablePath: root + '\\native.exe', sessionId: 1 }
const ready = { ...request, fixtureIdentity: fixture, nativeIdentity: native, guestRoot: root, windowId: '255', target: { id: 'window:ff:42:' + fixture.createdAtTicks, pid: 42, appId: fixture.executablePath.toLowerCase() }, nativeSha256: config.nativeSha256, fixtureSha256: config.fixtureSha256, auditSha256: config.auditSha256, endpoint: 'http://127.0.0.1:12345/v1/computer', controlEndpoint: 'http://127.0.0.1:12345/test/status', token: 'e'.repeat(64), controlToken: 'f'.repeat(64) }

test('Windows vision configuration has finite own paths, exact hashes and a twenty-minute deadline', () => {
  assert.equal(validateWindowsVisionConfig(config), config)
  for (const patch of [{ platform: 'darwin' }, { fixture: 'relative.exe' }, { nativeSha256: 'wrong' }, { expiresAt: Date.now() - 1 }, { expiresAt: Date.now() + 1300000 }]) assert.throws(() => validateWindowsVisionConfig({ ...config, ...patch }))
})
test('ready cannot substitute a Mac window, a changed native fixture identity or another network principal', () => {
  assert.equal(validateWindowsVisionReady(ready, request, config), ready)
  for (const patch of [{ requestId: randomUUID() }, { rendezvousNonce: '0'.repeat(64) }, { windowId: '256' }, { target: { ...ready.target, id: 'mac-window:255' } }, { target: { ...ready.target, pid: 43 } }, { fixtureIdentity: { ...fixture, createdAtTicks: native.createdAtTicks } }, { nativeIdentity: { ...native, executablePath: 'C:\\other\\native.exe' } }, { target: { ...ready.target, appId: 'C:\\other\\fixture.exe' } }, { endpoint: 'http://10.211.55.3:12345/v1/computer' }, { controlEndpoint: 'http://127.0.0.1:12346/test/status' }, { controlToken: ready.token }]) assert.throws(() => validateWindowsVisionReady({ ...ready, ...patch }, request, config))
  assert.equal(sameWindowsVisionIdentity(fixture, { ...fixture, executablePath: fixture.executablePath.toLowerCase() }), true)
  assert.equal(sameWindowsVisionIdentity(fixture, { ...fixture, pid: 43 }), false)
})
test('real business oracle projects only counters/booleans and never publishes answers or accepts changed identity', () => {
  const record = { task: 1, windows: { ready } }, raw = { fixtureAlive: true, fixtureIdentity: fixture, windowId: '255', oracle: { task: 1, passed: true, correctClicks: 1, wrongClicks: 0, mouseDown: 1, mouseUp: 1, dragged: 0, submitted: false, textMatches: false, nonce: 'SECRET_NONCE', note: 'SECRET_NOTE', coordinates: 'SECRET_COORDINATES' } }
  const value = projectWindowsVisionOracle(raw, record); assert.equal(value.passed, true); assert.doesNotMatch(JSON.stringify(value), /SECRET|nonce|note|coordinates/u)
  for (const patch of [{ fixtureAlive: false }, { windowId: '256' }, { fixtureIdentity: native }, { oracle: { ...raw.oracle, dragged: false } }, { oracle: { ...raw.oracle, correctClicks: Infinity } }]) assert.throws(() => projectWindowsVisionOracle({ ...raw, ...patch }, record))
})
test('natural exit alone cannot pass without independent exact-session OS input, lease and journal audit', () => {
  const desktopAudit = { phase: 'after-owned-native-fixture-exit', auditSourceSha256: config.auditSha256, sessionId: 1, userInteractive: true, activeDesktopAccessible: true, activeDesktopMatches: true, heldKeyCount: 0, leaseScopeExists: true, leaseFree: true, journalPresent: false }
  const options = { auditSha256: config.auditSha256, sessionId: 1 }, clean = { passed: true, errors: [], nativeNaturalExit: true, fixtureNaturalExit: true, forced: false, auditSha256: config.auditSha256, expectedSessionId: 1, desktopAudit }
  assert.equal(windowsVisionCleanupPassed(clean, options), true)
  assert.equal(windowsVisionCleanupPassed(clean), false)
  for (const patch of [{ passed: false }, { nativeNaturalExit: false }, { fixtureNaturalExit: false }, { forced: true }, { errors: ['cleanup failed'] }, { errors: undefined }, { auditSha256: '0'.repeat(64) }, { expectedSessionId: 2 }, { desktopAudit: undefined }]) assert.equal(windowsVisionCleanupPassed({ ...clean, ...patch }, options), false)
  for (const patch of [{ phase: 'before-release' }, { auditSourceSha256: '0'.repeat(64) }, { sessionId: 2 }, { userInteractive: false }, { activeDesktopAccessible: false }, { activeDesktopMatches: false }, { heldKeyCount: 1 }, { leaseScopeExists: false }, { leaseFree: false }, { journalPresent: true }]) assert.equal(windowsVisionCleanupPassed({ ...clean, desktopAudit: { ...desktopAudit, ...patch } }, options), false)
})
