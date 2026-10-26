import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { gzipSync } from 'node:zlib'

const run = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))

async function harnessPnpm() {
  const candidates = [process.env.QIUYA_TEST_PNPM,
    join(homedir(), '.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs'),
    '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs',
  ].filter(Boolean)
  for (const path of candidates) try { await access(path); return path } catch {}
  return undefined
}

function tarball(files) {
  const entries = []
  for (const [path, content] of Object.entries(files)) {
    const data = Buffer.from(content), header = Buffer.alloc(512)
    assert.ok(Buffer.byteLength(path) < 100, 'Fixture tar paths must fit a USTAR name')
    header.write(path)
    header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116)
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124)
    header.write('00000000000\0', 136); header.fill(32, 148, 156)
    header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263)
    header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148)
    entries.push(header, data, Buffer.alloc((512 - data.length % 512) % 512))
  }
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]))
}

function nativeTargets(pkg) {
  return Object.entries(pkg.optionalDependencies ?? {}).map(([name, version]) => {
    const match = /(?:^|-)(darwin|win32)-(arm64|x64|universal)$/.exec(name)
    assert.ok(match, `Unexpected native optional dependency: ${name}`)
    assert.equal(version, pkg.version, 'Native package versions must match the plugin exactly')
    assert.ok(match[2] !== 'universal' || match[1] === 'darwin', 'Only macOS has a universal native package')
    return { name, version, os: match[1], cpu: match[2], cpus: match[2] === 'universal' ? ['arm64', 'x64'] : [match[2]] }
  })
}

test('Git installation and npm ci deliver native dependencies without build approval or premature artifact hashes', { timeout: 180_000 }, async t => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const targets = nativeTargets(pkg)
  assert.ok(targets.some(item => item.os === 'win32' && item.cpu === 'x64'), 'Windows x64 must be an optional platform package')
  assert.ok(targets.some(item => item.os === 'win32' && item.cpu === 'arm64'), 'Windows ARM64 must be an optional platform package')
  assert.ok(targets.some(item => item.os === 'darwin' && item.cpus.includes('arm64') && item.cpus.includes('x64')), 'Both Mac architectures must be installable')
  assert.equal(pkg.scripts?.prepare, undefined, 'Committed bundles must not need a Git prepare script')
  const rootLock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
  assert.equal(rootLock.version, pkg.version)
  assert.deepEqual(rootLock.packages[''].optionalDependencies, pkg.optionalDependencies)
  for (const target of targets) {
    const entry = rootLock.packages[`node_modules/${target.name}`]
    assert.ok(entry, `Missing native lock entry would block npm ci: ${target.name}`)
    assert.equal(entry.version, target.version)
    assert.equal(entry.resolved, `https://registry.npmjs.org/${target.name}/-/${target.name}-${target.version}.tgz`)
    assert.equal(entry.optional, true)
    assert.deepEqual(entry.os, [target.os]); assert.deepEqual(entry.cpu, target.cpus)
  }
  const pnpm = await harnessPnpm()
  if (!pnpm) { t.skip('Set QIUYA_TEST_PNPM to the Harness bundled pnpm entry to run the real installer regression'); return }

  const directory = await mkdtemp(join(tmpdir(), 'qiuya-native-git-install-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const requests = [], packs = new Map(), publishedAt = new Date().toISOString(), registryState = { available: true }
  for (const target of targets) {
    const metadata = { name: target.name, version: target.version, os: [target.os], cpu: target.cpus, main: './index.js', files: ['index.js', 'native-fixture.txt'] }
    // Deliberately not an executable: this test proves dependency delivery only.
    packs.set(target.name, { target, metadata, bytes: tarball({
      'package/package.json': JSON.stringify(metadata),
      'package/index.js': `module.exports=${JSON.stringify({ fixture: true, os: target.os, cpu: target.cpu })}\n`,
      'package/native-fixture.txt': `INSTALLATION FIXTURE ONLY: ${target.os}/${target.cpu}\n`,
    }) })
  }
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).replace(/^\//, '')
    requests.push(path)
    const pack = packs.get(path)
    if (pack && registryState.available) {
      const base = `http://127.0.0.1:${server.address().port}`
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ name: pack.target.name, 'dist-tags': { latest: pack.target.version },
        time: { created: publishedAt, modified: publishedAt, [pack.target.version]: publishedAt },
        versions: { [pack.target.version]: { ...pack.metadata, dist: { tarball: `${base}/tarballs/${encodeURIComponent(pack.target.name)}.tgz`,
          integrity: `sha512-${createHash('sha512').update(pack.bytes).digest('base64')}`, shasum: createHash('sha1').update(pack.bytes).digest('hex') } } },
      }))
      return
    }
    const payload = [...packs.values()].find(item => path === `tarballs/${item.target.name}.tgz`)
    if (payload && registryState.available) { response.setHeader('content-type', 'application/octet-stream'); response.end(payload.bytes); return }
    response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `Unexpected fixture registry request: ${path}` }))
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const registry = `http://127.0.0.1:${server.address().port}`
  const repository = join(directory, 'repository')
  await mkdir(join(repository, 'lib'), { recursive: true })
  // Keep the production install/pack contract, including prepack if present.
  // Dev and peer dependencies are omitted because they are Host/build inputs,
  // not the native delivery path; autoInstallPeers remains false below.
  const manifest = Object.fromEntries(['name', 'version', 'type', 'main', 'exports', 'files', 'scripts', 'optionalDependencies'].map(key => [key, pkg[key]]))
  await writeFile(join(repository, 'package.json'), JSON.stringify(manifest, null, 2))
  await writeFile(join(repository, 'lib/index.js'), 'export const committedBundle = true\n')
  await writeFile(join(repository, 'lib/client.js'), 'export const committedClient = true\n')
  for (const command of Object.values(pkg.scripts ?? {})) {
    const match = /^node (scripts\/[^\s]+\.mjs)/.exec(command)
    if (!match) continue
    const path = join(repository, match[1]); await mkdir(dirname(path), { recursive: true })
    await writeFile(path, 'throw new Error("Git installation must use committed bundles without executing development scripts")\n')
  }
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(directory, 'empty-git-config') }
  await writeFile(gitEnv.GIT_CONFIG_GLOBAL, '')
  await run('git', ['init', '-b', 'fixture', repository], { env: gitEnv })
  await run('git', ['add', '.'], { cwd: repository, env: gitEnv })
  await run('git', ['-c', 'user.name=Native fixture', '-c', 'user.email=native-fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Committed installer fixture'], { cwd: repository, env: gitEnv })
  const { stdout: revision } = await run('git', ['rev-parse', 'HEAD'], { cwd: repository, env: gitEnv })
  const spec = `git+${pathToFileURL(repository).href}#${revision.trim()}`
  const { stdout: version } = await run(process.execPath, [pnpm, '--version'])
  t.diagnostic(`Real bundled pnpm ${version.trim()}; Git source ${revision.trim()}; native payloads are inert fixtures`)

  const scenarios = [
    ...(['darwin', 'win32'].includes(process.platform) ? [{ label: 'actual-host', os: process.platform, cpu: process.arch, simulated: false }] : []),
    ...targets.filter(item => item.os === 'win32' && (process.platform !== item.os || process.arch !== item.cpu)).map(item => ({ label: `simulated-${item.os}-${item.cpu}`, os: item.os, cpu: item.cpu, simulated: true })),
  ]
  for (const scenario of scenarios) await t.test(scenario.label, { timeout: 50_000 }, async () => {
    const profile = join(directory, scenario.label); await mkdir(profile)
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: `fixture-${scenario.label}`, private: true, dependencies: {} }))
    await writeFile(join(profile, '.npmrc'), `registry=${registry}\n`)
    await writeFile(join(profile, 'pnpm-workspace.yaml'), `packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nstoreDir: ./store\ncacheDir: ./cache\nstateDir: ./state\nsupportedArchitectures:\n  os: [${scenario.os}]\n  cpu: [${scenario.cpu}]\n`)
    const env = { ...gitEnv, npm_config_registry: registry, npm_config_userconfig: join(profile, '.npmrc'), NO_PROXY: '127.0.0.1,localhost' }
    let output
    try {
      const result = await run(process.execPath, [pnpm, 'add', '--reporter=append-only', '--ignore-scripts=false', '--registry', registry, '--fetch-retries=0', spec], { cwd: profile, env, timeout: 45_000, maxBuffer: 2 * 1024 * 1024 })
      output = result.stdout + result.stderr
    } catch (error) {
      assert.fail(`Real pnpm Git installation failed for ${scenario.label}: ${error.stdout ?? ''}\n${error.stderr ?? error.message}`)
    }
    assert.doesNotMatch(output, /GIT_DEP_PREPARE_NOT_ALLOWED|PREPARE_PACKAGE|Ignored build scripts|Git installation must use committed bundles/)
    const installed = join(profile, 'node_modules', pkg.name)
    assert.equal((await import(pathToFileURL(join(installed, 'lib/index.js')).href)).committedBundle, true)
    const expected = targets.filter(item => item.os === scenario.os && item.cpus.includes(scenario.cpu))
    assert.equal(expected.length, 1, 'Exactly one native package must match each tested platform')
    for (const target of targets) {
      const path = join(profile, 'node_modules', target.name, 'native-fixture.txt')
      if (expected.includes(target)) assert.equal(await readFile(path, 'utf8'), `INSTALLATION FIXTURE ONLY: ${target.os}/${target.cpu}\n`)
      else await assert.rejects(access(path), { code: 'ENOENT' }, 'Mismatched platform native packages must be absent')
    }
    const workspace = await readFile(join(profile, 'pnpm-workspace.yaml'), 'utf8')
    assert.doesNotMatch(workspace, /allowBuilds|onlyBuiltDependencies|dangerouslyAllowAllBuilds/)
    t.diagnostic(`${scenario.label} (${scenario.os}/${scenario.cpu}): installation passed without script approval; ${scenario.simulated ? 'selection simulated with supportedArchitectures' : 'actual Host platform'}; inert fixture only, no native binary executed`)
  })

  const npmPrefix = process.platform === 'win32'
    ? [process.env.npm_execpath?.endsWith('npm-cli.js') ? process.env.npm_execpath : join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')]
    : []
  const npmCommand = process.platform === 'win32' ? process.execPath : 'npm'
  for (const scenario of ['missing-lock-entries', 'native-assets-available', 'native-assets-unpublished-404']) await t.test(`npm-ci-${scenario}`, { timeout: 20_000 }, async () => {
    const profile = join(directory, `npm-ci-${scenario}`); await mkdir(profile)
    const metadata = { name: 'qiuya-native-ci-fixture', version: pkg.version, private: true, optionalDependencies: pkg.optionalDependencies }
    const lock = { name: metadata.name, version: metadata.version, lockfileVersion: 3, requires: true, packages: { '': metadata } }
    if (scenario !== 'missing-lock-entries') for (const target of targets) lock.packages[`node_modules/${target.name}`] = {
      version: target.version, resolved: `${registry}/tarballs/${encodeURIComponent(target.name)}.tgz`, optional: true, os: [target.os], cpu: target.cpus,
      // Registry availability is independent of the future CI-produced bytes.
      // No local fixture integrity is persisted in this version-only lock.
    }
    const lockText = JSON.stringify(lock, null, 2)
    await writeFile(join(profile, 'package.json'), JSON.stringify(metadata))
    await writeFile(join(profile, 'package-lock.json'), lockText)
    await writeFile(join(profile, '.npmrc'), `registry=${registry}\nupdate-notifier=false\n`)
    const env = { ...process.env, npm_config_registry: registry, npm_config_userconfig: join(profile, '.npmrc'), NO_PROXY: '127.0.0.1,localhost' }
    delete env.NODE_AUTH_TOKEN; delete env.NPM_TOKEN
    const args = [...npmPrefix, 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--fetch-retries=0', '--registry', registry, '--cache', join(profile, 'cache')]
    registryState.available = scenario !== 'native-assets-unpublished-404'
    try {
      if (scenario === 'missing-lock-entries') {
        await assert.rejects(run(npmCommand, [...args, '--dry-run', '--offline'], { cwd: profile, env, timeout: 15_000 }), error => {
          assert.equal(error.code, 1)
          assert.match(error.stderr, /EUSAGE/)
          for (const target of targets) assert.ok(error.stderr.includes(`Missing: ${target.name}@`), `npm ci must report the missing lock entry for ${target.name}`)
          return true
        })
      } else {
        await run(npmCommand, args, { cwd: profile, env, timeout: 15_000 })
        for (const target of targets) {
          const file = join(profile, 'node_modules', target.name, 'native-fixture.txt')
          if (registryState.available && target.os === process.platform && target.cpus.includes(process.arch)) assert.equal(await readFile(file, 'utf8'), `INSTALLATION FIXTURE ONLY: ${target.os}/${target.cpu}\n`)
          else await assert.rejects(access(file), { code: 'ENOENT' })
        }
      }
      assert.equal(await readFile(join(profile, 'package-lock.json'), 'utf8'), lockText, 'npm ci must not rewrite a lockfile to repair it')
    } finally { registryState.available = true }
  })
  assert.ok(requests.some(path => path.startsWith('tarballs/')), 'The real installer must fetch native tarballs through the isolated registry')
})
