/** Test-only observations for a real, separately owned WebView2 window. */
import { ownedWindowsProcesses } from './computer-soak-evidence.mjs'

const ticks = value => { try { return /^\d+$/u.test(value) ? BigInt(value) : null } catch { return null } }
export function preciseWindowsProcessIdentity(row) {
  const native = ticks(row.createdAtTicks), cim = ticks(row.cimCreatedAtTicks)
  return native !== null && cim !== null && native - native % 10n === cim
    ? { ...row, identityPrecision: 'native-100ns-verified-against-CIM-microseconds' } : null
}
export function sameWindowsProcessIdentity(row, identity) {
  if (row.pid !== identity.pid) return false
  const exact = preciseWindowsProcessIdentity(row)
  if (exact) return exact.createdAtTicks === identity.createdAtTicks
  const birth = ticks(identity.createdAtTicks), cim = ticks(row.cimCreatedAtTicks)
  if (birth !== null && cim === birth - birth % 10n) throw new Error('A still-live owned process birth identity could not be verified')
  return false
}

/** Pin native process handles before reading full-resolution birth ticks.
 * CIM truncates CreationDate to microseconds; it must only corroborate the
 * exact value, never be compared directly to Process.StartTime or used to kill.
 */
export function windowsProcessSnapshotCommand(nativeData, { fixturePath = '' } = {}) {
  const marker = `'${nativeData.replaceAll("'", "''")}'`
  const fixture = `'${fixturePath.replaceAll("'", "''")}'`
  return `$ErrorActionPreference='Stop';$marker=${marker};$fixture=${fixture};$rows=@(Get-CimInstance Win32_Process|ForEach-Object{ $row=$_;if($row.CreationDate){$cim=$row.CreationDate.ToUniversalTime().Ticks;$exact=$null;$state='unavailable';$p=$null;try{$p=[Diagnostics.Process]::GetProcessById([int]$row.ProcessId);$null=$p.SafeHandle;$native=$p.StartTime.ToUniversalTime().Ticks;if(($native-($native%10))-eq $cim){$exact=$native.ToString();$state='native-100ns-verified-against-CIM-microseconds'}else{$state='row-exited-or-reused'}}catch{$check=$null;try{$check=[Diagnostics.Process]::GetProcessById([int]$row.ProcessId);if($check.HasExited){$state='row-exited-or-reused'}}catch{$state='row-exited-or-reused'}finally{if($check){$check.Dispose()}}}finally{if($p){$p.Dispose()}};if($state-ne 'row-exited-or-reused'){@{pid=[int]$row.ProcessId;parentPid=[int]$row.ParentProcessId;name=$row.Name;createdAtTicks=$exact;cimCreatedAtTicks=$cim.ToString();identityPrecision=$state;executablePath=$row.ExecutablePath;workingSetBytes=[long]$row.WorkingSetSize;privateBytes=[long]$row.PrivatePageCount;cpuSeconds=([double]$row.KernelModeTime+[double]$row.UserModeTime)/10000000;ownedFixture=($fixture -ne '' -and $row.Name -ieq 'powershell.exe' -and $row.CommandLine -and $row.CommandLine.IndexOf($fixture,[StringComparison]::OrdinalIgnoreCase)-ge 0);ownedWebView=($row.Name -ieq 'msedgewebview2.exe' -and $row.CommandLine -and $row.CommandLine.IndexOf($marker,[StringComparison]::OrdinalIgnoreCase)-ge 0)}}}});ConvertTo-Json -InputObject $rows -Compress`
}

export function createWebViewOwnershipTracker() {
  const known = new Set(), knownCim = new Set()
  return (rows, runnerPid, helperPath) => {
    // Find candidate membership using the common CIM precision first. A live
    // candidate with unavailable native identity must fail rather than vanish
    // from the resource total. Synthetic unit rows can omit CIM metadata.
    const candidates = rows.map(row => ({ ...row, createdAtTicks: row.cimCreatedAtTicks ?? row.createdAtTicks }))
    const owned = new Map(ownedWindowsProcesses(candidates, runnerPid, helperPath).map(row => [row.pid, row]))
    const runner = candidates.find(row => row.pid === runnerPid)
    const born = row => { try { return BigInt(row.createdAtTicks) } catch { return -1n } }
    const identity = row => `${row.pid}:${row.createdAtTicks}`
    for (const row of candidates) {
      if (born(row) < born(runner)) continue
      // The collector sets this only after matching this run's unique WebView2
      // user-data directory. A shared msedgewebview2.exe path is insufficient.
      const original = rows.find(value => value.pid === row.pid)
      const remembered = original.createdAtTicks != null ? known.has(identity(original)) : knownCim.has(identity(row))
      if (row.ownedWebView === true || remembered) owned.set(row.pid, row)
    }
    let changed
    do {
      changed = false
      for (const row of candidates) {
        const parent = owned.get(row.parentPid)
        if (!owned.has(row.pid) && parent && born(row) >= born(parent)) { owned.set(row.pid, row); changed = true }
      }
    } while (changed)
    const result = []
    for (const candidate of owned.values()) {
      const row = rows.find(value => value.pid === candidate.pid)
      const verified = Object.hasOwn(row, 'cimCreatedAtTicks') ? preciseWindowsProcessIdentity(row) : row
      if (!verified) throw new Error('A live owned process native birth identity was unavailable')
      known.add(identity(verified)); knownCim.add(identity(candidate))
      const { executablePath: _path, ...item } = verified; result.push(item)
    }
    return result
  }
}

/** Emergency discovery never adopts children of a dead/reused runner merely by PPID. */
export function windowsEmergencyCleanupIdentities(rows, { runner, helperPath }, recorded = []) {
  const pathKey = value => typeof value === 'string' ? value.replaceAll('/', '\\').toLowerCase() : ''
  if (!Number.isSafeInteger(runner?.pid) || runner.pid <= 0 || ticks(runner.createdAtTicks) === null || !pathKey(helperPath)) throw new Error('Invalid emergency ownership root')
  const born = value => ticks(value?.createdAtTicks) ?? -1n, own = new Map()
  for (const row of rows) {
    const remembered = recorded.find(item => item.pid === row.pid && sameWindowsProcessIdentity(row, item))
    const root = row.pid === runner.pid && sameWindowsProcessIdentity(row, runner)
    const marked = pathKey(row.executablePath) === pathKey(helperPath) || row.ownedWebView === true || row.ownedFixture === true
    if (root || remembered || (marked && (ticks(row.cimCreatedAtTicks) ?? born(row)) >= born(runner))) own.set(row.pid, row)
  }
  let changed
  do {
    changed = false
    for (const row of rows) {
      const parent = own.get(row.parentPid)
      if (!own.has(row.pid) && parent && (ticks(row.cimCreatedAtTicks) ?? born(row)) >= (ticks(parent.cimCreatedAtTicks) ?? born(parent))) { own.set(row.pid, row); changed = true }
    }
  } while (changed)
  return [...own.values()].map(row => {
    const exact = preciseWindowsProcessIdentity(row)
    if (!exact) throw new Error('Emergency ownership requires an exact native birth identity')
    const previous = recorded.find(item => item.pid === row.pid && item.createdAtTicks === row.createdAtTicks)
    const expectedExecutablePath = row.executablePath || previous?.expectedExecutablePath || (row.pid === runner.pid ? runner.expectedExecutablePath : null)
    if (!expectedExecutablePath) throw new Error('Owned emergency executable path was unavailable')
    return { pid: row.pid, createdAtTicks: row.createdAtTicks, name: row.name, expectedExecutablePath }
  })
}

/** All verification and optional termination use one pinned Process object, never taskkill/PID. */
export function windowsPinnedProcessCommand(identities, { terminate = false } = {}) {
  if (!Array.isArray(identities) || identities.length > 4096) throw new Error('Cleanup identity budget exceeded')
  const seen = new Set()
  for (const item of identities) {
    if (!Number.isSafeInteger(item.pid) || item.pid <= 0 || ticks(item.createdAtTicks) === null || typeof item.expectedExecutablePath !== 'string' || !/^[a-z]:[\\/]/iu.test(item.expectedExecutablePath) || item.expectedExecutablePath.length > 32768 || seen.has(item.pid)) throw new Error('Invalid pinned cleanup identity')
    seen.add(item.pid)
  }
  const encoded = Buffer.from(JSON.stringify(identities), 'utf8').toString('base64')
  return `$ErrorActionPreference='Stop';$items=@(ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))));$results=@();$errors=@();$clock=[Diagnostics.Stopwatch]::StartNew();foreach($i in $items){$p=$null;try{try{$p=[Diagnostics.Process]::GetProcessById([int]$i.pid)}catch [ArgumentException]{$results+=@{pid=$i.pid;state='already-exited'};continue};$null=$p.SafeHandle;$birth=$p.StartTime.ToUniversalTime().Ticks.ToString();if($birth -ne $i.createdAtTicks){$results+=@{pid=$i.pid;state='reused-pid-skipped'};continue};if($p.MainModule.FileName -ine $i.expectedExecutablePath){throw 'Owned process executable identity changed'};if($clock.ElapsedMilliseconds -gt 15000){throw 'Pinned cleanup total deadline'};${terminate ? "$p.Kill();if(!$p.WaitForExit(2000)){throw 'Pinned owned process did not exit'};$results+=@{pid=$i.pid;createdAtTicks=$birth;state='terminated'}" : "$results+=@{pid=$i.pid;createdAtTicks=$birth;state='alive'}"}}catch{$failure=$_.Exception.Message;$gone=$false;if($p){try{$gone=$p.HasExited}catch{}};if($gone){$results+=@{pid=$i.pid;state='already-exited'}}else{$errors+=@{pid=$i.pid;error=$failure}}}finally{if($p){$p.Dispose()}}};@{passed=($errors.Count -eq 0);terminate=${terminate ? '$true' : '$false'};results=$results;errors=$errors}|ConvertTo-Json -Depth 6 -Compress`
}

export class WebViewClockAccumulator {
  constructor({ width = 1280, height = 720, maximumFrames = 250000 } = {}) {
    this.width = width; this.height = height; this.maximumFrames = maximumFrames
    this.frames = []; this.seen = new Set(); this.invalid = 0; this.wrongDimensions = 0; this.ignoredRetired = 0
    this.generation = 0; this.lastStamp = -1; this.warmup = 0; this.start = 0; this.end = 0
  }
  useGeneration(generation) { this.generation = generation }
  begin(now) { this.warmup = this.frames.length; this.frames = []; this.start = now; this.end = 0 }
  finish(now) { this.end = now; this.generation = 0 }
  accept(generation, event) {
    if (generation !== this.generation || this.end) { this.ignoredRetired++; return false }
    if (!event || event.kind !== 'frame' || !Number.isSafeInteger(event.stamp) || event.stamp < 0 || event.stamp >= 2 ** 32 || !Number.isSafeInteger(event.atMs)) throw new Error('Malformed WebView2 clock observation')
    if (event.width !== this.width || event.height !== this.height) { this.wrongDimensions++; return false }
    const latency = ((event.atMs % 2 ** 32) - event.stamp + 2 ** 32) % 2 ** 32
    if (latency > 10000) { this.invalid++; return false }
    if (this.seen.has(event.stamp)) return false
    // A CDP notification queued during initial warm-up cannot inflate FPS.
    if (this.start && event.atMs < this.start) return false
    if (this.frames.length >= this.maximumFrames) throw new Error('Clock evidence budget exceeded')
    this.seen.add(event.stamp); this.lastStamp = event.stamp
    this.frames.push([generation, event.stamp, event.atMs, latency])
    return true
  }
  summary(now = this.end || Date.now()) {
    const latencies = this.frames.map(frame => frame[3]).sort((a, b) => a - b)
    const first = this.frames[0]?.[2] ?? 0, last = this.frames.at(-1)?.[2] ?? 0
    let maxFrameGapMs = 0
    for (let i = 1; i < this.frames.length; i++) maxFrameGapMs = Math.max(maxFrameGapMs, this.frames[i][2] - this.frames[i - 1][2])
    return { frames: this.frames.length, elapsedMs: this.start ? now - this.start : 0, endToEndFps: this.start ? this.frames.length / ((now - this.start) / 1000) : 0,
      uniqueFps: last > first ? (this.frames.length - 1) / ((last - first) / 1000) : 0,
      latencyP95Ms: latencies.length ? latencies[Math.floor(latencies.length * 0.95)] : null,
      invalidTimestamps: this.invalid, wrongDimensions: this.wrongDimensions, maxFrameGapMs,
      warmupFramesExcluded: this.warmup, ignoredRetiredNotifications: this.ignoredRetired }
  }
}

/** Injected only through CDP into this test's own native production preview.
 * Reads pixels independently of Host/native frame identifiers and callbacks.
 */
export function installWebViewClockProbe({ bindingName, generation }) {
  if (window.__qytWebViewClockProbe) throw new Error('Clock probe was installed twice')
  const rowCanvas = document.createElement('canvas'); rowCanvas.height = 1
  const context = rowCanvas.getContext('2d', { willReadFrequently: true, alpha: false })
  if (!context || typeof window[bindingName] !== 'function') throw new Error('Clock probe binding unavailable')
  window.__qytWebViewClockProbe = { generation, firstInvalidImage: null }
  document.addEventListener('qiuya-preview-frame', event => {
    const screen = event.target
    if (!(screen instanceof HTMLCanvasElement) || screen.id !== 'screen') return
    const width = screen.width, height = screen.height
    if (!width || !height) return
    if (rowCanvas.width !== width) rowCanvas.width = width
    const scale = width / 640
    context.drawImage(screen, 0, Math.round(32 * scale), width, 1, 0, 0, width, 1)
    const row = context.getImageData(0, 0, width, 1).data
    let stamp = 0
    for (let bit = 0; bit < 32; bit++) {
      const offset = Math.round((28 + bit * 16) * scale) * 4
      if (row[offset] + row[offset + 1] + row[offset + 2] > 384) stamp += 2 ** bit
    }
    const atMs = Date.now(), latency = ((atMs % 2 ** 32) - stamp + 2 ** 32) % 2 ** 32
    if (latency > 10000 && !window.__qytWebViewClockProbe.firstInvalidImage) window.__qytWebViewClockProbe.firstInvalidImage = screen.toDataURL('image/jpeg')
    window[bindingName](JSON.stringify({ kind: 'frame', generation, stamp, atMs, width, height }))
  }, true)
  return { installed: true, generation, href: location.href }
}
