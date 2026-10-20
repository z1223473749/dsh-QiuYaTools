/** Rebuild the disposable Windows test runtime from an npm integrity lock. No production dependency. */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const fixture = join(root, 'tests/fixtures/windows-test-runtime')
const folder = 'qiuya-harness-windows-portable'
const nodeVersion = '22.23.3', nodeSource = `https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`
export const WINDOWS_TEST_NODES = Object.freeze({
  arm64: Object.freeze({ version: nodeVersion, architecture: 'arm64', file: `node-v${nodeVersion}-win-arm64.zip`, sha256: '33dad22e4cef5ee8f9fbb1b0d037fdacd0e56d12a4580f0d63f68b894deab535', source: nodeSource }),
  x64: Object.freeze({ version: nodeVersion, architecture: 'x64', file: `node-v${nodeVersion}-win-x64.zip`, sha256: '2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71', source: nodeSource }),
})
export const WINDOWS_TEST_NODE = WINDOWS_TEST_NODES.arm64
function checkedArchitecture(architecture) {
  if (!Object.hasOwn(WINDOWS_TEST_NODES, architecture)) throw new Error('Windows test architecture must be arm64 or x64')
  return architecture
}
const defaultOutput = architecture => join(root, architecture === 'arm64' ? 'artifacts/windows-test-runtime' : 'artifacts/windows-test-runtime-x64')
const overlays = ['scripts/e2e-harness.mjs', 'scripts/test-harness-install.mjs', 'tests/fixtures/harness-e2e-provider.mjs', 'tests/fixtures/harness-preview-windows.ps1', 'tests/fixtures/harness-owned-windows.ps1', 'tests/fixtures/harness-activate-windows.ps1', 'src/features/computer-use/native.ts', 'src/features/computer-use/contract.ts']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const run = (executable, args, options = {}) => new Promise((done, reject) => {
  const child = spawn(executable, args, { stdio: 'inherit', ...options })
  child.once('error', reject); child.once('exit', code => code === 0 ? done() : reject(new Error(`${executable} exited ${code}`)))
})

export async function windowsTestRuntimePlan(architecture = 'arm64') {
  checkedArchitecture(architecture)
  const specification = await readFile(join(fixture, 'package.json'))
  const lockBytes = await readFile(join(fixture, 'package-lock.json'))
  const pkg = JSON.parse(specification), lock = JSON.parse(lockBytes)
  const ordered = value => JSON.stringify(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b)))
  if (lock.lockfileVersion !== 3 || ordered(lock.packages?.['']?.dependencies) !== ordered(pkg.dependencies)) throw new Error('The Windows test-runtime package and lock disagree')
  for (const [name, version] of Object.entries(pkg.dependencies)) {
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(version) || lock.packages[`node_modules/${name}`]?.version !== version) throw new Error(`Unpinned test dependency: ${name}`)
  }
  for (const [path, value] of Object.entries(lock.packages)) {
    if (!path) continue
    const bundledParent = value.inBundle && [...path.matchAll(/\/node_modules\//gu)].some(match => {
      const parent = lock.packages[path.slice(0, match.index)]
      return parent?.integrity && parent.resolved?.startsWith('https://registry.npmjs.org/') && !parent.link
    })
    if (!path.startsWith('node_modules/') || value.link || (!bundledParent && (!value.integrity || !value.resolved?.startsWith('https://registry.npmjs.org/')))) throw new Error(`Nonportable test dependency lock entry: ${path}`)
  }
  return { version: 1, platform: 'win32', architecture, folder, archiveName: `${folder}-${architecture}.tgz`, node: WINDOWS_TEST_NODES[architecture], dependencies: pkg.dependencies, packageSha256: hash(specification), lockSha256: hash(lockBytes), overlays }
}

/** An explicit external archive remains usable for existing runs, but is identified as unmanifested. */
export async function loadWindowsTestRuntime(options = {}) {
  const architecture = checkedArchitecture(options.architecture ?? 'arm64')
  const plan = await windowsTestRuntimePlan(architecture), node = plan.node
  const defaultDirectory = defaultOutput(architecture)
  const explicit = options.portablePath && options.nodeZipPath
  let manifest
  const manifestPath = options.manifestPath || (explicit ? undefined : join(defaultDirectory, 'manifest.json'))
  if (manifestPath) {
    try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')) }
    catch { throw new Error('Prepare the Windows test runtime first, or supply both QIUYA_WINDOWS_PORTABLE_TGZ and QIUYA_WINDOWS_NODE_ZIP; see docs/windows-test-runtime.md') }
    if (manifest.version !== 1 || manifest.platform !== 'win32' || manifest.architecture !== architecture || manifest.lockSha256 !== plan.lockSha256 || manifest.archive?.file !== plan.archiveName || manifest.node?.file !== node.file || manifest.node?.sha256 !== node.sha256) throw new Error('Windows test-runtime manifest or dependency lock mismatch')
  }
  const base = manifestPath ? dirname(resolve(manifestPath)) : defaultDirectory
  const portablePath = resolve(options.portablePath || join(base, plan.archiveName))
  const nodeZipPath = resolve(options.nodeZipPath || join(base, node.file))
  const portable = await readFile(portablePath), nodeZip = await readFile(nodeZipPath)
  const portableSha256 = hash(portable), nodeSha256 = hash(nodeZip)
  if (nodeSha256 !== node.sha256) throw new Error('The supplied Windows Node archive does not match the pinned official SHA256')
  if (manifest && portableSha256 !== manifest.archive.sha256) throw new Error('Windows test-runtime archive integrity mismatch')
  return { architecture, folder, node, portable, nodeZip, portablePath, nodeZipPath, portableSha256, nodeSha256, preparation: manifest ? 'locked-npm-ci-manifest' : 'explicit-external-artifacts-no-lock-manifest', lockSha256: manifest?.lockSha256 ?? null }
}

async function npmCli(explicit) {
  const candidates = [explicit, process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')]
  for (const part of (process.env.PATH || '').split(delimiter)) candidates.push(join(part, process.platform === 'win32' ? 'npm.cmd' : 'npm'))
  for (const candidate of candidates.filter(Boolean)) {
    try {
      const target = await realpath(candidate)
      const script = target.endsWith('.cmd') ? join(dirname(target), 'node_modules/npm/bin/npm-cli.js') : target
      if (!script.endsWith('.js')) continue
      await access(script); return script
    } catch { }
  }
  throw new Error('Pass --npm-cli /absolute/path/to/npm-cli.js from Node/npm; no shell shim is executed')
}

async function main() {
  const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
  const plan = await windowsTestRuntimePlan(arg('--arch') || 'arm64'), node = plan.node
  if (process.argv.includes('--plan')) { console.log(JSON.stringify(plan, null, 2)); return }
  const sourceNode = arg('--node-zip')
  if (!sourceNode) throw new Error('Pass --node-zip <local official Node archive>; this script does not download Node or browsers')
  const nodeBytes = await readFile(resolve(sourceNode))
  if (hash(nodeBytes) !== node.sha256) throw new Error('Local Node archive failed pinned official SHA256 validation')
  const output = resolve(arg('--output') || defaultOutput(plan.architecture))
  await mkdir(output, { recursive: true })
  const work = await mkdtemp(join(output, 'prepare-')), portable = join(work, folder)
  try {
    await mkdir(portable)
    for (const name of ['package.json', 'package-lock.json']) await copyFile(join(fixture, name), join(portable, name))
    const userconfig = join(work, 'isolated.npmrc')
    await writeFile(userconfig, 'registry=https://registry.npmjs.org\n')
    await run(process.execPath, [await npmCli(arg('--npm-cli')), 'ci', '--ignore-scripts', '--include=optional', '--os=win32', `--cpu=${plan.architecture}`, '--registry=https://registry.npmjs.org', `--userconfig=${userconfig}`, '--no-audit', '--no-fund'], { cwd: portable, env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', npm_config_cache: join(output, 'npm-cache') } })
    const sources = {}
    for (const name of overlays) {
      const bytes = await readFile(join(root, name)); sources[name] = hash(bytes)
      await mkdir(dirname(join(portable, name)), { recursive: true }); await writeFile(join(portable, name), bytes)
    }
    const binary = join(portable, `node_modules/@esbuild/win32-${plan.architecture}/esbuild.exe`)
    await access(binary)
    await mkdir(join(portable, 'node_modules/.bin'), { recursive: true })
    await writeFile(join(portable, 'node_modules/.bin/pnpm.cmd'), '@echo off\r\nnode "%~dp0..\\pnpm\\bin\\pnpm.cjs" %*\r\n')
    const archive = join(output, plan.archiveName)
    await run(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-czf', archive, '-C', work, folder])
    await writeFile(join(output, node.file), nodeBytes)
    const manifest = { ...plan, archive: { file: plan.archiveName, sha256: hash(await readFile(archive)) }, sources, createdAt: new Date().toISOString(), note: 'Public npm integrity lock; scripts disabled; no user runtime, profile, credentials, or bundled browser copied. Windows execution is a separate gate.' }
    await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    console.log(JSON.stringify({ status: 'prepared-not-run', manifest: join(output, 'manifest.json'), portable: archive, nodeZip: join(output, node.file) }, null, 2))
  } finally { if (!process.argv.includes('--keep-workdir')) await rm(work, { recursive: true, force: true }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
