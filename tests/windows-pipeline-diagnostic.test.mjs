import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { instrumentPipelineSource, PIPELINE_TRACE_SOURCE } from '../scripts/prepare-windows-pipeline-diagnostic.mjs'
import { projectNativePipelineTiming, projectHostPipelineTiming } from '../scripts/analyze-windows-pipeline-diagnostic.mjs'

test('timing projection separates native queue/UIA/output delays from Host event-loop delays', () => {
  const row = (phase, qpc, extra = {}) => ({ phase, qpc, sequence: qpc + 1, request: 7, op: 'observe', available: 10, minimum: 2, utcMs: 100000 + qpc, ...extra })
  const result = projectNativePipelineTiming({ version: 1, pid: 42, mode: 'computer', capacity: 4096, frequency: 1000, records: [row('ui-dispatch-queued', 0), row('ui-dispatch-enter', 100), row('observe-outer-queued', 110), row('observe-outer-enter', 111), row('uia-task-queued', 120), row('uia-task-enter', 130), row('uia-wait-start', 120), row('uia-wait-timeout', 6620), row('emit-serialize-start', 6630), row('emit-serialize-end', 6640), row('emit-write-start', 6640), row('emit-write-end', 6641, { private: 'DO_NOT_KEEP' })] })
  assert.deepEqual(result.requests[0].uiDispatchMs, [100]); assert.deepEqual(result.requests[0].outerQueueMs, [1]); assert.deepEqual(result.requests[0].uiaWaitMs, [6500]); assert.deepEqual(result.requests[0].stdoutWriteMs, [1]); assert.equal(result.requests[0].workerAvailableMinimum, 10)
  const host = projectHostPipelineTiming({ version: 1, pid: 43, capacity: 4096, records: [{ phase: 'host-loop-delivery', delayMs: 2100, utcMs: 1000 }, { phase: 'native-reply-line', child: 1, request: 7, op: 'observe', elapsedMs: 9000, private: 'DO_NOT_KEEP' }] })
  assert.equal(host.maximumLoopDelayMs, 2100); assert.equal(host.loopDelaysOver1s.length, 1); assert.equal(host.pipes[0].elapsedMs, 9000)
  assert.doesNotMatch(JSON.stringify({ result, host }), /DO_NOT_KEEP|private/u)
  assert.throws(() => projectNativePipelineTiming({ version: 1, pid: 42, capacity: 4097, frequency: 1000, records: [] }))
})

test('diagnostic clone instruments each real queue/capture/UIA/emit boundary without changing waits', async () => {
  for (const name of ['Program.cs', 'ComputerDriver.cs', 'CaptureBroker.cs']) {
    const source = await readFile(new URL('../src/native/windows/' + name, import.meta.url), 'utf8'), transformed = instrumentPipelineSource(name, source)
    assert.notEqual(source, transformed)
    for (const marker of name === 'Program.cs' ? ['stdin-read', 'ui-dispatch-queued', 'ui-dispatch-enter', 'emit-serialize-start', 'emit-write-end'] : name === 'ComputerDriver.cs' ? ['capture-start', 'capture-end', 'uia-task-queued', 'uia-task-enter', 'uia-wait-timeout'] : ['capture-io-queued', 'capture-worker-reply', 'capture-wait-timeout', 'worker-capture-start', 'worker-emit-write-end']) assert.ok(transformed.includes(marker))
    if (name === 'CaptureBroker.cs') for (const constant of ['captureTimeoutMs = 2500', 'retirementTimeoutMs = 1500', 'attempt < 2', 'TaskCreationOptions.LongRunning']) assert.ok(transformed.includes(constant))
    if (name === 'ComputerDriver.cs') assert.ok(transformed.includes('task.Wait(6500)'))
    assert.throws(() => instrumentPipelineSource(name, transformed), /anchor changed/u)
  }
})

test('targets projection retains OS call intervals and actual pool counters without inferring starvation', () => {
  const row = (phase, qpc, extra = {}) => ({ phase, qpc, sequence: qpc + 1, request: 3, op: 'targets', available: 32760, minimum: 4, utcMs: 100000 + qpc, threadCount: 4, pending: 0, completed: 7, processors: 4, ...extra })
  const result = projectNativePipelineTiming({ version: 1, pid: 42, mode: 'computer', capacity: 4096, frequency: 1000, records: [row('targets-outer-queued', 0), row('targets-outer-enter', 900, { pending: 2 }), row('targets-enumerate-enter', 900), row('target-title-start', 901), row('target-title-end', 902), row('target-birth-start', 902), row('target-birth-end', 903), row('target-path-start', 903), row('target-path-end', 1500), row('targets-enumerate-return', 1501, { completed: 8 })] })
  const request = result.requests[0]
  assert.deepEqual(request.targetsOuterQueueMs, [900]); assert.deepEqual(request.targetsMs, [601]); assert.deepEqual(request.targetTitleMs, [1]); assert.deepEqual(request.targetBirthMs, [1]); assert.deepEqual(request.targetPathMs, [597])
  assert.deepEqual(request.threadCount, { first: 4, minimum: 4, maximum: 4, last: 4 }); assert.deepEqual(request.pending, { first: 0, minimum: 0, maximum: 2, last: 0 })
  assert.doesNotMatch(JSON.stringify(request), /starvation|deadlock|businessPass/u)
})

test('native diagnostics stay bounded and never perform disk or console work inside a marker', () => {
  const body = PIPELINE_TRACE_SOURCE.slice(PIPELINE_TRACE_SOURCE.indexOf('internal static void Mark('), PIPELINE_TRACE_SOURCE.indexOf('internal static Task<T> Run'))
  assert.ok(PIPELINE_TRACE_SOURCE.includes('new Row?[4096]'))
  assert.ok(PIPELINE_TRACE_SOURCE.includes('new Thread(')); assert.ok(PIPELINE_TRACE_SOURCE.includes('Thread.Sleep(250)'))
  assert.doesNotMatch(body, /File\.|Console\.|Serialize|Task\.Run/u)
  assert.doesNotMatch(PIPELINE_TRACE_SOURCE, /SetMinThreads|SetMaxThreads|AutoFlush|targetId|imageBase64|arguments|\.Message/u)
})

test('Host pipe diagnostics are opt-in own-profile only and retain finite prefix/length metadata', async () => {
  const source = await readFile(new URL('./fixtures/harness-native-pipeline-preload.cjs', import.meta.url), 'utf8')
  assert.ok(source.includes("process.env.QIUYA_HARNESS_E2E === '1'")); assert.ok(source.includes("profile.includes('qiuya-harness-e2e-')"))
  assert.ok(source.includes('capacity = 4096')); assert.ok(source.includes('new Worker(')); assert.ok(source.includes("prefix.length"))
  assert.doesNotMatch(source, /readFile|imageBase64|SetMinThreads|API.?KEY|appendFileSync/u)
})

test('real Node preload cannot recursively start a writer inside Workers and retires naturally', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qiuya-harness-e2e-preload-'))
  try {
    const preload = fileURLToPath(new URL('./fixtures/harness-native-pipeline-preload.cjs', import.meta.url))
    const result = await promisify(execFile)(process.execPath, ['-e', 'setTimeout(()=>process.stdout.write("MAIN_DONE"),900)'], { timeout: 5000, env: { ...process.env, DSH_HOME: directory, QIUYA_HARNESS_E2E: '1', NODE_OPTIONS: '--require ' + JSON.stringify(preload) } })
    assert.equal(result.stdout, 'MAIN_DONE'); assert.equal(result.stderr, '')
    const names = await readdir(directory); assert.equal(names.length, 1)
    const trace = JSON.parse(await readFile(join(directory, names[0]), 'utf8'))
    assert.equal(trace.capacity, 4096); assert.ok(trace.records.length > 1)
    assert.equal(trace.records.filter(row => row.phase === 'host-trace-start').length, 1)
    assert.ok(trace.records.every(row => ['host-trace-start', 'host-loop-delivery'].includes(row.phase)))
  } finally { await rm(directory, { recursive: true, force: true }) }
})
