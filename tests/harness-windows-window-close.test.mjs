import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHarnessWindowsSessionCloseRequest as request } from '../scripts/harness-computer-pipeline.mjs'
const seed = () => {
  const profileRoot = 'C:\\Users\\fixture\\AppData\\Local\\Temp\\own-uuid\\qiuya-harness-e2e-Ab12cD\\qiuya-harness-home', nativeExecutable = profileRoot + '\\profiles\\web\\node_modules\\dsh-qiuya-tools\\lib\\native\\win32-arm64\\qiuya-windows.exe'
  return { host: { pid: 41, exitCode: null, signalCode: null }, hostExecutable: 'C:\\own-runtime\\node.exe', hostSHA256: 'a'.repeat(64), profileRoot, architecture: 'arm64', nativeExecutable, nativeSHA256: 'b'.repeat(64), windows: ['Alpha', 'Beta'].map((name, i) => ({ sessionId: 'session-own-' + i, title: 'E2E:' + name + '-nonce42', target: { id: `window:${41+i}:52:639285443648240430`, pid: 52, title: 'E2E:' + name + '-nonce42 — QiuYaTools', appId: nativeExecutable.toLowerCase() } })) }
}
test('normal cleanup carries the two actual original session/window identities into the Windows observer', () => {
  const v = seed(), r = request(v); assert.equal(r.hostPID, 41); assert.equal(r.helperPID, 52); assert.equal(r.helperBirthTicks, '639285443648240430'); assert.equal(r.budgetMs, 5000); assert.equal(r.windows.length, 2); assert.deepEqual(r.windows.map(x => x.targetId), v.windows.map(x => x.target.id)); assert.equal(r.operation, 'normal-close-owned-session-windows'); assert(!JSON.stringify(r).includes('kill'))
})
const attacks = {
  exitedHost: v => v.host.exitCode = 0, signaledHost: v => v.host.signalCode = 'SIGTERM', noHost: v => v.host.pid = 0,
  foreignProfile: v => v.profileRoot = 'C:\\Users\\personal', foreignExecutable: v => v.nativeExecutable += '.other', foreignImage: v => v.nativeSHA256 = '',
  foreignApp: v => v.windows[0].target.appId = 'C:\\personal\\app.exe', foreignPID: v => v.windows[0].target.pid++, otherBirth: v => v.windows[1].target.id = 'window:42:52:639285443648240431',
  otherHelper: v => { v.windows[1].target.id = 'window:42:53:639285443648240430'; v.windows[1].target.pid = 53 },
  unrelatedTitle: v => v.windows[0].target.title = 'Personal Chat', unrelatedSession: v => v.windows[0].sessionId = 'personal', duplicateWindow: v => v.windows[1] = v.windows[0],
  duplicateSession: v => v.windows[1].sessionId = v.windows[0].sessionId, missingWindow: v => v.windows = [], tooMany: v => v.windows.push(v.windows[0]), badHostImage: v => v.hostSHA256 = 'no'
}
for (const [name, change] of Object.entries(attacks)) test('normal cleanup refuses ' + name + ' before any Windows command', () => { const v = seed(); change(v); assert.throws(() => request(v), /exact live isolated Host/) })
test('the actual Windows normal close observer uses exact parent/image/birth/WM_CLOSE and retained process handles, never process termination', async () => {
  const s = await readFile(new URL('./fixtures/harness-close-session-windows.ps1', import.meta.url), 'utf8')
  for (const marker of ['ParentProcessId', 'StartTime.ToUniversalTime().Ticks', 'Get-FileHash', 'PostMessage', '0x0010', '$pin.Process.Handle', '$pin.Process.HasExited', 'windowGroupReleased', 'processSignalsSent=0', '5000']) assert(s.includes(marker), marker)
  assert(!/Stop-Process|Stop-ScheduledTask|\.Kill\(|TerminateProcess|SendInput|SetForegroundWindow/u.test(s))
})
