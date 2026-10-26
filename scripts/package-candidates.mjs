import { mkdtemp, mkdir, cp, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { build } from 'esbuild'
const run = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))

/** Candidate assets are platform-scoped; never publish or pack both Windows runtimes together. */
export async function packageCandidate(platform, architecture, output = join(root, 'artifacts', 'candidates'), { sourceRoot = root } = {}) {
  if (platform !== 'darwin' && platform !== 'win32' || !['arm64', 'x64', 'universal'].includes(architecture) || platform === 'win32' && architecture === 'universal') throw new Error('Unsupported candidate target')
  const temp = await mkdtemp(join(tmpdir(), 'qiuya-candidate-'))
  try {
    const stage = join(temp, 'package'); await mkdir(stage)
    const pkg = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'))
    // Complete platform archives already carry their native payload. Do not
    // install the universal wrapper's optional packages a second time.
    const metadata = { ...pkg }; delete metadata.optionalDependencies
    await writeFile(join(stage, 'package.json'), JSON.stringify(metadata, null, 2) + '\n')
    for (const file of ['cordis.patch.yml', 'README.md', 'LICENSE', 'NOTICE']) await cp(join(sourceRoot, file), join(stage, file))
    await mkdir(join(stage, 'scripts'))
    await cp(join(sourceRoot, 'scripts', 'computer-agent.mjs'), join(stage, 'scripts', 'computer-agent.mjs'))
    await mkdir(join(stage, 'docs'))
    await cp(join(sourceRoot, 'docs/computer-use-guide.md'), join(stage, 'docs/computer-use-guide.md'))
    await cp(join(sourceRoot, 'docs/git-guide.md'), join(stage, 'docs/git-guide.md'))
    // Menu/scene images are already embedded in lib/client.js. Redistributing
    // their source copies wastes ~90 KiB and breaks the existing Windows x64
    // 64 MiB installer budget. The package icon remains a real public asset.
    await mkdir(join(stage, 'assets'))
    await cp(join(sourceRoot, 'assets/icon-color.webp'), join(stage, 'assets/icon-color.webp'))
    await cp(join(sourceRoot, 'locale'), join(stage, 'locale'), { recursive: true })
    await cp(join(sourceRoot, 'lib'), join(stage, 'lib'), { recursive: true, filter: source => {
      const path = source.slice(join(sourceRoot, 'lib').length).replaceAll('\\', '/')
      if (path.endsWith('.pdb') || path.endsWith('.swift') || path.startsWith('/native/') && path.endsWith('.xml')) return false
      if (/\/native(?:\/|$)/u.test(path)) return platform === 'win32' && (path === '/native' || path === '/native/windows-manifest.json' || path.startsWith(`/native/win32-${architecture}`))
      if (path === '/macos-manifest.json') return platform === 'darwin'
      if (path.includes('.app')) return platform === 'darwin'
      return !path.endsWith('.pdb') && !path.endsWith('.swift')
    } })
    if (platform === 'win32') {
      await stat(join(stage, 'lib', 'native', `win32-${architecture}`, 'qiuya-windows.exe'))
      const manifestPath = join(stage, 'lib/native/windows-manifest.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      if (manifest.version !== pkg.version) throw new Error('Windows native manifest version does not match the package; rebuild the native helpers')
      manifest.artifacts = manifest.artifacts.filter(asset => asset.architecture === architecture)
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    }
    else {
      const binary = join(stage, 'lib', 'QiuYaTools Computer.app', 'Contents', 'MacOS', 'qiuya-computer')
      const { stdout } = await run('/usr/bin/lipo', ['-archs', binary])
      for (const arch of architecture === 'universal' ? ['arm64', 'x86_64'] : [architecture === 'x64' ? 'x86_64' : architecture]) if (!stdout.includes(arch)) throw new Error(`Missing Mac computer helper architecture ${arch}`)
    }
    await mkdir(output, { recursive: true })
    const npmArgs = ['pack', '--ignore-scripts', '--json', '--pack-destination', temp, `--cache=${join(temp, 'npm-cache')}`]
    const npmCli = process.env.npm_execpath?.endsWith('npm-cli.js') ? process.env.npm_execpath : join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
    const { stdout } = await run(process.platform === 'win32' ? process.execPath : 'npm', process.platform === 'win32' ? [npmCli, ...npmArgs] : npmArgs, { cwd: stage, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })
    const packed = JSON.parse(stdout)[0], source = join(temp, packed.filename)
    const bytes = await readFile(source)
    if (bytes.length > 64 * 1024 * 1024) throw new Error(`Candidate exceeds existing 64 MiB installer limit: ${bytes.length}`)
    const checked = await build({ entryPoints: [join(root, 'src/updates/archive.ts')], bundle: true, write: false, platform: 'node', format: 'esm' })
    const { validateUpdateArchive } = await import(`data:text/javascript;base64,${Buffer.from(checked.outputFiles[0].text).toString('base64')}`)
    const architectures = architecture === 'universal' ? ['arm64', 'x64'] : [architecture]
    for (const arch of architectures) validateUpdateArchive(bytes, { platform, architecture: arch, packageName: pkg.name, version: pkg.version })
    const name = `${pkg.name}-${platform}-${architecture}.tgz`
    await cp(source, join(output, name))
    const result = { name, package: pkg.name, version: pkg.version, platform, architectures, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), status: 'package-validated', signed: false }
    await writeFile(join(output, `${name}.json`), JSON.stringify(result, null, 2) + '\n')
    return result
  } finally { await rm(temp, { recursive: true, force: true }) }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [platform = process.platform, architecture = platform === 'darwin' ? 'universal' : process.arch] = process.argv.slice(2)
  console.log(JSON.stringify(await packageCandidate(platform, architecture), null, 2))
}
