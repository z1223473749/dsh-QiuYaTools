import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const digest = value => createHash('sha256').update(value).digest('hex')
const RECEIPT_VERSION = 1

/** Only hashes are persisted; source contents and signing identities stay local. */
export async function macOSComputerInputFingerprint(files, settings) {
  const inputs = await Promise.all(files.map(async file => ({ file, sha256: digest(await readFile(file)) })))
  return digest(JSON.stringify({ inputs, settings }))
}

/** Include the entire sealed bundle, executable bits and unexpected added files. */
export async function macOSComputerApplicationDigest(application) {
  if (!(await lstat(application)).isDirectory()) throw new Error('The Mac companion must be a real application directory')
  const entries = []
  async function visit(directory, prefix = '') {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name), file = prefix + name, info = await lstat(path)
      if (info.isDirectory()) { entries.push({ file: file + '/', mode: info.mode & 0o777 }); await visit(path, file + '/') }
      else if (info.isFile()) entries.push({ file, mode: info.mode & 0o777, sha256: digest(await readFile(path)) })
      else throw new Error('The Mac companion contains an unsupported filesystem entry')
    }
  }
  await visit(application)
  return digest(JSON.stringify(entries))
}

export async function canReuseMacOSComputer({ receiptPath, application, fingerprint, verifySignature }) {
  try {
    const raw = await readFile(receiptPath, 'utf8')
    if (raw.length > 16 * 1024) return false
    const receipt = JSON.parse(raw)
    if (receipt.version !== RECEIPT_VERSION || receipt.application !== application || receipt.fingerprint !== fingerprint
      || typeof receipt.applicationDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(receipt.applicationDigest)) return false
    if (await macOSComputerApplicationDigest(application) !== receipt.applicationDigest) return false
    await verifySignature()
    return await macOSComputerApplicationDigest(application) === receipt.applicationDigest
  } catch { return false }
}

/** The receipt lives outside the app, so writing it cannot invalidate its seal. */
export async function recordMacOSComputerBuild({ receiptPath, application, fingerprint }) {
  const receipt = { version: RECEIPT_VERSION, application, fingerprint, applicationDigest: await macOSComputerApplicationDigest(application) }
  await mkdir(dirname(receiptPath), { recursive: true })
  const temporary = receiptPath + '.' + randomBytes(8).toString('hex') + '.tmp'
  try {
    await writeFile(temporary, JSON.stringify(receipt) + '\n', { mode: 0o600 })
    await rename(temporary, receiptPath)
  } finally { await rm(temporary, { force: true }) }
}
