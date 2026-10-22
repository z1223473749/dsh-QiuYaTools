/** Finite timing projection for the isolated diagnostic clone only. */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const intervals = [
  ['uiDispatchMs', 'ui-dispatch-queued', 'ui-dispatch-enter'],
  ['outerQueueMs', 'observe-outer-queued', 'observe-outer-enter'],
  ['targetsOuterQueueMs', 'targets-outer-queued', 'targets-outer-enter'],
  ['targetsMs', 'targets-enumerate-enter', 'targets-enumerate-return'],
  ['targetTitleMs', 'target-title-start', 'target-title-end'],
  ['targetBirthMs', 'target-birth-start', 'target-birth-end'],
  ['targetPathMs', 'target-path-start', 'target-path-end'],
  ['targetResolveMs', 'target-resolve-enter', 'target-resolve-complete'],
  ['observeMs', 'observe-enter', 'observe-return'],
  ['captureMs', 'capture-start', 'capture-end'],
  ['captureIoQueueMs', 'capture-io-queued', 'capture-io-enter'],
  ['captureReplyMs', 'capture-worker-write', 'capture-worker-reply'],
  ['captureWorkerStartMs', 'capture-process-start', 'capture-process-started'],
  ['captureRetireMs', 'capture-retire-start', 'capture-retire-end'],
  ['uiaQueueMs', 'uia-task-queued', 'uia-task-enter'],
  ['uiaExecutionMs', 'uia-task-enter', 'uia-task-complete'],
  ['uiaWaitMs', 'uia-wait-start', ['uia-wait-complete', 'uia-wait-timeout']],
  ['emitLockMs', 'emit-lock-wait', 'emit-serialize-start'],
  ['serializeMs', 'emit-serialize-start', 'emit-serialize-end'],
  ['stdoutWriteMs', 'emit-write-start', 'emit-write-end'],
]
export function projectNativePipelineTiming(value) {
  if (value?.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid <= 0 || value.capacity !== 4096 || !Number.isFinite(value.frequency) || value.frequency <= 0 || !Array.isArray(value.records) || value.records.length > 4096) throw new Error('Invalid bounded native pipeline evidence')
  const records = value.records.filter(row => Number.isSafeInteger(row.request) && row.request >= 0 && Number.isFinite(row.qpc)).sort((a, b) => a.sequence - b.sequence), groups = new Map()
  for (const row of records) { const group = groups.get(row.request) ?? []; group.push(row); groups.set(row.request, group) }
  const requests = [...groups].map(([requestId, rows]) => {
    const result = { requestId, operation: ['status', 'targets', 'observe', 'lease', 'release', 'act', 'applications', 'other'].includes(rows[0].op) ? rows[0].op : 'other', startedUtcMs: rows[0].utcMs, lastPhase: rows.at(-1).phase, events: rows.length, phases: [...new Set(rows.map(row => row.phase))] }
    for (const [name, begin, end] of intervals) {
      const durations = []; let start
      for (const row of rows) { if (row.phase === begin) start = row; else if ((Array.isArray(end) ? end : [end]).includes(row.phase) && start) { durations.push(Math.max(0, (row.qpc - start.qpc) / value.frequency * 1000)); start = undefined } }
      if (durations.length) result[name] = durations.map(value => Math.round(value * 1000) / 1000)
    }
    result.workerAvailableMinimum = Math.min(...rows.map(row => row.available).filter(Number.isFinite)); result.workerMinimum = rows[0].minimum
    for (const field of ['threadCount', 'pending', 'completed', 'processors']) {
      const values = rows.map(row => row[field]).filter(Number.isFinite)
      if (values.length) result[field] = { first: values[0], minimum: Math.min(...values), maximum: Math.max(...values), last: values.at(-1) }
    }
    return result
  })
  return { pid: value.pid, mode: ['computer', 'capture-worker', 'session'].includes(value.mode) ? value.mode : 'unknown', records: records.length, requests }
}
export function projectHostPipelineTiming(value) {
  if (value?.version !== 1 || !Number.isSafeInteger(value.pid) || value.capacity !== 4096 || !Array.isArray(value.records) || value.records.length > 4096) throw new Error('Invalid bounded Host pipeline evidence')
  const lag = value.records.filter(row => row.phase === 'host-loop-delivery' && Number.isFinite(row.delayMs)), pipes = value.records.filter(row => row.phase !== 'host-loop-delivery')
  return { pid: value.pid, records: value.records.length, loopSamples: lag.length, maximumLoopDelayMs: lag.length ? Math.max(...lag.map(row => row.delayMs)) : null,
    loopDelaysOver1s: lag.filter(row => row.delayMs >= 1000).map(row => ({ at: row.utcMs, delayMs: row.delayMs })),
    pipes: pipes.map(row => Object.fromEntries(['phase', 'utcMs', 'child', 'childPid', 'request', 'op', 'characters', 'elapsedMs', 'code', 'signalled', 'pending'].filter(key => row[key] !== undefined).map(key => [key, row[key]]))) }
}
export async function analyzePipelineDirectory(directory) {
  const native = [], hosts = [], errors = []
  for (const name of (await readdir(directory)).filter(name => /^(?:native|host-native)-pipeline-[0-9]+\.json$/u.test(name)).sort()) {
    try { const value = JSON.parse(await readFile(join(directory, name), 'utf8')); (name.startsWith('host-') ? hosts : native).push(name.startsWith('host-') ? projectHostPipelineTiming(value) : projectNativePipelineTiming(value)) }
    catch { errors.push({ file: name, code: 'DIAGNOSTIC_TRACE_INVALID' }) }
  }
  return { kind: 'bounded-native-host-pipeline-timing', native, hosts, errors, businessPassInferred: false, originalDeadlinesChanged: false }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const directory = resolve(process.argv[2]), result = await analyzePipelineDirectory(directory)
  await writeFile(join(directory, 'pipeline-timing-projection.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ nativeProcesses: result.native.length, hostProcesses: result.hosts.length, errors: result.errors, path: join(directory, 'pipeline-timing-projection.json') }))
}
