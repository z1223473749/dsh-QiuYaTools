import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir, stat, realpath } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url)), args = process.argv.slice(2)
const arg = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const execute = promisify(execFile), pause = ms => new Promise(done => setTimeout(done, ms))
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex')
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
const source = join(root, 'src/native/macos/fixtures/WKAssociationProbe.m')
const own = row => ({ pid: row.pid, birthMicros: row.birthMicros, uniqueId: row.uniqueId, path: row.path })
export const validProbeIdentity = row => Boolean(row && Number.isSafeInteger(row.pid) && row.pid > 0 && row.pid <= 2147483647 && typeof row.birthMicros === 'string' && /^[1-9][0-9]{0,31}$/u.test(row.birthMicros) && typeof row.uniqueId === 'string' && /^[1-9][0-9]{0,31}$/u.test(row.uniqueId) && typeof row.path === 'string' && row.path.startsWith('/') && row.path.length <= 4096 && !row.path.includes('\0'))
export const sameProbeIdentity = (a, b) => validProbeIdentity(a) && validProbeIdentity(b) && ['pid', 'birthMicros', 'uniqueId', 'path'].every(key => a[key] === b[key])
const same = sameProbeIdentity
const key = row => `${row.pid}:${row.birthMicros}:${row.uniqueId}`
async function observer(binary, request) {
  return await new Promise((done, reject) => {
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] }); const output = []; let bytes = 0
    const timer = setTimeout(() => { child.kill(); reject(Error('Own read-only metadata observer deadline')) }, 10000)
    child.stderr.resume(); child.stdin.on('error', () => {})
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 8 * 1024 ** 2) { child.kill(); reject(Error('Metadata bound')) } else output.push(chunk) })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); try { const value = JSON.parse(Buffer.concat(output)); assert.equal(code, 0); assert.equal(value.ok, true); done(value.result) } catch (error) { reject(error) } })
    child.stdin.end(JSON.stringify(request))
  })
}
async function prepare() {
  assert.equal(process.platform, 'darwin')
  const pinned = JSON.parse(await readFile(join(root, 'artifacts/computer-use/macos-owned-cursor-final-build/current.json'), 'utf8'))
  const helper = await realpath(resolve(arg('--native', pinned.binary)))
  assert.equal(await hash(helper), arg('--expect-sha256', pinned.sha256), 'Only the explicitly pinned formal helper may be prepared')
  const directory = resolve(arg('--output', join(root, 'artifacts/computer-use/macos-wk-association-probe', randomUUID())))
  await mkdir(directory, { mode: 0o700, recursive: true }); await save(join(directory, 'prepare-started.json'), { helper, helperSha256: await hash(helper), status: 'prepare-only' })
  const library = join(directory, 'wk-association-probe.dylib'), fake = join(directory, 'wk-association-fake'), metadata = join(directory, 'wk-metadata')
  const common = ['-O2', '-fobjc-arc', '-fblocks', '-mmacosx-version-min=13.0', '-framework', 'AppKit', '-framework', 'WebKit']
  const commands = [
    ['/usr/bin/clang', [...common, '-arch', 'arm64', '-arch', 'x86_64', '-dynamiclib', source, '-o', library]],
    ['/usr/bin/clang', [...common, '-DQIUYA_WK_ASSOC_SELFTEST=1', source, '-o', fake]],
    ['/usr/bin/swiftc', ['-O', '-swift-version', '5', '-parse-as-library', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.0`, '-framework', 'AppKit', '-framework', 'ScreenCaptureKit', '-framework', 'CoreImage', '-framework', 'CoreMedia', '-module-cache-path', join(directory, 'module-cache'), join(root, 'src/native/macos/fixtures/WKSoakObserver.swift'), '-o', metadata]],
  ]
  const logs = []
  for (const [command, argv] of commands) { const result = await execute(command, argv, { timeout: 90000, maxBuffer: 2 * 1024 ** 2 }); logs.push({ command, args: argv, stdout: result.stdout, stderr: result.stderr }) }
  const selftest = JSON.parse((await execute(fake, [], { timeout: 10000 })).stdout)
  assert.equal(selftest.passed, true); assert.equal(selftest.checks, 6); assert.equal(selftest.productionHelperSpawned, false)
  await save(join(directory, 'compile-and-fake.json'), { passed: true, commands: logs, selftest })
  const record = { schemaVersion: 1, status: 'prepared-not-run', directory, helper, helperSha256: await hash(helper), library, librarySha256: await hash(library), metadata, metadataSha256: await hash(metadata),
    sourceSha256: await hash(source), metadataSourceSha256: await hash(join(root, 'src/native/macos/fixtures/WKSoakObserver.swift')), scriptSha256: await hash(fileURLToPath(import.meta.url)), helperSourceCommit: (await hash(helper)) === pinned.sha256 ? pinned.sourceCommit : null,
    sourceCommitBinding: (await hash(helper)) === pinned.sha256 ? 'default-pin-exact-SHA-match' : 'explicit-helper-SHA-differs-from-default-pin-source-commit-unverified',
    carrier: 'test-only DYLD read-only getter instrumentation in the explicitly launched formal helper; no responsibility/TCC changes; not official Harness acceptance',
    limitations: ['Private WebKit selectors must be available with the expected ABI at runtime.', 'Getter associations do not alone prove complete resource attribution or natural cleanup.', 'Network getter is used only in one main-thread synchronous exists=true→PID→exists/PID stack; birth must predate the getter.'],
    smokeCommand: `node scripts/prepare-wk-association-probe.mjs --smoke --prepared ${join(directory, 'prepared.json')}` }
  await save(join(directory, 'prepared.json'), record); console.log(JSON.stringify(record))
}
async function smoke() {
  // This branch opens exactly one own static preview; prepare() NEVER runs it.
  assert.equal(process.platform, 'darwin')
  const prepared = JSON.parse(await readFile(resolve(arg('--prepared')), 'utf8'))
  for (const [path, expected] of [[prepared.helper, prepared.helperSha256], [prepared.library, prepared.librarySha256], [prepared.metadata, prepared.metadataSha256], [source, prepared.sourceSha256], [fileURLToPath(import.meta.url), prepared.scriptSha256]]) assert.equal(await hash(path), expected)
  const nonce = randomUUID(), directory = join(prepared.directory, `smoke-${nonce}`); await mkdir(directory, { mode: 0o700 })
  const title = `QiuYaTools WK association ${nonce}`, pagePath = `/own-${nonce}`, output = join(directory, 'probe.jsonl'), config = join(directory, 'probe-config.json')
  const html = `<!doctype html><html data-qyt-association-nonce="${nonce}" data-qyt-association-tick="0"><head><title>Own WK association probe</title></head><body>Own disposable WK process association check<script>setInterval(()=>document.documentElement.dataset.qytAssociationTick=String(Number(document.documentElement.dataset.qytAssociationTick)+1),50)</script></body></html>`
  const server = createServer((request, response) => { if (request.method === 'GET' && request.url === pagePath) { response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); response.end(html) } else response.writeHead(404).end() })
  let child, native, pending = new Map(), requestId = 0, buffer = '', report = { status: 'failed', associated: [], checks: [], errors: [], cleanup: { errors: [], forced: [] }, carrier: prepared.carrier, helperSha256: prepared.helperSha256, librarySha256: prepared.librarySha256, nativeInputOps: 0 }
  const known = new Map(), independent = []; let scopeComplete = false, runner
  const rpc = (op, payload = {}) => new Promise((done, reject) => {
    const id = ++requestId, timer = setTimeout(() => { pending.delete(id); reject(Error(`Native ${op} deadline`)) }, 10000)
    pending.set(id, { done, reject, timer }); child.stdin.write(JSON.stringify({ requestId: id, op, ...payload }) + '\n')
  })
  async function records() { try { const bytes = await readFile(output, 'utf8'); assert.ok(Buffer.byteLength(bytes) < 700000); return bytes.split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch (error) { if (error.code === 'ENOENT') return []; throw error } }
  try {
    await new Promise(done => server.listen(0, '127.0.0.1', done))
    const url = `http://127.0.0.1:${server.address().port}${pagePath}`
    await save(config, { nonce, title, url, output, helper: prepared.helper, parentPid: process.pid })
    child = spawn(prepared.helper, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DYLD_INSERT_LIBRARIES: prepared.library, QIUYA_WK_ASSOC_CONFIG: config, QIUYA_TOOLS_PARENT_PID: String(process.pid) } })
    child.stderr.resume(); child.stdin.on('error', () => {})
    child.stdout.on('data', chunk => {
      buffer += chunk.toString(); if (buffer.length > 2000000) { report.errors.push('Native protocol bound exceeded'); return }
      let newline; while ((newline = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); let value; try { value = JSON.parse(line) } catch { report.errors.push('Native protocol invalid JSON'); continue }
        const item = pending.get(value.requestId); if (item) { pending.delete(value.requestId); clearTimeout(item.timer); value.ok ? item.done(value.result) : item.reject(Error(`Native: ${value.error?.code ?? 'failed'}`)) }
      }
    })
    child.once('error', error => report.errors.push(`Owned helper spawn: ${error.message}`))
    runner = await observer(prepared.metadata, { op: 'identity', pid: process.pid })
    native = await observer(prepared.metadata, { op: 'identity', pid: child.pid }); known.set(key(native), own(native)); report.native = native
    assert.equal(await realpath(native.path), prepared.helper); assert.equal(native.parentPid, process.pid)
    assert.deepEqual(native.errors, []); assert.ok(Number.isSafeInteger(native.responsiblePid) && native.responsiblePid > 0); assert.match(native.resourceCoalitionId, /^[1-9][0-9]*$/u)
    report.statusReply = await rpc('status'); assert.equal(report.statusReply.protocolVersion, 1); assert.equal(report.statusReply.platform, 'darwin'); assert.equal(report.statusReply.available, true); assert.equal(report.statusReply.permissions.screenRecording, true, 'No TCC workaround: the exact ordinary helper must already have capture permission')
    await rpc('openPreview', { url, title, sessionId: nonce })
    let selected
    for (let attempt = 0; attempt < 75; attempt++) {
      const rows = await records(); for (const row of rows) { assert.equal(row.nonce, nonce); assert.ok(same(row.helper, own(native)), 'Injected probe must retain the exact own native birth/path') }
      const associations = rows.filter(row => row.event === 'association')
      if (associations.some(row => !row.verified)) throw Error('Probe association incomplete; no selector/zero PID/network fallback is accepted')
      if (associations.length >= 2 && associations[1].page.tick > associations[0].page.tick) { selected = associations.slice(0, 2); break }
      if (child.exitCode !== null || child.signalCode !== null) throw Error('Own helper exited before association')
      await pause(200)
    }
    assert.ok(selected, 'Runtime probe did not prove two continuous own-page associations')
    for (const sample of selected) {
      assert.equal(sample.associated.length, 3); assert.equal(sample.page.nonceVerified, true); assert.equal(sample.page.iframes, 0); assert.ok(sample.windowId > 0)
      for (const item of sample.associated) {
        const row = await observer(prepared.metadata, { op: 'identity', pid: item.identity.pid }); independent.push({ role: item.role, row }); known.set(key(row), own(row))
        assert.ok(same(row, item.identity)); assert.deepEqual(row.errors, []); assert.equal(row.resourceCoalitionId, native.resourceCoalitionId); assert.equal(row.webKitKind, item.role); assert.ok(BigInt(row.birthMicros) >= BigInt(native.birthMicros)); assert.ok(Number.isSafeInteger(row.residentBytes) && row.residentBytes >= 0)
        const file = await stat(row.path, { bigint: true }); assert.equal(String(file.dev), item.identity.device); assert.equal(String(file.ino), item.identity.inode)
        assert.equal(file.uid, 0n); assert.equal(row.responsiblePid, native.responsiblePid, 'Keep ordinary Codex responsibility; do not manufacture native self-responsibility')
        if (item.role === 'Networking') assert.ok(BigInt(row.birthMicros) < BigInt(sample.networkFence.getterBeforeUnixMicros), 'The networking PID must have existed before the getter')
      }
    }
    const snapshot = await observer(prepared.metadata, { op: 'snapshot', roots: [{ ...own(runner), role: 'runner' }, { ...own(native), role: 'native' }], known: [...known.values()], helperPath: prepared.helper, requireWebKit: false })
    const associatedKeys = new Set(selected.flatMap(row => row.associated.map(item => key(item.identity))))
    const unknown = snapshot.webKitDiagnostics.filter(row => row.bsd?.uid === process.getuid()).filter(row => {
      const live = row.readableProcessRow; return live && live.resourceCoalitionId === native.resourceCoalitionId && BigInt(live.birthMicros) >= BigInt(native.birthMicros) && !associatedKeys.has(key(live))
    }).map(row => own(row.readableProcessRow))
    report.unknownFreshSameCoalitionCandidates = unknown
    report.independentAssociationSnapshot = snapshot.attribution
    assert.equal(unknown.length, 0, 'Unassociated fresh same-coalition WebKit remains unknown; do not claim full attribution')
    scopeComplete = true; report.associated = independent; report.samples = selected
    report.checks = ['exact-native-PID-birth-path-and-formal-SHA', 'continuous-own-page-nonce-and-clock', 'runtime-getter-ABI-and-stable-PIDs', 'independent-OS-birth-system-file-role-and-RSS', 'network-PID-existed-before-guarded-getter', 'unknown-candidates-are-not-adopted']
    report.status = 'passed'
  } catch (error) { report.errors.push(error.message) }
  finally {
    // Even partial/failed associations are independently pinned for observation
    // before the helper closes. No WebKit PID is ever signalled.
    try {
      for (const row of await records()) {
        if (row.nonce !== nonce || !native || !same(row.helper, native)) continue
        for (const item of Array.isArray(row.associated) ? row.associated.slice(0, 4) : []) {
          if (!validProbeIdentity(item.identity)) { report.cleanup.errors.push('Malformed partial association identity'); continue }
          const live = await observer(prepared.metadata, { op: 'identity', pid: item.identity.pid })
          if (!same(live, item.identity) || !['WebContent', 'GPU', 'Networking'].includes(item.role) || live.webKitKind !== item.role || BigInt(live.birthMicros) < BigInt(native.birthMicros)) { report.cleanup.errors.push('Partial association could not be independently verified'); continue }
          known.set(key(live), own(live))
        }
      }
    } catch (error) { report.cleanup.errors.push(`Partial association audit: ${error.message}`) }
    if (child) {
      if (child.exitCode === null && child.signalCode === null) { try { await rpc('closePreview') } catch (error) { report.cleanup.errors.push(error.message) }; child.stdin.end() }
      for (let attempt = 0; attempt < 50 && child.exitCode === null && child.signalCode === null; attempt++) await pause(100)
      if (child.exitCode === null && child.signalCode === null) {
        report.cleanup.errors.push('Own helper did not retire naturally by EOF')
        try { const live = await observer(prepared.metadata, { op: 'identity', pid: child.pid }); if (native && same(live, native)) { report.cleanup.forced.push(own(live)); child.kill('SIGTERM') } else report.cleanup.errors.push('Helper identity unknown; no signal sent') } catch (error) { report.cleanup.errors.push(error.message) }
      }
      if (child.exitCode !== 0 || child.signalCode !== null) report.cleanup.errors.push(`Own helper exit ${child.exitCode}/${child.signalCode}`)
    }
    let checked = { passed: false, results: [] }
    try { for (let attempt = 0; attempt < 30; attempt++) { checked = await observer(prepared.metadata, { op: 'check', identities: [...known.values()] }); if (checked.passed) break; await pause(500) } } catch (error) { report.cleanup.errors.push(error.message) }
    report.cleanup.check = checked; report.cleanup.knownIdentitiesNaturallyGone = checked.passed && report.cleanup.errors.length === 0 && report.cleanup.forced.length === 0
    report.cleanup.attributionComplete = scopeComplete
    report.cleanup.passed = scopeComplete && report.cleanup.knownIdentitiesNaturallyGone
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error('Probe smoke closing')) }; pending.clear()
    server.closeAllConnections(); if (server.listening) await new Promise(done => server.close(done))
    report.productionHelperUnchanged = await hash(prepared.helper) === prepared.helperSha256
    if (!report.cleanup.passed || !report.productionHelperUnchanged || report.errors.length) report.status = 'failed'
    await save(join(directory, 'report.json'), report)
    console.log(JSON.stringify({ status: report.status, directory, checks: report.checks.length, cleanupPassed: report.cleanup.passed, errors: report.errors, nativeInputOps: 0 }))
    if (report.status !== 'passed') process.exitCode = 1
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { if (args.includes('--smoke')) await smoke(); else await prepare() }
