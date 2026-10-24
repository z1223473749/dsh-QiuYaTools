/** Acceptance-only receipts; no automatic input, retries, timeout signals or fabricated ACK. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
const hash = value => createHash('sha256').update(value).digest('hex')

export function detachRetainedChild(child) {
  child.unref()
  for (const stream of [child.stdout, child.stderr]) {
    assert.equal(typeof stream?.unref, 'function', 'Retained pipe must support unref without closing or signalling')
    stream.unref()
  }
}

/** The original child must exit AND close its stdio before normal acknowledgement. */
export async function retainedCommand(exe, argv, {
  budget, phase, records, onStart = async () => {}, onExit = async () => {},
  onTimeout = async () => {}, onLateExit = async () => {}, spawnChild = spawn,
  sourceScriptSHA256 = null,
} = {}) {
  assert(Number.isSafeInteger(budget) && budget > 0, 'Invalid fixed wait budget')
  assert(Array.isArray(records), 'An explicit own-command journal is required')
  const startedMono = performance.now(), deadline = startedMono + budget
  const child = spawnChild(exe, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
  const row = {
    phase, spawnNonce: randomUUID(), hostParentPID: process.pid, pid: child.pid,
    executable: exe, argvSHA256: hash(Buffer.from(JSON.stringify(argv))), sourceScriptSHA256,
    startedAt: new Date().toISOString(), code: null, signal: null, natural: false, forced: false,
  }
  records.push(row)
  const capture = limit => ({ limit, bytes: 0, retained: 0, chunks: [], digest: createHash('sha256') })
  const stdout = capture(32 * 1024 * 1024), stderr = capture(8192)
  const collect = (target, value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
    target.bytes += bytes.length; target.digest.update(bytes)
    const remaining = target.limit - target.retained
    if (remaining > 0) { const part = bytes.subarray(0, remaining); target.chunks.push(part); target.retained += part.length }
  }
  child.stdout.on('data', value => collect(stdout, value))
  child.stderr.on('data', value => collect(stderr, value))
  const text = target => Buffer.concat(target.chunks, target.retained).toString('utf8')
  const snapshot = () => ({ code: row.code, signal: row.signal, stdout: text(stdout), stderr: text(stderr) })
  const snapshotHashes = () => {
    for (const [key, value] of [['stdout', stdout], ['stderr', stderr]]) {
      row[key + 'Bytes'] = value.bytes
      row[key + 'CapturedBytes'] = value.retained
      row[key + 'Truncated'] = value.bytes > value.retained
      row[key + 'SHA256'] = value.digest.copy().digest('hex')
    }
  }
  let startAccepted = false, exited = false, closed = false, settled = false, lateIssued = false, timer
  let resolveCompletion, rejectCompletion
  const completion = new Promise((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject })
  const elapsed = () => Math.round((performance.now() - startedMono) * 1000) / 1000
  const late = () => {
    if (!row.unknown || !exited || !closed || lateIssued) return
    lateIssued = true
    void Promise.resolve().then(() => onLateExit(row, snapshot())).catch(error => {
      row.lateExitEvidenceError = String(error?.message ?? error).slice(0, 2048)
    })
  }
  const rejectUnknown = (error, origin) => {
    if (settled) return
    settled = true; clearTimeout(timer)
    row.unknown = true; row.retained = true; row.unknownOrigin = origin
    row.unknownAt = new Date().toISOString(); row.unknownElapsedMs = elapsed()
    try { detachRetainedChild(child); row.localHandlesUnrefWithoutClose = true }
    catch (detachError) { row.detachEvidenceError = String(detachError?.message ?? detachError).slice(0, 2048) }
    snapshotHashes()
    const journal = origin === 'deadline'
      ? Promise.resolve().then(() => onTimeout(row, { ...snapshot(), code: null, signal: null }))
      : Promise.resolve()
    void journal.then(() => rejectCompletion(error), journalError => {
      row.timeoutEvidenceError = String(journalError?.message ?? journalError).slice(0, 2048)
      rejectCompletion(error)
    })
    late()
  }
  const expire = () => {
    const remaining = deadline - performance.now()
    if (remaining > 0) { timer = setTimeout(expire, Math.max(1, Math.ceil(remaining))); return }
    rejectUnknown(new Error(`${phase} exceeded its fixed ${budget}ms budget; retained without signal or replay`), 'deadline')
  }
  const complete = () => {
    if (settled) { late(); return }
    if (performance.now() >= deadline) { expire(); return }
    if (!startAccepted || !exited || !closed) return
    settled = true; clearTimeout(timer)
    row.acknowledgementReadyElapsedMs = elapsed()
    resolveCompletion(snapshot())
  }
  // Bind all real-child terminal paths and the absolute deadline before invoking any callback.
  child.once('error', error => {
    row.spawnError = String(error?.message ?? error).slice(0, 2048)
    rejectUnknown(error, 'child-error')
  })
  child.once('exit', (code, signal) => {
    exited = true; Object.assign(row, { code, signal, natural: !signal,
      exitedAt: new Date().toISOString(), exitElapsedMs: elapsed() })
    complete()
  })
  child.once('close', (code, signal) => {
    closed = true; Object.assign(row, { stdioClosed: true, closedAt: new Date().toISOString(), closeElapsedMs: elapsed() })
    if (exited && (row.code !== code || row.signal !== signal)) {
      rejectUnknown(Error('Original child exit/close status changed; no acknowledgement'), 'terminal-status')
    }
    if (exited) { row.finishedAt = row.closedAt; row.elapsedMs = row.closeElapsedMs }
    snapshotHashes(); complete()
  })
  for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
    stream.once('error', error => {
      row.stdioError = { stream: name, error: String(error?.message ?? error).slice(0, 2048) }
      rejectUnknown(error, 'stdio-error')
    })
  }
  timer = setTimeout(expire, Math.max(0, deadline - performance.now()))
  void Promise.resolve().then(() => {
    if (settled) return
    if (performance.now() >= deadline) { expire(); return }
    return onStart(row)
  }).then(() => { startAccepted = true; complete() }, error => rejectUnknown(error, 'on-start'))
  const result = await completion
  await onExit(row, result)
  return result
}

/** Acceptance-only transport diagnostics. No input execution, retries, or fabricated acknowledgement. */
export function coordinatorFailure(error){return{ok:false,error:String(error?.message??error).slice(0,2048),kind:'coordinator-rejected-or-unknown',noAcknowledgement:true}}
export async function readCoordinatorResponse(response,{operation}){
 if(typeof operation!=='string'||!/^[-a-z]+$/.test(operation))throw Error('Invalid fixed coordinator operation');
 let bytes=0,parts=[];if(response.body){const reader=response.body.getReader();for(;;){const r=await reader.read();if(r.done)break;bytes+=r.value.byteLength;if(bytes>65536){await reader.cancel();throw Error('Coordinator '+operation+' response exceeds65536 bytes; no acknowledgement accepted')}parts.push(r.value)}}
 const all=new Uint8Array(bytes);let at=0;for(const p of parts){all.set(p,at);at+=p.byteLength}const text=new TextDecoder('utf-8',{fatal:true}).decode(all);let body;
 try{body=JSON.parse(text)}catch{const error=Error('Coordinator '+operation+' HTTP'+response.status+': '+(bytes===0?'empty response':'invalid JSON response')+'; no acknowledgement accepted');error.coordinatorReceipt={operation,status:response.status,bytes,kind:'unreadable-response',acknowledgementAccepted:false};throw error}
 if(!response.ok||!body||body.ok!==true||!Object.hasOwn(body,'result')){const message=typeof body?.error==='string'?body.error.slice(0,2048):'Coordinator rejected operation';const error=Error('Coordinator '+operation+' HTTP'+response.status+': '+message);error.coordinatorReceipt={operation,status:response.status,bytes,kind:typeof body?.kind==='string'?body.kind:'rejected-response',noAcknowledgement:body?.noAcknowledgement===true,acknowledgementAccepted:false};throw error}
 return body.result;
}
