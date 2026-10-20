import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, readdir, realpath, rm, symlink, link, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { build } from 'esbuild'

const source = (await build({ entryPoints: [fileURLToPath(new URL('../src/features/computer-use/exchange.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })).outputFiles[0].text
const { ComputerExchange, EXCHANGE_MAX_BYTES, EXCHANGE_CHUNK_BYTES, exchangeName } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const entries = async directory => (await readdir(directory)).filter(name => !['.qiuya-exchange.lock', '.qiuya-exchange.recovery'].includes(name))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function fixture(t, options = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'qyt-exchange-'))), directory = join(base, 'shared')
  await mkdir(directory)
  const store = await ComputerExchange.create(directory, options)
  t.after(async () => { await store.close(); await rm(base, { recursive: true, force: true }) })
  const run = (request, owner = 'owner-a', signal) => store.run(owner, request, signal)
  const begin = (name, bytes, owner) => run({ action: 'begin', name, size: bytes.length, sha256: sha(bytes) }, owner)
  const upload = async (name, bytes, owner) => {
    const { id } = await begin(name, bytes, owner)
    for (let offset = 0; offset < bytes.length; offset += EXCHANGE_CHUNK_BYTES) await run({ action: 'chunk', id, offset, data: bytes.subarray(offset, offset + EXCHANGE_CHUNK_BYTES).toString('base64') }, owner)
    return run({ action: 'commit', id }, owner)
  }
  return { base, directory, store, run, begin, upload }
}

test('real filesystem binary/Unicode/CRLF exchange is bounded, versioned and never exposes a directory path', async t => {
  const f = await fixture(t), bytes = Buffer.concat([Buffer.from('中文🙂\r\n'), Buffer.alloc(EXCHANGE_CHUNK_BYTES * 2 + 19, 0xab)])
  const uploaded = await f.upload('中文🙂.bin', bytes)
  assert.equal(uploaded.done, true); assert.equal(uploaded.file.size, bytes.length)
  const listing = await f.run({ action: 'list' }); assert.equal(listing.files.length, 1)
  assert.equal(JSON.stringify(listing).includes(f.directory), false)
  const chunks = []; let offset = 0
  do { const result = await f.run({ action: 'read', name: uploaded.file.name, version: uploaded.file.version, offset }); chunks.push(Buffer.from(result.data, 'base64')); offset = result.offset; if (result.done) break } while (true)
  assert.deepEqual(Buffer.concat(chunks), bytes)
  await assert.rejects(f.begin('中文🙂.bin', Buffer.from('replacement')), { code: 'EXCHANGE_EXISTS' })
  assert.deepEqual(await readFile(join(f.directory, '中文🙂.bin')), bytes)
})

test('cross-platform basename policy rejects traversal, ADS, reserved Windows names and unstable names', () => {
  for (const name of ['..', '.', '../a', 'a/b', 'a\\b', 'a:b', 'CON', 'con.txt', 'CON .txt', 'CONIN$', 'CONOUT$.txt', 'CLOCK$', 'LPT9.log', 'COM¹.txt', 'NUL', 'a.', 'a ', 'a\0b', 'a\nb', 'a\u202eb', '.qiuya-upload-secret.tmp', 'e\u0301.txt', 'x'.repeat(181)]) assert.throws(() => exchangeName(name), { code: 'EXCHANGE_NAME' }, name)
  assert.equal(exchangeName('报告🙂.txt'), '报告🙂.txt')
})

test('regular file whitelist refuses hard links, symlinks/junctions and oversized files', async t => {
  const f = await fixture(t), outside = join(f.base, 'outside'), outsideFile = join(f.base, 'private.txt')
  await mkdir(outside); await writeFile(outsideFile, 'private'); await link(outsideFile, join(f.directory, 'hard.txt'))
  await symlink(outside, join(f.directory, 'linked-directory'), process.platform === 'win32' ? 'junction' : 'dir')
  if (process.platform !== 'win32') await symlink(outsideFile, join(f.directory, 'linked.txt'))
  await writeFile(join(f.directory, 'large.bin'), Buffer.alloc(EXCHANGE_MAX_BYTES + 1))
  assert.deepEqual((await f.run({ action: 'list' })).files, [])
  for (const name of ['hard.txt', 'linked-directory', 'large.bin']) await assert.rejects(f.run({ action: 'read', name, version: 'x', offset: 0 }), { code: 'EXCHANGE_FILE' })
  const error = await f.run({ action: 'read', name: 'missing.txt', version: 'x', offset: 0 }).catch(error => error)
  assert.equal(error.code, 'EXCHANGE_IO'); assert.equal(error.message.includes(f.directory), false)
  await assert.rejects(ComputerExchange.create(join(f.directory, 'linked-directory')), { code: 'EXCHANGE_DIRECTORY' })
})

test('8 MiB boundary roundtrips; two uploads reserve at most 16 MiB and dishonest blocks are removed', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(EXCHANGE_MAX_BYTES, 0x5e)
  const a = await f.begin('one.bin', bytes), b = await f.begin('two.bin', bytes)
  await assert.rejects(f.begin('third.bin', Buffer.alloc(0)), { code: 'EXCHANGE_BUSY' })
  await f.run({ action: 'abort', id: b.id })
  for (let offset = 0; offset < bytes.length; offset += EXCHANGE_CHUNK_BYTES) await f.run({ action: 'chunk', id: a.id, offset, data: bytes.subarray(offset, offset + EXCHANGE_CHUNK_BYTES).toString('base64') })
  assert.equal((await f.run({ action: 'commit', id: a.id })).file.size, EXCHANGE_MAX_BYTES)
  assert.equal(sha(await readFile(join(f.directory, 'one.bin'))), sha(bytes))
  await assert.rejects(f.run({ action: 'begin', name: 'too-large', size: EXCHANGE_MAX_BYTES + 1, sha256: sha('') }), { code: 'EXCHANGE_SIZE' })
  const dishonest = await f.begin('small.bin', Buffer.from('x'))
  await assert.rejects(f.run({ action: 'chunk', id: dishonest.id, offset: 0, data: Buffer.from('xx').toString('base64') }), { code: 'EXCHANGE_SIZE' })
  assert.deepEqual(await entries(f.directory), ['one.bin'])
})

test('incorrect digest, duplicate/parallel chunks and commit collisions cannot append twice or overwrite', async t => {
  const f = await fixture(t), bytes = Buffer.from('abc')
  const bad = await f.run({ action: 'begin', name: 'bad', size: 3, sha256: sha('xyz') })
  await f.run({ action: 'chunk', id: bad.id, offset: 0, data: bytes.toString('base64') })
  await assert.rejects(f.run({ action: 'commit', id: bad.id }), { code: 'EXCHANGE_DIGEST' })
  const parallel = await f.begin('parallel', bytes), chunk = { action: 'chunk', id: parallel.id, offset: 0, data: bytes.toString('base64') }
  const outcomes = await Promise.allSettled([f.run(chunk), f.run(chunk)])
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1)
  await assert.rejects(f.run({ action: 'commit', id: parallel.id }), { code: 'EXCHANGE_UPLOAD' })
  const collision = await f.begin('keep.txt', Buffer.alloc(0)); await writeFile(join(f.directory, 'keep.txt'), 'original')
  await assert.rejects(f.run({ action: 'commit', id: collision.id }), { code: 'EXCHANGE_EXISTS' })
  assert.equal(await readFile(join(f.directory, 'keep.txt'), 'utf8'), 'original')
  assert.deepEqual(await entries(f.directory), ['keep.txt'])
})

test('disk tampering and adding an outside hard link to an upload cannot publish or receive more bytes', async t => {
  const f = await fixture(t), bytes = Buffer.from('abc'), upload = await f.begin('tampered', bytes)
  await f.run({ action: 'chunk', id: upload.id, offset: 0, data: bytes.toString('base64') })
  const name = (await entries(f.directory))[0]; await writeFile(join(f.directory, name), 'xyz')
  await assert.rejects(f.run({ action: 'commit', id: upload.id }), { code: 'EXCHANGE_DIGEST' })
  assert.deepEqual(await entries(f.directory), [])
  const linked = await f.begin('linked', bytes), temporary = join(f.directory, (await entries(f.directory))[0]), outside = join(f.base, 'outside-link')
  await link(temporary, outside)
  await assert.rejects(f.run({ action: 'chunk', id: linked.id, offset: 0, data: bytes.toString('base64') }), { code: 'EXCHANGE_FILE_CHANGED' })
  assert.equal((await readFile(outside)).length, 0)
})

test('upload identity is owner-bound; cancel and expiry only remove unfinished transactions', async t => {
  let now = Date.now(); const f = await fixture(t, { now: () => now })
  const a = await f.begin('a', Buffer.from('a')), b = await f.begin('b', Buffer.from('b'), 'owner-b')
  await assert.rejects(f.run({ action: 'abort', id: a.id }, 'owner-b'), { code: 'EXCHANGE_UPLOAD' })
  await f.run({ action: 'cancel' }); assert.equal((await entries(f.directory)).length, 1)
  now += 120001; await f.run({ action: 'status' })
  await assert.rejects(f.run({ action: 'commit', id: b.id }, 'owner-b'), { code: 'EXCHANGE_UPLOAD' })
  assert.deepEqual(await entries(f.directory), [])
  await f.upload('committed', Buffer.from('keep')); await f.store.reset()
  assert.equal(await readFile(join(f.directory, 'committed'), 'utf8'), 'keep', 'pair revocation never deletes already committed files')
})

test('fresh crash leftovers consume the directory budget and periodic cleanup removes them after expiry', async t => {
  const f = await fixture(t); await f.store.close()
  const names = ['.qiuya-upload-00000000-0000-0000-0000-000000000011.tmp', '.qiuya-upload-00000000-0000-0000-0000-000000000012.tmp']
  for (const name of names) await writeFile(join(f.directory, name), 'fresh crash leftover')
  let now = Date.now(), restarted = await ComputerExchange.create(f.directory, { now: () => now })
  try {
    await assert.rejects(restarted.run('owner', { action: 'begin', name: 'new', size: 0, sha256: sha('') }), { code: 'EXCHANGE_BUSY' })
    now += 121000
    const deadline = Date.now() + 6500
    while ((await entries(f.directory)).some(name => names.includes(name)) && Date.now() < deadline) await new Promise(done => setTimeout(done, 25))
    assert.equal((await entries(f.directory)).some(name => names.includes(name)), false, 'timer must sweep old-process leftovers without another API request')
    assert.ok((await restarted.run('owner', { action: 'begin', name: 'new', size: 0, sha256: sha('') })).id)
  } finally { await restarted.close() }
})

test('reset fences a commit already paused at disk publication and waits for its cleanup', async t => {
  const entered = deferred(), finish = deferred(), f = await fixture(t, { hooks: { beforePublish: async () => { entered.resolve(); await finish.promise } } })
  const upload = await f.begin('must-not-publish', Buffer.alloc(0))
  const committing = f.run({ action: 'commit', id: upload.id }), rejected = assert.rejects(committing, { code: 'PAIR_UNAUTHORIZED' })
  await entered.promise
  let resetDone = false; const resetting = f.store.reset().then(() => { resetDone = true })
  await new Promise(done => setImmediate(done)); assert.equal(resetDone, false)
  finish.resolve(); await rejected; await resetting
  assert.deepEqual(await entries(f.directory), [])
})

test('revoke after atomic publication never deletes an operator edit; crash-link cleanup removes only the expired temporary name', async t => {
  const entered = deferred(), finish = deferred(), f = await fixture(t, { hooks: { afterPublish: async () => { entered.resolve(); await finish.promise } } })
  const upload = await f.begin('published.txt', Buffer.alloc(0)), committing = f.run({ action: 'commit', id: upload.id })
  const rejected = assert.rejects(committing, { code: 'EXCHANGE_COMMIT_UNKNOWN' })
  await entered.promise; await writeFile(join(f.directory, 'published.txt'), 'operator edit')
  const resetting = f.store.reset(); finish.resolve(); await rejected; await resetting
  assert.equal(await readFile(join(f.directory, 'published.txt'), 'utf8'), 'operator edit')
  await f.store.close()
  const temporary = join(f.directory, '.qiuya-upload-00000000-0000-0000-0000-000000000001.tmp')
  await writeFile(temporary, 'crash before unlink'); await link(temporary, join(f.directory, 'crash.txt'))
  const restarted = await ComputerExchange.create(f.directory, { now: () => Date.now() + 120001 })
  try {
    assert.equal((await entries(f.directory)).includes('.qiuya-upload-00000000-0000-0000-0000-000000000001.tmp'), false)
    const listing = await restarted.run('owner', { action: 'list' })
    assert.ok(listing.files.some(file => file.name === 'crash.txt'))
    assert.equal(await readFile(join(f.directory, 'crash.txt'), 'utf8'), 'crash before unlink')
  } finally { await restarted.close() }
})

test('canonicalizes a harmless ancestor alias but rejects a selected final-directory link', async t => {
  const f = await fixture(t), alias = join(f.base, 'alias')
  await f.store.close()
  await symlink(f.base, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const viaAncestor = await ComputerExchange.create(join(alias, 'shared'))
  try { assert.equal((await viaAncestor.run('owner', { action: 'status' })).enabled, true) } finally { await viaAncestor.close() }
  await assert.rejects(ComputerExchange.create(alias), { code: 'EXCHANGE_DIRECTORY' })
})

test('failed cleanup retains its transaction for retry and cannot silently free the temporary budget', async t => {
  let blocked = true
  const f = await fixture(t, { hooks: { beforeRemove: async () => { if (blocked) throw new Error('disk cleanup failed') } } })
  await f.begin('pending', Buffer.from('x'))
  await assert.rejects(f.store.reset(), { code: 'EXCHANGE_CLEANUP_FAILED' })
  assert.equal((await entries(f.directory)).length, 1)
  await assert.rejects(f.begin('new', Buffer.from('y')), { code: 'EXCHANGE_IO' })
  await assert.rejects(f.store.close(), { code: 'EXCHANGE_CLEANUP_FAILED' })
  await assert.rejects(ComputerExchange.create(f.directory), { code: 'EXCHANGE_CLEANUP_FAILED' })
  blocked = false; await f.store.close(); assert.deepEqual(await entries(f.directory), [])
  const fresh = await ComputerExchange.create(f.directory)
  try { await f.store.close(); assert.equal((await fresh.run('owner', { action: 'status' })).enabled, true) } finally { await fresh.close() }
})

test('directory owner lock excludes another process and its metadata namespace is never exposed as files', async t => {
  const f = await fixture(t)
  await assert.rejects(ComputerExchange.create(f.directory), { code: 'EXCHANGE_DIRECTORY_BUSY' })
  const module = join(f.base, 'exchange-runtime.mjs'); await writeFile(module, source)
  const code = `import{pathToFileURL}from'node:url';const{ComputerExchange}=await import(pathToFileURL(process.argv[1]).href);try{const store=await ComputerExchange.create(process.argv[2]);await store.close();process.exitCode=1;console.log('unexpected-acquire')}catch(error){console.log(error.code);if(error.code!=='EXCHANGE_DIRECTORY_BUSY')process.exitCode=1}`
  const child = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', code, module, f.directory], { timeout: 5000, maxBuffer: 4096 })
  assert.equal(child.stdout.trim(), 'EXCHANGE_DIRECTORY_BUSY')
  assert.deepEqual((await f.run({ action: 'list' })).files, [])
  for (const name of ['.qiuya-exchange.lock', '.qiuya-exchange.recovery']) {
    await assert.rejects(f.begin(name, Buffer.alloc(0)), { code: 'EXCHANGE_NAME' })
    await assert.rejects(f.run({ action: 'read', name, version: 'x', offset: 0 }), { code: 'EXCHANGE_NAME' })
  }
})

test('two real child processes racing an empty directory grant exactly one owner', async t => {
  const f = await fixture(t); await f.store.close()
  const module = join(f.base, 'exchange-race-runtime.mjs'); await writeFile(module, source)
  const code = `import{pathToFileURL}from'node:url';const{ComputerExchange}=await import(pathToFileURL(process.argv[1]).href);try{const store=await ComputerExchange.create(process.argv[2]);console.log('acquired');process.stdin.resume();await new Promise(done=>process.stdin.once('end',done));await store.close()}catch(error){console.log(error.code);if(error.code!=='EXCHANGE_DIRECTORY_BUSY')process.exitCode=1}`
  const children = Array.from({ length: 2 }, () => spawn(process.execPath, ['--input-type=module', '--eval', code, module, f.directory], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }))
  try {
    const results = await Promise.all(children.map(child => new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error('child directory lock handshake timed out')), 5000); let text = ''
      child.once('error', error => { clearTimeout(timer); reject(error) }); child.stderr.resume()
      child.stdout.on('data', bytes => { text += bytes; if (text.includes('\n')) { clearTimeout(timer); done(text.trim()) } })
    })))
    assert.deepEqual(results.sort(), ['EXCHANGE_DIRECTORY_BUSY', 'acquired'])
  } finally {
    await Promise.all(children.map(child => new Promise(done => {
      if (child.exitCode !== null || child.signalCode !== null) return done()
      const timer = setTimeout(() => { child.kill(); done() }, 5000); child.once('exit', () => { clearTimeout(timer); done() }); child.stdin.end()
    })))
  }
  assert.deepEqual(await entries(f.directory), [])
})

test('failed initialization releases its owner lock or retains a closed instance for retry after root restoration', async t => {
  const f = await fixture(t); await f.store.close()
  await assert.rejects(ComputerExchange.create(f.directory, { hooks: { afterLockAcquired: async () => { throw new Error('simulated abandoned sweep IO failure') } } }), { code: 'EXCHANGE_DIRECTORY' })
  assert.deepEqual(await readdir(f.directory), [], 'successful failure cleanup removes both owner metadata files')
  const moved = `${f.directory}-moved`
  await assert.rejects(ComputerExchange.create(f.directory, { hooks: { afterLockAcquired: async () => { await rename(f.directory, moved) } } }), { code: 'EXCHANGE_CLEANUP_FAILED' })
  await rename(moved, f.directory)
  const retried = await ComputerExchange.create(f.directory)
  try { assert.equal((await retried.run('owner', { action: 'status' })).enabled, true) } finally { await retried.close() }
})

test('only confirmed dead PID primary locks recover; corrupt records and residual recovery gates fail closed', async t => {
  const f = await fixture(t); await f.store.close()
  const lock = join(f.directory, '.qiuya-exchange.lock'), gate = join(f.directory, '.qiuya-exchange.recovery')
  await writeFile(lock, 'corrupt lock')
  await assert.rejects(ComputerExchange.create(f.directory), { code: 'EXCHANGE_DIRECTORY_BUSY' })
  assert.equal(await readFile(lock, 'utf8'), 'corrupt lock'); await rm(lock)
  await writeFile(gate, 'interrupted recovery')
  await assert.rejects(ComputerExchange.create(f.directory), { code: 'EXCHANGE_DIRECTORY_BUSY' })
  assert.equal(await readFile(gate, 'utf8'), 'interrupted recovery'); await rm(gate)
  const dead = 2147483647; assert.throws(() => process.kill(dead, 0), { code: 'ESRCH' })
  await writeFile(lock, JSON.stringify({ version: 1, pid: dead, ownerId: 'a'.repeat(32) }))
  const recovered = await ComputerExchange.create(f.directory)
  try { assert.equal((await recovered.run('owner', { action: 'status' })).enabled, true) } finally { await recovered.close() }
  assert.deepEqual(await entries(f.directory), [])
})

test('close refuses to delete a replacement lock and succeeds after its own identity is restored', async t => {
  const f = await fixture(t), lock = join(f.directory, '.qiuya-exchange.lock'), saved = join(f.directory, 'saved-lock')
  await rename(lock, saved)
  const replacement = JSON.stringify({ version: 1, pid: process.pid, ownerId: 'b'.repeat(32) }); await writeFile(lock, replacement)
  await assert.rejects(f.store.close(), { code: 'EXCHANGE_LOCK_CHANGED' })
  assert.equal(await readFile(lock, 'utf8'), replacement)
  await rm(lock); await rename(saved, lock); await f.store.close()
})

test('download versions reject an operator edit and root replacement never follows an outside directory', async t => {
  const f = await fixture(t), uploaded = await f.upload('document.txt', Buffer.from('first'))
  await writeFile(join(f.directory, 'document.txt'), 'changed content')
  await assert.rejects(f.run({ action: 'read', name: 'document.txt', version: uploaded.file.version, offset: 0 }), { code: 'EXCHANGE_FILE_CHANGED' })
  const saved = `${f.directory}-original`, outside = join(f.base, 'outside'); await mkdir(outside); await writeFile(join(outside, 'private'), 'secret')
  await rename(f.directory, saved); await symlink(outside, f.directory, process.platform === 'win32' ? 'junction' : 'dir')
  try { await assert.rejects(f.run({ action: 'list' }), { code: 'EXCHANGE_DIRECTORY_CHANGED' }); assert.deepEqual(await readdir(outside), ['private']) }
  finally { await rm(f.directory); await rename(saved, f.directory) }
})

test('list has a bounded file count and never returns private metadata paths', async t => {
  const f = await fixture(t)
  await Promise.all(Array.from({ length: 103 }, (_, index) => writeFile(join(f.directory, `file-${index}`), '')))
  const listed = await f.run({ action: 'list' })
  assert.equal(listed.files.length, 100); assert.equal(listed.truncated, true)
  assert.ok(listed.files.every(file => Object.keys(file).sort().join(',') === 'modifiedAt,name,size,version'))
})
