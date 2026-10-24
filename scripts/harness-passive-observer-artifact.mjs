/** Deploy the prepared listen-only observer beside the actual bundled provider. Never executes it. */
import assert from 'node:assert/strict'
import { lstat, realpath, writeFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { boundedFile } from './macos-acceptance-files.mjs'

const binaryName = 'harness-passive-input-observer', receiptName = binaryName + '.binding.json'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

export async function stagePassiveObserverForProvider({ sourceDirectory, providerDirectory, expectedSHA256 }) {
  assert(isAbsolute(sourceDirectory) && isAbsolute(providerDirectory))
  assert.match(expectedSHA256, /^[a-f\d]{64}$/u)
  assert.notEqual(expectedSHA256, '0'.repeat(64), 'Prepared observer digest is required')
  for (const directory of [sourceDirectory, providerDirectory]) {
    const info = await lstat(directory)
    assert(info.isDirectory() && !info.isSymbolicLink(), 'Owned observer directory required')
    assert.equal(info.uid, process.getuid(), 'Observer directory owner changed')
  }
  sourceDirectory = await realpath(sourceDirectory)
  providerDirectory = await realpath(providerDirectory)
  assert.notEqual(sourceDirectory, providerDirectory, 'Bundle deployment must use its own directory')
  const source = join(sourceDirectory, binaryName), destination = join(providerDirectory, binaryName)
  const receiptBytes = await boundedFile(join(sourceDirectory, receiptName), 65536, { singleLink: true, own: true })
  const receipt = JSON.parse(receiptBytes)
  assert.equal(receipt.version, 1)
  assert.equal(receipt.binary?.name, binaryName)
  assert.equal(receipt.binary?.sha256, expectedSHA256)
  assert(Number.isSafeInteger(receipt.binary?.bytes) && receipt.binary.bytes > 0 && receipt.binary.bytes <= 2 * 1024 * 1024)
  assert.equal(receipt.compileOnly, true)
  assert.equal(typeof receipt.actualCompilation, 'boolean')
  assert.equal(receipt.outputExecuted, false)
  for (const key of ['permissionRequests', 'inputCalls', 'signals']) assert.equal(receipt[key], 0)
  const bytes = await boundedFile(source, 2 * 1024 * 1024, { singleLink: true, own: true })
  assert.equal(bytes.length, receipt.binary.bytes)
  assert.equal(hash(bytes), expectedSHA256, 'Prepared observer bytes changed')
  assert((await lstat(source)).mode & 0o111, 'Prepared observer must remain executable')
  // wx and the final bounded nofollow/single-link read preserve the original
  // observer boundary. Neither a stale destination nor an alias is adopted.
  await writeFile(destination, bytes, { flag: 'wx', mode: 0o700 })
  assert.equal(hash(await boundedFile(destination, 2 * 1024 * 1024, { singleLink: true, own: true })), expectedSHA256)
  assert((await lstat(destination)).mode & 0o111, 'Runtime observer must remain executable')
  await writeFile(join(providerDirectory, receiptName), receiptBytes, { flag: 'wx', mode: 0o600 })
  assert.equal(hash(await boundedFile(join(providerDirectory, receiptName), 65536, { singleLink: true, own: true })), hash(receiptBytes))
  return { source, destination, bytes: bytes.length, sha256: expectedSHA256, receiptSHA256: hash(receiptBytes), actualCompilation: receipt.actualCompilation, deployedBeforeHost: true, outputExecuted: false, inputCalls: 0, signals: 0 }
}
