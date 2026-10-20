import test from 'node:test'
import assert from 'node:assert/strict'
import { ownedWindowsProcesses } from '../scripts/computer-soak-evidence.mjs'

const birth = 639281000000000000n
const row = (pid, parentPid, offset, name, executablePath = '') => ({ pid, parentPid, createdAtTicks: String(birth + BigInt(offset)), name, executablePath, workingSetBytes: 4096, cpuSeconds: 0 })

test('resource attribution rejects the observed reused conhost PID chain into Windows services', () => {
  const rows = [
    row(6956, 10944, 0, 'node.exe'), row(6744, 6956, 100, 'powershell.exe'), row(752, 6744, 200, 'conhost.exe'),
    row(848, 752, -50000, 'wininit.exe'), row(996, 848, -49000, 'services.exe'), row(3396, 996, -48000, 'MsMpEng.exe'),
    row(12572, 6956, 50, 'qiuya-windows.exe', 'C:\\test-uuid\\qiuya-windows.exe'), row(11596, 4856, 41, 'msedge.exe'), row(4856, 6956, 40, 'msedge.exe'),
  ]
  const actual = ownedWindowsProcesses(rows, 6956, 'C:\\test-uuid\\qiuya-windows.exe')
  assert.deepEqual(actual.map(item => item.pid).sort((a, b) => a - b), [752, 4856, 6744, 6956, 11596, 12572])
  assert.ok(actual.some(item => item.pid === 6744), 'sampling PowerShell overhead remains counted')
  assert.equal(actual.reduce((sum, item) => sum + item.workingSetBytes, 0), 6 * 4096)
  assert.equal(actual.some(item => item.name === 'MsMpEng.exe'), false)
  assert.equal(actual.some(item => Object.hasOwn(item, 'executablePath')), false, 'unrelated executable paths are not copied into evidence')
})

test('only an exact helper path born during this run can retain an orphan native process tree', () => {
  const helper = 'C:\\disposable-uuid\\qiuya-windows.exe'
  const rows = [row(10, 1, 0, 'node.exe'), row(20, 999, 1, 'qiuya-windows.exe', helper.toUpperCase()), row(21, 20, 2, 'conhost.exe'), row(22, 20, -1, 'old-process.exe'), row(30, 999, 3, 'qiuya-windows.exe', 'C:\\another-uuid\\qiuya-windows.exe'), row(40, 999, -10, 'qiuya-windows.exe', helper)]
  assert.deepEqual(ownedWindowsProcesses(rows, 10, helper).map(item => item.pid), [10, 20, 21])
  assert.throws(() => ownedWindowsProcesses(rows, 200, helper), /creation identity/)
  assert.throws(() => ownedWindowsProcesses([{ ...rows[0], createdAtTicks: null }], 10, helper), /creation identity/)
})
