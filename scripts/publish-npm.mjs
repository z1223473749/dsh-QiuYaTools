import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { verifyPackage } from './verify-package.mjs'
import { nativePackages, nativeOptionalDependencies, validateNativeArchive, validateUniversalArchive } from './package-native.mjs'

const exec = promisify(execFile)
const repository = 'z1223473749/dsh-QiuYaTools'
const packageName = 'dsh-qiuya-tools'
const registry = 'https://registry.npmjs.org'
const archiveName = 'dsh-qiuya-tools.tgz'
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u
const confirmationAttempts = 46
const confirmationIntervalMs = 20_000
const newer = (left, right) => {
  const a = left.split('.').map(BigInt), b = right.split('.').map(BigInt)
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index]
  return false
}

async function command(file, args, options) {
  try { return { code: 0, ...await exec(file, args, { ...options, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }) } }
  catch (error) {
    if (typeof error.code !== 'number') throw new Error(`Could not complete ${file}`, { cause: error })
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

function json(text, description) {
  try { return JSON.parse(text) }
  catch { throw new Error(`Invalid ${description}`) }
}

function npmError(result) {
  for (const output of [result.stdout, result.stderr]) {
    try {
      const error = JSON.parse(output)?.error
      if (error && typeof error.code === 'string') return error
    } catch { /* npm diagnostics without structured JSON are failures, never absence. */ }
  }
}

/** Publish only the stable tag whose commit GitHub records for this run. */
export async function publishNpmRelease({
  root = new URL('../', import.meta.url), env = process.env,
  run = command, verify = verifyPackage, temporaryRoot = tmpdir(),
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  report = message => console.error(message),
} = {}) {
  const directory = root instanceof URL ? fileURLToPath(root) : resolve(root)
  const metadata = json(await readFile(join(directory, 'package.json'), 'utf8'), 'checkout package.json')
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== repository
    || !['push', 'release', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)) throw new Error('Publish requires the official GitHub Actions repository')
  if (metadata.name !== packageName || !stableVersion.test(metadata.version)
    || env.GITHUB_REF !== `refs/tags/v${metadata.version}`) throw new Error('Run from the matching stable v<package version> tag')
  if (!/^[a-f0-9]{40}$/u.test(env.GITHUB_SHA ?? '')) throw new Error('Missing GitHub release commit')
  const tag = `v${metadata.version}`
  if (metadata.repository?.url !== `git+https://github.com/${repository}.git`) throw new Error('Package repository does not match the trusted publisher')
  const withNativePackages = !newer('0.6.1', metadata.version)
  if (withNativePackages && JSON.stringify(Object.entries(metadata.optionalDependencies ?? {}).sort()) !== JSON.stringify(Object.entries(nativeOptionalDependencies(metadata.version)).sort())) {
    throw new Error('Checkout must pin every native optional package to the exact release version')
  }
  const childEnv = { ...env }
  delete childEnv.NODE_AUTH_TOKEN
  delete childEnv.NPM_TOKEN
  const invoke = (file, args, timeout = 120_000) => run(file, args, { cwd: directory, env: childEnv, timeout })
  const requireSuccess = async (file, args, description) => {
    const result = await invoke(file, args)
    if (result.code !== 0) throw new Error(`${description} failed`)
    return result.stdout.trim()
  }
  for (const ref of ['HEAD', `${env.GITHUB_REF}^{commit}`]) {
    if (await requireSuccess('git', ['rev-parse', '--verify', ref], 'Release commit verification') !== env.GITHUB_SHA) {
      throw new Error('Tag, checkout and GitHub event must identify the same commit')
    }
  }
  const npmVersion = await requireSuccess('npm', ['--version'], 'npm version check')
  const parts = /^(\d+)\.(\d+)\.(\d+)$/u.exec(npmVersion)
  if (!parts || Number(parts[1]) < 11 || Number(parts[1]) === 11 && Number(parts[2]) < 15) throw new Error('npm 11.15.0 or later is required')
  const release = json(await requireSuccess('gh', ['release', 'view', tag, '--repo', repository,
    '--json', 'tagName,isDraft,isPrerelease,publishedAt'], 'GitHub release lookup'), 'GitHub release metadata')
  if (release.tagName !== tag || release.isDraft !== false || release.isPrerelease !== false
    || typeof release.publishedAt !== 'string' || !Number.isFinite(Date.parse(release.publishedAt))) throw new Error('Expected a published stable GitHub release for this tag')
  const temporary = await mkdtemp(join(temporaryRoot, 'qiuya-npm-publish-'))
  try {
    const nativeNames = withNativePackages ? nativePackages.map(target => `${target.name}.tgz`) : []
    await requireSuccess('gh', ['release', 'download', tag, '--repo', repository, '--dir', temporary,
      ...[...nativeNames, archiveName, 'SHA256SUMS'].flatMap(name => ['--pattern', name])], 'GitHub release download')
    const sums = (await readFile(join(temporary, 'SHA256SUMS'), 'utf8')).trim().split(/\r?\n/u)
    // Validate the entire publication set before any registry mutation. A broken
    // third native package must not publish the first two or the parent wrapper.
    const publications = []
    for (const name of [...nativeNames, archiveName]) {
      const archive = join(temporary, name), size = await stat(archive)
      if (!size.isFile() || size.size > 64 * 1024 * 1024) throw new Error('Expected a release archive smaller than 64 MiB')
      const bytes = await readFile(archive)
      const matches = sums.map(line => /^([a-f0-9]{64}) [ *](.+)$/iu.exec(line)).filter(match => match?.[2] === name)
      if (matches.length !== 1 || matches[0][1].toLowerCase() !== createHash('sha256').update(bytes).digest('hex')) throw new Error('GitHub release archive SHA256 mismatch')
      const packed = json(await requireSuccess('tar', ['-xzOf', archive, 'package/package.json'], 'Package metadata read'), 'packed package.json')
      const expectedName = name === archiveName ? packageName : nativePackages.find(target => `${target.name}.tgz` === name)?.name
      if (packed.name !== expectedName || packed.version !== metadata.version || packed.repository?.url !== metadata.repository.url) throw new Error('Release archive package, version or repository mismatch')
      if (name === archiveName) {
        if (!packed.dsh?.bundle) throw new Error('Release archive declares no plugin bundle')
        if (withNativePackages) validateUniversalArchive(bytes, { version: metadata.version })
        const checked = await verify(archive)
        if (checked.name !== packageName || checked.version !== metadata.version) throw new Error('Verified Host identity does not match the release')
      } else validateNativeArchive(bytes, { packageName: expectedName, version: metadata.version })
      publications.push({ name: expectedName, archive, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` })
    }
    const registryValue = async (spec, field) => {
      const result = await invoke('npm', ['view', spec, field, '--json',
        `--registry=${registry}`, '--fetch-retries=0', '--fetch-timeout=30000'])
      if (result.code !== 0) {
        if (npmError(result)?.code === 'E404') return undefined
        throw new Error('npm registry lookup failed; publication state is unknown')
      }
      return json(result.stdout, 'npm registry response')
    }
    const publishedIntegrity = async name => {
      const value = await registryValue(`${name}@${metadata.version}`, 'dist.integrity')
      if (value === undefined) return undefined
      if (typeof value !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(value)) throw new Error('npm registry returned no valid SHA512 integrity')
      return value
    }
    const latestVersion = async (name, { processing = false } = {}) => {
      const value = await registryValue(name, 'dist-tags.latest')
      // This exact first-publish placeholder is not a stable semver to compare.
      // It can only keep post-publish confirmation waiting, never authorize a publish.
      if (processing && value === '0.0.0-stage') return undefined
      if (value !== undefined && (typeof value !== 'string' || !stableVersion.test(value))) throw new Error('npm latest is not a valid stable version')
      return value
    }
    const compare = (publication, value) => {
      if (value === undefined) return false
      if (value !== publication.integrity) throw new Error(`This npm version already exists with different release bytes: ${publication.name}`)
      return true
    }
    for (const publication of publications) {
      publication.existing = compare(publication, await publishedIntegrity(publication.name))
      publication.latest = await latestVersion(publication.name)
      publication.distTag = publication.latest && newer(publication.latest, metadata.version) ? `version-${metadata.version}` : 'latest'
      if (publication.existing && publication.distTag === 'latest' && (!publication.latest || newer(metadata.version, publication.latest))) {
        throw new Error('npm package bytes match, but latest was not advanced; explicitly repair the npm dist-tag before retrying')
      }
    }
    if (publications.some(publication => !publication.existing) && (!childEnv.ACTIONS_ID_TOKEN_REQUEST_URL || !childEnv.ACTIONS_ID_TOKEN_REQUEST_TOKEN)) throw new Error('GitHub OIDC is unavailable; grant id-token: write to the publishing job')
    const alreadyPublished = async publication => {
      const current = await latestVersion(publication.name)
      const { distTag, integrity } = publication
      if (distTag === 'latest' && (!current || newer(metadata.version, current))) {
        throw new Error('npm package bytes match, but latest was not advanced; explicitly repair the npm dist-tag before retrying')
      }
      return { status: 'already-published', version: metadata.version, integrity, latestVersion: current }
    }
    const publishOne = async publication => {
      const { name, archive, integrity, distTag, latest } = publication
      if (publication.existing) return alreadyPublished(publication)
      const result = await invoke('npm', ['publish', archive, '--ignore-scripts', '--access', 'public', '--tag', distTag, `--registry=${registry}`, '--json'])
      if (result.code !== 0) {
        // A competing run or lost successful response is safe only after byte-for-byte confirmation.
        if (compare(publication, await publishedIntegrity(name))) return alreadyPublished(publication)
        throw new Error(`npm publish failed${npmError(result)?.code ? ` (${npmError(result).code})` : ''}`)
      }
      // Do not mistake dry-run configuration or an unconfirmed registry response for a publish.
      // npm scans accepted publishes before exposing them. Allow 45 bounded waits
      // (15 minutes); keep checking the original bytes and the actual stable tag.
      for (let attempt = 0; attempt < confirmationAttempts; attempt++) {
        if (compare(publication, await publishedIntegrity(name))) {
          const current = await latestVersion(name, { processing: true })
          const minimumLatest = distTag === 'latest' ? metadata.version : latest
          if (current && !newer(minimumLatest, current)) {
            return { status: 'published', version: metadata.version, integrity, distTag }
          }
        }
        if (attempt < confirmationAttempts - 1) {
          report(`npm is still processing ${name}@${metadata.version}; confirmation ${attempt + 1}/${confirmationAttempts}, retrying in 20 seconds`)
          await wait(confirmationIntervalMs)
        }
      }
      throw new Error('npm accepted the publish, but after 15 minutes the registry has not confirmed the archive and stable dist-tag; processing may still be pending, so rerun this workflow later')
    }
    const results = []
    // Every native package must be publicly confirmed before the parent can
    // advertise that exact optional version to Git/npm installers.
    for (const publication of publications) results.push({ name: publication.name, ...await publishOne(publication) })
    const { name: ignored, ...parent } = results.at(-1)
    return withNativePackages ? { ...parent, nativePackages: results.slice(0, -1) } : parent
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

if (process.argv[1] && pathToFileURL(await realpath(process.argv[1])).href === import.meta.url) {
  try { console.log(JSON.stringify(await publishNpmRelease())) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
