import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile, chmod, symlink, readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { build } from 'esbuild'
import vm from 'node:vm'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validateExternalConfig, validateExternalRequest, validateExternalBinding, verifyExternalFixture, sameExternalIdentity,
  readPrivateJSON, writePrivateJSON, removePrivateJSON, externalCleanupPassed, externalIdentityRetired, sameExternalExecutable, visionDigest } from '../scripts/live-vision-external-core.mjs'
const hash = 'a'.repeat(64), runId = '12345678-1234-1234-1234-123456789abc', sessionId = 'qiuya-vision-12345678-1234-1234-1234-123456789abc'
function config() { const directory = resolve(tmpdir(), 'vision-synthetic'); return { version: 1, runId, rendezvousNonce: 'b'.repeat(64), directory, native: join(directory, 'helper'), oracle: join(directory, 'oracle'), carrier: join(directory, 'carrier.mjs'), nativeSha256: hash, oracleSha256: hash, carrierSha256: hash, fixtureSha256: hash, expiresAt: Date.now() + 900000 } }
function request(cfg = config()) { return { version: 1, runId: cfg.runId, rendezvousNonce: cfg.rendezvousNonce, task: 1, requestId: runId, sessionId, pid: 123, parentPid: 42, windowId: 456, bundleId: 'com.qiuya.tools.vision-12345678-1234-1234-1234-123456789abc', executablePath: join(cfg.directory, 'runtime', sessionId + '.app', 'Contents/MacOS/fixture'), fixtureSha256: cfg.fixtureSha256, nativeSha256: cfg.nativeSha256 } }
const row = request => ({ pid: request.pid, parentPid: request.parentPid, executablePath: request.executablePath, startSeconds: '123', startMicroseconds: '456', uniqueId: '1' })
const target = request => ({ id: `mac-window:${request.windowId}`, appId: request.bundleId, pid: request.pid, x: 0, y: 0, width: 680, height: 480, scale: 1 })

test('external carrier config is explicit, source pinned, private-nonce bound and time bounded', () => {
  const cfg = config(); assert.equal(validateExternalConfig(cfg), cfg)
  for (const changed of [{ runId: 'other' }, { rendezvousNonce: 'short' }, { native: 'relative/helper' }, { nativeSha256: 'wrong' }, { expiresAt: 1 }, { expiresAt: Date.now() + 1800000 }]) assert.throws(() => validateExternalConfig({ ...cfg, ...changed }), { code: 'VISION_EXTERNAL_CONFIG' })
})
test('external requests cannot select another task, parent, executable tree, run or source binary', () => {
  const cfg = config(), req = request(cfg); assert.equal(validateExternalRequest(req, cfg, 1), req)
  for (const changed of [{ task: 2 }, { pid: 0 }, { parentPid: 0 }, { windowId: 0 }, { executablePath: '/Applications/Another.app/fixture' }, { rendezvousNonce: 'c'.repeat(64) }, { runId: randomUUID() }, { fixtureSha256: 'c'.repeat(64) }, { nativeSha256: 'c'.repeat(64) }]) assert.throws(() => validateExternalRequest({ ...req, ...changed }, cfg, 1), { code: 'VISION_EXTERNAL_BINDING' })
  assert.throws(() => validateExternalRequest({ ...req, task: 99 }, cfg, 99), { code: 'VISION_EXTERNAL_BINDING' })
})
test('fixture adoption verifies current PID birth/path/parent, binary SHA and native window/bundle together', async () => {
  const cfg = config(), req = request(cfg), pinned = row(req)
  const good = { identity: async () => pinned, fileHash: async () => hash, targets: async () => [target(req)], pinned, executableEquals: async (a, b) => a === b }
  assert.deepEqual((await verifyExternalFixture(req, cfg, good)).identity, pinned)
  for (const changed of [{ identity: async () => ({ ...pinned, startMicroseconds: '999' }) }, { identity: async () => ({ ...pinned, parentPid: 999 }) }, { identity: async () => ({ ...pinned, executablePath: '/another' }) }, { fileHash: async () => 'c'.repeat(64) }, { targets: async () => [{ ...target(req), pid: 999 }] }, { targets: async () => [{ ...target(req), appId: 'another.app' }] }, { targets: async () => [{ ...target(req), id: 'mac-window:other' }] }]) await assert.rejects(verifyExternalFixture(req, cfg, { ...good, ...changed }), { code: 'VISION_EXTERNAL_FIXTURE_CHANGED' })
})
test('a retired or reused fixture is rejected before enumerating native targets', async () => {
  const cfg = config(), req = request(cfg); let enumerations = 0
  await assert.rejects(verifyExternalFixture(req, cfg, { identity: async () => null, fileHash: async () => hash, targets: async () => { enumerations++; return [] } }), { code: 'VISION_EXTERNAL_FIXTURE_CHANGED' })
  assert.equal(enumerations, 0); assert.equal(sameExternalIdentity(row(req), { ...row(req), startSeconds: '999' }), false)
})
test('cleanup/ready receipts bind the exact task request and cannot be borrowed from a previous task', () => {
  const cfg = config(), req = request(cfg), receipt = { version: 1, runId, rendezvousNonce: cfg.rendezvousNonce, task: 1, requestId: req.requestId, sessionId }
  assert.equal(validateExternalBinding(receipt, req, cfg), receipt)
  for (const changed of [{ task: 2 }, { requestId: randomUUID() }, { sessionId: 'another' }, { rendezvousNonce: 'wrong' }]) assert.throws(() => validateExternalBinding({ ...receipt, ...changed }, req, cfg), { code: 'VISION_EXTERNAL_BINDING' })
})
test('a nominal cleanup pass cannot hide force, missing natural exit or retained cleanup errors', () => {
  const good = { passed: true, errors: [], forced: false, nativeNaturalExit: true }
  assert.equal(externalCleanupPassed(good), true)
  for (const changed of [{ passed: false }, { errors: ['native remained'] }, { forced: true }, { nativeNaturalExit: false }, { errors: null }]) assert.equal(externalCleanupPassed({ ...good, ...changed }), false)
})
test('natural retirement accepts ESRCH or a new birth, but never an unknown read or same-birth exec mismatch', () => {
  const pinned = row(request())
  assert.equal(externalIdentityRetired(null, pinned), true)
  assert.equal(externalIdentityRetired({ ...pinned, startSeconds: '999' }, pinned), true)
  for (const current of [undefined, pinned, { ...pinned, executablePath: '/another-executable' }, { ...pinned, pid: 999 }]) assert.equal(externalIdentityRetired(current, pinned), false)
})
test('actual /tmp executable aliases compare canonically while the original raw identity remains the oracle pin', { skip: process.platform !== 'darwin' }, async t => {
  const directory = await realpath(await mkdtemp('/private/tmp/qiuya-external-alias-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const cfg = { ...config(), directory, fixtureSha256: visionDigest('synthetic-not-executed') }, req = request(cfg), canonical = req.executablePath
  await mkdir(join(directory, 'runtime', sessionId + '.app', 'Contents/MacOS'), { recursive: true }); await writeFile(canonical, 'synthetic-not-executed')
  const alias = canonical.replace(/^\/private\/tmp\//u, '/tmp/'); assert.notEqual(alias, canonical)
  assert.equal(await sameExternalExecutable(alias, canonical), true)
  const raw = { ...row(req), executablePath: alias }, before = JSON.stringify(raw)
  const verified = await verifyExternalFixture(req, cfg, { identity: async () => raw, fileHash: async file => visionDigest(await readFile(file)), targets: async () => [target(req)], pinned: raw })
  assert.equal(verified.identity, raw); assert.equal(JSON.stringify(raw), before)
  assert.equal(sameExternalIdentity(raw, { ...raw, executablePath: canonical }), false, 'The strict raw identity must not be rewritten for Swift expected(...)')
  const unrelated = join(directory, 'same-bytes-different-executable'); await writeFile(unrelated, 'synthetic-not-executed')
  assert.equal(await sameExternalExecutable(unrelated, canonical), false)
  assert.equal(await sameExternalExecutable(join(directory, 'missing'), canonical), false)
})
test('private rendezvous publishing is atomic, one-shot, 0600 and rejects symlink or public files', { skip: process.platform !== 'darwin' }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'qiuya-external-private-'))); await chmod(directory, 0o700); t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'ready.json'); await writePrivateJSON(path, { synthetic: true }); assert.deepEqual(await readPrivateJSON(path), { synthetic: true })
  await assert.rejects(writePrivateJSON(path, { replacement: true }), { code: 'VISION_EXTERNAL_REPLAY' }); assert.deepEqual(await readPrivateJSON(path), { synthetic: true })
  const link = join(directory, 'link.json'); await symlink(path, link); await assert.rejects(readPrivateJSON(link))
  await chmod(path, 0o644); await assert.rejects(readPrivateJSON(path), { code: 'VISION_EXTERNAL_FILE_BOUNDARY' }); await chmod(path, 0o600)
  await removePrivateJSON(path); await assert.rejects(readFile(path), { code: 'ENOENT' })
})
test('oversized and non-private rendezvous boundaries fail before JSON adoption', { skip: process.platform !== 'darwin' }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'qiuya-external-bounds-'))); await chmod(directory, 0o700); t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'large.json'); await writeFile(path, ' '.repeat(65537), { mode: 0o600 }); await assert.rejects(readPrivateJSON(path), { code: 'VISION_EXTERNAL_FILE_BOUNDARY' })
  await assert.rejects(writePrivateJSON(join(directory, 'new.json'), { oversized: 'x'.repeat(65537) }), { code: 'VISION_EXTERNAL_FILE_BOUNDARY' })
  const publicDirectory = join(directory, 'public'); await mkdir(publicDirectory, { mode: 0o755 }); await writeFile(join(publicDirectory, 'file.json'), '{}', { mode: 0o600 }); await assert.rejects(readPrivateJSON(join(publicDirectory, 'file.json')), { code: 'VISION_EXTERNAL_FILE_BOUNDARY' })
})
test('owner connects, starts, stops and restores only its three new session IDs under the default manager', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qiuya-external-owner-scope-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'guard.mjs')
  await build({ entryPoints: [fileURLToPath(new URL('../scripts/live-vision-guard-plugin.mjs', import.meta.url))], outfile: file, bundle: true, platform: 'node', target: 'node22', format: 'esm' })
  const plugin = await import(pathToFileURL(file).href), calls = [], flags = {}, original = { enabled: true, computerUseEnabled: false }, ids = [1, 2, 3].map(task => `own-new-${task}`)
  const modes = new Map([['unrelated-existing-chat', 'local']]); let rpcSequence = 0
  const run = vm.runInNewContext(plugin.visionOwnerClientSource().replace('export const run=', 'const run=') + ';run', {
    crypto: { randomUUID: () => `synthetic-${++rpcSequence}` }, AbortSignal, Object, TypeError, SyntaxError,
    console: { log() {} }, setTimeout: done => queueMicrotask(done),
    async fetch(url, options) {
      const input = JSON.parse(options.body); calls.push({ url, input })
      if (url === '/api/qiuya-tools.vision-test') {
        let value
        if (input.op === 'prepare') value = { sessionId: ids[input.task - 1], endpoint: 'http://127.0.0.1:1234/v1/computer', token: 'synthetic-private', targetId: 'own-window', prompt: 'Synthetic; never sent to a model' }
        else if (input.op === 'arm') value = { armed: true }
        else if (input.op === 'status') value = { state: 'idle', requests: 1 }
        else if (input.op === 'finish') value = { passed: true, cleanup: { passed: true }, denials: [], fatal: null }
        else if (input.op === 'delivery') value = { passed: input.restore.localMode && input.restore.featureFlags }
        else throw Error('Unexpected test operation')
        return Response.json({ ok: true, value })
      }
      let value
      if (input.method === 'settings/describe') value = { writable: true, namespaces: [{ ns: 'qiuya-tools', revision: 1, user: { ...flags }, value: { ...original, ...flags } }] }
      else if (input.method === 'settings/mutate') { for (const op of input.payload.args.ops) { if (op.op === 'set') flags[op.path[0]] = op.value; else delete flags[op.path[0]] }; value = {} }
      else if (input.method === 'qiuya-tools.computer.control') {
        const request = input.payload
        if (request.op !== 'status' || request.sessionId !== undefined) assert.ok(ids.includes(request.sessionId), 'Every mutating control and per-session status must name an owned session')
        if (request.op === 'connect') modes.set(request.sessionId, request.mode)
        value = request.op === 'status' ? { native: { mode: request.sessionId ? modes.get(request.sessionId) : 'local' }, sessions: [{ sessionId: 'unrelated-existing-chat', state: 'stopped' }, ...ids.map(sessionId => ({ sessionId, state: 'stopped' }))] } : {}
      } else if (['session/prompt', 'session/cancel'].includes(input.method)) { assert.ok(ids.includes(input.payload.args.request.sessionId)); value = {} }
      else throw Error('Unrelated RPC forbidden')
      return Response.json({ rpcId: input.rpcId, result: { ok: true, value } })
    },
  })
  const result = await run(); assert.equal(result.passed, true); assert.equal(result.tasks.length, 3)
  const controls = calls.filter(row => row.input.method === 'qiuya-tools.computer.control').map(row => row.input.payload)
  assert.equal(controls.filter(row => row.op === 'connect' && row.mode === 'remote').length, 3)
  assert.equal(controls.filter(row => row.op === 'status' && row.sessionId).length, 3)
  assert.ok(controls.filter(row => row.op === 'connect').every(row => ids.includes(row.sessionId)))
  assert.equal(modes.get('unrelated-existing-chat'), 'local'); assert.ok(ids.every(id => modes.get(id) === 'local'))
})
