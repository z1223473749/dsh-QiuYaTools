import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { parseGitStatus, rebuiltMacOutputs, verifyReleaseSources } from '../scripts/release-source-guard.mjs'

const execute = promisify(execFile)
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'qiuya-release-source-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const git = async args => (await execute('git', args, { cwd: root, encoding: 'utf8' })).stdout.trim()
  await git(['init', '-q'])
  await mkdir(join(root, '.empty-hooks'))
  await git(['config', 'core.hooksPath', join(root, '.empty-hooks')])
  const put = async (path, text) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text) }
  await put('package.json', JSON.stringify({ name: 'dsh-qiuya-tools', version: '0.6.0' }))
  await put('src/index.ts', 'export const source = true\n')
  await put('lib/index.js', 'export const built = true\n')
  for (const path of rebuiltMacOutputs) await put(path, 'committed native output\n')
  await git(['add', '.'])
  const commit = async () => git(['-c', 'user.name=Release Test', '-c', 'user.email=release-test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'release fixture'])
  await commit()
  await git(['tag', 'v0.6.0'])
  const sourceCommit = await git(['rev-parse', 'HEAD'])
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'z1223473749/dsh-QiuYaTools', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v0.6.0', GITHUB_SHA: sourceCommit }
  return { root, git, put, commit, env, sourceCommit }
}

test('local assembly requires committed production inputs, including native outputs', async t => {
  const f = await fixture(t)
  assert.equal((await verifyReleaseSources({ root: f.root, env: {} })).sourceCommit, f.sourceCommit)
  await f.put(rebuiltMacOutputs[0], 'locally rebuilt\n')
  await assert.rejects(verifyReleaseSources({ root: f.root, env: {} }), /Commit production and packaging inputs/u)
  await assert.rejects(verifyReleaseSources({ root: f.root, env: { ...f.env, GITHUB_ACTIONS: 'false' } }), /Commit production and packaging inputs/u)
})

test('verified tag CI allows exactly the two rebuilt Mac outputs and retains the source commit', async t => {
  const f = await fixture(t)
  await verifyReleaseSources({ root: f.root, phase: 'before-build', env: f.env })
  for (const path of rebuiltMacOutputs) await f.put(path, 'rebuilt with the CI Swift toolchain\n')
  const result = await verifyReleaseSources({ root: f.root, env: f.env })
  assert.equal(result.sourceCommit, f.sourceCommit)
  assert.match(result.productionSourceStatus, /rebuilt in verified tag CI/u)
  await assert.rejects(verifyReleaseSources({ root: f.root, phase: 'before-build', env: f.env }), /Commit production and packaging inputs/u)
})

test('CI rejects source, JavaScript and packaging changes even beside allowed native changes', async t => {
  for (const path of ['src/index.ts', 'lib/index.js', 'scripts/new-packaging-input.mjs', 'CHANGELOG.md', 'docs/git-guide.md', '.github/workflows/release.yml']) {
    const f = await fixture(t)
    await f.put(rebuiltMacOutputs[0], 'allowed native rebuild\n')
    await f.put(path, 'uncommitted input\n')
    await assert.rejects(verifyReleaseSources({ root: f.root, env: f.env }), /Commit production and packaging inputs/u, path)
  }
})

test('CI rejects staged, deleted or renamed native outputs instead of exempting arbitrary statuses', async t => {
  const staged = await fixture(t)
  await staged.put(rebuiltMacOutputs[0], 'staged rebuild\n')
  await staged.git(['add', rebuiltMacOutputs[0]])
  await assert.rejects(verifyReleaseSources({ root: staged.root, env: staged.env }), /Commit production and packaging inputs/u)
  const removed = await fixture(t)
  await rm(join(removed.root, rebuiltMacOutputs[0]))
  await assert.rejects(verifyReleaseSources({ root: removed.root, env: removed.env }), /Commit production and packaging inputs/u)
  const renamed = await fixture(t)
  await renamed.git(['mv', rebuiltMacOutputs[0], rebuiltMacOutputs[0] + '-renamed'])
  await assert.rejects(verifyReleaseSources({ root: renamed.root, env: renamed.env }), /Commit production and packaging inputs/u)
})

test('only official matching tag pushes can use the CI native rebuild exception', async t => {
  const f = await fixture(t)
  await f.put(rebuiltMacOutputs[0], 'CI rebuild\n')
  for (const change of [
    { GITHUB_REPOSITORY: 'someone/fork' }, { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_EVENT_NAME: 'workflow_dispatch' }, { GITHUB_REF: 'refs/heads/main' },
    { GITHUB_REF: 'refs/tags/v0.6.1' }, { GITHUB_SHA: 'invalid' },
    { GITHUB_SHA: 'f'.repeat(40) },
  ]) await assert.rejects(verifyReleaseSources({ root: f.root, env: { ...f.env, ...change } }), /official repository|same commit/u)
})

test('a clean newer checkout cannot claim the older version tag as its source', async t => {
  const f = await fixture(t)
  await f.put('src/index.ts', 'export const changed = true\n')
  await f.git(['add', 'src/index.ts'])
  await f.commit()
  const newerCommit = await f.git(['rev-parse', 'HEAD'])
  await assert.rejects(verifyReleaseSources({ root: f.root, env: { ...f.env, GITHUB_SHA: newerCommit } }), /same commit/u)
})

test('the pre-build gate checks the whole checkout while local assembly permits finalized reports', async t => {
  const f = await fixture(t)
  await f.put('docs/test-report.md', 'a separately finalized report\n')
  await verifyReleaseSources({ root: f.root, env: {} })
  await assert.rejects(verifyReleaseSources({ root: f.root, phase: 'before-build', env: f.env }), /Commit production and packaging inputs/u)
})

test('NUL-delimited Git status preserves spaces and parses both rename paths', () => {
  assert.deepEqual(parseGitStatus(' M lib/path with spaces\0R  lib/new name\0lib/old name\0?? scripts/new.mjs\0'), [
    { status: ' M', path: 'lib/path with spaces' }, { status: 'R ', path: 'lib/new name' }, { status: '??', path: 'scripts/new.mjs' },
  ])
  assert.throws(() => parseGitStatus('R  incomplete\0'), /Incomplete Git/u)
})

test('release verifies clean source before building and both platform jobs supply .NET before check', async () => {
  const release = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  const releaseJob = release.slice(release.indexOf('\n  release:\n    if:'))
  const guard = releaseJob.indexOf('node scripts/release-source-guard.mjs --before-build')
  assert(guard >= 0 && guard < releaseJob.indexOf('npm ci'))
  assert(releaseJob.indexOf('actions/setup-dotnet@v4') < releaseJob.indexOf('npm run check'))
  assert.match(releaseJob, /QIUYA_DOTNET="\$\(command -v dotnet\)" npm run check/u)
  const platforms = await readFile(new URL('../.github/workflows/verify-platforms.yml', import.meta.url), 'utf8')
  assert(platforms.indexOf('actions/setup-dotnet@v4') < platforms.indexOf('npm run check'))
  assert(platforms.indexOf('QIUYA_DOTNET=${executable}') < platforms.indexOf('npm run check'))
  assert.match(platforms, /process\.platform === "win32" \? "dotnet\.exe" : "dotnet"/u)
})
