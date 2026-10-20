/** Read-only Windows preflight: no Form construction, CDP, lease or input. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWebViewOwnershipTracker, sameWindowsProcessIdentity, windowsProcessSnapshotCommand } from './computer-webview2-soak-evidence.mjs'

assert.equal(process.platform, 'win32')
const arg = (key, fallback) => { const i = process.argv.indexOf(key); return i < 0 ? fallback : process.argv[i + 1] }
const output = resolve(arg('--output', 'artifacts/computer-use/windows-webview2-identity-exact-preflight'))
const fixture = resolve(arg('--fixture', fileURLToPath(new URL('../tests/fixtures/windows-webview2-soak-fixture.ps1', import.meta.url))))
const run = promisify(execFile), marker = `test-only-no-profile-${randomUUID()}`
await mkdir(output, { recursive: true })
async function ps(code) {
  return (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim()
}
let report
try {
  const snapshot = JSON.parse(await ps(windowsProcessSnapshotCommand(marker)))
  const owned = createWebViewOwnershipTracker()(snapshot, process.pid, '')
  const runner = owned.find(row => row.pid === process.pid)
  assert.ok(runner)
  const independent = await ps(`$ErrorActionPreference='Stop';$p=[Diagnostics.Process]::GetProcessById(${process.pid});try{$null=$p.SafeHandle;$p.StartTime.ToUniversalTime().Ticks.ToString()}finally{$p.Dispose()}`)
  assert.equal(runner.createdAtTicks, independent)
  assert.ok(sameWindowsProcessIdentity(runner, { pid: process.pid, createdAtTicks: independent }))
  const compile = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', fixture, '-CompileOnly'], { windowsHide: true, timeout: 90000, maxBuffer: 65536 })
  assert.equal(JSON.parse(compile.stdout.trim()).compiled, true)
  report = { status: 'passed', kind: 'read-only-native-birth-identity-and-fixture-compile', guiStarted: false, nativeOps: 0, platform: process.platform, architecture: process.arch, runner: { pid: runner.pid, nativeStartTicks: independent, cimStartTicks: runner.cimCreatedAtTicks, precisionDeltaTicks: String(BigInt(independent) - BigInt(runner.cimCreatedAtTicks)), identityPrecision: runner.identityPrecision }, ownedRows: owned.map(row => ({ pid: row.pid, createdAtTicks: row.createdAtTicks, cimCreatedAtTicks: row.cimCreatedAtTicks, identityPrecision: row.identityPrecision })), fixtureCompiled: true, checkedAt: new Date().toISOString() }
} catch (error) { report = { status: 'failed', kind: 'read-only-native-birth-identity-and-fixture-compile', guiStarted: false, nativeOps: 0, reason: error.message }; process.exitCode = 1 }
await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
