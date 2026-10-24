import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { spawn } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { coordinatorFailure, readCoordinatorResponse, retainedCommand } from '../scripts/windows-acceptance/command-receipt.mjs'
const hash = value => createHash('sha256').update(value).digest('hex')
const response = (body, status = 200) => new Response(body, { status })
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value }); return { promise, resolve } }

test('a genuine completed child with empty stdout is valid opaque output, never parsed as JSON', async () => {
  const records = [], callbacks = []
  const args = ['--input-type=module', '-e', 'process.exitCode=0']
  const result = await retainedCommand(process.execPath, args, {
    budget: 2000, phase: 'readonly-test-child', records,
    onStart: row => { callbacks.push(['start', row.spawnNonce]) },
    onExit: (row, ack) => { callbacks.push(['exit', row.spawnNonce]); assert.equal(ack.stdout, '') },
  })
  assert.deepEqual(result, { code: 0, signal: null, stdout: '', stderr: '' })
  const [row] = records
  assert.equal(row.code, 0); assert.equal(row.signal, null); assert.equal(row.natural, true)
  assert.equal(row.forced, false); assert.notEqual(row.unknown, true)
  assert.equal(row.executable, process.execPath); assert.equal(row.hostParentPID, process.pid)
  assert.match(row.spawnNonce, /^[a-f0-9-]{36}$/u); assert(row.pid > 0)
  assert.equal(row.argvSHA256, hash(Buffer.from(JSON.stringify(args))))
  assert.equal(row.stdoutBytes, 0); assert.equal(row.stdoutSHA256, hash(Buffer.alloc(0)))
  assert.deepEqual(callbacks, [['start', row.spawnNonce], ['exit', row.spawnNonce]])
})

test('a real child late exit0 records its original identity and cannot turn the timed-out operation into ACK', { timeout: 5000 }, async () => {
  const records = [], late = deferred(); let normalACKs = 0, deadlines = 0
  const args = ['--input-type=module', '-e', 'setTimeout(()=>process.stdout.write("late"),180)']
  const promise = retainedCommand(process.execPath, args, {
    budget: 10, phase: 'retained-test-child', records,
    onExit: () => { normalACKs++ },
    onTimeout: (row, ack) => {
      deadlines++; assert.equal(row.unknown, true); assert.equal(row.retained, true)
      assert.equal(row.localHandlesUnrefWithoutClose, true)
      assert.equal(row.code, null); assert.equal(ack.code, null)
      assert.equal(row.finishedAt, undefined)
    },
    onLateExit: (row, ack) => { late.resolve({ row: { ...row }, ack }) },
  })
  await assert.rejects(promise, /exceeded its fixed 10ms budget; retained without signal or replay/u)
  const nonce = records[0].spawnNonce, pid = records[0].pid
  const heartbeat = setTimeout(() => {}, 1500)
  try {
    const settled = await late.promise
    assert.equal(settled.row.spawnNonce, nonce); assert.equal(settled.row.pid, pid)
    assert.equal(settled.row.code, 0); assert.equal(settled.row.signal, null)
    assert.equal(settled.row.unknown, true); assert.equal(settled.row.forced, false)
    assert(settled.row.elapsedMs > 10)
    assert.equal(settled.ack.stdout, 'late')
    assert.equal(normalACKs, 0); assert.equal(deadlines, 1)
  } finally { clearTimeout(heartbeat) }
})

test('timeout detaches only original child/pipe references, sends no signal and calls late evidence once', async () => {
  const child = new EventEmitter(); child.pid = 1001
  let unrefs = 0, normalACKs = 0, lateACKs = 0, kills = 0
  child.unref = () => { unrefs++ }; child.kill = () => { kills++; throw Error('No signal permitted') }
  child.stdout = new PassThrough(); child.stderr = new PassThrough()
  child.stdout.unref = child.stderr.unref = () => { unrefs++ }
  const records = [], late = deferred()
  await assert.rejects(retainedCommand('own-child', [], {
    budget: 5, phase: 'test-timeout', records, spawnChild: () => child,
    onExit: () => { normalACKs++ },
    onLateExit: () => { lateACKs++; late.resolve() },
  }), /fixed 5ms budget/u)
  assert.equal(unrefs, 3); assert.equal(kills, 0)
  child.emit('exit', 0, null); child.emit('close', 0, null); await late.promise
  child.emit('exit', 0, null); await Promise.resolve()
  assert.equal(records[0].unknown, true); assert.equal(normalACKs, 0)
  assert.equal(lateACKs, 1); assert.equal(kills, 0)
})

test('late evidence failure is retained, cannot create successful ACK or erase unknown', async () => {
  const child = new EventEmitter(); child.pid = 1002; child.unref = () => {}
  child.stdout = new PassThrough(); child.stderr = new PassThrough()
  child.stdout.unref = child.stderr.unref = () => {}
  const records = []; let successful = 0
  await assert.rejects(retainedCommand('own-child', [], {
    budget: 5, phase: 'test-evidence-failure', records, spawnChild: () => child,
    onExit: () => { successful++ }, onLateExit: () => { throw Error('write failed') },
  }), /fixed 5ms budget/u)
  child.emit('exit', 0, null); child.emit('close', 0, null)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(records[0].unknown, true); assert.equal(records[0].lateExitEvidenceError, 'write failed')
  assert.equal(successful, 0)
})

test('HTTP409 preserves original timeout and explicit no-acknowledgement', async () => {
  const text = 'virtual-hardware-key exceeded its fixed 10000ms budget; retained without signal or replay'
  const body = coordinatorFailure(Error(text))
  assert.deepEqual(body, { ok: false, error: text, kind: 'coordinator-rejected-or-unknown', noAcknowledgement: true })
  await assert.rejects(readCoordinatorResponse(response(JSON.stringify(body), 409), { operation: 'key' }), error => {
    assert.match(error.message, /HTTP409: virtual-hardware-key exceeded its fixed 10000ms/u)
    assert.equal(error.coordinatorReceipt.noAcknowledgement, true)
    assert.equal(error.coordinatorReceipt.acknowledgementAccepted, false)
    assert.equal(error.coordinatorReceipt.status, 409)
    return true
  })
})

for (const [label, body, status] of [
  ['empty rejection', '', 409], ['empty success', '', 200], ['damaged JSON', '{', 200],
  ['null body', 'null', 200], ['missing ok', '{"result":{"code":0}}', 200],
  ['missing result', '{"ok":true}', 200], ['false ok', '{"ok":false,"result":{"code":0}}', 200],
  ['non-OK HTTP with ok body', '{"ok":true,"result":{"code":0}}', 409],
]) test(`${label} never fabricates ACK`, async () => {
  await assert.rejects(readCoordinatorResponse(response(body, status), { operation: 'key' }), error => {
    assert.equal(error.coordinatorReceipt.acknowledgementAccepted, false)
    return true
  })
})

test('only explicit HTTP success with ok:true and a present result returns the actual result', async () => {
  const result = { nonce: 'actual', ordinal: 1, code: 0, signal: null }
  assert.deepEqual(await readCoordinatorResponse(response(JSON.stringify({ ok: true, result })), { operation: 'observed' }), result)
})

test('error text and streamed body retain original bounds', async () => {
  const body = coordinatorFailure(Error('a'.repeat(9000)))
  assert.equal(body.error.length, 2048)
  await assert.rejects(readCoordinatorResponse(response('x'.repeat(65537)), { operation: 'key' }), /exceeds65536 bytes; no acknowledgement accepted/u)
})

test('invalid operation is rejected before consuming response bytes', async () => {
  let consumed = false
  await assert.rejects(readCoordinatorResponse({ status: 200, get body() { consumed = true; throw Error('must not read') } }, { operation: '../key' }), /Invalid fixed coordinator operation/u)
  assert.equal(consumed, false)
})

test('the original5ms absolute deadline covers a30ms start callback: late exit0 cannot ACK', async () => {
  const child = new EventEmitter(); child.pid = 1003; child.unref = () => {}
  child.stdout = new PassThrough(); child.stderr = new PassThrough()
  child.stdout.unref = child.stderr.unref = () => {}
  const records = [], late = deferred(); let normalACKs = 0, callbacks = 0
  let callbackCompleted = false
  await assert.rejects(retainedCommand('own-child', [], {
    budget: 5, phase: 'callback-is-inside-budget', records, spawnChild: () => child,
    onStart: async () => { callbacks++; await new Promise(resolve => setTimeout(resolve, 30)); child.emit('exit', 0, null); child.emit('close', 0, null); callbackCompleted = true },
    onExit: () => { normalACKs++ }, onLateExit: () => late.resolve(),
  }), /fixed 5ms budget/u)
  assert.equal(callbackCompleted, false, 'The rejection cannot wait until onStart completes')
  if (callbacks === 0) { child.emit('exit', 0, null); child.emit('close', 0, null) }
  await late.promise
  assert(callbacks <= 1); assert.equal(normalACKs, 0)
  assert.equal(records[0].unknown, true); assert.equal(records[0].unknownOrigin, 'deadline')
  assert.equal(records[0].code, 0); assert.equal(records[0].stdioClosed, true)
})

test('a real child that exits before onStart completes is retained until successful callback and close', { timeout: 5000 }, async () => {
  const records = []; let child, closeBeforeCallback = false
  const result = await retainedCommand(process.execPath, ['--input-type=module', '-e', 'process.stdout.write("完整输出你好");process.stderr.write("diagnostic")'], {
    budget: 2000, phase: 'real-child-first', records,
    spawnChild: (...args) => { child = spawn(...args); return child },
    onStart: async () => { await once(child, 'close'); closeBeforeCallback = true },
    onExit: row => { assert.equal(closeBeforeCallback, true); assert.equal(row.stdioClosed, true) },
  })
  assert.equal(result.stdout, '完整输出你好'); assert.equal(result.stderr, 'diagnostic')
  assert.equal(records[0].stdoutSHA256, hash(Buffer.from(result.stdout)))
  assert.equal(records[0].stdoutBytes, Buffer.byteLength(result.stdout))
  assert.notEqual(records[0].unknown, true)
})

test('a real child and slow onStart cannot extend the original deadline or manufacture ACK', { timeout: 5000 }, async () => {
  const records = [], late = deferred(); let normalACKs = 0, callbacks = 0
  const heartbeat = setTimeout(() => {}, 1000)
  try {
    await assert.rejects(retainedCommand(process.execPath, ['--input-type=module', '-e', 'process.stdout.write("done")'], {
      budget: 15, phase: 'real-slow-start', records,
      onStart: async () => { callbacks++; await new Promise(resolve => setTimeout(resolve, 100)) },
      onExit: () => { normalACKs++ }, onLateExit: () => late.resolve(),
    }), /fixed 15ms budget/u)
    await late.promise
    assert.equal(normalACKs, 0); assert(callbacks <= 1)
    assert.equal(records[0].unknown, true); assert.equal(records[0].code, 0)
    assert.equal(records[0].signal, null); assert.equal(records[0].forced, false)
  } finally { clearTimeout(heartbeat) }
})

test('a rejected start callback retains the real child and its eventual exit without successful ACK', { timeout: 5000 }, async () => {
  const records = [], late = deferred(); let normalACKs = 0
  const heartbeat = setTimeout(() => {}, 1000)
  try {
    await assert.rejects(retainedCommand(process.execPath, ['--input-type=module', '-e', 'setTimeout(()=>process.stdout.write("retired"),40)'], {
      budget: 500, phase: 'real-failed-start', records,
      onStart: async () => { throw Error('start journal unavailable') },
      onExit: () => { normalACKs++ }, onLateExit: () => late.resolve(),
    }), /start journal unavailable/u)
    await late.promise
    assert.equal(normalACKs, 0); assert.equal(records[0].unknown, true)
    assert.equal(records[0].unknownOrigin, 'on-start'); assert.equal(records[0].code, 0)
    assert.equal(records[0].stdioClosed, true); assert.equal(records[0].forced, false)
  } finally { clearTimeout(heartbeat) }
})

test('exit alone cannot imply complete stdout drain or a normal acknowledgement', async () => {
  const child = new EventEmitter(); child.pid = 1004; child.unref = () => {}
  child.stdout = new PassThrough(); child.stderr = new PassThrough()
  child.stdout.unref = child.stderr.unref = () => {}
  const records = []; let normalACKs = 0
  const pending = retainedCommand('own-child', [], {
    budget: 1000, phase: 'wait-for-pipe-close', records, spawnChild: () => child,
    onExit: row => { normalACKs++; assert.equal(row.stdioClosed, true) },
  })
  await Promise.resolve()
  child.stdout.write('before-'); child.emit('exit', 0, null)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(normalACKs, 0); assert.equal(records[0].finishedAt, undefined)
  child.stdout.write('after'); child.emit('close', 0, null)
  const result = await pending
  assert.equal(result.stdout, 'before-after'); assert.equal(normalACKs, 1)
  assert.equal(records[0].stdoutSHA256, hash(Buffer.from('before-after')))
})

test('child-start error is observed before callbacks can supply a successful ACK', async () => {
  const records = []; let normalACKs = 0
  await assert.rejects(retainedCommand('/qiuya-acceptance-nonexistent-executable', [], {
    budget: 1000, phase: 'start-error', records, onExit: () => { normalACKs++ },
  }), /ENOENT/u)
  assert.equal(normalACKs, 0); assert.equal(records[0].unknown, true)
  assert.equal(records[0].unknownOrigin, 'child-error'); assert.equal(records[0].forced, false)
})

test('an exit0 before deadline with late pipe close still has no timely ACK', async () => {
  const child = new EventEmitter(); child.pid = 1005; child.unref = () => {}
  child.stdout = new PassThrough(); child.stderr = new PassThrough()
  child.stdout.unref = child.stderr.unref = () => {}
  const records = [], late = deferred(); let normalACKs = 0, started = false
  await assert.rejects(retainedCommand('own-child', [], {
    budget: 5, phase: 'late-drain', records, spawnChild: () => child,
    onStart: () => { started = true; child.emit('exit', 0, null); setTimeout(() => { child.stdout.write('tail'); child.emit('close', 0, null) }, 30) },
    onExit: () => { normalACKs++ }, onLateExit: (_row, result) => late.resolve(result),
  }), /fixed 5ms budget/u)
  if (!started) { child.emit('exit', 0, null); child.emit('close', 0, null) }
  const terminal = await late.promise
  assert.equal(records[0].unknown, true); assert.equal(normalACKs, 0)
  assert.equal(records[0].stdioClosed, true); assert.equal(terminal.code, 0)
  if (started) assert.equal(terminal.stdout, 'tail')
})

test('stdio error retains the exact child without an uncaught stream exception or normal ACK', async () => {
  const child = new EventEmitter(); child.pid = 1007; child.unref = () => {}
  child.stdout = new PassThrough(); child.stderr = new PassThrough()
  child.stdout.unref = child.stderr.unref = () => {}
  const records = []; let ACK = 0
  await assert.rejects(retainedCommand('own-child', [], {
    budget: 1000, phase: 'pipe-error', records, spawnChild: () => child,
    onStart: () => child.stderr.emit('error', Error('owned pipe failed')),
    onExit: () => { ACK++ },
  }), /owned pipe failed/u)
  child.emit('exit', 0, null); child.emit('close', 0, null)
  await Promise.resolve()
  assert.equal(records[0].unknown, true); assert.equal(records[0].unknownOrigin, 'stdio-error')
  assert.equal(records[0].stdioError.stream, 'stderr'); assert.equal(ACK, 0)
})

test('invalid budgets or absent journal are rejected before any child can be spawned', async () => {
  let launched = 0
  const spawnChild = () => { launched++; throw Error('No launch permitted') }
  for (const budget of [undefined, 0, -1, 1.5]) await assert.rejects(retainedCommand('own-child', [], {
    budget, phase: 'invalid-before-start', records: [], spawnChild,
  }), /Invalid fixed wait budget/u)
  await assert.rejects(retainedCommand('own-child', [], { budget: 10, spawnChild }), /explicit own-command journal/u)
  assert.equal(launched, 0)
})
