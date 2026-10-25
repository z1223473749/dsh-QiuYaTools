/** Prepare only. Native compilation and every PD/GUI operation are deferred to --run. */
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, realpath, rm } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve, dirname } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { build, stop } from 'esbuild'
import { reverseSnapshotSmoke } from './reverse-remote-carrier.mjs'

const root = fileURLToPath(new URL('../', import.meta.url)), id = randomUUID(), base = join(root, 'artifacts/computer-use/windows-to-macos-strict-prepared-' + id), snapshot = join(base, 'snapshot')
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
const hash = value => createHash('sha256').update(value).digest('hex'), execute = promisify(execFile), sourceHashes = {}, snapshotHashes = {}
const helper = await realpath(join(root, 'lib/QiuYaTools Computer.app/Contents/MacOS/qiuya-computer')), helperSHA256 = hash(await readFile(helper))
const expectedHelperSHA256 = arg('--expect-helper-sha256')
assert.match(expectedHelperSHA256, /^[a-f0-9]{64}$/u, 'Pass --expect-helper-sha256 with the reviewed current helper SHA256'); assert.equal(helperSHA256, expectedHelperSHA256, 'Use the reviewed current formal Mac helper')
const runtimeReceiptArgument = arg('--runtime-receipt')
assert.equal(typeof runtimeReceiptArgument, 'string', 'Pass --runtime-receipt with the reviewed current Windows runtime receipt')
assert.ok(runtimeReceiptArgument.length > 0, 'Pass --runtime-receipt with the reviewed current Windows runtime receipt')
const runtimeReceipt = resolve(runtimeReceiptArgument)
const runtime = { ...JSON.parse(await readFile(runtimeReceipt, 'utf8')).runtime }
if (arg('--guest-node-root')) runtime.assetRoot = arg('--guest-node-root')
assert.match(runtime.assetRoot, /^[a-z]:\\/iu); assert.equal(runtime.architecture, 'arm64')
assert.equal(hash(await readFile(runtime.nodeArchivePath)), '33dad22e4cef5ee8f9fbb1b0d037fdacd0e56d12a4580f0d63f68b894deab535')
runtime.nodeArchiveSHA256 = '33dad22e4cef5ee8f9fbb1b0d037fdacd0e56d12a4580f0d63f68b894deab535'
const archiveMemberHash = await new Promise((done, reject) => {
  const child = spawn('/usr/bin/unzip', ['-p', runtime.nodeArchivePath, 'node-v22.23.3-win-arm64/node.exe'], { stdio: ['ignore', 'pipe', 'pipe'] }), digest = createHash('sha256')
  child.stdout.on('data', bytes => digest.update(bytes)); child.stderr.resume(); child.once('error', reject); child.once('exit', code => code === 0 ? done(digest.digest('hex')) : reject(Error('Reviewed Node archive member unavailable')))
})
assert.equal(archiveMemberHash, runtime.nodeExecutableSHA256, 'Cached Node executable proof differs from the actual reviewed archive member')
await mkdir(snapshot, { recursive: true })
const graph = await build({ stdin: { contents: "export{RemoteComputerDriver,createComputerAgentServer}from'./src/features/computer-use/remote.ts';export{NativeCompanionDriver}from'./src/features/computer-use/native.ts'", resolveDir: root }, bundle: true, write: false, platform: 'node', format: 'esm', metafile: true })
const own = ['scripts/prepare-reverse-remote-acceptance.mjs', 'scripts/reverse-remote-carrier.mjs', 'tests/reverse-remote-delivery.test.mjs', 'lib/macos-manifest.json', 'lib/QiuYaTools Computer.app/Contents/Info.plist', ...['Protocol.swift', 'Capture.swift', 'LeaseGuard.swift', 'Applications.swift', 'MacTransport.swift', 'PermissionGuide.swift', 'OperationBadge.swift', 'CursorOverlay.swift', 'FocusPreparation.swift', 'Input.swift', 'Preview.swift', 'main.swift'].map(name => 'src/native/macos/' + name), ...['ComputerFixture.swift', 'LeaseOracle.swift', 'ReverseLeaseAudit.swift'].map(name => 'src/native/macos/fixtures/' + name)]
for (const path of new Set([...own, ...Object.keys(graph.metafile.inputs).filter(path => path !== '<stdin>')])) sourceHashes[path] = hash(await readFile(join(root, path)))
const closure = await build({ entryPoints: [join(root, 'scripts/e2e-windows-to-macos-pd.mjs')], absWorkingDir: root, bundle: true, packages: 'external', platform: 'node', format: 'esm', write: false, metafile: true })
await stop()
for (const path of Object.keys(closure.metafile.inputs)) {
  assert.ok(!path.startsWith('..') && !path.startsWith('/'), 'Snapshot module escaped the reviewed repository')
  const original = await readFile(join(root, path), 'utf8')
  let content = original
  if (path === 'scripts/e2e-windows-to-macos-pd.mjs') {
    const needle = "repo = fileURLToPath(new URL('../', import.meta.url))"
    assert.equal(original.split(needle).length, 2, 'Snapshot repo-root transform must be exact')
    content = content.replace(needle, 'repo = ' + JSON.stringify(root))
  }
  const destination = join(snapshot, path); await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, content)
  sourceHashes[path] = hash(Buffer.from(original)); snapshotHashes[path] = hash(Buffer.from(content))
}
const smokeEnv = { ...process.env }; delete smokeEnv.QIUYA_PD_VM; delete smokeEnv.QIUYA_PD_HOST_IP
const snapshotImportSmoke = JSON.parse((await execute(process.execPath, ['--input-type=module', '-e', reverseSnapshotSmoke, pathToFileURL(join(snapshot, 'scripts/e2e-windows-to-macos-pd.mjs')).href], { env: smokeEnv, timeout: 15000 })).stdout.trim())
assert.equal(snapshotImportSmoke.passed, true)
const negative = join(base, 'negative-import-control')
for (const path of Object.keys(snapshotHashes)) {
  if (path === 'scripts/computer-soak-evidence.mjs') continue
  const destination = join(negative, path); await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, await readFile(join(snapshot, path)))
}
const negativeProgram = "import assert from'node:assert/strict';try{await import(process.argv[1]);throw Error('Missing dependency was accepted')}catch(error){assert.equal(error.code,'ERR_MODULE_NOT_FOUND');assert.ok(error.message.includes('/scripts/computer-soak-evidence.mjs'));console.log(JSON.stringify({passed:true,missingTransitiveDependencyRejected:true,pdCommandsExecuted:0,guiStarted:0,nativeCompilations:0}))}"
const missingTransitiveImportControl = JSON.parse((await execute(process.execPath, ['--input-type=module', '-e', negativeProgram, pathToFileURL(join(negative, 'scripts/e2e-windows-to-macos-pd.mjs')).href], { env: smokeEnv, timeout: 15000 })).stdout.trim())
assert.equal(missingTransitiveImportControl.passed, true); await rm(negative, { recursive: true })
const source = await readFile(join(root, 'scripts/e2e-windows-to-macos-pd.mjs'), 'utf8'), match = /const client = String.raw`([\s\S]*?)`\n\ntry \{/u.exec(source)
assert.ok(match, 'Actual embedded Windows client must be syntax checked')
await writeFile(join(base, 'client-syntax-only.mjs'), match[1]); await execute(process.execPath, ['--check', join(base, 'client-syntax-only.mjs')], { timeout: 15000 })
const data = { id, root, base, helper, helperSHA256, sourceHashes, snapshotHashes, runtime, runtimeReceipt, vm: 'ffba3614-b0e4-4b38-b185-b9a4b7ba5aec', host: '10.211.55.2', output: '/Users/qiuya/QiuYaTools-验收/2026-10-22/原始截图/Windows到Mac-严格九项-' + id, status: 'prepared-not-run', preparedAt: new Date().toISOString(), snapshotImportSmoke, missingTransitiveImportControl, deferredNativeCompilation: ['ComputerFixture.swift', 'LeaseOracle.swift', 'ReverseLeaseAudit.swift'], nativeCompilations: 0, guiStarted: false, pdCommandsExecuted: false, actualInput: false, actualCapture: false, scope: 'Same original nine real Windows RemoteComputerDriver business checks. New natural-cleanup predicate requires exact client/native/guardian/fixture retirement, no Stop/fallback, OS input empty, physical lease free, journal absent, revoked token and erased private config. Plan does not verify live guest runtime or execute/compile native fixtures.' }
const entry = "import{dirname}from'node:path';import{fileURLToPath}from'node:url';import{readFile}from'node:fs/promises';import{runReverseRemoteCarrier}from" + JSON.stringify(pathToFileURL(join(root, 'scripts/reverse-remote-carrier.mjs')).href) + ";const base=dirname(fileURLToPath(import.meta.url));await runReverseRemoteCarrier(base,JSON.parse(await readFile(base+'/prepare-data.json','utf8')));\n"
await writeFile(join(base, 'entry.mjs'), entry); data.entrySHA256 = hash(Buffer.from(entry)); await writeFile(join(base, 'prepare-data.json'), JSON.stringify(data, null, 2))
await writeFile(join(base, 'snapshot-import-smoke.json'), JSON.stringify(snapshotImportSmoke, null, 2)); await writeFile(join(base, 'missing-transitive-import-control.json'), JSON.stringify(missingTransitiveImportControl, null, 2))
console.log(JSON.stringify({ status: data.status, entry: join(base, 'entry.mjs'), output: data.output, helperSHA256, sourceCount: Object.keys(sourceHashes).length, snapshotCount: Object.keys(snapshotHashes).length, nativeCompilations: 0, guiStarted: false, pdCommandsExecuted: false, deferredNativeCompilation: data.deferredNativeCompilation }, null, 2))
