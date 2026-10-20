/** Test-only evidence helpers; process identities include their creation time. */
export function ownedWindowsProcesses(snapshot, rootPid, helperPath) {
  const created = item => { try { return /^\d+$/u.test(item.createdAtTicks) ? BigInt(item.createdAtTicks) : 0n } catch { return 0n } }
  const pathKey = value => typeof value === 'string' ? value.replaceAll('/', '\\').toLowerCase() : ''
  const rows = snapshot.filter(item => Number.isSafeInteger(item.pid) && item.pid > 0 && created(item) > 0n)
  const runner = rows.find(item => item.pid === rootPid)
  if (!runner) throw new Error('Owned runner process creation identity was unavailable')
  const owned = new Map([[runner.pid, runner]]), helper = pathKey(helperPath)
  // Exact UUID helper paths retain orphan capture/guardian workers after a
  // controlled companion termination. Same-name processes are insufficient.
  for (const item of rows) if (helper && pathKey(item.executablePath) === helper && created(item) >= created(runner)) owned.set(item.pid, item)
  let changed
  do {
    changed = false
    for (const item of rows) {
      const parent = owned.get(item.parentPid)
      // An old child pointing at a now-reused parent PID is not our child.
      if (!owned.has(item.pid) && parent && created(item) >= created(parent)) { owned.set(item.pid, item); changed = true }
    }
  } while (changed)
  return [...owned.values()].map(({ executablePath: _path, ...item }) => item)
}

/** Runs in the actual preview page. Decode one row with one reusable canvas. */
export function installSoakClockProbe() {
  const canvas = document.createElement('canvas'); canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true, alpha: false })
  if (!context) throw new Error('Clock decoder canvas unavailable')
  window.__soak = { frames: 0, invalid: 0, lastStamp: -1, latencies: [], first: 0, last: 0, maxFrameGapMs: 0 }
  document.addEventListener('load', event => {
    const img = event.target
    if (!(img instanceof HTMLImageElement) || !img.naturalWidth) return
    if (canvas.width !== img.naturalWidth) canvas.width = img.naturalWidth
    const scale = img.naturalWidth / 640
    context.drawImage(img, 0, Math.round(32 * scale), img.naturalWidth, 1, 0, 0, img.naturalWidth, 1)
    const row = context.getImageData(0, 0, canvas.width, 1).data
    let stamp = 0
    for (let bit = 0; bit < 32; bit++) { const index = Math.round((28 + bit * 16) * scale) * 4; if (row[index] + row[index + 1] + row[index + 2] > 384) stamp += 2 ** bit }
    const elapsed = ((Date.now() % 2 ** 32) - stamp + 2 ** 32) % 2 ** 32
    if (elapsed > 10000) { window.__soak.invalid++; if (!window.__soak.firstInvalidImage) window.__soak.firstInvalidImage = img.src; return }
    if (stamp === window.__soak.lastStamp) return
    const stats = window.__soak; stats.lastStamp = stamp; stats.frames++; const now = Date.now(); if (stats.last) stats.maxFrameGapMs = Math.max(stats.maxFrameGapMs, now - stats.last); stats.last = now; if (!stats.first) stats.first = stats.last
    stats.latencies.push(elapsed); if (stats.latencies.length > 100000) stats.latencies.shift()
  }, true)
}
