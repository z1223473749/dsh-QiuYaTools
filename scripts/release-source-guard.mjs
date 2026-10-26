import { execFile } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'

const execute = promisify(execFile)
const repository = 'z1223473749/dsh-QiuYaTools'
// Local assembly still requires committed production/package inputs. Reports
// outside this set may be finalized after the packages have been assembled.
export const releaseSourceInputs = ['src', 'lib', 'package.json', 'package-lock.json', 'cordis.patch.yml', 'locale', 'assets', 'LICENSE', 'NOTICE', 'README.md', 'CHANGELOG.md', 'docs/computer-use-guide.md', 'docs/git-guide.md', 'scripts', '.github/workflows']
// Swift toolchains can change these native bytes even when the tagged source is
// identical. No JavaScript, source, package metadata or other path is exempt.
export const rebuiltMacOutputs = ['lib/QiuYaTools Sessions.app/Contents/MacOS/qiuya-session-window', 'lib/macos-manifest.json']

export function parseGitStatus(output) {
  const records = output.split('\0').filter(Boolean)
  const entries = []
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (record.length < 4 || record[2] !== ' ') throw new Error('Unexpected Git status record')
    const entry = { status: record.slice(0, 2), path: record.slice(3) }
    if (/[RC]/u.test(entry.status)) {
      if (!records[++index]) throw new Error('Incomplete Git rename/copy status')
    }
    entries.push(entry)
  }
  return entries
}

/** Bind CI-generated native outputs to the exact clean source tag being built. */
export async function verifyReleaseSources({ root = new URL('../', import.meta.url), phase = 'assemble', env = process.env } = {}) {
  if (!['before-build', 'assemble'].includes(phase)) throw new Error('Unknown release source verification phase')
  const cwd = root instanceof URL ? fileURLToPath(root) : resolve(root)
  const git = async args => (await execute('git', args, { cwd, encoding: 'utf8' })).stdout
  const sourceCommit = (await git(['rev-parse', '--verify', 'HEAD'])).trim()
  const ci = env.GITHUB_ACTIONS === 'true'
  if (ci) {
    const metadata = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'))
    if (env.GITHUB_REPOSITORY !== repository || env.GITHUB_EVENT_NAME !== 'push'
      || env.GITHUB_REF !== `refs/tags/v${metadata.version}` || !/^[a-f0-9]{40}$/u.test(env.GITHUB_SHA ?? '')) {
      throw new Error('Release assembly CI requires the official repository push for the matching version tag')
    }
    const tagCommit = (await git(['rev-parse', '--verify', `${env.GITHUB_REF}^{commit}`])).trim()
    if (sourceCommit !== env.GITHUB_SHA || tagCommit !== sourceCommit) throw new Error('Release tag, HEAD and GitHub SHA must identify the same commit')
  }
  // The pre-build gate checks the entire checkout, before npm or a compiler has
  // an opportunity to write anything. Assembly keeps the local report exception.
  const paths = phase === 'before-build' ? [] : releaseSourceInputs
  const entries = parseGitStatus(await git(['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--', ...paths]))
  const dirty = entries.filter(entry => !(ci && phase === 'assemble' && entry.status === ' M' && rebuiltMacOutputs.includes(entry.path)))
  if (dirty.length) throw new Error('Commit production and packaging inputs before release assembly: ' + dirty.map(entry => `${entry.status} ${JSON.stringify(entry.path)}`).join(', '))
  return {
    sourceCommit,
    productionSourceStatus: ci
      ? 'committed source and packaging inputs; native Mac outputs rebuilt in verified tag CI'
      : 'committed production and packaging inputs; test reports are finalized separately',
  }
}

if (process.argv[1] && pathToFileURL(await realpath(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3 || process.argv[2] !== '--before-build') throw new Error('Usage: node scripts/release-source-guard.mjs --before-build')
  const result = await verifyReleaseSources({ phase: 'before-build' })
  console.log(`Verified clean release source ${result.sourceCommit}`)
}
