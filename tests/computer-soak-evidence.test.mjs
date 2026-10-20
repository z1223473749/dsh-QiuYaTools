import test from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { ownedWindowsProcesses, installSoakClockProbe } from '../scripts/computer-soak-evidence.mjs'

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

test('soak reads completed canvas frames and preserves only the first invalid pixels without relying on a data URL src', () => {
  const listeners = new Map(), clock = 1792550000000, stats = {}, created = []
  let rowReads = 0
  class Canvas {
    constructor() { this.width = 640; this.height = 360; this.id = 'screen' }
    getContext() { return { drawImage: image => { this.pixels = image.stamp }, getImageData: () => {
      rowReads++; const data = new Uint8ClampedArray(this.width * 4)
      for (let bit = 0; bit < 32; bit++) if (Math.floor(this.pixels / 2 ** bit) % 2) data.fill(255, (28 + bit * 16) * 4, (28 + bit * 16) * 4 + 3)
      return { data }
    } } }
    toDataURL() { return `data:image/jpeg;base64,${Buffer.from(`pixels:${this.pixels}`).toString('base64')}` }
  }
  class Image { naturalWidth = 640; naturalHeight = 360; src = 'blob:already-revoked' }
  const document = { createElement() { const canvas = new Canvas(); created.push(canvas); return canvas }, addEventListener(name, handler) { listeners.set(name, handler) } }
  runInNewContext(`(${installSoakClockProbe.toString()})()`, { document, window: stats, HTMLImageElement: Image, HTMLCanvasElement: Canvas, Date: { now: () => clock } })
  const canvas = new Canvas(); canvas.stamp = (clock - 20) % 2 ** 32
  listeners.get('load')({ type: 'load', target: canvas }); assert.equal(stats.__soak.frames, 0, 'canvas must count only its completed draw event')
  listeners.get('qiuya-preview-frame')({ type: 'qiuya-preview-frame', target: canvas })
  const image = new Image(); image.stamp = canvas.stamp + 1
  listeners.get('load')({ type: 'load', target: image }); assert.equal(stats.__soak.frames, 2)
  canvas.stamp = (clock - 11000) % 2 ** 32
  listeners.get('qiuya-preview-frame')({ type: 'qiuya-preview-frame', target: canvas })
  const first = stats.__soak.firstInvalidImage
  assert.equal(Buffer.from(first.split(',')[1], 'base64').toString(), `pixels:${canvas.stamp}`)
  image.stamp = canvas.stamp - 1; listeners.get('load')({ type: 'load', target: image })
  assert.equal(stats.__soak.firstInvalidImage, first); assert.equal(stats.__soak.invalid, 2)
  assert.equal(created.length, 2, 'one reused row decoder and one first-invalid image canvas only')
  assert.equal(rowReads, 4, 'one row read per decoded frame')
})
