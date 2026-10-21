/** Static test preparation only: no app launch, install, profile edit or inference. */
import { build, transform } from 'esbuild'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
const run = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url))
const digest = data => createHash('sha256').update(data).digest('hex')
export const VISION_TEST_BUNDLE = 'qiuya-live-vision-test-only'
export function visionBundleManifest() {
  return { name: VISION_TEST_BUNDLE, version: '0.0.0', private: true, type: 'module', main: './guard-plugin.mjs', exports: { '.': './guard-plugin.mjs' },
    description: 'Temporary scoped visual acceptance fixture; uninstall after testing.', files: ['guard-plugin.mjs', 'fixture-template.app/', 'cordis.patch.yml'], engines: { node: '>=22' }, dsh: { bundle: { patch: 'cordis.patch.yml' } } }
}
export function visionBundlePatch(config, id = randomUUID()) {
  if (!isAbsolute(config.native) || !isAbsolute(config.directory) || !/^[a-f0-9-]{36}$/u.test(id)) throw Error('Explicit absolute test paths and a unique patch identity are required')
  return [{ insert: [{ id: `qiuya-live-vision-test-${id}`, name: VISION_TEST_BUNDLE, config: { native: config.native, directory: config.directory } }] }]
}
/** Each closure is a single line below 2k, for the already-authenticated owner
 * renderer. No account keys, auth URLs, raw package output or diagnostics. */
export async function visionBundleConsole(mode, { archive, sha256 }) {
  if (!['read-only', 'install', 'uninstall'].includes(mode) || !isAbsolute(archive) || !/^[a-f0-9]{64}$/u.test(sha256)) throw Error('Invalid scoped bundle closure configuration')
  const key = `qiuya-vision-install:${sha256}`
  const body = mode === 'read-only' ? `const b=await rpc('pluginManager/listBundles',{}),p=await rpc('pluginManager/listPlugins',{}),v=b.find(x=>x.name===name);emit({installed:!!v,enabled:v?.enabled===true,version:v?.version==='0.0.0'?'0.0.0':v?'different':null,active:p.some(x=>x.moduleName===name&&x.fiberPhase==='active'),hmrActive:p.some(x=>x.moduleName==='@deepseek-ai/dsh-hmr'&&x.fiberPhase==='active')});`
    : mode === 'install' ? `const b=await rpc('pluginManager/listBundles',{});if(b.some(x=>x.name===name)||sessionStorage.getItem(key)!==null){emit({attempted:false,duplicateSuppressed:true});return}sessionStorage.setItem(key,'attempted');const v=await rpc('pluginManager/installBundle',{spec:${JSON.stringify(archive)},options:{enabled:true,saveExact:true,requestId:crypto.randomUUID()}});emit(project(v));`
      : `if(sessionStorage.getItem(key)===null)throw Error('not-owned');const b=await rpc('pluginManager/listBundles',{});if(!b.some(x=>x.name===name)){emit({absent:true});return}const v=await rpc('pluginManager/removeBundle',{name}),a=await rpc('pluginManager/listBundles',{}),p=await rpc('pluginManager/listPlugins',{}),absent=!a.some(x=>x.name===name),inactive=!p.some(x=>x.moduleName===name&&x.fiberPhase==='active');emit({...project(v),absent,inactive});`
  const script = `void(async()=>{if(location.protocol!=='dsh-app:'||location.hostname!=='app'||window.top!==window)throw Error('owner-renderer-required');const name=${JSON.stringify(VISION_TEST_BUNDLE)},key=${JSON.stringify(key)},emit=v=>console.log('QIUYA_VISION_BUNDLE '+JSON.stringify({mode:${JSON.stringify(mode)},package:name,...v})),project=v=>({application:['applied','failed','restart-required','cancelled','overridden'].includes(v?.application)?v.application:null,changed:v?.changed===true,error:v?.error?'official-manager-rejected':null});const rpc=async(method,args)=>{const rpcId=crypto.randomUUID(),r=await fetch('/api/'+method,{method:'POST',credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(120000),headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId,method,payload:{args}})}),v=await r.json();if(!r.ok||v.rpcId!==rpcId||!v.result?.ok)throw Error('rpc');return v.result.value};${body}})().catch(()=>console.error('QIUYA_VISION_BUNDLE_OPERATION_FAILED'));`
  const source = (await transform(script, { minify: true, target: 'es2022' })).code.trim()
  if (source.includes('\n') || source.length > 2000) throw Error('The scoped owner Console command exceeds the single-line bound')
  return source
}

export async function prepareLiveVision({ directory = join(tmpdir(), `qiuya-live-vision-${randomUUID()}`), native } = {}) {
  if (process.platform !== 'darwin') throw Error('Prepare the AppKit fixture on macOS')
  if (!native || !isAbsolute(native)) throw Error('Pass --native with the explicitly selected frozen helper path; floating lib defaults are forbidden')
  directory = resolve(directory); native = resolve(native)
  await access(native); await mkdir(directory, { recursive: true })
  const template = join(directory, 'fixture-template.app'), plugin = join(directory, 'guard-plugin.mjs'), packageDir = join(directory, 'bundle/package')
  if (await access(plugin).then(() => true, () => false)) throw Error('Use a fresh test preparation directory')
  await mkdir(join(template, 'Contents/MacOS'), { recursive: true }); await mkdir(join(directory, 'evidence'), { recursive: true }); await mkdir(packageDir, { recursive: true })
  await run('/usr/bin/swiftc', ['-swift-version', '5', '-framework', 'AppKit', '-module-cache-path', '/private/tmp/qiuya-live-vision-swift-cache', join(root, 'src/native/macos/fixtures/LiveVisionFixture.swift'), '-o', join(template, 'Contents/MacOS/fixture')], { timeout: 90000 })
  const bundle = await build({ entryPoints: [join(root, 'scripts/live-vision-guard-plugin.mjs')], outfile: plugin, bundle: true, platform: 'node', target: 'node22', format: 'esm', metafile: true })
  const config = { native, directory }, manifest = visionBundleManifest(), patch = visionBundlePatch(config)
  await cp(template, join(packageDir, 'fixture-template.app'), { recursive: true, errorOnExist: true, force: false })
  await cp(plugin, join(packageDir, 'guard-plugin.mjs'), { errorOnExist: true, force: false })
  await writeFile(join(packageDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  await writeFile(join(packageDir, 'cordis.patch.yml'), JSON.stringify(patch, null, 2) + '\n')
  const archive = join(directory, `${VISION_TEST_BUNDLE}-0.0.0.tgz`)
  await run('/usr/bin/tar', ['-czf', archive, '-C', join(directory, 'bundle'), 'package'], { timeout: 30000 })
  const archiveBytes = await readFile(archive), archiveSha256 = digest(archiveBytes)
  await writeFile(join(directory, 'plugin-config.json'), JSON.stringify(config, null, 2))
  const command = "void import('/api/qiuya-tools.vision-test-client').then(m=>m.run()).catch(()=>console.error('QIUYA_VISION_TEST_FAILED'))"
  const consoleFiles = { 'console-command.txt': command }
  for (const mode of ['read-only', 'install', 'uninstall']) consoleFiles[`${mode}-console.txt`] = await visionBundleConsole(mode, { archive, sha256: archiveSha256 })
  for (const [name, source] of Object.entries(consoleFiles)) await writeFile(join(directory, name), source + '\n')
  const files = [...new Set(['scripts/prepare-live-vision.mjs', 'src/native/macos/fixtures/LiveVisionFixture.swift', ...Object.keys(bundle.metafile.inputs).map(name => relative(root, resolve(name)))])]
  const sourceHashes = Object.fromEntries(await Promise.all(files.map(async name => [name, digest(await readFile(join(root, name)))])))
  const report = { status: 'prepared-not-run', plugin, config, package: { name: manifest.name, version: manifest.version, private: true, archive, sha256: archiveSha256, bytes: archiveBytes.length, patchEntryId: patch[0].insert[0].id },
    consoleCommands: Object.fromEntries(Object.entries(consoleFiles).map(([name, source]) => [name, { characters: source.length, sha256: digest(source), multiline: false }])), sourceHashes,
    pluginSha256: digest(await readFile(plugin)), fixtureSha256: digest(await readFile(join(template, 'Contents/MacOS/fixture'))), helperSha256: digest(await readFile(native)),
    inferenceRequestSent: false, actualInstallationExecuted: false, profileFilesChanged: false,
    note: 'Owner may use official pluginManager.installBundle/removeBundle for this temporary local package. Inspect the full one-line Console command before Enter; unknown install responses are never automatically replayed. The helper is explicitly frozen; this does not establish new pointer/manager integration.' }
  await writeFile(join(directory, 'preparation.json'), JSON.stringify(report, null, 2)); await writeFile(join(directory, 'evidence/preparation.json'), JSON.stringify(report, null, 2))
  return { status: report.status, directory, archive, archiveSha256, configFile: join(directory, 'plugin-config.json'), consoleFiles: Object.keys(consoleFiles) }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const arg = key => { const index = process.argv.indexOf(key); return index < 0 ? undefined : process.argv[index + 1] }
  console.log(JSON.stringify(await prepareLiveVision({ directory: arg('--output'), native: arg('--native') }), null, 2))
}
