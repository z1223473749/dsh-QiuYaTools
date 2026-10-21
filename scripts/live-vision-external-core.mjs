/** Test-only private rendezvous. No GUI, permission changes or arbitrary IPC operations. */
import { open, lstat, realpath, link, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export const visionDigest = bytes => createHash('sha256').update(bytes).digest('hex')
export const visionExternalFailure = code => { throw Object.assign(new Error(code), { code }) }
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value)
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
export function sameExternalIdentity(a, b) {
  return !!a && !!b && a.pid === b.pid && a.startSeconds === b.startSeconds && a.startMicroseconds === b.startMicroseconds && a.executablePath === b.executablePath
}
export async function sameExternalExecutable(a, b) {
  // Foundation/proc_pidpath can publish /tmp while Node realpath publishes
  // /private/tmp. Compare filesystem objects here without changing the raw
  // identity passed back to the Swift observer's strict expected(...) oracle.
  if (typeof a !== 'string' || typeof b !== 'string' || !isAbsolute(a) || !isAbsolute(b)) return false
  try { return await realpath(a) === await realpath(b) } catch { return false }
}
export function externalIdentityRetired(current, pinned) {
  // A different executable with the same PID/birth is not proof of exit. The
  // read-only observer returns null only for ESRCH, never for permission errors.
  return current === null || !!current && current.pid === pinned.pid &&
    (current.startSeconds !== pinned.startSeconds || current.startMicroseconds !== pinned.startMicroseconds)
}
export function validateExternalConfig(value) {
  if (!value || value.version !== 1 || !uuid(value.runId) || !sha(value.rendezvousNonce) ||
      !['directory', 'native', 'oracle', 'carrier'].every(key => typeof value[key] === 'string' && isAbsolute(value[key]) && resolve(value[key]) === value[key]) ||
      !['nativeSha256', 'oracleSha256', 'fixtureSha256', 'carrierSha256'].every(key => sha(value[key])) ||
      !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now() || value.expiresAt > Date.now() + 20 * 60_000) visionExternalFailure('VISION_EXTERNAL_CONFIG')
  return value
}
export function externalFile(config, task, kind) {
  if (![1, 2, 3].includes(task) || !['request', 'ready', 'stop', 'cleanup'].includes(kind)) visionExternalFailure('VISION_EXTERNAL_BINDING')
  return join(config.directory, 'external', `task-${task}-${kind}.json`)
}
export async function checkPrivateDirectory(path) {
  if (process.platform !== 'darwin' || typeof process.getuid !== 'function') visionExternalFailure('VISION_MAC_REQUIRED')
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0 || await realpath(path) !== resolve(path)) visionExternalFailure('VISION_EXTERNAL_FILE_BOUNDARY')
}
export async function readPrivateJSON(path) {
  await checkPrivateDirectory(dirname(path))
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.uid !== process.getuid() || (before.mode & 0o077) !== 0 || before.size > 65536) visionExternalFailure('VISION_EXTERNAL_FILE_BOUNDARY')
    const data = Buffer.alloc(65537); let bytesRead = 0
    while (bytesRead < data.length) {
      const part = await handle.read(data, bytesRead, data.length - bytesRead, bytesRead)
      if (!part.bytesRead) break
      bytesRead += part.bytesRead
    }
    const after = await handle.stat()
    if (bytesRead > 65536 || before.size !== bytesRead || after.size !== before.size || after.mtimeMs !== before.mtimeMs) visionExternalFailure('VISION_EXTERNAL_FILE_BOUNDARY')
    return JSON.parse(data.subarray(0, bytesRead).toString('utf8'))
  } finally { await handle.close() }
}
export async function writePrivateJSON(path, value) {
  await checkPrivateDirectory(dirname(path))
  const bytes = Buffer.from(JSON.stringify(value)), temporary = join(dirname(path), `.write-${randomUUID()}.json`)
  if (bytes.length > 65536) visionExternalFailure('VISION_EXTERNAL_FILE_BOUNDARY')
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  // Each protocol filename is consumed once. Never replace an uncertain prior
  // request/reply or follow a caller-provided leaf path.
  try {
    if (await lstat(path).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error))) visionExternalFailure('VISION_EXTERNAL_REPLAY')
    await link(temporary, path)
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}
export async function removePrivateJSON(path) {
  try { await readPrivateJSON(path); await unlink(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
}
export function validateExternalRequest(value, config, task) {
  const expected = join(config.directory, 'runtime', `${value?.sessionId}.app`, 'Contents/MacOS/fixture')
  if (![1, 2, 3].includes(task) || !value || value.version !== 1 || value.runId !== config.runId || value.rendezvousNonce !== config.rendezvousNonce || value.task !== task ||
      !uuid(value.requestId) || typeof value.sessionId !== 'string' || !value.sessionId.startsWith('qiuya-vision-') || !uuid(value.sessionId.slice('qiuya-vision-'.length)) ||
      typeof value.bundleId !== 'string' || !value.bundleId.startsWith('com.qiuya.tools.vision-') || !uuid(value.bundleId.slice('com.qiuya.tools.vision-'.length)) ||
      !Number.isSafeInteger(value.pid) || value.pid <= 1 || !Number.isSafeInteger(value.parentPid) || value.parentPid <= 1 ||
      !Number.isSafeInteger(value.windowId) || value.windowId <= 0 || value.executablePath !== expected || value.fixtureSha256 !== config.fixtureSha256 ||
      value.nativeSha256 !== config.nativeSha256) visionExternalFailure('VISION_EXTERNAL_BINDING')
  return value
}
export function validateExternalBinding(value, request, config) {
  if (!value || value.version !== 1 || value.runId !== config.runId || value.rendezvousNonce !== config.rendezvousNonce ||
      value.requestId !== request.requestId || value.sessionId !== request.sessionId || value.task !== request.task) visionExternalFailure('VISION_EXTERNAL_BINDING')
  return value
}
export function externalCleanupPassed(value) {
  return value?.passed === true && Array.isArray(value.errors) && value.errors.length === 0 && value.nativeNaturalExit === true && value.forced === false
}
export async function verifyExternalFixture(request, config, { identity, fileHash, targets, pinned, executableEquals = sameExternalExecutable }) {
  validateExternalRequest(request, config, request.task)
  const current = await identity(request.pid)
  if (!current || current.pid !== request.pid || current.parentPid !== request.parentPid || !await executableEquals(current.executablePath, request.executablePath) ||
      typeof current.startSeconds !== 'string' || typeof current.startMicroseconds !== 'string' || pinned && !sameExternalIdentity(current, pinned) ||
      await fileHash(current.executablePath) !== config.fixtureSha256) visionExternalFailure('VISION_EXTERNAL_FIXTURE_CHANGED')
  const target = (await targets()).find(row => row.id === `mac-window:${request.windowId}`)
  if (!target || target.pid !== current.pid || target.appId !== request.bundleId) visionExternalFailure('VISION_EXTERNAL_FIXTURE_CHANGED')
  return { identity: current, target }
}
