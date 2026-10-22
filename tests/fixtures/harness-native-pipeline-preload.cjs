/** Diagnostic carrier only: finite native pipe/Host-loop timing; no payloads. */
const { isMainThread } = require('node:worker_threads')
const profile = process.env.DSH_HOME
if (isMainThread && process.env.QIUYA_HARNESS_E2E === '1' && typeof profile === 'string' && profile.includes('qiuya-harness-e2e-')) {
  const { Worker } = require('node:worker_threads')
  const childProcess = require('node:child_process'), { syncBuiltinESMExports } = require('node:module')
  const { basename, join } = require('node:path')
  const capacity = 4096, rows = new Array(capacity); let sequence = 0, childSequence = 0
  function mark(phase, values = {}) {
    const row = { sequence: ++sequence, phase, utcMs: Date.now(), qpcNs: process.hrtime.bigint().toString(), ...values }
    rows[(sequence - 1) % capacity] = row
  }
  // Files are written by an independent Worker. Markers only update memory.
  const writer = new Worker(`const{parentPort,workerData}=require('node:worker_threads');const fs=require('node:fs');let snapshot;parentPort.on('message',value=>{snapshot=value});setInterval(()=>{parentPort.postMessage({ping:true,utcMs:Date.now()});if(snapshot)try{const temporary=workerData.path+'.tmp';fs.writeFileSync(temporary,JSON.stringify({...snapshot,flushedUtcMs:Date.now()}));fs.renameSync(temporary,workerData.path)}catch{}},250).unref()`, { eval: true, workerData: { path: join(profile, `host-native-pipeline-${process.pid}.json`) } })
  writer.unref(); writer.on('error', () => {})
  writer.on('message', value => { if (value?.ping) mark('host-loop-delivery', { delayMs: Math.max(0, Date.now() - value.utcMs) }); writer.postMessage({ version: 1, pid: process.pid, capacity, sequence, records: rows.filter(Boolean).sort((a, b) => a.sequence - b.sequence) }) })
  const originalSpawn = childProcess.spawn
  childProcess.spawn = function (executable, args, options) {
    const child = originalSpawn.apply(this, arguments)
    const observer = process.env.QIUYA_HARNESS_OBSERVER_NATIVE
    const ownObserver = typeof observer === 'string' && /\\AppData\\Local\\Temp\\QiuYaTools-harness-[a-f0-9-]{36}\\helper\.exe$/iu.test(observer) && typeof executable === 'string' && executable.toLowerCase() === observer.toLowerCase()
    const ownCompanion = typeof executable === 'string' && basename(executable).toLowerCase() === 'qiuya-windows.exe' && executable.toLowerCase().startsWith(profile.toLowerCase() + '\\')
    if (!ownObserver && !ownCompanion) return child
    const id = ++childSequence, allowed = new Set(['status', 'applications', 'launchApplication', 'targets', 'observe', 'lease', 'release', 'act', 'openPreview', 'closePreview', 'open', 'close'])
    const requests = new Map(); mark('native-spawn', { child: id, childPid: child.pid ?? 0 })
    if (child.stdin) {
      const originalWrite = child.stdin.write
      child.stdin.write = function (chunk) {
        try {
          const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : ''
          if (text.length < 1024 * 1024) {
            const value = JSON.parse(text), request = Number.isSafeInteger(value.requestId) ? value.requestId : 0, op = allowed.has(value.op) ? value.op : 'other'
            if (request) { requests.set(request, { op, start: Date.now() }); if (requests.size > 128) requests.delete(requests.keys().next().value) }
            mark('native-stdin-write', { child: id, request, op, characters: text.length })
          }
        } catch {}
        return originalWrite.apply(this, arguments)
      }
    }
    let prefix = '', length = 0
    child.stdout?.on('data', chunk => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      mark('native-stdout-chunk', { child: id, characters: text.length })
      let begin = 0
      for (;;) {
        const end = text.indexOf('\n', begin), part = text.slice(begin, end < 0 ? undefined : end)
        prefix += part.slice(0, Math.max(0, 128 - prefix.length)); length += part.length
        if (end < 0) break
        const request = Number(/^\s*\{"requestId":(\d+)/u.exec(prefix)?.[1] ?? 0), pending = requests.get(request)
        mark('native-reply-line', { child: id, request, op: pending?.op ?? 'other', elapsedMs: pending ? Date.now() - pending.start : null, characters: length })
        requests.delete(request); prefix = ''; length = 0; begin = end + 1
      }
    })
    child.once('exit', (code, signal) => mark('native-exit', { child: id, code, signalled: !!signal, pending: requests.size }))
    return child
  }
  writer.unref(); syncBuiltinESMExports(); mark('host-trace-start')
}
