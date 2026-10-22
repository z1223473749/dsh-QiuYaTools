/** Independent, read-only evidence for one nonce TXT in an own fresh profile. */
import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
export async function readOwnHarnessPastedText({ profileHome, operation, name, expectedSHA256, expectedBytes }) {
  assert.ok(typeof profileHome === 'string' && resolve(profileHome) === profileHome && basename(profileHome) === 'qiuya-harness-home' && /^qiuya-harness-e2e-[A-Za-z0-9]{6}$/u.test(basename(dirname(profileHome))), 'The exact own fresh profile is required')
  assert.ok(['before', 'after'].includes(operation) && /^[a-f0-9]{64}$/u.test(expectedSHA256) && Number.isSafeInteger(expectedBytes) && expectedBytes > 0 && expectedBytes <= 4096, 'Invalid own nonce-file binding')
  const root = await lstat(profileHome); assert.ok(root.isDirectory() && !root.isSymbolicLink() && await realpath(profileHome) === profileHome, 'Own profile must be a canonical direct directory')
  const parts = ['attachments', 'v1', 'files', expectedSHA256.slice(0, 2), expectedSHA256], bucket = join(profileHome, ...parts)
  const check = async (allowMissing = false) => {
    let path = profileHome
    for (const part of parts) {
      path = join(path, part)
      let state
      try { state = await lstat(path) } catch (error) { if (allowMissing && error.code === 'ENOENT') return false; throw error }
      assert.ok(state.isDirectory() && !state.isSymbolicLink() && await realpath(path) === path, 'Stored-file components must be canonical direct directories')
    }
    return true
  }
  if (operation === 'before') { assert.equal(await check(true), false, 'This nonce attachment must not exist before the single paste'); return { operation, profileBound: true, nonceBucketAbsent: true, readOnly: true } }
  assert.ok(/^粘贴文本-\d{8}-\d{6}-[a-f0-9]{8}\.txt$/u.test(name ?? ''), 'Invalid observed official TXT filename')
  await check(); assert.deepEqual(await readdir(bucket), [name], 'The nonce bucket must contain exactly the observed TXT')
  const path = join(bucket, name), before = await lstat(path)
  assert.ok(path.startsWith(profileHome + sep) && before.isFile() && !before.isSymbolicLink() && before.nlink >= 1 && before.size === expectedBytes, 'Own TXT must be one direct regular file')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const state = await file.stat(); assert.ok(state.isFile() && state.dev === before.dev && state.ino === before.ino && state.nlink === before.nlink && state.size === expectedBytes, 'Opened TXT identity changed')
    const hash = createHash('sha256'), buffer = Buffer.alloc(4096); let bytes = 0
    for (;;) { const read = await file.read(buffer, 0, buffer.length, null); if (!read.bytesRead) break; bytes += read.bytesRead; assert.ok(bytes <= expectedBytes, 'Own TXT grew during read'); hash.update(buffer.subarray(0, read.bytesRead)) }
    const sha256 = hash.digest('hex'), after = await file.stat(), leaf = await lstat(path), currentRoot = await lstat(profileHome)
    await check(); assert.deepEqual(await readdir(bucket), [name])
    assert.ok(after.dev === state.dev && after.ino === state.ino && after.nlink === state.nlink && after.size === state.size && after.mtimeMs === state.mtimeMs && after.ctimeMs === state.ctimeMs && leaf.dev === state.dev && leaf.ino === state.ino && !leaf.isSymbolicLink() && currentRoot.dev === root.dev && currentRoot.ino === root.ino && !currentRoot.isSymbolicLink(), 'Own TXT/profile identity changed during read')
    assert.equal(bytes, expectedBytes); assert.equal(sha256, expectedSHA256, 'Actual stored TXT hash differs from original payload')
    return { operation, name, bytes, sha256, storedBytesVerified: true, profileBound: true, uniqueFile: true, reparseRejected: true, linkCount: state.nlink, handleIdentityVerified: true, readOnly: true, source: 'independent-own-file-handle' }
  } finally { await file.close() }
}
