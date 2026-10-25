import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink, link, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readOwnHarnessPastedText } from '../scripts/harness-pasted-text-evidence.mjs'
const bytes = Buffer.from('E2E nonce\r\n保留原始文本。🙂\n'), sha256 = createHash('sha256').update(bytes).digest('hex'), name = '粘贴文本-20261022-191000-1234abcd.txt'
async function fixture(operation) {
  const own = await mkdtemp(join(tmpdir(), 'qiuya-harness-e2e-'))
  try { const profileHome = join(own, 'qiuya-harness-home'); await mkdir(profileHome); await operation({ own, profileHome: await realpath(profileHome) }) }
  finally { await rm(own, { recursive: true, force: true }) }
}
const input = profileHome => ({ profileHome, expectedSHA256: sha256, expectedBytes: bytes.length, name })
const bucket = profileHome => join(profileHome, 'attachments/v1/files', sha256.slice(0, 2), sha256)
async function store(profileHome, value = bytes) { await mkdir(bucket(profileHome), { recursive: true }); await writeFile(join(bucket(profileHome), name), value) }

test('one nonce is absent before paste and independently read as exact stored UTF8 bytes afterward', () => fixture(async ({ profileHome }) => {
  assert.deepEqual(await readOwnHarnessPastedText({ ...input(profileHome), operation: 'before' }), { operation: 'before', profileBound: true, nonceBucketAbsent: true, readOnly: true })
  await store(profileHome)
  const value = await readOwnHarnessPastedText({ ...input(profileHome), operation: 'after' })
  assert.deepEqual(value, { operation: 'after', name, bytes: bytes.length, sha256, storedBytesVerified: true, profileBound: true, uniqueFile: true, reparseRejected: true, linkCount: 1, handleIdentityVerified: true, readOnly: true, source: 'independent-own-file-handle' })
  assert.doesNotMatch(JSON.stringify(value), /保留原始|E2E nonce|receiptId|token|profileHome/u)
  await assert.rejects(readOwnHarnessPastedText({ ...input(profileHome), operation: 'before' }))
}))
test('actual bytes must match, even when the bucket is named with the pre-known expected digest', () => fixture(async ({ profileHome }) => {
  await store(profileHome, Buffer.alloc(bytes.length))
  await assert.rejects(readOwnHarnessPastedText({ ...input(profileHome), operation: 'after' }), /hash differs/u)
  await store(profileHome, Buffer.concat([bytes, Buffer.from('extra')]))
  await assert.rejects(readOwnHarnessPastedText({ ...input(profileHome), operation: 'after' }))
}))
test('noncanonical roots, escaped filenames and extra leaves cannot be accepted while immutable hardlinks remain valid', () => fixture(async ({ own, profileHome }) => {
  await store(profileHome)
  await assert.rejects(readOwnHarnessPastedText({ ...input(profileHome), profileHome: profileHome + '/.', operation: 'after' }))
  await assert.rejects(readOwnHarnessPastedText({ ...input(profileHome), name: '../outside.txt', operation: 'after' }))
  await writeFile(join(bucket(profileHome), 'extra.txt'), bytes)
  await assert.rejects(readOwnHarnessPastedText({ ...input(profileHome), operation: 'after' }))
  await rm(join(bucket(profileHome), 'extra.txt'))
  const duplicate = join(own, 'duplicate.txt'); await link(join(bucket(profileHome), name), duplicate)
  const linked = await readOwnHarnessPastedText({ ...input(profileHome), operation: 'after' }); assert.equal(linked.linkCount, 2); assert.equal(linked.sha256, sha256)
}))
test('a linked bucket or leaf is refused instead of following a matching outside file', () => fixture(async ({ own, profileHome }) => {
  const outside = join(own, 'outside'); await mkdir(outside); await writeFile(join(outside, name), bytes)
  await mkdir(join(profileHome, 'attachments/v1/files', sha256.slice(0, 2)), { recursive: true }); await symlink(outside, bucket(profileHome), 'dir')
  await assert.rejects(readOwnHarnessPastedText({ ...input(profileHome), operation: 'after' }))
  await rm(bucket(profileHome)); await mkdir(bucket(profileHome)); await symlink(join(outside, name), join(bucket(profileHome), name))
  await assert.rejects(readOwnHarnessPastedText({ ...input(profileHome), operation: 'after' }))
}))
test('Windows oracle is ASCII-safe for PowerShell5.1 and both immutable transports include its source', async () => {
  const source = await readFile(new URL('./fixtures/harness-pasted-file-windows.ps1', import.meta.url), 'utf8')
  assert.ok([...source].every(character => character.charCodeAt(0) < 128))
  for (const n of ['ReparsePoint', 'GetFinalPathNameByHandle', 'GetFileInformationByHandle', 'ComputeHash', 'CreateFileW', 'System.IO.FileStream']) assert.ok(source.includes(n))
  for (const file of ['../scripts/e2e-windows-harness-pd.mjs', '../scripts/prepare-windows-test-runtime.mjs']) assert.ok((await readFile(new URL(file, import.meta.url), 'utf8')).includes('harness-pasted-file-windows.ps1'))
})
