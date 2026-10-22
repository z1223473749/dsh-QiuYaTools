/** Test-carrier diagnostics: finite stages and digests only; never log commands or raw errors. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { writePrivateJSON } from './live-vision-external-core.mjs'

const digest = value => {
 const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : '')
 return { available: typeof value === 'string' || Buffer.isBuffer(value), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}
const systemCodes = new Set(['EPERM','EACCES','ENOENT','ENOTDIR','EIO','EINVAL','ENOMEM','ENOBUFS','EADDRINUSE','EADDRNOTAVAIL','ECONNREFUSED','ECONNRESET','EPIPE','ETIMEDOUT','EHOSTUNREACH','ENETUNREACH','ABORT_ERR','ERR_SERVER_ALREADY_LISTEN','ERR_SOCKET_BAD_PORT','ERR_CHILD_PROCESS_STDIO_MAXBUFFER'])
const safeCode = code => typeof code === 'string' && (systemCodes.has(code) || /^VISION_[A-Z0-9_]{1,100}$/u.test(code)) ? code : null
const label = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,79}$/u.test(value)

export function projectWindowsCarrierError(error) {
 const code = safeCode(error?.code), exitCode = Number.isSafeInteger(error?.code) ? error.code : null
 const signal = typeof error?.signal === 'string' && /^SIG[A-Z0-9]{1,12}$/u.test(error.signal) ? error.signal : null
 const stderr = typeof error?.stderr === 'string' ? error.stderr : Buffer.isBuffer(error?.stderr) ? error.stderr.toString('utf8') : ''
 let powershellCategory = null
 if (/ParserError|ParseException|UnexpectedToken|MissingEndCurlyBrace|MissingEndParenthesis/iu.test(stderr)) powershellCategory = 'parser'
 else if (/CommandNotFoundException|CommandNotFound/iu.test(stderr)) powershellCategory = 'command-not-found'
 else if (/UnauthorizedAccessException|PermissionDenied|AccessDenied/iu.test(stderr)) powershellCategory = 'access-denied'
 else if (/WebException|DownloadFile|ConnectFailure|NameResolutionFailure/iu.test(stderr)) powershellCategory = 'download-or-network'
 return {
  category: exitCode !== null ? 'process-exit' : code?.startsWith('VISION_') ? 'policy' : code ? 'node-system' : signal ? 'process-signal' : 'unclassified',
  code, exitCode, signal, killed: error?.killed === true, powershellCategory,
  unknownCode: code === null && typeof error?.code === 'string' ? digest(error.code) : null,
  message: digest(error?.message), stdout: digest(error?.stdout), stderr: digest(error?.stderr)
 }
}

export function createWindowsCarrierDiagnostics({ runId, evidence, writeReceipt = writePrivateJSON, now = Date.now }) {
 let sequence = 0, currentStage = 'initialization'
 const failures = new WeakMap()
 const persist = async value => {
  if (++sequence > 2048) throw Object.assign(Error('Diagnostic receipt limit'), { code: 'VISION_WINDOWS_DIAGNOSTIC_LIMIT' })
  const receipt = { version: 1, runId, sequence, at: now(), ...value }
  await writeReceipt(join(evidence, `windows-carrier-stage-${String(sequence).padStart(4,'0')}.json`), receipt)
  return receipt
 }
 const remember = (error, value) => { if (error && typeof error === 'object' && !failures.has(error)) failures.set(error, value) }
 const stage = async (name, work) => {
  if (!label(name)) throw Object.assign(Error('Invalid diagnostic stage'), { code: 'VISION_WINDOWS_DIAGNOSTIC_STAGE' })
  const previous = currentStage; currentStage = name
  const started = await persist({ kind: 'stage', stage: name, phase: 'started' })
  try {
   const result = await work()
   await persist({ kind: 'stage', stage: name, phase: 'completed', startedSequence: started.sequence, elapsedMs: now()-started.at })
   return result
  } catch (error) {
   const failure = { stage: name, error: projectWindowsCarrierError(error) }
   remember(error, failure)
   try { await persist({ kind: 'stage', ...failure, phase: 'failed', startedSequence: started.sequence, elapsedMs: now()-started.at }) }
   catch (receiptError) { if(error && typeof error === 'object') failures.set(error,{...failures.get(error),receiptError:projectWindowsCarrierError(receiptError)}) }
   throw error
  } finally { currentStage = previous }
 }
 const command = async (kind, execute) => {
  if (!label(kind)) throw Object.assign(Error('Invalid diagnostic command'), { code: 'VISION_WINDOWS_DIAGNOSTIC_STAGE' })
  const stageName = currentStage, started = await persist({ kind: 'command', stage: stageName, command: kind, phase: 'started' })
  try {
   const result = await execute()
   await persist({ kind: 'command', stage: stageName, command: kind, phase: 'completed', startedSequence: started.sequence, elapsedMs: now()-started.at, exitCode: 0, stdout: digest(result.stdout), stderr: digest(result.stderr) })
   return result
  } catch (error) {
   const failure = { stage: stageName, command: kind, error: projectWindowsCarrierError(error) }
   remember(error, failure)
   try { await persist({ kind: 'command', ...failure, phase: 'failed', startedSequence: started.sequence, elapsedMs: now()-started.at }) }
   catch (receiptError) { if(error && typeof error === 'object') failures.set(error,{...failure,receiptError:projectWindowsCarrierError(receiptError)}) }
   throw error
  }
 }
 return { stage, command, failure: error => failures.get(error) ?? { stage: currentStage, error: projectWindowsCarrierError(error) } }
}
