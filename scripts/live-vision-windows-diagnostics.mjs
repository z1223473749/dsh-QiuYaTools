/** Test-carrier diagnostics: finite stages and digests only; never log commands or raw errors. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, lstat, link, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { checkPrivateDirectory, visionExternalFailure } from './live-vision-external-core.mjs'

const digest = value => {
 const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : '')
 return { available: typeof value === 'string' || Buffer.isBuffer(value), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}
const systemCodes = new Set(['EPERM','EACCES','ENOENT','ENOTDIR','EIO','EINVAL','ENOMEM','ENOBUFS','EADDRINUSE','EADDRNOTAVAIL','ECONNREFUSED','ECONNRESET','EPIPE','ETIMEDOUT','EHOSTUNREACH','ENETUNREACH','ABORT_ERR','ERR_SERVER_ALREADY_LISTEN','ERR_SOCKET_BAD_PORT','ERR_CHILD_PROCESS_STDIO_MAXBUFFER'])
const safeCode = code => typeof code === 'string' && (systemCodes.has(code) || /^VISION_[A-Z0-9_]{1,100}$/u.test(code)) ? code : null
const label = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,79}$/u.test(value)

// Observational logs stay awaited and atomic. Protocol receipts retain their
// durable writePrivateJSON barrier; diagnostics do not add a per-event fsync.
async function writeDiagnosticReceipt(path, value) {
 if (!/^windows-carrier-stage-\d{4}\.json$/u.test(basename(path))) visionExternalFailure('VISION_WINDOWS_DIAGNOSTIC_STAGE')
 await checkPrivateDirectory(dirname(path))
 const bytes = Buffer.from(JSON.stringify(value)), temporary = join(dirname(path), `.diagnostic-${randomUUID()}.json`)
 if (bytes.length > 65536) visionExternalFailure('VISION_EXTERNAL_FILE_BOUNDARY')
 const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
 try {
  try { await handle.writeFile(bytes) } finally { await handle.close() }
  if (await lstat(path).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error))) visionExternalFailure('VISION_EXTERNAL_REPLAY')
  await link(temporary, path)
 } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}


/** Decode only finite PowerShell Error strings for enum projection, never persist text. */
export function projectPowerShellFailure(stderr) {
 const original=Buffer.isBuffer(stderr)?stderr.toString('utf8'):typeof stderr==='string'?stderr:'';
 const clipped=original.slice(0,65536);
 const text=clipped.replace(/_x([a-f\d]{4})_/giu,(_,hex)=>String.fromCharCode(parseInt(hex,16))).replace(/&lt;/gu,'<').replace(/&gt;/gu,'>').replace(/&quot;/gu,'"').replace(/&apos;/gu,"'").replace(/&amp;/gu,'&').replace(/<[^>]{0,4096}>/gu,' ');
 const reasons=[['fresh-own-root-exists','Fresh own root exists'],['node-sha-mismatch','Node SHA mismatch'],['own-command-sha-mismatch','Own command SHA mismatch'],['transfer-integrity-failed','Transfer integrity failed'],['node-archive-sha-mismatch','Node archive SHA mismatch'],['node-executable-sha-mismatch','Node executable SHA mismatch'],['fresh-own-node-folder-exists','Fresh own Node folder exists'],['node-archive-entry-limit','Node archive entry limit'],['node-archive-path-binding','Node archive path binding'],['own-task-principal-changed','Own task principal changed'],['own-task-action-changed','Own task action changed'],['own-task-not-natural','Own task did not finish naturally'],['own-task-changed-before-unregister','Own task changed before unregister'],['own-task-still-registered','Own task still registered'],['own-cleanup-source-changed','Own cleanup source changed'],['own-task-terminal-unknown','Own task terminal state unknown']];
 const staticReason=reasons.find(([,message])=>text.includes(message))?.[0]??null;
 const kinds=[['parser',/ParserError|ParseException|UnexpectedToken|MissingEndCurlyBrace|MissingEndParenthesis/iu],['command-not-found',/CommandNotFoundException|CommandNotFound/iu],['access-denied',/UnauthorizedAccessException|PermissionDenied|AccessDenied/iu],['item-not-found',/ItemNotFoundException|PathNotFound|FileNotFoundException|DirectoryNotFoundException|DriveNotFoundException/iu],['download-or-network',/WebException|DownloadFile|ConnectFailure|NameResolutionFailure/iu]];
 const category=kinds.find(([,pattern])=>pattern.test(text))?.[0]??null;
 const position=/At line:(\d{1,7}) char:(\d{1,7})/u.exec(text);
 const types=['ParseException','CommandNotFoundException','UnauthorizedAccessException','ItemNotFoundException','FileNotFoundException','DirectoryNotFoundException','DriveNotFoundException','WebException'];
 return {category,staticReason,exceptionType:types.find(type=>text.includes(type))??null,position:position?{line:Number(position[1]),column:Number(position[2])}:null,projectionInputTruncated:original.length>clipped.length};
}

export function projectWindowsCarrierError(error) {
 const code = safeCode(error?.code), exitCode = Number.isSafeInteger(error?.code) ? error.code : null
 const signal = typeof error?.signal === 'string' && /^SIG[A-Z0-9]{1,12}$/u.test(error.signal) ? error.signal : null
 const stderr = typeof error?.stderr === 'string' ? error.stderr : Buffer.isBuffer(error?.stderr) ? error.stderr.toString('utf8') : ''
 const powershell=projectPowerShellFailure(stderr),powershellCategory=powershell.category
 return {
  category: exitCode !== null ? 'process-exit' : code?.startsWith('VISION_') ? 'policy' : code ? 'node-system' : signal ? 'process-signal' : 'unclassified',
  code, exitCode, signal, killed: error?.killed === true, powershellCategory, powershell,
  unknownCode: code === null && typeof error?.code === 'string' ? digest(error.code) : null,
  message: digest(error?.message), stdout: digest(error?.stdout), stderr: digest(error?.stderr)
 }
}

export function createWindowsCarrierDiagnostics({ runId, evidence, writeReceipt = writeDiagnosticReceipt, now = Date.now }) {
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
